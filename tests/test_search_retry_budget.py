"""Retry cost follows the failure, not the attempt count.

`DEFAULT_SEARCH_MAX_ATTEMPTS` weights every failure the same. An empty grounded
reply returns in about four seconds and is worth a second try; a timeout costs
the full deadline and retrying one spends another. Two timed-out attempts held a
research run for ~101 seconds before the tool reported anything, and the model
then retried on top of that.

A wall-clock budget separates them without naming either.
"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace import web_sources
from helpudoc_agent.tools.workspace.web_sources import build_google_search_tool
from helpudoc_agent.utils import SourceTracker


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    monkeypatch.setattr(
        web_sources, "resolve_vertex_redirects", lambda urls: {u: u for u in urls}
    )
    monkeypatch.setattr(web_sources, "search_retry_delay", lambda attempt: 0.0)


def _workspace(tmp_path) -> WorkspaceState:
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path)
    state.context.update({"plan_approved": True, "google_search_attempts": 0})
    return state


def _ungrounded():
    return SimpleNamespace(
        response_metadata={"finish_reason": "MAX_TOKENS", "grounding_metadata": {}},
        usage_metadata={}, text="", content=[],
    )


def _tool(state):
    return build_google_search_tool(
        state, SourceTracker(), SimpleNamespace(bind=lambda **_: None)
    )


def test_a_cheap_failure_is_retried(tmp_path, monkeypatch):
    """An empty grounded reply costs seconds, so the budget still allows a retry."""
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_TOTAL_BUDGET", 75)
    calls = {"n": 0}

    def fake(invoke, timeout_s, label):
        calls["n"] += 1
        return (_ungrounded(), None)  # returns immediately, as a real one nearly does

    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)
    _tool(_workspace(tmp_path)).invoke({"query": "CloudMile"})

    assert calls["n"] == 2, "a fast failure must still get its second attempt"


def test_an_expensive_failure_is_not_retried(tmp_path, monkeypatch):
    """A timeout eats the budget, so no second upstream call is started."""
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_TOTAL_BUDGET", 1)
    monkeypatch.setattr(web_sources, "MIN_SEARCH_RETRY_HEADROOM", 1)
    calls = {"n": 0}

    def fake(invoke, timeout_s, label):
        calls["n"] += 1
        time.sleep(1.1)  # stands in for a call that burns its deadline
        return (None, f"timeout after {timeout_s}s")

    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)
    result = _tool(_workspace(tmp_path)).invoke({"query": "CloudMile"})

    assert calls["n"] == 1, "the budget was spent; a second attempt must not start"
    assert json.loads(result)["errorCode"] == "SEARCH_TIMEOUT"


def test_an_attempt_never_outlives_the_budget(tmp_path, monkeypatch):
    """The second attempt is given only what is left, not a fresh deadline."""
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_TIMEOUT", 50)
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_TOTAL_BUDGET", 60)
    seen = []

    def fake(invoke, timeout_s, label):
        seen.append(timeout_s)
        time.sleep(0.2)
        return (_ungrounded(), None)

    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)
    _tool(_workspace(tmp_path)).invoke({"query": "CloudMile"})

    assert seen[0] == 50, "the first attempt gets the normal deadline"
    assert seen[1] <= 60, "the second is bounded by what remains of the budget"


def test_a_success_still_costs_one_attempt(tmp_path, monkeypatch):
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    calls = {"n": 0}

    def fake(invoke, timeout_s, label):
        calls["n"] += 1
        return (SimpleNamespace(
            response_metadata={"finish_reason": "STOP", "grounding_metadata": {
                "groundingChunks": [{"web": {"uri": "https://a.example", "title": "A"}}]}},
            usage_metadata={}, text="", content=[]), None)

    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)
    state = _workspace(tmp_path)
    result = _tool(state).invoke({"query": "CloudMile"})

    assert calls["n"] == 1
    assert "a.example" in result
    assert state.context["google_search_count"] == 1
