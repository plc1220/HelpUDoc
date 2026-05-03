"""Optional Langfuse tracing for LangChain / LangGraph runs (self-hosted)."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Sequence

logger = logging.getLogger(__name__)


def _tracing_enabled() -> bool:
    raw = (os.getenv("LANGFUSE_ENABLED") or "").strip().lower()
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    # Legacy opt-out flag (default off when LANGFUSE_ENABLED unset)
    legacy = (os.getenv("LANGFUSE_TRACING_ENABLED") or "").strip().lower()
    return legacy in {"1", "true", "yes", "y", "on"}


def langfuse_langchain_callbacks() -> List[Any]:
    """Return Langfuse CallbackHandler instances when LANGFUSE_* env is configured."""
    if not _tracing_enabled():
        return []
    public_key = (os.getenv("LANGFUSE_PUBLIC_KEY") or "").strip()
    secret_key = (os.getenv("LANGFUSE_SECRET_KEY") or "").strip()
    base_url = (os.getenv("LANGFUSE_BASE_URL") or os.getenv("LANGFUSE_HOST") or "").strip()
    if not public_key or not secret_key:
        return []
    if not base_url:
        logger.warning(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set but LANGFUSE_BASE_URL "
            "(or LANGFUSE_HOST) is missing; Langfuse callbacks disabled."
        )
        return []
    try:
        from langfuse.langchain import CallbackHandler
    except ModuleNotFoundError as exc:
        logger.warning("Langfuse LangChain integration unavailable: %s", exc)
        return []
    return [CallbackHandler()]


def emit_langfuse_trace_payload(handlers: Sequence[Any]) -> Dict[str, str]:
    """Best-effort trace id / URL for backend run metadata (non-blocking callers)."""
    trace_id = ""
    for h in handlers:
        if not h:
            continue
        for attr in ("get_trace_id", "last_trace_id"):
            if hasattr(h, attr):
                val = getattr(h, attr)
                if callable(val):
                    try:
                        val = val()
                    except Exception:
                        val = None
                if isinstance(val, str) and val.strip():
                    trace_id = val.strip()
                    break
        if trace_id:
            break
        root = getattr(h, "root", None)
        rid = getattr(root, "id", None) if root is not None else None
        if isinstance(rid, str) and rid.strip():
            trace_id = rid.strip()
            break
        lf = getattr(h, "langfuse", None) or getattr(h, "client", None)
        rid = getattr(lf, "trace_id", None) if lf is not None else None
        if isinstance(rid, str) and rid.strip():
            trace_id = rid.strip()
            break
    if not trace_id:
        return {}
    out: Dict[str, str] = {"traceId": trace_id}
    trace_url = _resolve_trace_url_via_sdk(trace_id)
    if trace_url:
        out["traceUrl"] = trace_url
    return out


def _resolve_trace_url_via_sdk(trace_id: str) -> str:
    """Project-scoped trace URL from Langfuse Python SDK v3+; empty string if unavailable."""
    tid = (trace_id or "").strip()
    if not tid:
        return ""
    try:
        from langfuse import get_client

        client = get_client()
        getter = getattr(client, "get_trace_url", None)
        if not callable(getter):
            return ""
        try:
            url = getter(trace_id=tid)
        except TypeError:
            url = getter(tid)
        if isinstance(url, str) and url.strip():
            return url.strip()
    except Exception:
        logger.debug("Langfuse get_trace_url failed for trace_id=%s", tid, exc_info=True)
    return ""


def patch_current_trace_skill(skill_id: str) -> None:
    """Merge helpudoc_skill_id into the active Langfuse trace after load_skill (SDK v3+)."""
    if not _tracing_enabled():
        return
    sid = (skill_id or "").strip()
    if not sid:
        return
    try:
        from langfuse import get_client

        client = get_client()
        updater = getattr(client, "update_current_trace", None)
        if callable(updater):
            updater(metadata={"helpudoc_skill_id": sid})
            return
    except Exception:
        logger.debug("Langfuse patch_current_trace_skill (get_client) failed", exc_info=True)
    try:
        from langfuse.decorators import langfuse_context

        updater = getattr(langfuse_context, "update_current_trace", None)
        if callable(updater):
            updater(metadata={"helpudoc_skill_id": sid})
    except Exception:
        logger.debug("Langfuse patch_current_trace_skill (langfuse_context) failed", exc_info=True)
