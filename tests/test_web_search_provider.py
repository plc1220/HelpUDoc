from contextlib import contextmanager
import json

import httpx
import pytest
import yaml

from helpudoc_agent.api.routes.chat import _research_source_contract_error
from helpudoc_agent.configuration import WebSearchConfig, load_settings
from helpudoc_agent.state import AgentRuntimeState, WorkspaceState
from helpudoc_agent.tools.workspace import oss_web
from helpudoc_agent.tools.workspace.factory import ToolFactory
from helpudoc_agent.utils import SourceTracker


def private_runtime(tmp_path):
    config = {
        "inherit_defaults": False,
        "model": {"provider": "openai-compatible", "base_url": "http://models.test/v1"},
        "backend": {"workspace_root": str(tmp_path)},
        "tools": [],
    }
    path = tmp_path / "runtime.yaml"
    path.write_text(yaml.safe_dump(config))
    return path


def test_search_is_opt_in_on_existing_private_profile(tmp_path, monkeypatch):
    path = private_runtime(tmp_path)
    monkeypatch.delenv("WEB_SEARCH_PROVIDER", raising=False)
    assert "web_search" not in load_settings(path).tools
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "searxng")
    monkeypatch.delenv("SEARXNG_BASE_URL", raising=False)
    with pytest.raises(ValueError, match="SEARXNG_BASE_URL"):
        load_settings(path)


def test_private_chat_search_uses_only_the_query_and_keeps_snippets_out_of_verified_sources(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "searxng")
    monkeypatch.setenv("SEARXNG_BASE_URL", "http://internal.test/search-service/")
    settings = load_settings(private_runtime(tmp_path))
    ws = WorkspaceState(workspace_id="private", root_path=tmp_path)
    tracker = SourceTracker()
    search, = ToolFactory(settings, tracker, None).build_tools(["web_search"], ws)
    requests = []
    result = {"title": "Example", "content": "z" * 2000, "url": "https://example.org/page"}

    @contextmanager
    def stream(method, url, **kwargs):
        requests.append((method, url, kwargs))
        yield httpx.Response(200, request=httpx.Request(method, url), json={"results": [
            {"url": "file:///secret", "content": "bad"}, result, result,
            {**result, "url": "https://example.org/second"},
        ]})

    monkeypatch.setattr(oss_web.httpx, "stream", stream)
    ws.context["internet_search_enabled"] = False
    assert json.loads(search.invoke({"query": "release date"}))["errorCode"] == "SEARCH_DISABLED"
    assert not requests
    ws.context["internet_search_enabled"] = True
    payload = json.loads(search.invoke({"query": "release date", "max_results": 2}))
    method, url, kwargs = requests.pop()
    assert (method, url) == ("POST", "http://internal.test/search-service/search")
    assert kwargs["data"] == {"q": "release date", "format": "json"}
    assert not kwargs.get("headers")
    assert payload["evidence"] == "search_snippets"
    assert [hit["url"] for hit in payload["results"]] == [result["url"], "https://example.org/second"]
    assert len(payload["results"][0]["snippet"]) == 1000
    ws.context["active_skill"] = "research"
    assert "returned snippets" in _research_source_contract_error(AgentRuntimeState("fast", ws), tracker)
    assert tracker.list_sources(ws) == []
    assert ws.context.get("web_search_source_count", 0) == 0


@pytest.mark.parametrize(("status", "body", "outcome"), [
    (200, {"results": []}, "ok"),
    (200, {"results": [], "unresponsive_engines": [["engine", "timeout"]]}, "error"),
    (200, {"unexpected": []}, "error"),
    (403, {}, "error"),
])
def test_searxng_empty_and_error_responses(tmp_path, monkeypatch, status, body, outcome):
    ws = WorkspaceState(workspace_id="private", root_path=tmp_path)
    search = oss_web.build_oss_search_tool(ws, WebSearchConfig(provider="searxng", base_url="http://internal.test"))

    @contextmanager
    def stream(method, url, **kwargs):
        yield httpx.Response(status, request=httpx.Request(method, url), json=body)

    monkeypatch.setattr(oss_web.httpx, "stream", stream)
    assert json.loads(search.invoke({"query": "test"}))["status"] == outcome


def test_legacy_cloud_tool_configuration_maps_to_web_search(tmp_path, monkeypatch):
    path = private_runtime(tmp_path)
    cfg = yaml.safe_load(path.read_text())
    cfg["model"] = {"provider": "gemini"}
    cfg["tools"] = [{"name": "google_search"}]
    cfg["backend"]["code_interpreter"] = {"ptc_tools": ["google_search", "web_search"]}
    path.write_text(yaml.safe_dump(cfg))
    monkeypatch.delenv("WEB_SEARCH_PROVIDER", raising=False)
    settings = load_settings(path)
    assert settings.web_search.provider == "gemini"
    assert list(settings.tools) == ["web_search"]
    assert settings.backend.code_interpreter.ptc_tools == ["web_search"]


@pytest.fixture
def oss_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "websearchfree")
    monkeypatch.setenv("WEBSEARCHFREE_BASE_URL", "http://websearchfree.test")
    settings = load_settings(private_runtime(tmp_path))
    ws = WorkspaceState(workspace_id="private", root_path=tmp_path, context={"active_skill": "research"})
    tracker = SourceTracker()
    factory = ToolFactory(settings, tracker, None)
    search, read = factory.build_tools(["web_search", "url_context"], ws)
    return ws, tracker, search, read


@pytest.mark.parametrize(("backend", "engines"), [("searxng", ["searx"]), ("direct", ["ddg", "brave", "wikipedia"])])
def test_discover_then_read_selected_sources(backend, engines, tmp_path, monkeypatch):
    monkeypatch.setenv("WEBSEARCHFREE_SEARCH_BACKEND", backend)
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "websearchfree")
    monkeypatch.setenv("WEBSEARCHFREE_BASE_URL", "http://wsf.test/api/")
    settings = load_settings(private_runtime(tmp_path))
    ws = WorkspaceState(workspace_id="private", root_path=tmp_path, context={"active_skill": "research"})
    tracker = SourceTracker()
    search, read = ToolFactory(settings, tracker, None).build_tools(["web_search", "url_context"], ws)
    source = "https://docs.example.org/page"
    other = "https://docs.example.org/other"
    monkeypatch.setattr(oss_web.socket, "getaddrinfo", lambda *a, **kw: [(0, 0, 0, "", ("8.8.8.8", 0))])
    calls = []

    @contextmanager
    def stream(method, url, **kwargs):
        calls.append((method, url, kwargs["json"]))
        if url.endswith("/search"):
            payload = {"results": [{"url": source, "title": "Docs", "content": "Index entry", "raw_content": "ignore"}]}
        else:
            payload = {"results": [
                {"url": source, "title": "Docs", "status": "ok", "raw_content": "a" * 7000},
                {"url": other, "status": "robots_denied", "raw_content": "ignore"},
                {"url": "https://unknown.example", "status": "ok", "raw_content": "ignore"},
            ]}
        yield httpx.Response(200, request=httpx.Request(method, url), json=payload)
    monkeypatch.setattr(oss_web.httpx, "stream", stream)
    discovery = json.loads(search.invoke({"query": "which page?", "max_results": 5}))
    assert discovery["results"] == [{"url": source, "title": "Docs", "snippet": "Index entry"}]
    runtime = AgentRuntimeState("fast", ws)
    assert _research_source_contract_error(runtime, tracker)
    response = json.loads(read.invoke({"urls": [source, other, source], "question": "private question"}))
    assert response["results"] == [{"url": source, "title": "Docs", "text": "a" * 6000}]
    assert response["evidence"] == "page_text"
    assert response["failed_urls"] == [other]
    assert _research_source_contract_error(runtime, tracker) == ""
    assert tracker.list_sources(ws) == [(1, "Docs", source)]
    assert calls == [
        ("POST", "http://wsf.test/api/search", {
            "query": "which page?", "engines": engines, "search_depth": "basic", "max_results": 5,
            "use_search_cache": False,
        }),
        ("POST", "http://wsf.test/api/extract", {"urls": [source, other], "timeout_ms": 8000, "use_cache": False}),
    ]


@pytest.mark.parametrize(("reports", "results", "expected_status"), [
    ([{"ok": False, "error": "no results"}], [], "ok"),
    ([{"ok": False, "error": "timeout"}], [], "error"),
    ([{"ok": False, "error": "no results"}, {"ok": False, "error": "timeout"}], [], "error"),
    ([{"ok": False, "error": "timeout"}, {"ok": True}],
     [{"url": "https://example.org/", "content": "A result from the available engine"}], "ok"),
])
def test_websearchfree_engine_outcomes(oss_tools, monkeypatch, reports, results, expected_status):
    _, _, search, _ = oss_tools

    @contextmanager
    def stream(method, url, **kwargs):
        yield httpx.Response(200, request=httpx.Request(method, url), json={"engines": reports, "results": results})

    monkeypatch.setattr(oss_web.httpx, "stream", stream)
    outcome = json.loads(search.invoke({"query": "example"}))
    assert outcome["status"] == expected_status
    if expected_status == "error":
        assert outcome["errorCode"] == "SEARCH_FAILED"
    else:
        assert [hit["url"] for hit in outcome["results"]] == [hit["url"] for hit in results]


def test_pasted_url_goes_directly_to_extract_and_empty_page_is_unverified(oss_tools, monkeypatch):
    ws, tracker, _, read = oss_tools
    url = "https://1.1.1.1/terms"

    @contextmanager
    def stream(method, endpoint, **kwargs):
        assert endpoint == "http://websearchfree.test/extract"
        yield httpx.Response(200, request=httpx.Request(method, endpoint), json={"results": [
            {"url": url, "status": "empty", "raw_content": ""},
        ]})
    monkeypatch.setattr(oss_web.httpx, "stream", stream)
    result = json.loads(read.invoke({"urls": [url]}))
    assert result["errorCode"] == "NO_PAGE_CONTENT"
    assert result["failed_urls"] == [url]
    assert not tracker.list_sources(ws)


@pytest.mark.parametrize("url", ["file:///etc/test", "http://127.0.0.1/", "https://[::1]/", "http://10.1.2.3/",
                                  "http://svc.cluster.local/", "https://user:pass@public.example/", "https://mixed.example/"])
def test_nonpublic_urls_never_reach_service(oss_tools, monkeypatch, url):
    _, _, _, read = oss_tools
    monkeypatch.setattr(oss_web.socket, "getaddrinfo", lambda *a, **kw: [
        (0, 0, 0, "", ("1.1.1.1", 0)), (0, 0, 0, "", ("192.168.1.2", 0)),
    ])
    monkeypatch.setattr(oss_web.httpx, "stream", lambda *a, **kw: pytest.fail("unexpected HTTP request"))
    assert json.loads(read.invoke({"urls": [url]}))["errorCode"] == "INVALID_URL"


def test_url_read_respects_turn_switch_and_limits(oss_tools, monkeypatch):
    ws, _, _, read = oss_tools
    monkeypatch.setattr(oss_web.httpx, "stream", lambda *a, **kw: pytest.fail("unexpected HTTP request"))
    ws.context["internet_search_enabled"] = False
    err = json.loads(read.invoke({"urls": ["https://example.org/"]}))
    assert (err["tool"], err["errorCode"]) == ("url_context", "SEARCH_DISABLED")
    ws.context["internet_search_enabled"] = True
    ws.context["web_search_count"] = 3
    err = json.loads(read.invoke({"urls": ["https://example.org/"]}))
    assert (err["tool"], err["errorCode"]) == ("url_context", "SEARCH_CALL_LIMIT")


def test_disabled_removes_both_tools_even_in_legacy_config(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "disabled")
    path = private_runtime(tmp_path)
    cfg = yaml.safe_load(path.read_text())
    cfg["tools"] = [{"name": "google_search"}, {"name": "url_context"}]
    path.write_text(yaml.safe_dump(cfg))
    assert not load_settings(path).tools
