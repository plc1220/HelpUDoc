"""Agentic navigation over published Open Knowledge Format bundles."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import List, Optional

from langchain_core.tools import Tool, tool

from ....state import WorkspaceState
from .workspace_files import _display_path, _workspace_root


_KNOWLEDGE_ROOT = Path(".system/knowledge")
_MAX_RESULTS = 50
_MAX_READ_CHARS = 50000
_MAX_GRAPH_HOPS = 2


def _knowledge_root(workspace_state: WorkspaceState) -> Path:
    return (_workspace_root(workspace_state) / _KNOWLEDGE_ROOT).resolve()


def _published_bundle_roots(root: Path) -> list[tuple[Path, str | None]]:
    """Resolve only atomically selected bundles, with legacy-layout fallback."""
    bundles: list[tuple[Path, str | None]] = []
    if not root.exists():
        return bundles
    for knowledge_dir in sorted((item for item in root.iterdir() if item.is_dir()), key=lambda item: item.name):
        pointer = knowledge_dir / "current.json"
        if pointer.is_file():
            try:
                payload = json.loads(pointer.read_text(encoding="utf-8"))
                raw_path = str(payload.get("bundlePath") or "").replace("\\", "/").lstrip("/")
                prefix = ".system/knowledge/"
                if raw_path.startswith(prefix):
                    raw_path = raw_path[len(prefix):]
                candidate = (root / raw_path).resolve()
                if root in candidate.parents and candidate.is_dir():
                    bundles.append((candidate, str(payload.get("snapshotHash") or "") or None))
                    continue
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
        if (knowledge_dir / "index.md").is_file():
            bundles.append((knowledge_dir.resolve(), None))
    return bundles


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
    if not any(bundle == candidate.parent or bundle in candidate.parents for bundle, _ in _published_bundle_roots(root)):
        raise ValueError("Knowledge path is not part of the currently published bundle")
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


def _query_tokens(value: str) -> list[str]:
    lowered = value.lower()
    words = [token for token in re.findall(r"[\w.-]+", lowered) if len(token) > 1]
    cjk_runs = re.findall(r"[\u3400-\u9fff\uf900-\ufaff]+", lowered)
    cjk_tokens = [run[index:index + 2] for run in cjk_runs for index in range(max(1, len(run) - 1))]
    return list(dict.fromkeys([*words, *cjk_tokens]))


def _lexical_score(path: Path, title: str, text: str, phrase: str, tokens: list[str]) -> tuple[float, list[str]]:
    if not phrase:
        return 1.0, ["bundle-index"]
    lowered_title = title.lower()
    lowered_path = path.as_posix().lower()
    lowered_text = text.lower()
    score = 0.0
    reasons: list[str] = []
    if phrase in lowered_title:
        score += 8.0
        reasons.append("title_phrase")
    if phrase in lowered_path:
        score += 5.0
        reasons.append("path_phrase")
    if phrase in lowered_text:
        score += 4.0
        reasons.append("exact_phrase")
    matched = sum(token in lowered_text for token in tokens)
    minimum_matches = 1 if len(tokens) <= 2 else max(2, math.ceil(len(tokens) * 0.4))
    if matched >= minimum_matches:
        score += 3.0 * matched / max(1, len(tokens))
        reasons.append("lexical")
    return score, reasons


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
        tokens = _query_tokens(phrase)
        limit = max(1, min(int(max_results or 20), _MAX_RESULTS))
        results = []
        published_bundles = _published_bundle_roots(root)
        for bundle_root, snapshot_hash in published_bundles:
            concept_root = bundle_root / "concepts"
            paths = [bundle_root / "index.md"] if not phrase else (
                sorted(concept_root.rglob("*.md")) if concept_root.is_dir()
                else sorted(bundle_root.rglob("*.md"))
            )
            for path in paths:
                if path.name == "log.md" or not path.is_file():
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                title = _title_from_markdown(path, text)
                score, reasons = _lexical_score(path, title, text, phrase, tokens)
                if phrase and score <= 0:
                    continue
                results.append(
                    {
                        "path": _display_path(workspace_root, path),
                        "title": title,
                        "line": _matching_line(text, phrase, tokens) if phrase else 1,
                        "snippet": _snippet(text, phrase),
                        "score": round(score, 4),
                        "reasons": reasons,
                        "snapshotId": snapshot_hash,
                    }
                )
        results.sort(key=lambda item: (-float(item["score"]), str(item["path"])))
        if phrase and results:
            existing_paths = {str(item["path"]) for item in results}
            expanded = []
            queue = [(seed, 0) for seed in results[:5]]
            traversed_paths: set[str] = set()
            while queue and len(expanded) < limit:
                seed, hop = queue.pop(0)
                seed_display = str(seed["path"])
                if seed_display in traversed_paths or hop >= _MAX_GRAPH_HOPS:
                    continue
                traversed_paths.add(seed_display)
                try:
                    seed_path = _resolve_knowledge_path(root, seed_display)
                    seed_text = seed_path.read_text(encoding="utf-8", errors="replace")
                except (OSError, ValueError):
                    continue
                for match in re.finditer(r"\[[^\]]+\]\(([^)#?]+)(?:[?#][^)]*)?\)", seed_text):
                    raw_target = match.group(1)
                    target = (seed_path.parent / raw_target).resolve()
                    if target.name in {"index.md", "source.md", "log.md"} or not target.is_file():
                        continue
                    display = _display_path(workspace_root, target)
                    if display in existing_paths:
                        continue
                    if not any(bundle == target.parent or bundle in target.parents for bundle, _ in published_bundles):
                        continue
                    target_text = target.read_text(encoding="utf-8", errors="replace")
                    target_result = {
                        "path": display,
                        "title": _title_from_markdown(target, target_text),
                        "line": 1,
                        "snippet": _snippet(target_text, ""),
                        "score": round(float(seed["score"]) * 0.5, 4),
                        "reasons": ["graph"],
                        "snapshotId": seed.get("snapshotId"),
                        "graphHop": hop + 1,
                    }
                    expanded.append(target_result)
                    existing_paths.add(display)
                    queue.append((target_result, hop + 1))
                    if len(expanded) >= limit:
                        break
            results.extend(expanded)
            results.sort(key=lambda item: (-float(item["score"]), str(item["path"])))
        results = results[:limit]
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
            snapshot_id = next(
                (snapshot for bundle, snapshot in _published_bundle_roots(root) if bundle == candidate.parent or bundle in candidate.parents),
                None,
            )
            page_ranges = [
                {"pageStart": int(start), "pageEnd": int(end)}
                for start, end in re.findall(
                    r"(?ms)^\s*kind:\s*[\"']?pdf_page_range[\"']?.*?^\s*start:\s*(\d+).*?^\s*end:\s*(\d+)",
                    full_text,
                )
            ]
            block_locations = []
            for raw_ids in re.findall(
                r"(?ms)^\s*kind:\s*[\"']?source_blocks[\"']?.*?^\s*block_ids:\s*\[([^\]]*)\]",
                full_text,
            ):
                block_ids = re.findall(r"[\"']([^\"']+)[\"']", raw_ids)
                if block_ids:
                    block_locations.append({"kind": "source_blocks", "blockIds": block_ids})
            return json.dumps(
                {
                    "path": _display_path(workspace_root, candidate),
                    "title": _title_from_markdown(candidate, full_text),
                    "lineCount": len(lines),
                    "selectedLines": [start, end],
                    "content": text,
                    "truncated": truncated,
                    "snapshotId": snapshot_id,
                    "sourceLocations": [*page_ranges, *block_locations],
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


def build_legacy_rag_query_tool(workspace_state: WorkspaceState) -> Tool:
    """Keep persisted pre-OKF tool configurations operational during upgrades."""
    from .document_inspection import build_search_document_tool

    knowledge_search = build_knowledge_search_tool(workspace_state)
    document_search = build_search_document_tool(workspace_state)

    @tool
    def rag_query(
        query: str,
        file_paths: Optional[List[str]] = None,
        mode: str = "naive",
        include_references: bool = False,
    ) -> str:
        """Compatibility search over original files or published OKF knowledge."""
        phrase = str(query or "").strip()
        if not phrase:
            return "Query is required"
        paths = [str(item).strip() for item in (file_paths or []) if str(item).strip()]
        if not paths:
            result = knowledge_search.invoke({"query": phrase, "max_results": 20})
            try:
                payload = json.loads(str(result))
                payload["mode"] = str(mode or "hybrid")
                payload["includeReferences"] = bool(include_references)
                payload["compatibilityTool"] = "rag_query"
                return json.dumps(payload, ensure_ascii=False, indent=2)
            except (TypeError, ValueError, json.JSONDecodeError):
                return str(result)
        results = [
            {
                "file": file_path,
                "result": document_search.invoke(
                    {
                        "file_path": file_path,
                        "query": phrase,
                        "max_results": 20,
                    }
                ),
            }
            for file_path in paths[:20]
        ]
        return json.dumps(
            {
                "compatibilityTool": "rag_query",
                "query": phrase,
                "mode": str(mode or "naive"),
                "includeReferences": bool(include_references),
                "files": results,
            },
            ensure_ascii=False,
            indent=2,
        )

    rag_query.name = "rag_query"
    rag_query.description = (
        "Compatibility alias for persisted pre-OKF configurations. Search named original "
        "workspace files on demand, or search published OKF knowledge when no files are supplied."
    )
    return rag_query
