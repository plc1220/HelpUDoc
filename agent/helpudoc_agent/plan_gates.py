"""Shared plan-approval state checks for workspace and data agent tools."""
from __future__ import annotations

import re

from .state import WorkspaceState


def has_rejected_plan_decision(resume_decisions: object) -> bool:
    if not isinstance(resume_decisions, list):
        return False
    return any(
        isinstance(decision, dict)
        and str(decision.get("type") or "").strip().lower() == "reject"
        for decision in resume_decisions
    )


def has_approved_plan_decision(resume_decisions: object) -> bool:
    if not isinstance(resume_decisions, list):
        return False
    return any(
        isinstance(decision, dict)
        and str(decision.get("type") or "").strip().lower() == "approve"
        for decision in resume_decisions
    )


def has_edited_plan_decision(resume_decisions: object) -> bool:
    if not isinstance(resume_decisions, list):
        return False
    return any(
        isinstance(decision, dict)
        and str(decision.get("type") or "").strip().lower() == "edit"
        for decision in resume_decisions
    )


def requested_dashboard_title(message: object) -> str:
    """Extract an explicitly bound dashboard title from the current user turn."""
    if not isinstance(message, str):
        return ""
    match = re.search(
        r"\bdashboard\s+titled\s+(?P<title>.+?)\s+from\s+(?:[`\"']?)[^\s,]+",
        message,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return " ".join(match.group("title").split()) if match else ""


def requested_dashboard_output_path(message: object) -> str:
    """Extract an explicitly bound dashboard package path from the current turn."""
    if not isinstance(message, str):
        return ""
    match = re.search(
        r"\boutput\s+path\s+exactly\s+(?P<path>[^\s,.;]+)",
        message,
        flags=re.IGNORECASE,
    )
    if not match:
        return ""
    return match.group("path").strip("`\"'")


def requested_dashboard_time_field(message: object) -> str:
    if not isinstance(message, str):
        return ""
    match = re.search(
        r"\buse\s+(?P<field>[A-Za-z_][A-Za-z0-9_]*)\s+as\s+the\s+time\s+field",
        message,
        flags=re.IGNORECASE,
    )
    return match.group("field") if match else ""


def requested_dashboard_filters(message: object) -> list[str]:
    if not isinstance(message, str):
        return []
    match = re.search(
        r"\band\s+(?P<fields>[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*"
        r"(?:\s*,?\s*and\s+[A-Za-z_][A-Za-z0-9_]*)?)\s+as\s+filters\b",
        message,
        flags=re.IGNORECASE,
    )
    if not match:
        return []
    raw = re.sub(r"\s*,?\s+and\s+", ",", match.group("fields"), flags=re.IGNORECASE)
    return [field.strip() for field in raw.split(",") if field.strip()]


def prepare_plan_context_for_explicit_resume(
    workspace_state: WorkspaceState,
    resume_decisions: object,
) -> None:
    """Make an explicit human decision authoritative over trusted-mode shortcuts."""
    if resume_decisions is None:
        return
    context = getattr(workspace_state, "context", None)
    if not isinstance(context, dict):
        return
    context["skip_plan_approvals"] = False
    context["plan_approved"] = False
    context["host_plan_approved"] = False
    context["last_plan_decision"] = ""


def is_plan_approved(workspace_state: WorkspaceState) -> bool:
    context = getattr(workspace_state, "context", {}) or {}
    if context.get("skip_plan_approvals"):
        return True
    return bool(context.get("plan_approved"))
