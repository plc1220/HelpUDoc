"""Shared utilities for the agent service."""
from __future__ import annotations

import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

from .state import WorkspaceState


_VERTEX_SEARCH_HOST = "vertexaisearch.cloud.google.com"
_REQUEST_TIMEOUT = 3


def resolve_urls(urls_to_resolve: Iterable[Any], id_seed: int) -> Dict[str, str]:
    """Map long Vertex search URLs to short deterministic aliases."""
    prefix = "https://vertexaisearch.cloud.google.com/id/"
    resolved: Dict[str, str] = {}
    for idx, chunk in enumerate(urls_to_resolve):
        if hasattr(chunk, "web") and getattr(chunk.web, "uri", None):
            url = chunk.web.uri
        else:
            url = getattr(chunk, "uri", None)
        if not url or url in resolved:
            continue
        resolved[url] = f"{prefix}{id_seed}-{idx}"
    return resolved


def _resolve_vertex_redirect(url: str) -> str:
    if not url or requests is None or _VERTEX_SEARCH_HOST not in url:
        return url

    session = requests.Session()
    for method in ("head", "get"):
        request_fn = getattr(session, method)
        try:
            response = request_fn(
                url,
                allow_redirects=True,
                timeout=_REQUEST_TIMEOUT,
                stream=method == "get",
            )
            final_url = response.url or url
            if method == "get":
                response.close()
            if final_url:
                return final_url
        except Exception:  # pragma: no cover - best effort
            continue
    return url


def extract_web_url(web_chunk: Any) -> str | None:
    candidate_attrs = ("resolved_uri", "display_uri", "uri")
    for attr in candidate_attrs:
        url = getattr(web_chunk, attr, None)
        if isinstance(url, str) and url.strip():
            return _resolve_vertex_redirect(url.strip())
    return None


class SourceTracker:
    """Tracks collected sources per workspace so final report can be annotated."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sources: Dict[str, "OrderedDict[str, str]"] = {}

    def record(self, workspace: WorkspaceState, sources: List[Dict[str, str]]) -> None:
        if not sources:
            return
        with self._lock:
            if workspace.workspace_id not in self._sources:
                self._sources[workspace.workspace_id] = OrderedDict()
            stored = self._sources[workspace.workspace_id]
            for src in sources:
                url = src.get("url")
                if not url or url in stored:
                    continue
                stored[url] = src.get("title", "Untitled")

    def reset(self, workspace: WorkspaceState) -> None:
        """Clear any cached sources for the given workspace."""
        with self._lock:
            self._sources.pop(workspace.workspace_id, None)

    def list_sources(self, workspace: WorkspaceState) -> List[Tuple[int, str, str]]:
        with self._lock:
            stored = self._sources.get(workspace.workspace_id)
            if not stored:
                return []
            return [
                (idx, title, url)
                for idx, (url, title) in enumerate(stored.items(), start=1)
            ]

    def update_final_report(self, workspace: WorkspaceState) -> None:
        if not workspace.final_report_path.exists():
            return
        ordered = self.list_sources(workspace)
        if not ordered:
            return

        sources_lines = ["### Sources", ""]
        for idx, title, url in ordered:
            sources_lines.append(f"[{idx}] {title}: {url}")
        sources_lines.append("")
        sources_section = "\n".join(sources_lines)

        report_text = workspace.final_report_path.read_text(encoding="utf-8")
        header = "### Sources"
        if header in report_text:
            head = report_text.split(header, 1)[0].rstrip()
        else:
            head = report_text.rstrip()

        linked_body = self._linkify_numeric_citations(head, ordered)
        new_report = f"{linked_body}\n\n{sources_section}"
        workspace.final_report_path.write_text(new_report, encoding="utf-8")

    @staticmethod
    def _linkify_numeric_citations(body: str, ordered_sources: List[Tuple[int, str, str]]) -> str:
        mapping = {
            idx: f"[{title}]({url})"
            for idx, title, url in ordered_sources
        }
        pattern = re.compile(r"\[(\d+)\]")

        def replace(match: re.Match[str]) -> str:
            idx = int(match.group(1))
            return mapping.get(idx, match.group(0))

        return pattern.sub(replace, body)
