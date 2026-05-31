"""Workspace-scoped LightRAG indexing and query helpers (HKU LightRAG).

This module is used by the background worker that consumes Redis jobs enqueued by
the backend on file upload/update.
"""

from __future__ import annotations

import asyncio
import logging
import re
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

try:
    from lightrag import LightRAG  # type: ignore
    from lightrag.base import QueryParam  # type: ignore
    from lightrag.utils import EmbeddingFunc, compute_mdhash_id  # type: ignore
except Exception:  # pragma: no cover - optional dependency for some test environments
    LightRAG = None  # type: ignore[assignment]
    QueryParam = None  # type: ignore[assignment]
    EmbeddingFunc = Any  # type: ignore[assignment]

    def compute_mdhash_id(text: str, prefix: str = "") -> str:  # type: ignore[override]
        return f"{prefix}{hashlib.md5(text.encode('utf-8')).hexdigest()}"


from .config.env import ensure_lightrag_postgres_env_defaults, env_trim, gemini_key_for_embeddings

logger = logging.getLogger(__name__)

RAG_INDEXABLE_SUFFIXES = {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".md", ".html", ".htm"}


@dataclass(frozen=True)
class RagConfig:
    working_dir: Path
    llm_model: str
    embedding_model: str
    embedding_dim: int
    gemini_api_key: str | None
    gemini_base_url: str | None
    max_file_bytes: int
    max_text_chars: int
    offline: bool
    enable_rerank: bool

    @classmethod
    def from_env(cls, workspace_root: Path) -> "RagConfig":
        ensure_lightrag_postgres_env_defaults()
        working_dir = Path(env_trim("RAG_WORKING_DIR", str(workspace_root / ".lightrag_storage"))).resolve()
        llm_model = env_trim("RAG_LLM_MODEL", env_trim("LLM_MODEL", "gemini-3.5-flash")) or "gemini-3.5-flash"
        embedding_model = env_trim("RAG_EMBEDDING_MODEL", env_trim("EMBEDDING_MODEL", "gemini-embedding-001")) or "gemini-embedding-001"
        embedding_dim = int(env_trim("RAG_EMBEDDING_DIM", env_trim("EMBEDDING_DIM", "3072")) or "3072")
        api_key = env_trim("GEMINI_API_KEY", env_trim("LLM_BINDING_API_KEY"))
        base_url = env_trim("LLM_BINDING_HOST")
        max_file_bytes = int(env_trim("RAG_MAX_FILE_BYTES", str(25 * 1024 * 1024)) or str(25 * 1024 * 1024))
        max_text_chars = int(env_trim("RAG_MAX_TEXT_CHARS", "250000") or "250000")
        offline_env = (env_trim("RAG_OFFLINE", "false") or "false").lower()
        offline = offline_env in {"1", "true", "yes", "y", "on"} or not api_key
        enable_rerank = (env_trim("RAG_ENABLE_RERANK", "false") or "false").strip().lower() in {"1", "true", "yes", "y", "on"}
        return cls(
            working_dir=working_dir,
            llm_model=llm_model,
            embedding_model=embedding_model,
            embedding_dim=embedding_dim,
            gemini_api_key=api_key,
            gemini_base_url=base_url,
            max_file_bytes=max_file_bytes,
            max_text_chars=max_text_chars,
            offline=offline,
            enable_rerank=enable_rerank,
        )


def _safe_join_workspace(workspace_root: Path, workspace_id: str, relative_path: str) -> Path:
    base = (workspace_root / workspace_id).resolve()
    candidate = (base / relative_path.lstrip("/")).resolve()
    if base not in candidate.parents and candidate != base:
        raise ValueError("Path must remain inside the workspace")
    return candidate


def _doc_id_for_file(workspace_id: str, relative_path: str) -> str:
    return compute_mdhash_id(f"{workspace_id}:{relative_path}", prefix="doc-")


async def _embed_gemini(
    texts: list[str],
    *,
    model: str,
    api_key: str | None,
    output_dimensionality: int,
) -> np.ndarray:
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("google-genai is required for Gemini embeddings") from exc

    key = gemini_key_for_embeddings(api_key)
    if not key:
        raise RuntimeError("Missing GEMINI_API_KEY/GOOGLE_API_KEY for embeddings")

    client = genai.Client(api_key=key)

    def _call() -> np.ndarray:
        config = types.EmbedContentConfig(output_dimensionality=output_dimensionality)
        response = client.models.embed_content(model=model, contents=list(texts), config=config)
        vectors = [list(emb.values) for emb in getattr(response, "embeddings", [])]
        return np.array(vectors, dtype=np.float32)

    return await asyncio.to_thread(_call)


async def _embed_local(texts: list[str], *, embedding_dim: int) -> np.ndarray:
    """Deterministic local embedding for dev/test when Gemini creds aren't available."""

    def _vectorize(text: str) -> np.ndarray:
        vec = np.zeros((embedding_dim,), dtype=np.float32)
        for token in re.findall(r"[a-zA-Z0-9_]{2,}", (text or "").lower()):
            digest = hashlib.md5(token.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % embedding_dim
            vec[idx] += 1.0
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec /= norm
        return vec

    return np.stack([_vectorize(t) for t in texts], axis=0)


def _build_llm_func(config: RagConfig):
    if config.offline:
        async def _noop_llm(*_args: Any, **_kwargs: Any) -> str:
            return ""

        return _noop_llm

    from lightrag.llm.gemini import gemini_complete_if_cache

    async def llm(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list[dict[str, Any]] | None = None,
        keyword_extraction: bool = False,
        **kwargs: Any,
    ) -> str:
        return await gemini_complete_if_cache(
            config.llm_model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            api_key=config.gemini_api_key,
            base_url=config.gemini_base_url,
            keyword_extraction=keyword_extraction,
            **kwargs,
        )

    return llm


def _read_pdf_text(path: Path, max_chars: int) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("PDF ingestion requires pypdf") from exc

    reader = PdfReader(str(path))
    parts: list[str] = []
    for idx, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if text.strip():
            parts.append(f"[Page {idx + 1}]\n{text}".strip())
        if sum(len(p) for p in parts) > max_chars:
            break
    joined = "\n\n".join(parts).strip()
    if len(joined) > max_chars:
        return joined[:max_chars] + "\n\n[Truncated]"
    return joined


def _read_text(path: Path, max_chars: int) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) > max_chars:
        return text[:max_chars] + "\n\n[Truncated]"
    return text


class WorkspaceRagStore:
    """Caches a LightRAG instance per workspace id."""

    def __init__(self, workspace_root: Path, config: RagConfig):
        self.workspace_root = workspace_root.resolve()
        self.config = config
        self._cache: Dict[str, LightRAG] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    async def _get_rag(self, workspace_id: str) -> LightRAG:
        if LightRAG is None:  # pragma: no cover - guarded by optional dependency
            raise RuntimeError("LightRAG is not installed; RAG tools are unavailable in this environment")
        if workspace_id in self._cache:
            return self._cache[workspace_id]

        lock = self._locks.get(workspace_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[workspace_id] = lock

        async with lock:
            if workspace_id in self._cache:
                return self._cache[workspace_id]

            self.config.working_dir.mkdir(parents=True, exist_ok=True)
            if self.config.offline:
                embedding_func = EmbeddingFunc(
                    embedding_dim=self.config.embedding_dim,
                    func=lambda texts: _embed_local(texts, embedding_dim=self.config.embedding_dim),
                )
            else:
                embedding_func = EmbeddingFunc(
                    embedding_dim=self.config.embedding_dim,
                    func=lambda texts: _embed_gemini(
                        texts,
                        model=self.config.embedding_model,
                        api_key=self.config.gemini_api_key,
                        output_dimensionality=self.config.embedding_dim,
                    ),
                )

            rag = LightRAG(
                working_dir=str(self.config.working_dir),
                workspace=workspace_id,
                llm_model_func=_build_llm_func(self.config),
                llm_model_name=self.config.llm_model,
                embedding_func=embedding_func,
            )
            await rag.initialize_storages()
            await rag.check_and_migrate_data()
            try:
                from lightrag.kg.shared_storage import initialize_pipeline_status  # type: ignore

                await initialize_pipeline_status()
            except Exception:
                logger.exception("Failed to initialize LightRAG pipeline status")

            self._cache[workspace_id] = rag
            return rag

    async def ingest_file(self, workspace_id: str, relative_path: str) -> str:
        path = _safe_join_workspace(self.workspace_root, workspace_id, relative_path)
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"File not found: {relative_path}")

        stat = path.stat()
        if stat.st_size > self.config.max_file_bytes:
            raise ValueError(f"File too large to index ({stat.st_size} bytes): {relative_path}")

        suffix = path.suffix.lower()
        if suffix not in RAG_INDEXABLE_SUFFIXES:
            logger.info("Skipping file for RAG indexing (unsupported type): %s", relative_path)
            return "Skipped unsupported file type."
        if suffix == ".md":
            text = _read_text(path, self.config.max_text_chars).strip()
        elif suffix in {".pdf", ".doc", ".docx"}:
            if suffix == ".pdf":
                text = _read_pdf_text(path, self.config.max_text_chars).strip()
            else:
                logger.info(
                    "Skipping raw Office document for direct RAG indexing; derived markdown artifacts are indexed instead: %s",
                    relative_path,
                )
                return "Skipped unsupported file type."
        else:
            logger.info("Skipping non-text file for RAG indexing: %s", relative_path)
            return "Skipped unsupported file type."

        if not text:
            return "Skipped empty content."

        doc_id = _doc_id_for_file(workspace_id, relative_path)
        rag = await self._get_rag(workspace_id)
        payload = f"SOURCE: /{relative_path.lstrip('/')}\n\n{text}"
        await rag.ainsert(payload, ids=doc_id, file_paths="/" + relative_path.lstrip("/"))
        return doc_id

    async def get_doc_status(self, workspace_id: str, relative_path: str) -> Dict[str, Any] | None:
        suffix = Path(relative_path).suffix.lower()
        if suffix not in RAG_INDEXABLE_SUFFIXES:
            return None
        rag = await self._get_rag(workspace_id)
        doc_id = compute_mdhash_id(f"{workspace_id}:{relative_path}", prefix="doc-")
        return await rag.doc_status.get_by_id(doc_id)

    async def query(
        self,
        workspace_id: str,
        query: str,
        *,
        mode: str = "local",
        only_need_context: bool = True,
        include_references: bool = False,
    ) -> str:
        rag = await self._get_rag(workspace_id)
        query_param_kwargs: Dict[str, Any] = {
            "mode": mode,
            "only_need_context": only_need_context,
            "include_references": include_references,
            "hl_keywords": [query],
            "ll_keywords": [query],
            "stream": False,
            "enable_rerank": self.config.enable_rerank,
        }
        try:
            param = QueryParam(**query_param_kwargs)
        except TypeError:
            query_param_kwargs.pop("enable_rerank", None)
            param = QueryParam(**query_param_kwargs)
        result = await rag.aquery(query, param=param)
        if result is None:
            return ""
        if isinstance(result, str):
            return result
        # Streaming iterator: join for API response.
        return "".join(list(result))

    async def query_data(
        self,
        workspace_id: str,
        query: str,
        *,
        mode: str = "local",
        include_references: bool = False,
        hl_keywords: Optional[list[str]] = None,
        ll_keywords: Optional[list[str]] = None,
    ) -> Dict[str, Any]:
        rag = await self._get_rag(workspace_id)
        param = QueryParam(
            mode=mode,
            only_need_context=True,
            include_references=include_references,
            hl_keywords=hl_keywords or [],
            ll_keywords=ll_keywords or [],
            stream=False,
        )
        return await rag.aquery_data(query, param=param)

    async def delete_file(self, workspace_id: str, relative_path: str, *, delete_llm_cache: bool = False) -> dict[str, Any]:
        rag = await self._get_rag(workspace_id)
        doc_id = _doc_id_for_file(workspace_id, relative_path)
        result = await rag.adelete_by_doc_id(doc_id, delete_llm_cache=delete_llm_cache)
        if hasattr(result, "__dict__"):
            return result.__dict__
        return dict(result)

    async def delete_workspace(self, workspace_id: str, *, delete_llm_cache: bool = False) -> int:
        rag = await self._get_rag(workspace_id)
        deleted = 0
        while True:
            docs, _total = await rag.doc_status.get_docs_paginated(page=1, page_size=200)
            if not docs:
                break
            deleted_in_batch = 0
            for doc_id, _doc_status in docs:
                result = await rag.adelete_by_doc_id(doc_id, delete_llm_cache=delete_llm_cache)
                if getattr(result, "status", "") == "success":
                    deleted += 1
                    deleted_in_batch += 1
            if deleted_in_batch == 0:
                break
        return deleted
