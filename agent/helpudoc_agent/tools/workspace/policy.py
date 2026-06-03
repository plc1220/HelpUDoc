"""Skill policy and plan-approval gates for workspace tools."""
from __future__ import annotations

import os
from typing import Optional

from ...plan_gates import is_plan_approved
from ...skills_registry import SkillPolicy
from ...state import WorkspaceState
from ...tagged_file_policy import tagged_files_mode_guard


def get_active_skill_policy(workspace_state: WorkspaceState) -> SkillPolicy:
    raw = workspace_state.context.get("active_skill_policy")
    if isinstance(raw, SkillPolicy):
        return raw
    if isinstance(raw, dict):
        raw_pre_plan_limit = raw.get("pre_plan_search_limit")
        try:
            pre_plan_limit = int(raw_pre_plan_limit or 0)
        except (TypeError, ValueError):
            pre_plan_limit = 0
        return SkillPolicy(
            requires_hitl_plan=bool(raw.get("requires_hitl_plan")),
            requires_workspace_artifacts=bool(raw.get("requires_workspace_artifacts")),
            required_artifacts_mode=str(raw.get("required_artifacts_mode") or "") or None,
            required_artifacts=list(raw.get("required_artifacts") or []) or None,
            pre_plan_search_limit=max(0, pre_plan_limit),
        )
    return SkillPolicy()


def plan_gate_message() -> str:
    return (
        "Plan approval required before execution. "
        "Call request_plan_approval with title, summary, and checklist first."
    )


def plan_gate_with_presearch_message(used: int, limit: int) -> str:
    base = plan_gate_message()
    if limit <= 0:
        return base
    return f"{base} Pre-plan search limit reached ({used}/{limit})."


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def apply_search_policy_guard(workspace_state: WorkspaceState, tool_name: str) -> Optional[str]:
    """Tagged-files gates and optional pre-plan search limits (shared by web tools)."""
    blocked = tagged_files_mode_guard(workspace_state.context, tool_name)
    if blocked:
        return blocked
    if tool_name == "google_search":
        if bool(workspace_state.context.get("google_search_terminal_error")):
            return (
                "Google search is unavailable for this run because the last search timed out. "
                "Do not retry google_search; continue from available workspace context or ask the user to retry later."
            )
        limit = max(1, _env_int("GOOGLE_SEARCH_MAX_CALLS_PER_RUN", 3))
        raw_used = workspace_state.context.get("google_search_count", 0)
        try:
            used = max(0, int(raw_used))
        except (TypeError, ValueError):
            used = 0
        if used >= limit:
            return (
                f"Google search limit reached for this run ({used}/{limit}). "
                "Do not retry google_search; continue with the sources already collected."
            )
        workspace_state.context["google_search_count"] = used + 1
    policy = get_active_skill_policy(workspace_state)
    if policy.requires_hitl_plan and not is_plan_approved(workspace_state):
        limit = max(0, int(policy.pre_plan_search_limit or 0))
        raw_used = workspace_state.context.get("pre_plan_search_count", 0)
        try:
            used = max(0, int(raw_used))
        except (TypeError, ValueError):
            used = 0
        if limit <= 0 or used >= limit:
            return plan_gate_with_presearch_message(used, limit)
        workspace_state.context["pre_plan_search_count"] = used + 1
    return None
