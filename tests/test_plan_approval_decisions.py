"""What the human clicked is what the plan decision means.

A research run asked for approval, the user approved, and the run answered
"revise the plan and call request_plan_approval again". It happened because the
model had filled in `reviewer_feedback`, and a non-empty one was read as an edit
whatever the human chose. The user approved the same plan repeatedly and the run
never started.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins import human_interrupts

PLAN = {
    "plan_title": "CloudMile Group Research Plan",
    "plan_summary": "A corporate profile of CloudMile Group.",
    "execution_checklist": "1. gather sources 2. write the report",
}


def _workspace(tmp_path) -> WorkspaceState:
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    state.context.update({"active_skill": "research", "user_id": "u", "run_id": "run-1"})
    return state


def _tool(monkeypatch, state, decision):
    monkeypatch.setattr(
        human_interrupts,
        "interrupt_with_retry",
        lambda *a, **k: {"decisions": [decision]},
    )
    return human_interrupts.build_request_plan_approval_tool(state)


def test_approve_is_an_approval_even_with_reviewer_feedback(tmp_path, monkeypatch):
    """The regression: `reviewer_feedback` is the model's own argument.

    Letting it decide the outcome overrode the human's click.
    """
    state = _workspace(tmp_path)
    tool = _tool(monkeypatch, state, {"type": "approve"})

    result = tool.invoke({**PLAN, "reviewer_feedback": "Approved. All steps are documented."})

    assert "PLAN_APPROVAL_RECORDED" in result
    assert "PLAN_EDIT_FEEDBACK_RECORDED" not in result
    assert state.context["plan_approved"] is True
    assert state.context["last_plan_decision"] == "approve"


def test_approve_without_feedback_is_an_approval(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    tool = _tool(monkeypatch, state, {"type": "approve"})

    assert "PLAN_APPROVAL_RECORDED" in tool.invoke(dict(PLAN))
    assert state.context["plan_approved"] is True


def test_edit_is_still_an_edit(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    tool = _tool(
        monkeypatch,
        state,
        {"type": "edit", "message": "tighten the scope"},
    )

    result = tool.invoke(dict(PLAN))

    assert "PLAN_EDIT_FEEDBACK_RECORDED" in result
    assert "tighten the scope" in result
    assert state.context["plan_approved"] is False
    assert state.context["last_plan_decision"] == "edit"


def test_reject_is_still_a_rejection(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    tool = _tool(monkeypatch, state, {"type": "reject", "message": "wrong subject"})

    result = tool.invoke(dict(PLAN))

    assert "PLAN_REJECTION_RECORDED" in result
    assert state.context["plan_approved"] is False
    assert state.context["last_plan_decision"] == "reject"


def test_the_tool_needs_nothing_beyond_the_plan(tmp_path, monkeypatch):
    """No extra argument gates approval.

    The pack disposition gate demanded one, and because the tool body re-runs on
    resume it could refuse a plan the human had already approved -- the approval
    was then never consumed and the run failed having done nothing.
    """
    state = _workspace(tmp_path)
    tool = _tool(monkeypatch, state, {"type": "approve"})

    assert "PLAN_APPROVAL_RECORDED" in tool.invoke(dict(PLAN))


def test_a_plan_still_needs_its_own_fields(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    tool = _tool(monkeypatch, state, {"type": "approve"})

    assert "plan_title is required" in tool.invoke({**PLAN, "plan_title": ""})


def test_trusted_mode_approves_without_asking(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    state.context["skip_plan_approvals"] = True
    monkeypatch.setattr(
        human_interrupts,
        "interrupt_with_retry",
        lambda *a, **k: pytest.fail("trusted mode must not interrupt"),
    )
    tool = human_interrupts.build_request_plan_approval_tool(state)

    result = tool.invoke(dict(PLAN))

    assert "PLAN_APPROVAL_SKIPPED_TRUSTED_MODE" in result
    assert state.context["plan_approved"] is True


def test_a_missing_decision_does_not_approve(tmp_path, monkeypatch):
    state = _workspace(tmp_path)
    monkeypatch.setattr(human_interrupts, "interrupt_with_retry", lambda *a, **k: {})
    tool = human_interrupts.build_request_plan_approval_tool(state)

    result = tool.invoke(dict(PLAN))

    assert "PLAN_APPROVAL_DECISION_MISSING" in result
    assert state.context["plan_approved"] is False
