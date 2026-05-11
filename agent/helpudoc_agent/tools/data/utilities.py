"""JSON coercion, slugs, and small shared helpers."""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_slug(value: str, default: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", (value or "").strip()).strip("_")
    return slug or default
def _chart_title_from_path(path: Path) -> str:
    title = path.stem
    if title.endswith(".plotly"):
        title = title[: -len(".plotly")]
    return title.replace("_", " ")


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.ndarray,)):
        return value.tolist()
    if isinstance(value, (pd.Series, pd.Index)):
        return value.tolist()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value)} is not JSON serializable")


def _json_dump(payload: Any) -> str:
    return json.dumps(payload, default=_json_default, ensure_ascii=False)


def _coerce_plotly_spec(payload: Any) -> Optional[Dict[str, Any]]:
    """Attempt to coerce a payload into a Plotly JSON-serializable dict."""
    if payload is None:
        return None

    try:  # pragma: no cover - optional dependency
        import plotly.io as pio  # type: ignore
    except Exception:  # pragma: no cover - optional dependency
        pio = None

    try:
        if hasattr(payload, "to_plotly_json"):
            if pio is not None:
                return json.loads(pio.to_json(payload, validate=False))
            return payload.to_plotly_json()
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, list):
                return payload
    except Exception:  # pragma: no cover - defensive
        logger.warning("Failed to coerce Plotly spec", exc_info=True)
    return None


def _coerce_text_arg(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def _coerce_int_arg(
    value: Any,
    default: int,
    *,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> int:
    try:
        coerced = int(value if value is not None else default)
    except (TypeError, ValueError):
        coerced = int(default)
    if minimum is not None:
        coerced = max(minimum, coerced)
    if maximum is not None:
        coerced = min(maximum, coerced)
    return coerced


def _coerce_bool_arg(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return bool(default if value is None else value)

