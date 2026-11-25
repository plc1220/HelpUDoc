"""Source discovery and selected-page reading through self-hosted HTTP services."""
from __future__ import annotations

import ipaddress
import json
import socket
from urllib.parse import urlsplit

import httpx
from langchain_core.tools import tool

from ...configuration import WebSearchConfig
from ...state import WorkspaceState
from ...utils import SourceTracker
from .policy import apply_search_policy_guard


def _error(name: str, code: str, message: str, *, retryable: bool = False, **details) -> str:
    return json.dumps({"status": "error", "tool": name, "errorCode": code,
                       "message": message, "retryable": retryable, **details})


def _results(endpoint: str, **request) -> dict:
    with httpx.stream("POST", endpoint, timeout=20, follow_redirects=False, **request) as response:
        response.raise_for_status()
        body = bytearray()
        for chunk in response.iter_bytes(chunk_size=65536):
            body.extend(chunk)
            if len(body) > 2_000_000:
                raise ValueError("Oversized response")
    payload = json.loads(body)
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("Invalid response")
    return payload


def _upstream_error(name: str, exc: Exception) -> str:
    code = "SEARCH_TIMEOUT" if isinstance(exc, httpx.TimeoutException) else "SEARCH_FAILED"
    return _error(name, code, "The web service could not return usable results.", retryable=True)


def _web_hostname(url: object) -> str | None:
    if not isinstance(url, str) or len(url) > 4096 or "\\" in url:
        return None
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or parsed.username is not None or not parsed.hostname:
            return None
        if parsed.port not in {None, 80, 443}:
            return None
        return parsed.hostname.rstrip(".")
    except ValueError:
        return None


def _public_url(url: str) -> bool:
    host = _web_hostname(url)
    if not host or host.endswith((".local", ".localhost", ".internal")) or ("." not in host and ":" not in host):
        return False
    # The fetch service must also restrict its own egress, including redirects
    # and DNS changes between this check and its connection.
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            records = socket.getaddrinfo(host + ".", None, type=socket.SOCK_STREAM)
            addresses = [ipaddress.ip_address(record[4][0]) for record in records]
        except (OSError, ValueError, UnicodeError):
            return False
    else:
        addresses = [address]
    return bool(addresses) and all(ip.is_global and not ip.is_multicast for ip in addresses)


def _text(value: object, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _search_hits(payload: dict, limit: int) -> list[dict[str, str]]:
    hits = []
    seen = set()
    for item in payload["results"]:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        snippet = _text(item.get("content"), 1000)
        if not snippet or not _web_hostname(url) or url in seen:
            continue
        hits.append({"url": url, "title": _text(item.get("title"), 250), "snippet": snippet})
        seen.add(url)
        if len(hits) >= limit:
            break
    return hits


def build_oss_search_tool(workspace: WorkspaceState, config: WebSearchConfig):
    endpoint = str(config.base_url).rstrip("/") + "/search"

    @tool
    def web_search(query: str, max_results: int = 5) -> str:
        """Discover public sources. Read selected results with url_context when page evidence is needed."""
        blocked = apply_search_policy_guard(workspace, "web_search")
        if blocked:
            return blocked
        query = query.strip()
        if not 1 <= len(query) <= 1024:
            return _error("web_search", "INVALID_QUERY", "Supply a query of 1 to 1024 characters.", retryable=True)
        limit = min(10, max(1, max_results))
        try:
            if config.provider == "searxng":
                payload = _results(endpoint, data={"q": query, "format": "json"})
                unavailable = bool(payload.get("unresponsive_engines"))
            else:
                engines = ["searx"] if config.search_backend == "searxng" else ["ddg", "brave", "wikipedia"]
                payload = _results(endpoint, json={"query": query, "engines": engines,
                                                   "search_depth": "basic", "max_results": limit})
                reports = payload.get("engines") or []
                unavailable = bool(reports) and all(isinstance(x, dict) and x.get("ok") is False for x in reports)
            hits = _search_hits(payload, limit)
        except (httpx.HTTPError, ValueError) as exc:
            return _upstream_error("web_search", exc)
        if not hits and unavailable:
            return _error("web_search", "SEARCH_FAILED", "Search engines returned no usable results.", retryable=True)
        if hits:
            workspace.context["web_search_returned_snippets"] = True
        return json.dumps({"status": "ok", "evidence": "search_snippets", "results": hits}, ensure_ascii=False)

    return web_search


def build_oss_url_context_tool(workspace: WorkspaceState, config: WebSearchConfig, tracker: SourceTracker):
    endpoint = str(config.base_url).rstrip("/") + "/extract"

    @tool
    def url_context(urls: list[str], question: str = "") -> str:
        """Read up to five pasted or selected public URLs. Use the returned page text to answer the question."""
        blocked = apply_search_policy_guard(workspace, "url_context")
        if blocked:
            return blocked
        requested = list(dict.fromkeys(url.strip() for url in urls))
        if not 1 <= len(requested) <= 5 or not all(_public_url(url) for url in requested):
            return _error("url_context", "INVALID_URL", "Supply one to five publicly reachable HTTP(S) URLs.")
        try:
            payload = _results(endpoint, json={"urls": requested, "timeout_ms": 8000})
        except (httpx.HTTPError, ValueError) as exc:
            return _upstream_error("url_context", exc)

        pages = {}
        for item in payload["results"]:
            if not isinstance(item, dict) or item.get("status") != "ok":
                continue
            url = item.get("url")
            if url not in requested:
                continue
            passage = _text(item.get("raw_content"), 6000)
            if passage:
                pages[url] = {"url": url, "title": _text(item.get("title"), 250) or url, "text": passage}
        failed = [url for url in requested if url not in pages]
        if not pages:
            return _error("url_context", "NO_PAGE_CONTENT", "No requested page returned readable text.", failed_urls=failed)
        sources = [pages[url] for url in requested if url in pages]
        tracker.record(workspace, sources)
        workspace.context["web_search_source_count"] = workspace.context.get("web_search_source_count", 0) + len(sources)
        return json.dumps({"status": "ok", "evidence": "page_text", "results": sources, "failed_urls": failed},
                          ensure_ascii=False)

    return url_context
