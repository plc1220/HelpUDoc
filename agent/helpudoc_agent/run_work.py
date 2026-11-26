"""How close one run is to its step limit. Bound to the run's task, so runs never share it."""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any, Optional

_RUN_WORK: ContextVar[Optional[dict]] = ContextVar("helpudoc_run_work", default=None)

PARTIAL_NOTE = (
    "\n\n---\n*Lumo reached its work limit for this request, so this answer may be incomplete. "
    "Reply \"continue\" to carry on from here.*"
)


def bind_run_work() -> None:
    """Call at the start of the run's task, and again for a resume: each has its own limit."""
    _RUN_WORK.set({"first_step": None, "stopped": False})


def remaining_steps(config: Any) -> Optional[int]:
    """Steps left before the graph fails, or None when this is unknown (an unbound run)."""
    work = _RUN_WORK.get()
    if work is None or not isinstance(config, dict):
        return None
    step = (config.get("metadata") or {}).get("langgraph_step")
    limit = config.get("recursion_limit")
    if not isinstance(step, int) or not isinstance(limit, int):
        return None
    # A resumed thread keeps counting its steps, while the limit starts again.
    if work["first_step"] is None or step < work["first_step"]:
        work["first_step"] = step
    return limit - (step - work["first_step"])


def mark_stopped() -> None:
    work = _RUN_WORK.get()
    if work is not None:
        work["stopped"] = True


def stopped_at_the_limit() -> bool:
    work = _RUN_WORK.get()
    return bool(work and work["stopped"])
