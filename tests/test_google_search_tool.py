from __future__ import annotations

import json
from types import SimpleNamespace

from helpudoc_agent.api.routes.chat import _research_source_contract_error
from helpudoc_agent.state import AgentRuntimeState, WorkspaceState
from helpudoc_agent.tools.workspace import web_sources
from helpudoc_agent.tools.workspace.web_sources import build_google_search_tool
from helpudoc_agent.utils import SourceTracker


class FakeBoundModel:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def invoke(self, *_args, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeModel:
    def __init__(self, outcomes):
        self.bound = FakeBoundModel(outcomes)
        self.bind_kwargs = None

    def bind(self, **kwargs):
        self.bind_kwargs = kwargs
        return self.bound


def _invoke_inline(invoke, *, timeout_s, label):
    del timeout_s, label
    try:
        return invoke(), None
    except Exception as exc:  # noqa: BLE001 - model failures are the test input
        return None, str(exc)


def _grounded_response():
    return SimpleNamespace(
        text="A grounded answer.",
        response_metadata={
            "grounding_metadata": {
                "groundingChunks": [
                    {"web": {"uri": "https://example.com/source", "title": "Example source"}}
                ]
            }
        },
    )


def _build(tmp_path, outcomes, monkeypatch):
    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", _invoke_inline)
    monkeypatch.setattr(web_sources, "search_retry_delay", lambda _attempt: 0.0)
    monkeypatch.setattr(web_sources.time, "sleep", lambda _delay: None)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_CONSECUTIVE_FAILURES", 2)
    workspace = WorkspaceState(workspace_id="ws-search", root_path=tmp_path)
    tracker = SourceTracker()
    model = FakeModel(outcomes)
    tool = build_google_search_tool(workspace, tracker, model)
    return tool, workspace, tracker, model


def test_google_search_is_the_single_public_tool_and_retries_once(tmp_path, monkeypatch):
    tool, workspace, tracker, model = _build(
        tmp_path,
        [TimeoutError("deadline exceeded"), _grounded_response()],
        monkeypatch,
    )

    result = tool.invoke({"query": "current example", "max_results": 3})

    assert tool.name == "google_search"
    assert model.bind_kwargs == {"tools": [{"google_search": {}}]}
    assert model.bound.calls == 2
    assert "A grounded answer." in result
    assert "https://example.com/source" in result
    assert len(tracker.list_sources(workspace)) == 1
    assert workspace.context["google_search_upstream_attempt_count"] == 2
    assert workspace.context["google_search_consecutive_failures"] == 0
    assert workspace.context["google_search_success_count"] == 1
    assert workspace.context["google_search_source_count"] == 1
    assert "google_search_terminal_error" not in workspace.context


def test_google_search_retries_a_response_without_grounding_sources(tmp_path, monkeypatch):
    ungrounded = SimpleNamespace(text="Model-only answer.", response_metadata={})
    tool, workspace, tracker, model = _build(
        tmp_path,
        [ungrounded, _grounded_response()],
        monkeypatch,
    )

    result = tool.invoke({"query": "current example"})

    assert model.bound.calls == 2
    assert "A grounded answer." in result
    assert workspace.context["google_search_source_count"] == 1
    assert len(tracker.list_sources(workspace)) == 1


def test_google_search_rejects_model_authored_urls_without_grounding_metadata(tmp_path, monkeypatch):
    unverified = SimpleNamespace(
        text=json.dumps(
            {
                "summary": "An unsupported answer.",
                "sources": [{"title": "Invented", "url": "https://invented.example/source"}],
            }
        ),
        response_metadata={},
    )
    tool, workspace, tracker, model = _build(
        tmp_path,
        [unverified, unverified],
        monkeypatch,
    )

    result = json.loads(tool.invoke({"query": "current example"}))

    assert model.bound.calls == 2
    assert result["errorCode"] == "SEARCH_NO_SOURCES"
    assert result["retryable"] is False
    assert workspace.context.get("google_search_source_count", 0) == 0
    assert tracker.list_sources(workspace) == []


def test_google_search_opens_circuit_after_two_transient_failures(tmp_path, monkeypatch):
    tool, workspace, _tracker, model = _build(
        tmp_path,
        [TimeoutError("deadline exceeded"), TimeoutError("deadline exceeded")],
        monkeypatch,
    )

    result = json.loads(tool.invoke({"query": "current example"}))

    assert model.bound.calls == 2
    assert result["status"] == "error"
    assert result["errorCode"] == "SEARCH_TIMEOUT"
    assert result["retryable"] is False
    assert result["attempts"] == 2
    assert workspace.context["google_search_terminal_error"] is True

    blocked = json.loads(tool.invoke({"query": "must not reach upstream"}))
    assert blocked["errorCode"] == "SEARCH_CIRCUIT_OPEN"
    assert blocked["retryable"] is False
    assert model.bound.calls == 2


def test_google_search_does_not_retry_non_transient_errors(tmp_path, monkeypatch):
    tool, workspace, _tracker, model = _build(
        tmp_path,
        [RuntimeError("400 INVALID_ARGUMENT")],
        monkeypatch,
    )

    result = json.loads(tool.invoke({"query": "bad request"}))

    assert model.bound.calls == 1
    assert result["errorCode"] == "SEARCH_FAILED"
    assert result["retryable"] is False
    assert workspace.context["google_search_terminal_error"] is True


def test_research_completion_requires_newly_tracked_sources(tmp_path):
    workspace = WorkspaceState(workspace_id="ws-research", root_path=tmp_path)
    workspace.context["active_skill"] = "research"
    runtime = AgentRuntimeState("fast", workspace)
    tracker = SourceTracker()

    assert "did not return any verified web sources" in _research_source_contract_error(runtime, tracker)

    tracker.record(workspace, [{"title": "Primary", "url": "https://example.com/primary"}])
    workspace.context["google_search_source_count"] = 1
    assert _research_source_contract_error(runtime, tracker) == ""

    workspace.context["active_skill"] = "proposal-writing"
    tracker.reset(workspace)
    assert _research_source_contract_error(runtime, tracker) == ""
