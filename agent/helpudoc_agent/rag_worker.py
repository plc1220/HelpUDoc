"""Redis-backed indexing worker for workspace document uploads."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from dataclasses import dataclass
from typing import Any, Dict, Optional

from redis.asyncio import Redis

from .rag_indexer import RagConfig, WorkspaceRagStore


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RagQueueConfig:
    redis_url: str
    stream: str
    group: str
    consumer: str

    @classmethod
    def from_env(cls) -> "RagQueueConfig":
        redis_url = os.getenv("RAG_REDIS_URL") or os.getenv("REDIS_URL") or "redis://127.0.0.1:6379"
        stream = os.getenv("RAG_INDEX_STREAM") or "helpudoc:rag:index-jobs"
        group = os.getenv("RAG_INDEX_GROUP") or "helpudoc-rag-indexers"
        consumer = os.getenv("RAG_INDEX_CONSUMER") or f"{socket.gethostname()}-{os.getpid()}"
        return cls(redis_url=redis_url, stream=stream, group=group, consumer=consumer)


class RagIndexWorker:
    def __init__(self, workspace_root, *, queue_cfg: RagQueueConfig | None = None):
        self.queue_cfg = queue_cfg or RagQueueConfig.from_env()
        self.redis: Optional[Redis] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()

        rag_cfg = RagConfig.from_env(workspace_root)
        self.store = WorkspaceRagStore(workspace_root, rag_cfg)

    async def start(self) -> None:
        if self._task is not None:
            return
        self.redis = Redis.from_url(self.queue_cfg.redis_url, decode_responses=True)
        await self._ensure_group()
        self._task = asyncio.create_task(self._run_loop(), name="rag-index-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self.redis is not None:
            await self.redis.aclose()
            self.redis = None

    async def _ensure_group(self) -> None:
        assert self.redis is not None
        try:
            await self.redis.xgroup_create(
                name=self.queue_cfg.stream,
                groupname=self.queue_cfg.group,
                id="0-0",
                mkstream=True,
            )
        except Exception as exc:
            # BUSYGROUP means already created.
            if "BUSYGROUP" not in str(exc):
                raise

    async def _handle_message(self, fields: Dict[str, Any]) -> None:
        job_type = (fields.get("type") or "").strip()
        workspace_id = str(fields.get("workspaceId") or "").strip()
        if not workspace_id:
            raise ValueError("Missing workspaceId")

        if job_type == "file_upsert":
            relative_path = str(fields.get("relativePath") or "").strip()
            if not relative_path:
                raise ValueError("Missing relativePath")
            await self.store.ingest_file(workspace_id, relative_path)
            return

        if job_type == "file_delete":
            relative_path = str(fields.get("relativePath") or "").strip()
            if not relative_path:
                raise ValueError("Missing relativePath")
            await self.store.delete_file(workspace_id, relative_path)
            return

        if job_type == "workspace_delete":
            await self.store.delete_workspace(workspace_id)
            return

        raise ValueError(f"Unsupported job type: {job_type}")

    async def _run_loop(self) -> None:
        assert self.redis is not None
        cfg = self.queue_cfg
        logger.info("RAG index worker started (stream=%s group=%s consumer=%s)", cfg.stream, cfg.group, cfg.consumer)

        while not self._stop.is_set():
            try:
                response = await self.redis.xreadgroup(
                    groupname=cfg.group,
                    consumername=cfg.consumer,
                    streams={cfg.stream: ">"},
                    count=10,
                    block=1000,
                )
                if not response:
                    continue
                for _stream_name, messages in response:
                    for message_id, fields in messages:
                        try:
                            await self._handle_message(fields)
                            await self.redis.xack(cfg.stream, cfg.group, message_id)
                        except Exception:
                            logger.exception("Failed processing RAG job id=%s fields=%s", message_id, json.dumps(fields, ensure_ascii=False))
                            # Leave unacked so it can be inspected/replayed.
                            continue
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("RAG worker loop error; retrying soon")
                await asyncio.sleep(2)
