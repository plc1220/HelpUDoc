"""Optional Langfuse tracing for LangChain / LangGraph runs (self-hosted)."""
from __future__ import annotations

import logging
import os
from typing import Any, List

logger = logging.getLogger(__name__)


def _tracing_enabled() -> bool:
    raw = (os.getenv("LANGFUSE_TRACING_ENABLED") or "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


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
