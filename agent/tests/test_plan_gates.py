from __future__ import annotations

from helpudoc_agent.plan_gates import (
    has_approved_plan_decision,
    has_edited_plan_decision,
    has_rejected_plan_decision,
    is_plan_approved,
    prepare_plan_context_for_explicit_resume,
    requested_dashboard_filters,
    requested_dashboard_output_path,
    requested_dashboard_time_field,
    requested_dashboard_title,
)
from helpudoc_agent.state import WorkspaceState


def test_fresh_request_preserves_explicit_trusted_mode(tmp_path) -> None:
    state = WorkspaceState("workspace-1", tmp_path)
    state.context.update(
        {
            "skip_plan_approvals": True,
            "plan_approved": True,
            "host_plan_approved": True,
        }
    )

    prepare_plan_context_for_explicit_resume(state, None)

    assert state.context["skip_plan_approvals"] is True
    assert is_plan_approved(state) is True


def test_explicit_resume_overrides_trusted_mode_until_decision_is_consumed(tmp_path) -> None:
    state = WorkspaceState("workspace-1", tmp_path)
    state.context.update({"skip_plan_approvals": True, "plan_approved": True})

    prepare_plan_context_for_explicit_resume(state, [{"type": "reject"}])

    assert state.context["skip_plan_approvals"] is False
    assert state.context["plan_approved"] is False
    assert state.context["host_plan_approved"] is False
    assert is_plan_approved(state) is False


def test_rejected_plan_decision_is_detected_case_insensitively() -> None:
    assert has_rejected_plan_decision([{"type": "Reject"}]) is True
    assert has_rejected_plan_decision([{"type": "approve"}]) is False
    assert has_rejected_plan_decision(None) is False


def test_approved_plan_decision_is_detected_case_insensitively() -> None:
    assert has_approved_plan_decision([{"type": "Approve"}]) is True
    assert has_approved_plan_decision([{"type": "reject"}]) is False
    assert has_approved_plan_decision(None) is False


def test_edited_plan_decision_is_detected_case_insensitively() -> None:
    assert has_edited_plan_decision([{"type": "Edit"}]) is True
    assert has_edited_plan_decision([{"type": "approve"}]) is False
    assert has_edited_plan_decision(None) is False


def test_explicit_dashboard_title_is_extracted_from_current_turn() -> None:
    assert requested_dashboard_title(
        "Build a filterable dashboard titled Approved Checkpoint Fidelity Final "
        "from orders_dirty.csv."
    ) == "Approved Checkpoint Fidelity Final"
    assert requested_dashboard_title("Build a dashboard from orders.csv.") == ""


def test_explicit_dashboard_output_path_is_extracted_from_current_turn() -> None:
    assert requested_dashboard_output_path(
        "Use package output path exactly dashboards/final-fidelity-contract-pass."
    ) == "dashboards/final-fidelity-contract-pass"
    assert requested_dashboard_output_path("Use a suitable output folder.") == ""


def test_explicit_dashboard_fields_are_extracted_from_current_turn() -> None:
    prompt = (
        "Use order_date as the time field and country, category, and device as filters."
    )
    assert requested_dashboard_time_field(prompt) == "order_date"
    assert requested_dashboard_filters(prompt) == ["country", "category", "device"]
