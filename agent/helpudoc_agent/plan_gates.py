"""Shared plan-approval state checks for workspace and data agent tools."""
from __future__ import annotations

from .state import WorkspaceState


def is_plan_approved(workspace_state: WorkspaceState) -> bool:
    context = getattr(workspace_state, "context", {}) or {}
    if context.get("skip_plan_approvals"):
        return True
    return bool(context.get("plan_approved"))
