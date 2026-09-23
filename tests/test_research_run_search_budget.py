"""Search budget, retry and circuit behaviour for a research run.

These started as a reproduction of the two ways a research run ended with no
report: the run's search budget was spent before evidence gathering began, and a
single upstream error latched the search circuit for the rest of the run. Both
failures were invisible in chat -- the model followed SKILL.md section 6 and
stopped without drafting, so the user saw a bare failed banner.

They now pin the fixed behaviour. No network calls.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from helpudoc_agent.plan_gates import prepare_plan_context_for_explicit_resume
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace import web_sources
from helpudoc_agent.tools.workspace.policy import (
    apply_search_policy_guard,
    record_search_success,
    run_search_call_limit,
)
from helpudoc_agent.tools.workspace.web_sources import build_google_search_tool
from helpudoc_agent.utils import SourceTracker

RESEARCH_PRE_PLAN_SEARCH_LIMIT = 3


def _research_workspace(tmp_path) -> WorkspaceState:
    """A workspace mid-run with the research skill active and no plan approved."""
    workspace = WorkspaceState(workspace_id="ws-research", root_path=tmp_path)
    workspace.context.update(
        {
            "active_skill": "research",
            "active_skill_policy": {
                "requires_hitl_plan": True,
                "requires_workspace_artifacts": True,
                "required_artifacts_mode": "full_pack",
                "required_artifacts": ["/final-research-report.md"],
                "pre_plan_search_limit": RESEARCH_PRE_PLAN_SEARCH_LIMIT,
            },
            "plan_approved": False,
            "pre_plan_search_count": 0,
            "google_search_count": 0,
            "google_search_attempts": 0,
        }
    )
    return workspace


def _error_code(result: str | None) -> str:
    if not result or not result.strip().startswith("{"):
        return ""
    return json.loads(result).get("errorCode", "")


def _grounded_response(*urls: str) -> SimpleNamespace:
    """A Gemini reply carrying real grounding metadata."""
    return SimpleNamespace(
        response_metadata={
            "finish_reason": "STOP",
            "grounding_metadata": {
                "groundingChunks": [
                    {"web": {"uri": url, "title": f"Title {i}"}} for i, url in enumerate(urls)
                ]
            },
        },
        usage_metadata={"input_tokens": 100, "output_tokens": 200},
        text="",
        content=[],
    )


def _ungrounded_response() -> SimpleNamespace:
    """A 200 OK reply with no grounding metadata -- the measured ~9% case."""
    return SimpleNamespace(
        response_metadata={"finish_reason": "MAX_TOKENS", "grounding_metadata": {}},
        usage_metadata={"input_tokens": 100, "output_tokens": 1024},
        text="",
        content=[],
    )


@pytest.fixture(autouse=True)
def _no_redirect_resolution(monkeypatch):
    """Citation URLs are resolved over the network; keep these tests offline."""
    monkeypatch.setattr(
        web_sources, "resolve_vertex_redirects", lambda urls: {u: u for u in urls}
    )


def _build_tool(workspace, responses):
    """Bind a tool whose upstream returns `responses` in order."""
    calls = {"n": 0}

    def fake_invoke(invoke, timeout_s, label):
        index = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        item = responses[index]
        return (None, item) if isinstance(item, str) else (item, None)

    return (
        build_google_search_tool(
            workspace, SourceTracker(), SimpleNamespace(bind=lambda **_: None)
        ),
        calls,
        fake_invoke,
    )


def test_pre_plan_searches_leave_the_post_approval_budget_intact(tmp_path):
    """Section 4's preliminary searches must not spend section 6's evidence budget.

    Both counters were once the same one, and it was charged before the call ran,
    so approving the plan bought a budget that was already gone.
    """
    workspace = _research_workspace(tmp_path)

    for _ in range(RESEARCH_PRE_PLAN_SEARCH_LIMIT):
        assert apply_search_policy_guard(workspace, "google_search") is None
        # Stands in for a successful call; the tool charges on success.
        workspace.context["pre_plan_search_count"] += 1

    assert workspace.context["google_search_count"] == 0, (
        "pre-plan searches must not be charged to the run budget"
    )

    workspace.context["plan_approved"] = True
    assert apply_search_policy_guard(workspace, "google_search") is None, (
        "research gathers evidence only after approval; it must have budget left"
    )


def test_a_failed_search_does_not_spend_the_run_budget(tmp_path, monkeypatch):
    """Only a call that returned sources should cost the run one of its searches."""
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 1)
    workspace = _research_workspace(tmp_path)
    workspace.context["plan_approved"] = True

    tool, _, fake = _build_tool(workspace, [_ungrounded_response()])
    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)

    assert _error_code(tool.invoke({"query": "CloudMile"})) == "SEARCH_NO_SOURCES"
    assert workspace.context["google_search_count"] == 0
    assert workspace.context["google_search_attempts"] == 1, (
        "attempts are still counted, so a run that only fails cannot loop forever"
    )


def test_a_successful_search_spends_exactly_one_of_the_budget(tmp_path, monkeypatch):
    workspace = _research_workspace(tmp_path)
    workspace.context["plan_approved"] = True

    tool, _, fake = _build_tool(
        workspace, [_grounded_response("https://a.example", "https://b.example")]
    )
    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake)

    result = tool.invoke({"query": "CloudMile"})
    assert "a.example" in result
    assert workspace.context["google_search_count"] == 1
    assert workspace.context["google_search_source_count"] == 2


def test_an_ungrounded_reply_is_retried_inside_the_tool(tmp_path, monkeypatch):
    """The retry belongs here, not in the model.

    At the old default of one attempt the tool handed the failure back as
    `retryable: true` and the model retried, which spent the run budget and showed
    the user a visible stall.
    """
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(web_sources, "search_retry_delay", lambda attempt: 0.0)
    workspace = _research_workspace(tmp_path)
    workspace.context["plan_approved"] = True

    responses = [_ungrounded_response(), _grounded_response("https://a.example")]
    calls = {"n": 0}

    def fake_invoke(invoke, timeout_s, label):
        item = responses[min(calls["n"], len(responses) - 1)]
        calls["n"] += 1
        return (item, None)

    monkeypatch.setattr(web_sources, "invoke_lc_with_timeout", fake_invoke)
    tool = build_google_search_tool(
        workspace, SourceTracker(), SimpleNamespace(bind=lambda **_: None)
    )

    result = tool.invoke({"query": "CloudMile"})
    assert calls["n"] == 2, "the tool must retry itself before giving up"
    assert "a.example" in result
    assert workspace.context["google_search_count"] == 1


def test_a_configuration_fault_is_reported_as_one(tmp_path, monkeypatch):
    """404 is an operator error, not a transient outage, and must not read as one."""
    monkeypatch.setattr(web_sources, "DEFAULT_SEARCH_MAX_ATTEMPTS", 1)
    monkeypatch.setattr(
        web_sources,
        "invoke_lc_with_timeout",
        lambda invoke, timeout_s, label: (
            None,
            "404 NOT_FOUND: publishers/google/models/gemini-3.1-flash-lite",
        ),
    )
    workspace = _research_workspace(tmp_path)
    tool = build_google_search_tool(
        workspace, SourceTracker(), SimpleNamespace(bind=lambda **_: None)
    )

    first = json.loads(tool.invoke({"query": "CloudMile"}))
    assert first["errorCode"] == "SEARCH_CONFIG_ERROR"
    assert first["retryable"] is False
    assert not web_sources._is_transient_search_error("404 NOT_FOUND: whatever")


def test_approving_the_plan_reopens_the_search_circuit(tmp_path):
    """The latch must not outlive the approval gate.

    Only a successful search cleared `google_search_terminal_error`, and the policy
    guard refused the call before one could happen, so the evidence gathering the
    user had just approved could never run.
    """
    workspace = _research_workspace(tmp_path)
    workspace.context["google_search_terminal_error"] = True
    workspace.context["google_search_consecutive_failures"] = 3

    assert _error_code(apply_search_policy_guard(workspace, "google_search")) == "SEARCH_CIRCUIT_OPEN"

    prepare_plan_context_for_explicit_resume(workspace, [{"type": "approve"}])
    workspace.context["plan_approved"] = True

    assert apply_search_policy_guard(workspace, "google_search") is None
    assert workspace.context["google_search_consecutive_failures"] == 0


def test_repeated_failures_stop_at_the_attempt_ceiling(tmp_path):
    """Budgeting on success alone would let a failing run search forever."""
    workspace = _research_workspace(tmp_path)
    workspace.context["plan_approved"] = True
    ceiling = run_search_call_limit() * 2

    for _ in range(ceiling):
        assert apply_search_policy_guard(workspace, "google_search") is None

    assert _error_code(apply_search_policy_guard(workspace, "google_search")) == "SEARCH_ATTEMPT_LIMIT"


def test_the_run_budget_clears_the_cheapest_research_mode(tmp_path):
    """Quick Research needs 4 credible sources; the old budget of 3 could not reach it."""
    assert run_search_call_limit() >= 4


def test_url_context_still_consumes_the_pre_plan_allowance(tmp_path):
    """The plan gate bounds every web tool, not just google_search.

    Moving the charge from the guard to the success path initially wired only
    google_search, which left url_context unbounded before plan approval -- a run
    could gather all its evidence without ever presenting a plan.
    """
    workspace = _research_workspace(tmp_path)

    for _ in range(RESEARCH_PRE_PLAN_SEARCH_LIMIT):
        assert apply_search_policy_guard(workspace, "url_context") is None
        record_search_success(workspace, "url_context")

    assert apply_search_policy_guard(workspace, "url_context") is not None, (
        "url_context must stop at the pre-plan limit"
    )


def test_url_context_does_not_spend_the_post_approval_search_budget(tmp_path):
    """url_context reads links the user supplied; only discovery draws on the budget."""
    workspace = _research_workspace(tmp_path)
    workspace.context["plan_approved"] = True

    record_search_success(workspace, "url_context")

    assert workspace.context["google_search_count"] == 0
