"""Citation redirect resolution: dedup, concurrency, and the wall-clock deadline.

Resolving grounding citations one at a time accounted for ~90% of google_search's
wall clock (68-84 sequential round trips per search). These tests pin the batch
contract that replaced it. No network: the per-URL worker is patched.
"""
from __future__ import annotations

import threading
import time

from helpudoc_agent import utils
from helpudoc_agent.tools.workspace.web_sources import verified_google_search_sources

REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/"


def _grounded(*urls: str):
    class Msg:
        response_metadata = {
            "grounding_metadata": {
                "groundingChunks": [{"web": {"uri": u, "title": "t"}} for u in urls]
            }
        }
        content_blocks = []

    return Msg()


def test_duplicate_urls_are_resolved_once(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(utils, "_resolve_vertex_redirect", lambda u: (calls.append(u), u + "#r")[1])

    url = f"{REDIRECT}AAA"
    resolved = utils.resolve_vertex_redirects([url, url, url])

    assert calls == [url], "each distinct URL must cost exactly one round trip"
    assert resolved[url] == url + "#r"


def test_non_redirect_urls_never_hit_the_network(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(utils, "_resolve_vertex_redirect", lambda u: (calls.append(u), u)[1])

    resolved = utils.resolve_vertex_redirects(["https://example.com/a", "", None])

    assert calls == []
    assert resolved == {}


def test_resolution_runs_concurrently(monkeypatch):
    """8 URLs each sleeping 0.2s must finish well inside the sequential 1.6s."""
    monkeypatch.setattr(utils, "_resolve_vertex_redirect", lambda u: (time.sleep(0.2), u + "#r")[1])

    urls = [f"{REDIRECT}{i}" for i in range(8)]
    started = time.monotonic()
    resolved = utils.resolve_vertex_redirects(urls, deadline_s=5, max_workers=8)
    elapsed = time.monotonic() - started

    assert len(resolved) == 8
    assert all(v.endswith("#r") for v in resolved.values())
    assert elapsed < 1.0, f"expected concurrent execution, took {elapsed:.2f}s"


def test_deadline_falls_back_to_the_raw_url(monkeypatch):
    """A hung host must not extend the tool; the redirect URL is still usable."""
    release = threading.Event()
    monkeypatch.setattr(
        utils, "_resolve_vertex_redirect", lambda u: (release.wait(30), u + "#r")[1]
    )

    urls = [f"{REDIRECT}{i}" for i in range(4)]
    started = time.monotonic()
    try:
        resolved = utils.resolve_vertex_redirects(urls, deadline_s=0.3, max_workers=4)
        elapsed = time.monotonic() - started

        assert elapsed < 3.0, f"deadline not enforced, took {elapsed:.2f}s"
        assert resolved == {u: u for u in urls}, "unresolved URLs map to themselves"
    finally:
        release.set()


def test_extract_web_url_performs_no_network_io(monkeypatch):
    def explode(_url):
        raise AssertionError("extract_web_url must not resolve redirects")

    monkeypatch.setattr(utils, "_resolve_vertex_redirect", explode)

    assert utils.extract_web_url({"uri": f"{REDIRECT}AAA"}) == f"{REDIRECT}AAA"


def test_search_sources_are_resolved_and_deduplicated(monkeypatch):
    """Two chunks pointing at one publisher collapse to a single source."""
    calls: list[str] = []

    def fake(url):
        calls.append(url)
        return "https://publisher.example/article"

    monkeypatch.setattr(utils, "_resolve_vertex_redirect", fake)

    sources = verified_google_search_sources(_grounded(f"{REDIRECT}AAA", f"{REDIRECT}BBB"))

    assert len(calls) == 2, "distinct redirect URLs each need resolving"
    assert [s["url"] for s in sources] == ["https://publisher.example/article"]
