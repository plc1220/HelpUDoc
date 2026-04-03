"""Persistent memory store helpers for /memories/* files."""
from __future__ import annotations

import os
import re
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional

from deepagents.backends import StoreBackend
from deepagents.backends.utils import create_file_data, file_data_to_string
from langgraph.store.base import BaseStore, Item
from langgraph.store.memory import InMemoryStore

try:  # pragma: no cover - import depends on optional package
    from langgraph.store.postgres import PostgresStore
except Exception:  # pragma: no cover - handled at runtime when store is requested
    PostgresStore = None  # type: ignore[assignment]


MEMORY_ROUTE_PREFIX = "/memories/"
MEMORY_NAMESPACE_SUFFIX = "helpudoc-memory"
MEMORY_PATH_PATTERN = re.compile(
    r"^/memories/(global/(preferences|context)\.md|workspaces/[^/]+/(preferences|context)\.md)$"
)


@dataclass
class MemoryFile:
    path: str
    exists: bool
    content: str
    modified_at: Optional[str] = None


def resolve_store_connection_string() -> str:
    explicit = (os.getenv("AGENT_STORE_DATABASE_URL") or "").strip()
    if explicit:
        return explicit

    database_url = (os.getenv("DATABASE_URL") or "").strip()
    if database_url:
        return database_url

    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "helpudoc")
    user = os.getenv("POSTGRES_USER", "helpudoc")
    password = os.getenv("POSTGRES_PASSWORD", "helpudoc")
    return f"postgres://{user}:{password}@{host}:{port}/{db}"


def should_use_in_memory_store() -> bool:
    raw = (os.getenv("AGENT_STORE_USE_IN_MEMORY") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def normalize_memory_path(path: str) -> str:
    normalized = str(path or "").strip().replace("\\", "/")
    if not normalized.startswith("/"):
        normalized = f"/{normalized.lstrip('/')}"
    if not MEMORY_PATH_PATTERN.match(normalized):
        raise ValueError("Unsupported memory path")
    return normalized


def strip_memory_prefix(path: str) -> str:
    normalized = normalize_memory_path(path)
    stripped = normalized[len("/memories") :]
    if not stripped.startswith("/"):
        stripped = f"/{stripped}"
    return stripped


def restore_memory_prefix(path: str) -> str:
    normalized = str(path or "").strip().replace("\\", "/")
    if not normalized.startswith("/"):
        normalized = f"/{normalized.lstrip('/')}"
    if normalized.startswith("/memories/"):
        return normalize_memory_path(normalized)
    return normalize_memory_path(f"/memories{normalized}")


def user_memory_namespace(user_id: str) -> tuple[str, ...]:
    normalized = str(user_id or "").strip()
    if not normalized:
        raise ValueError("user_id is required for persistent memory access")
    return (normalized, MEMORY_NAMESPACE_SUFFIX)


class UserScopedStoreBackend(StoreBackend):
    """Route /memories/* files to a per-user namespace in the shared store."""

    def _get_namespace(self) -> tuple[str, ...]:
        runtime_context = getattr(self.runtime, "context", None)
        if isinstance(runtime_context, dict):
            user_id = runtime_context.get("user_id") or runtime_context.get("userId")
            if isinstance(user_id, str) and user_id.strip():
                return user_memory_namespace(user_id)

        runtime_cfg = getattr(self.runtime, "config", None)
        if isinstance(runtime_cfg, dict):
            configurable = runtime_cfg.get("configurable") or {}
            if isinstance(configurable, dict):
                user_id = configurable.get("user_id") or configurable.get("userId")
                if isinstance(user_id, str) and user_id.strip():
                    return user_memory_namespace(user_id)
        raise ValueError("user_id is required for persistent memory access")


class MemoryStoreManager:
    """Owns the long-term store used by CompositeBackend and internal APIs."""

    def __init__(self) -> None:
        self._store: BaseStore | None = None
        self._store_context: AbstractContextManager[Any] | None = None

    @property
    def store(self) -> BaseStore:
        if self._store is None:
            raise RuntimeError("Memory store is not initialized")
        return self._store

    def start(self) -> None:
        if self._store is not None:
            return
        if should_use_in_memory_store():
            self._store = InMemoryStore()
            return
        if PostgresStore is None:
            raise RuntimeError(
                "langgraph.store.postgres is unavailable. Install langgraph-checkpoint-postgres and psycopg[binary]."
            )
        conn_string = resolve_store_connection_string()
        store_context = PostgresStore.from_conn_string(conn_string)
        store = store_context.__enter__()
        store.setup()
        self._store_context = store_context
        self._store = store

    def stop(self) -> None:
        if self._store_context is not None:
            self._store_context.__exit__(None, None, None)
        self._store_context = None
        self._store = None

    def read_file(self, user_id: str, path: str) -> MemoryFile:
        normalized_path = normalize_memory_path(path)
        item = self.store.get(user_memory_namespace(user_id), strip_memory_prefix(normalized_path))
        if item is None:
            return MemoryFile(path=normalized_path, exists=False, content="", modified_at=None)
        content, modified_at = self._item_content(item)
        return MemoryFile(path=normalized_path, exists=True, content=content, modified_at=modified_at)

    def write_file(self, user_id: str, path: str, content: str) -> MemoryFile:
        normalized_path = normalize_memory_path(path)
        self.store.put(
            user_memory_namespace(user_id),
            strip_memory_prefix(normalized_path),
            create_file_data(content),
        )
        return self.read_file(user_id, normalized_path)

    def delete_file(self, user_id: str, path: str) -> None:
        normalized_path = normalize_memory_path(path)
        self.store.delete(user_memory_namespace(user_id), strip_memory_prefix(normalized_path))

    def read_many(self, user_id: str, paths: Iterable[str]) -> Dict[str, MemoryFile]:
        result: Dict[str, MemoryFile] = {}
        for path in paths:
            normalized = normalize_memory_path(path)
            result[normalized] = self.read_file(user_id, normalized)
        return result

    @staticmethod
    def _item_content(item: Item) -> tuple[str, Optional[str]]:
        raw_content = item.value.get("content")
        modified_at = item.value.get("modified_at")
        if not isinstance(raw_content, list):
            return "", modified_at if isinstance(modified_at, str) else None
        return file_data_to_string(item.value), modified_at if isinstance(modified_at, str) else None
