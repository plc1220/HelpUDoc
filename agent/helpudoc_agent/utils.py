"""Shared utilities for the agent service."""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Dict, List, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

from .state import WorkspaceState


_VERTEX_SEARCH_HOST = "vertexaisearch.cloud.google.com"
_REQUEST_TIMEOUT = 3


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
    if isinstance(web_chunk, dict):
        for key in ("resolvedUri", "displayUri", "uri", "resolved_uri", "display_uri"):
            url = web_chunk.get(key)
            if isinstance(url, str) and url.strip():
                return _resolve_vertex_redirect(url.strip())
        return None
    candidate_attrs = ("resolved_uri", "display_uri", "uri")
    for attr in candidate_attrs:
        url = getattr(web_chunk, attr, None)
        if isinstance(url, str) and url.strip():
            return _resolve_vertex_redirect(url.strip())
    return None


class SourceTracker:
    """Tracks verified web sources per workspace.

    The agent owns all report formatting; this tracker only records which
    sources were actually grounded so the research source contract can verify
    that a run collected real evidence.
    """

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
