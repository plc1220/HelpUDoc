"""Agentic navigation over published Open Knowledge Format bundles."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List

from langchain_core.tools import Tool, tool

from ....state import WorkspaceState
from .workspace_files import _display_path, _workspace_root


_KNOWLEDGE_ROOT = Path(".system/knowledge")
_MAX_RESULTS = 50
_MAX_READ_CHARS = 50000


def _knowledge_root(workspace_state: WorkspaceState) -> Path:
    return (_workspace_root(workspace_state) / _KNOWLEDGE_ROOT).resolve()


def _resolve_knowledge_path(root: Path, raw_path: str) -> Path:
    cleaned = str(raw_path or "").strip().replace("\\", "/").lstrip("/")
    if cleaned.startswith(".system/knowledge/"):
        cleaned = cleaned[len(".system/knowledge/") :]
    candidate = (root / cleaned).resolve()
    if root not in candidate.parents and candidate != root:
        raise ValueError("Knowledge path must remain inside the published knowledge root")
    if candidate.is_dir():
        candidate = candidate / "index.md"
    if not candidate.suffix:
        candidate = candidate / "index.md"
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"Published knowledge path not found: {raw_path}")
    if candidate.suffix.lower() != ".md":
        raise ValueError("Published knowledge documents must be Markdown")
    return candidate


def _title_from_markdown(path: Path, text: str) -> str:
    frontmatter_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, flags=re.DOTALL)
    if frontmatter_match:
        title_match = re.search(r"(?m)^title:\s*[\"']?(.*?)[\"']?\s*$", frontmatter_match.group(1))
        if title_match and title_match.group(1).strip():
            return title_match.group(1).strip()
    heading_match = re.search(r"(?m)^#\s+(.+)$", text)
    return heading_match.group(1).strip() if heading_match else path.stem


def _snippet(text: str, query: str, limit: int = 450) -> str:
    body = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, flags=re.DOTALL)
    compact = re.sub(r"\s+", " ", body).strip()
    if len(compact) <= limit:
        return compact
    index = compact.lower().find(query.lower()) if query else 0
    if index < 0:
        index = 0
    start = max(0, index - limit // 3)
    end = min(len(compact), start + limit)
    return f"{'…' if start else ''}{compact[start:end].strip()}{'…' if end < len(compact) else ''}"


def _matching_line(text: str, query: str, tokens: list[str]) -> int:
    lowered_query = query.lower()
    for line_number, line in enumerate(text.splitlines(), start=1):
        lowered = line.lower()
        if lowered_query and lowered_query in lowered:
            return line_number
        if tokens and all(token in lowered for token in tokens):
            return line_number
    if tokens:
        for line_number, line in enumerate(text.splitlines(), start=1):
            lowered = line.lower()
            if any(token in lowered for token in tokens):
                return line_number
    return 1


def build_knowledge_search_tool(workspace_state: WorkspaceState) -> Tool:
    root = _knowledge_root(workspace_state)
    workspace_root = _workspace_root(workspace_state)

    @tool
    def knowledge_search(query: str = "", max_results: int = 20) -> str:
        """List or search published OKF concepts in the current workspace."""
        if not root.exists():
            return json.dumps(
                {
                    "query": query,
                    "resultCount": 0,
                    "results": [],
                    "message": "No published knowledge bundles are available in this workspace.",
                }
            )
        phrase = str(query or "").strip().lower()
        tokens = [token for token in re.findall(r"[\w.-]+", phrase) if len(token) > 1]
        limit = max(1, min(int(max_results or 20), _MAX_RESULTS))
        results = []
        paths = sorted(root.rglob("index.md")) if not phrase else sorted(root.rglob("*.md"))
        for path in paths:
            if path.name == "log.md":
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            haystack = f"{path.as_posix()}\n{text}".lower()
            if phrase and phrase not in haystack and not all(token in haystack for token in tokens):
                continue
            results.append(
                {
                    "path": _display_path(workspace_root, path),
                    "title": _title_from_markdown(path, text),
                    "line": _matching_line(text, phrase, tokens) if phrase else 1,
                    "snippet": _snippet(text, phrase),
                }
            )
            if len(results) >= limit:
                break
        return json.dumps(
            {
                "query": query,
                "resultCount": len(results),
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        )

    knowledge_search.name = "knowledge_search"
    knowledge_search.description = (
        "List published OKF knowledge bundles or search their Markdown concepts. "
        "Use this for @knowledge context before opening individual concepts."
    )
    return knowledge_search


def build_knowledge_read_tool(workspace_state: WorkspaceState) -> Tool:
    root = _knowledge_root(workspace_state)
    workspace_root = _workspace_root(workspace_state)

    @tool
    def knowledge_read(
        path: str,
        start_line: int = 1,
        end_line: int = 400,
        max_chars: int = 30000,
    ) -> str:
        """Read a bounded line range from one published OKF index or concept."""
        try:
            candidate = _resolve_knowledge_path(root, path)
            full_text = candidate.read_text(encoding="utf-8", errors="replace")
            lines = full_text.splitlines()
            start = max(1, int(start_line or 1))
            end = min(len(lines), max(start, int(end_line or start + 399)))
            text = "\n".join(lines[start - 1 : end])
            limit = max(1000, min(int(max_chars or 30000), _MAX_READ_CHARS))
            truncated = len(text) > limit
            if truncated:
                text = text[:limit].rstrip() + "\n\n[Knowledge document truncated]"
            return json.dumps(
                {
                    "path": _display_path(workspace_root, candidate),
                    "title": _title_from_markdown(candidate, full_text),
                    "lineCount": len(lines),
                    "selectedLines": [start, end],
                    "content": text,
                    "truncated": truncated,
                },
                ensure_ascii=False,
                indent=2,
            )
        except Exception as exc:
            return f"Knowledge read failed: {exc}"

    knowledge_read.name = "knowledge_read"
    knowledge_read.description = (
        "Read a bounded line range from a published OKF index or concept returned by "
        "knowledge_search. Use the search result's line location for long concepts and "
        "follow Markdown links progressively instead of loading the whole bundle."
    )
    return knowledge_read


def build_knowledge_navigation_tools(workspace_state: WorkspaceState) -> List[Tool]:
    return [
        build_knowledge_search_tool(workspace_state),
        build_knowledge_read_tool(workspace_state),
    ]
