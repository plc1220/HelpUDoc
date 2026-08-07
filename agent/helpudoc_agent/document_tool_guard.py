"""Per-run caching and loop breaking for trusted document inspection tools.

``inspect_document`` and ``search_document`` are deterministic, read-only
primitives, so two identical calls inside one run must produce the same answer.
This module lives at the trusted tool boundary (``GuardedTool``) and:

* serves an exact, argument-normalized cache for repeated identical calls, and
* returns a structured ``LOOP_BREAK`` result once the normalized call signature
  sequence repeats a short cycle (period 1-4) three times.

There is deliberately no "same file was read N times" cap: enumerable
multi-read batches (for example a Python tool-calling batch over every sheet)
and unique searches must never be throttled. Only an actually repeating cycle
is treated as a loop.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

DOCUMENT_TOOL_NAMES = frozenset({"inspect_document", "search_document"})

LOOP_BREAK_ERROR_CODE = "LOOP_BREAK"
MAX_CYCLE_PERIOD = 4
CYCLE_REPETITIONS = 3

RUN_STATE_CONTEXT_KEY = "_document_tool_run_state"

# Enough history for the longest detectable cycle with headroom for logging.
_MAX_TRACKED_SIGNATURES = 64

# Documented tool defaults. An omitted argument and an explicitly passed
# default are the same call, so both normalize to "absent".
_DEFAULT_ARGS: Dict[str, Dict[str, Any]] = {
    "inspect_document": {
        "page_start": 1,
        "page_end": 5,
        "item_start": 1,
        "item_end": 40,
        "sheet_name": None,
        "cell_range": None,
    },
    "search_document": {
        "max_results": 20,
    },
}

# ``inspect_document`` uses this range when ``cell_range`` is omitted.
_DEFAULT_CELL_RANGE = "A1:J25"

_WHITESPACE = re.compile(r"\s+")


def _normalize_path(value: str) -> str:
    normalized = _WHITESPACE.sub(" ", value.replace("\\", "/")).strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def _normalize_range(value: str) -> str:
    normalized = value.replace("$", "").replace(" ", "").upper()
    if ":" in normalized:
        start, _, end = normalized.partition(":")
        if start and start == end:
            normalized = start
    return normalized


def _normalize_value(key: str, value: Any) -> Any:
    if isinstance(value, str):
        if key in {"file_path", "path"}:
            return _normalize_path(value)
        if key in {"cell_range", "range"}:
            return _normalize_range(value)
        if key in {"sheet_name"}:
            return _WHITESPACE.sub(" ", value).strip()
        if key in {"query"}:
            # search_document already lowercases the query internally.
            return _WHITESPACE.sub(" ", value).strip().lower()
        return _WHITESPACE.sub(" ", value).strip()
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, dict):
        return {str(inner_key): _normalize_value(str(inner_key), inner_value) for inner_key, inner_value in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_value(key, item) for item in value]
    return value


def _is_default(tool_name: str, key: str, value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value:
        return True
    if key in {"cell_range", "range"} and value == _DEFAULT_CELL_RANGE:
        return True
    defaults = _DEFAULT_ARGS.get(tool_name, {})
    if key not in defaults:
        return False
    default_value = defaults[key]
    if default_value is None:
        return False
    try:
        return type(default_value)(value) == default_value  # type: ignore[call-arg]
    except (TypeError, ValueError):
        return value == default_value


def normalize_document_tool_signature(tool_name: str, payload: Any) -> Optional[str]:
    """Return a stable signature, or ``None`` when the call cannot be normalized.

    JSON key order, surrounding whitespace, and omitted/default-equivalent
    arguments are normalized away. Meaningfully different ranges, sheets, and
    queries stay distinct.
    """
    if tool_name not in DOCUMENT_TOOL_NAMES or not isinstance(payload, dict):
        return None
    normalized: Dict[str, Any] = {}
    for raw_key, raw_value in payload.items():
        key = str(raw_key)
        if key in {"id", "name", "type", "tool_call_id"}:
            continue
        value = _normalize_value(key, raw_value)
        if _is_default(tool_name, key, value):
            continue
        normalized[key] = value
    try:
        return json.dumps(
            {"tool": tool_name, "args": normalized},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    except (TypeError, ValueError):
        return None


def reset_document_tool_run_state(context: Any) -> None:
    """Drop cached results and signature history for a new top-level run/resume."""
    if isinstance(context, dict):
        context.pop(RUN_STATE_CONTEXT_KEY, None)


def _run_state(context: Dict[str, Any]) -> Dict[str, Any]:
    state = context.get(RUN_STATE_CONTEXT_KEY)
    if not isinstance(state, dict) or "signatures" not in state or "cache" not in state:
        state = {"signatures": [], "cache": {}}
        context[RUN_STATE_CONTEXT_KEY] = state
    return state


def detect_signature_cycle(sequence: List[str]) -> Optional[Tuple[int, List[str]]]:
    """Return ``(period, block)`` when the tail is one block repeated 3 times."""
    for period in range(1, MAX_CYCLE_PERIOD + 1):
        window = period * CYCLE_REPETITIONS
        if len(sequence) < window:
            continue
        block = sequence[-period:]
        if sequence[-window:] == block * CYCLE_REPETITIONS:
            return period, block
    return None


def _loop_break_envelope(tool_name: str, period: int, block: List[str]) -> str:
    if period == 1:
        detail = "the same call was issued three times"
    else:
        detail = f"the same cycle of {period} calls was issued three times"
    body = {
        "status": "error",
        "tool": tool_name,
        "message": (
            f"Document tool loop broken: {detail}. "
            "inspect_document and search_document are deterministic, so repeating them "
            "cannot produce new information. Use the evidence already gathered, request a "
            "different file/sheet/range/query, or tell the user what is missing."
        ),
        "errorCode": LOOP_BREAK_ERROR_CODE,
        "retryable": False,
        "suggestedNextCall": (
            "none: answer from the evidence already collected, or ask the user one "
            "clarifying question"
        ),
        "cyclePeriod": period,
        "repetitions": CYCLE_REPETITIONS,
        "repeatedCalls": block,
    }
    return json.dumps(body, ensure_ascii=False, indent=2)


def check_document_tool_call(context: Any, tool_name: str, payload: Any) -> Optional[str]:
    """Return a short-circuit result (cache hit or LOOP_BREAK) or ``None``."""
    if not isinstance(context, dict):
        return None
    signature = normalize_document_tool_signature(tool_name, payload)
    if signature is None:
        return None
    state = _run_state(context)
    sequence: List[str] = list(state.get("signatures") or [])
    sequence.append(signature)
    state["signatures"] = sequence[-_MAX_TRACKED_SIGNATURES:]
    cycle = detect_signature_cycle(sequence)
    if cycle is not None:
        period, block = cycle
        return _loop_break_envelope(tool_name, period, block)
    cache = state.get("cache")
    if isinstance(cache, dict):
        cached = cache.get(signature)
        if isinstance(cached, str):
            return cached
    return None


def _is_cacheable_result(result: str) -> bool:
    text = result.strip()
    if not text.startswith("{"):
        # Legacy plain-text results are not guaranteed deterministic envelopes.
        return False
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return False
    if not isinstance(parsed, dict):
        return False
    status = str(parsed.get("status") or "").strip().lower()
    if status == "ok":
        return True
    if status == "error":
        if parsed.get("errorCode") == LOOP_BREAK_ERROR_CODE:
            return False
        return parsed.get("retryable") is False
    return False


def record_document_tool_result(context: Any, tool_name: str, payload: Any, result: Any) -> None:
    """Cache a deterministic document tool result for the rest of this run."""
    if not isinstance(context, dict) or not isinstance(result, str):
        return
    signature = normalize_document_tool_signature(tool_name, payload)
    if signature is None or not _is_cacheable_result(result):
        return
    state = _run_state(context)
    cache = state.get("cache")
    if not isinstance(cache, dict):
        cache = {}
        state["cache"] = cache
    cache[signature] = result
