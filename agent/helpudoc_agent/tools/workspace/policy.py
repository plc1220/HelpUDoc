"""Skill policy and plan-approval gates for workspace tools."""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from ...plan_gates import is_plan_approved
from ...skills_registry import SkillPolicy
from ...state import WorkspaceState
from ...tagged_file_policy import tagged_files_mode_guard

logger = logging.getLogger(__name__)


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


def _search_policy_error(error_code: str, message: str) -> str:
    return json.dumps(
        {
            "status": "error",
            "tool": "google_search",
            "errorCode": error_code,
            "message": message,
            "retryable": False,
            "suggestedNextCall": "none: report that live web research is unavailable for this run",
        }
    )


def _count(context: dict, key: str) -> int:
    try:
        return max(0, int(context.get(key, 0) or 0))
    except (TypeError, ValueError):
        return 0


def run_search_call_limit() -> int:
    """Successful searches a single run may spend.

    Raised from 3. `skills/research/SKILL.md` asks for a minimum of 4 credible
    sources in its cheapest mode and 30 in its most thorough, and section 4 spends
    2-3 searches before the plan gate. A budget of 3 could not satisfy the cheapest
    mode even when every call succeeded.
    """
    return max(1, _env_int("GOOGLE_SEARCH_MAX_CALLS_PER_RUN", 12))


def is_pre_plan_phase(workspace_state: WorkspaceState) -> bool:
    policy = get_active_skill_policy(workspace_state)
    return bool(policy.requires_hitl_plan) and not is_plan_approved(workspace_state)


def record_search_success(workspace_state: WorkspaceState, tool_name: str) -> None:
    """Charge a search budget only for a call that actually did the work.

    The budget used to be charged in the guard below, before the call ran, so a
    failed search spent it too. Three upstream failures could exhaust a run's whole
    allowance without gathering a single source.

    Pre-plan and post-approval searches are charged to different counters. They
    shared one before, so section 4's preliminary searches consumed the budget that
    section 6 needs after the user approves the plan.

    Both web tools consume the pre-plan allowance. That gate exists to stop a run
    doing its research before the user has approved a plan, and `url_context`
    gathers evidence just as `google_search` does. Only `google_search` draws on the
    post-approval run budget; `url_context` reads links the user supplied.
    """
    context = workspace_state.context
    if is_pre_plan_phase(workspace_state):
        context["pre_plan_search_count"] = _count(context, "pre_plan_search_count") + 1
        return
    if tool_name == "google_search":
        context["google_search_count"] = _count(context, "google_search_count") + 1


def apply_search_policy_guard(workspace_state: WorkspaceState, tool_name: str) -> Optional[str]:
    """Tagged-files gates and optional pre-plan search limits (shared by web tools)."""
    blocked = tagged_files_mode_guard(workspace_state.context, tool_name)
    if blocked:
        return blocked
    context = workspace_state.context
    pre_plan = is_pre_plan_phase(workspace_state)
    if tool_name == "google_search":
        if bool(context.get("google_search_terminal_error")):
            logger.warning(
                "google_search blocked: circuit open for this run (attempts=%s successes=%s)",
                _count(context, "google_search_attempts"),
                _count(context, "google_search_count"),
            )
            return _search_policy_error(
                "SEARCH_CIRCUIT_OPEN",
                "Google Search is unavailable for this run after repeated upstream failures.",
            )
        limit = run_search_call_limit()
        # Successes no longer bound total work, so bound attempts separately. Without
        # this a run that only ever fails could call search forever.
        attempts = _count(context, "google_search_attempts")
        if attempts >= limit * 2:
            logger.warning(
                "google_search blocked: attempt ceiling reached (%s/%s)", attempts, limit * 2
            )
            return _search_policy_error(
                "SEARCH_ATTEMPT_LIMIT",
                f"Google Search attempt ceiling reached for this run ({attempts}/{limit * 2}).",
            )
        if not pre_plan:
            used = _count(context, "google_search_count")
            if used >= limit:
                logger.warning("google_search blocked: run budget spent (%s/%s)", used, limit)
                return _search_policy_error(
                    "SEARCH_CALL_LIMIT",
                    f"Google Search limit reached for this run ({used}/{limit}).",
                )
        context["google_search_attempts"] = attempts + 1
    if pre_plan:
        limit = max(0, int(get_active_skill_policy(workspace_state).pre_plan_search_limit or 0))
        used = _count(context, "pre_plan_search_count")
        if limit <= 0 or used >= limit:
            return plan_gate_with_presearch_message(used, limit)
    return None
