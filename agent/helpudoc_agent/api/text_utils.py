"""Small string and exception helpers for the HTTP API."""
from __future__ import annotations

import os
import re
from typing import Optional

from .constants import _LOADED_SKILL_OUTPUT_ID, _LOCAL_DEV_AGENT_JWT_SECRET


def _skill_id_from_loaded_skill_output(text: str) -> Optional[str]:
    if not isinstance(text, str) or not text.strip():
        return None
    match = _LOADED_SKILL_OUTPUT_ID.search(text)
    if not match:
        return None
    cleaned = match.group(1).strip()
    return cleaned or None


def _get_agent_jwt_secret() -> str:
    configured = os.getenv("AGENT_JWT_SECRET", "").strip()
    if configured:
        return configured
    env = os.getenv("NODE_ENV", "").strip().lower()
    if not env or env == "development":
        return _LOCAL_DEV_AGENT_JWT_SECRET
    return ""


def _format_exception(exc: BaseException) -> str:
    if isinstance(exc, BaseExceptionGroup):
        parts = [_format_exception(inner) for inner in exc.exceptions]
        message = "; ".join(part for part in parts if part)
        return message or (str(exc) or repr(exc))
    return str(exc) or repr(exc)


def _clean_langfuse_value(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _safe_langfuse_tag(prefix: str, value: object) -> Optional[str]:
    cleaned = _clean_langfuse_value(value)
    if not cleaned:
        return None
    normalized = re.sub(r"[^A-Za-z0-9_.:-]+", "-", cleaned).strip("-")
    if not normalized:
        return None
    return f"{prefix}:{normalized[:96]}"
