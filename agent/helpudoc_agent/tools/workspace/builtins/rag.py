"""LightRAG workspace query tool."""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from langchain_core.tools import Tool, tool

from ....configuration import Settings
from ....rag_indexer import RagConfig, WorkspaceRagStore
from ....state import WorkspaceState
from ....tagged_file_policy import is_tagged_files_only


def _read_text_truncated(path: Path, max_chars: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"[Error reading file: {exc}]"
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + "\n\n[Truncated]"
    return text


def build_rag_query_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    rag_cfg = RagConfig.from_env(settings.backend.workspace_root)
    rag_store = WorkspaceRagStore(settings.backend.workspace_root, rag_cfg)

    def _normalize_file_paths(paths: List[str]) -> List[str]:
        normalized: List[str] = []
        for raw in paths:
            if not raw:
                continue
            cleaned = str(raw).strip().replace("\\", "/")
            if not cleaned:
                continue
            lowered = cleaned.lower()
            if "tagged files" in lowered:
                continue
            if cleaned.startswith(("-", "*", "•")):
                cleaned = cleaned.lstrip("-*•").strip()
            if cleaned.startswith(":"):
                cleaned = cleaned.lstrip(":").strip()
            if cleaned.startswith(("'", '"')) and cleaned.endswith(("'", '"')):
                cleaned = cleaned[1:-1].strip()
            if not cleaned.startswith("/"):
                cleaned = f"/{cleaned.lstrip('/')}"
            normalized.append(cleaned)
        return sorted(set(normalized))

    def _allow_basename_match(path_value: str) -> bool:
        normalized = str(path_value or "").strip().replace("\\", "/").lstrip("/")
        if not normalized:
            return False
        if normalized.startswith(".system/"):
            return False
        return "/" not in normalized

    async def _query_chunks(
        query: str,
        mode: str,
        *,
        include_references: bool,
        keywords: List[str],
    ) -> list:
        response = await rag_store.query_data(
            workspace_state.workspace_id,
            query,
            mode=mode,
            include_references=include_references,
            hl_keywords=keywords,
            ll_keywords=keywords,
        )
        data = response.get("data") if isinstance(response, dict) else None
        return data.get("chunks", []) if isinstance(data, dict) else []

    @tool
    async def rag_query(
        query: str,
        file_paths: Optional[List[str]] = None,
        mode: str = "naive",
        include_references: bool = False,
    ) -> str:
        """Retrieve context from LightRAG, optionally restricted to specific file paths."""
        if not query or not query.strip():
            raise ValueError("Query is required")
        effective_paths = file_paths or workspace_state.context.get("tagged_files") or []
        normalized = _normalize_file_paths(effective_paths)
        if normalized and mode != "hybrid":
            mode = "hybrid"
        cached_context = workspace_state.context.get("tagged_rag_context")
        if cached_context and is_tagged_files_only(workspace_state.context):
            return str(cached_context)

        keywords: List[str] = [query.strip()]
        if normalized:
            keywords.extend(normalized)
            keywords.extend([Path(item).name for item in normalized if item])

        chunks = await _query_chunks(query, mode, include_references=include_references, keywords=keywords)
        if not chunks and mode != "naive":
            chunks = await _query_chunks(query, "naive", include_references=include_references, keywords=keywords)
        if not chunks and mode != "hybrid":
            chunks = await _query_chunks(query, "hybrid", include_references=include_references, keywords=keywords)

        if normalized:
            normalized_basenames = {Path(item).name for item in normalized if _allow_basename_match(item)}
            filtered = []
            for chunk in chunks:
                file_path = chunk.get("file_path") or ""
                if file_path in normalized:
                    filtered.append(chunk)
                    continue
                if Path(file_path).name in normalized_basenames:
                    filtered.append(chunk)
            chunks = filtered

        if not chunks:
            if normalized:
                workspace_root = workspace_state.root_path.resolve()
                max_chars = int(getattr(rag_cfg, "max_text_chars", 250000) or 250000)
                max_chars = min(max_chars, 40000)
                supported_text_suffixes = {
                    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv",
                    ".ts", ".tsx", ".js", ".jsx", ".py", ".sql",
                }
                parts: List[str] = []
                for rel in normalized:
                    rel_clean = rel.lstrip("/")
                    candidate = (workspace_root / rel_clean).resolve()
                    if workspace_root not in candidate.parents and candidate != workspace_root:
                        continue
                    if not candidate.exists() or not candidate.is_file():
                        parts.append(f"[{rel}] [File not found on disk]")
                        continue
                    if candidate.suffix.lower() not in supported_text_suffixes:
                        parts.append(
                            f"[{rel}] [Not indexed and not a supported text file type for fallback: {candidate.suffix}]"
                        )
                        continue
                    parts.append(f"[{rel}] {_read_text_truncated(candidate, max_chars)}")
                if parts:
                    return "\n\n".join(parts)
            return (
                "No relevant context found for the requested file(s)."
                if normalized
                else "No relevant context found."
            )

        lines: List[str] = []
        for chunk in chunks:
            content = chunk.get("content") or ""
            if not content:
                continue
            file_path = chunk.get("file_path") or "unknown_source"
            lines.append(f"[{file_path}] {content}")
        return "\n\n".join(lines) if lines else "No relevant context found."

    rag_query.name = "rag_query"
    rag_query.description = (
        "Retrieve workspace context from LightRAG. "
        "Use file_paths to restrict results to specific tagged files."
    )
    return rag_query
