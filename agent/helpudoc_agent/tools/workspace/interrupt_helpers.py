"""LangGraph interrupt helpers for human-in-the-loop tools."""
from __future__ import annotations

import logging
from typing import Any, Dict, Set

logger = logging.getLogger(__name__)


def _interrupt(payload: Dict[str, Any]) -> Any:
    """Delegate to ``tools_and_schemas.interrupt`` so tests can monkeypatch one symbol."""
    from helpudoc_agent import tools_and_schemas

    return tools_and_schemas.interrupt(payload)


def dict_has_keys(value: Any, keys: Set[str]) -> bool:
    return isinstance(value, dict) and any(key in value for key in keys)


def interrupt_with_retry(
    payload: Dict[str, Any],
    *,
    valid_keys: Set[str],
    stale_keys: Set[str],
    label: str,
    attempts: int = 2,
) -> Any:
    """Retry once when an interrupt receives a stale resume payload from a prior step."""
    response: Any = None
    for attempt in range(attempts):
        response = _interrupt(payload)
        if not dict_has_keys(response, stale_keys) or dict_has_keys(response, valid_keys):
            return response
        logger.warning(
            "%s received stale interrupt resume payload on attempt %s; retrying",
            label,
            attempt + 1,
        )
    raise RuntimeError(
        f"{label} did not receive a matching human response. "
        "The run was stopped to avoid re-entering the same interrupt loop."
    )


def first_decision(response: Any) -> Dict[str, Any]:
    if not isinstance(response, dict):
        return {}
    decisions = response.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        return {}
    first = decisions[0]
    return first if isinstance(first, dict) else {}


def edited_action_args(decision: Dict[str, Any]) -> Dict[str, Any]:
    edited_action = decision.get("edited_action") or decision.get("editedAction")
    if not isinstance(edited_action, dict):
        return {}
    args = edited_action.get("args")
    return args if isinstance(args, dict) else {}
