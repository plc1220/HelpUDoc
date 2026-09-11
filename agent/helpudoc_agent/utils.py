"""Shared utilities for the agent service."""
from __future__ import annotations

import concurrent.futures
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

from .state import WorkspaceState

logger = logging.getLogger(__name__)

_VERTEX_SEARCH_HOST = "vertexaisearch.cloud.google.com"
# (connect, read). Applies per redirect hop, not to the whole chain, which is why
# the batch below also enforces a wall-clock deadline across every URL.
_REQUEST_TIMEOUT = (3, 3)


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return max(minimum, int(str(raw).strip()))
    except ValueError:
        logger.warning("Invalid int for %s=%r; using default=%s", name, raw, default)
        return default


# One grounded search can carry 80+ citation chunks. Resolving them one at a time
# cost 90% of the tool's wall clock, so the batch is concurrent and time-boxed:
# an unresolved redirect URL still works in a browser, a 90s search does not.
REDIRECT_DEADLINE_SECONDS = _env_int("GOOGLE_SEARCH_REDIRECT_DEADLINE_SECONDS", 8)
REDIRECT_MAX_WORKERS = _env_int("GOOGLE_SEARCH_REDIRECT_MAX_WORKERS", 16)

_session_local = threading.local()


def _redirect_session() -> Any:
    """One requests.Session per worker thread, so connections are pooled and reused."""
    session = getattr(_session_local, "session", None)
    if session is None:
        session = requests.Session()
        _session_local.session = session
    return session


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
    """Follow one Vertex grounding redirect to the publisher URL.

    HEAD only. The previous GET fallback doubled the cost of every unreachable
    host — two expired timeouts instead of one — and almost never succeeded where
    HEAD had already failed, so it is not worth the second deadline.
    """
    if not url or requests is None or _VERTEX_SEARCH_HOST not in url:
        return url
    try:
        response = _redirect_session().head(url, allow_redirects=True, timeout=_REQUEST_TIMEOUT)
        return response.url or url
    except Exception:  # pragma: no cover - best effort; the raw URL still resolves in a browser
        return url


def resolve_vertex_redirects(
    urls: Iterable[str],
    *,
    deadline_s: float | None = None,
    max_workers: int | None = None,
) -> Dict[str, str]:
    """Resolve many grounding redirects concurrently, bounded by one wall-clock deadline.

    Returns a raw-URL -> resolved-URL map. URLs that fail or do not finish inside
    the deadline map to themselves, so callers degrade to the redirect link rather
    than blocking. Deduplicates first: the same URL appears across many citation
    chunks and each duplicate used to pay for its own round trip.
    """
    pending = [u for u in dict.fromkeys(urls) if u and _VERTEX_SEARCH_HOST in u]
    resolved: Dict[str, str] = {}
    if not pending or requests is None:
        return resolved

    deadline = float(deadline_s if deadline_s is not None else REDIRECT_DEADLINE_SECONDS)
    workers = max(1, min(max_workers or REDIRECT_MAX_WORKERS, len(pending)))
    started = time.monotonic()
    timed_out = 0
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    try:
        futures = {executor.submit(_resolve_vertex_redirect, url): url for url in pending}
        done, not_done = concurrent.futures.wait(futures, timeout=deadline)
        timed_out = len(not_done)
        for future in done:
            url = futures[future]
            try:
                resolved[url] = future.result() or url
            except Exception:  # pragma: no cover - worker already swallows failures
                resolved[url] = url
        for future in not_done:
            resolved[futures[future]] = futures[future]
    finally:
        # Never block the tool waiting on stragglers; their sockets time out on their own.
        executor.shutdown(wait=False, cancel_futures=True)

    changed = sum(1 for raw, final in resolved.items() if raw != final)
    logger.info(
        "resolved %s/%s grounding redirects in %.2fs (deadline=%ss workers=%s timed_out=%s)",
        changed,
        len(pending),
        time.monotonic() - started,
        deadline,
        workers,
        timed_out,
    )
    return resolved


def extract_web_url(web_chunk: Any) -> str | None:
    """Return the raw citation URL for a grounding chunk. Performs no network I/O.

    Resolution is deliberately separate: callers collect every raw URL first, then
    resolve the whole batch through `resolve_vertex_redirects`.
    """
    if isinstance(web_chunk, dict):
        for key in ("resolvedUri", "displayUri", "uri", "resolved_uri", "display_uri"):
            url = web_chunk.get(key)
            if isinstance(url, str) and url.strip():
                return url.strip()
        return None
    for attr in ("resolved_uri", "display_uri", "uri"):
        url = getattr(web_chunk, attr, None)
        if isinstance(url, str) and url.strip():
            return url.strip()
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
