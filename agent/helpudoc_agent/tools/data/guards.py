"""Strict dashboard mode and query-plan guard helpers."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from .constants import DATA_FILE_EXTENSIONS, STRICT_DASHBOARD_DIMENSION_FIELDS

from ...state import WorkspaceState

def _query_looks_aggregated(query: str) -> bool:
    if re.search(r"\bover\s*\(", query, re.IGNORECASE):
        return False
    return bool(
        re.search(r"\bgroup\s+by\b", query, re.IGNORECASE)
        or re.search(r"\bhaving\b", query, re.IGNORECASE)
    )


def _get_dashboard_mode(workspace_state: WorkspaceState) -> Dict[str, Any]:
    context = getattr(workspace_state, "context", {}) or {}
    raw = context.get("dashboard_mode")
    if isinstance(raw, dict):
        return raw
    active_skill = str(context.get("active_skill") or "").strip()
    tagged_files = context.get("tagged_files") or []
    tagged_dataset_paths = [
        str(path).strip()
        for path in tagged_files
        if str(path).strip() and Path(str(path).strip()).suffix.lower() in DATA_FILE_EXTENSIONS
    ]
    return {
        "strictLocalDatasets": active_skill == "data/dashboard" and bool(tagged_dataset_paths),
        "taggedDatasetPaths": tagged_dataset_paths,
    }


def _is_strict_dashboard_mode(workspace_state: WorkspaceState) -> bool:
    mode = _get_dashboard_mode(workspace_state)
    return bool(mode.get("strictLocalDatasets"))


def _is_plan_approved(workspace_state: WorkspaceState) -> bool:
    context = getattr(workspace_state, "context", {}) or {}
    if context.get("skip_plan_approvals"):
        return True
    return bool(context.get("plan_approved"))


def _dashboard_plan_gate_message() -> str:
    return (
        "Dashboard planning mode is active. Draft the dashboard plan, call request_plan_approval, "
        "and wait for approval before running aggregate analysis or generating charts."
    )


def _looks_like_preview_query(query: str) -> bool:
    if _query_looks_aggregated(query):
        return False
    limit_match = re.search(r"\blimit\s+(\d+)\b", query, re.IGNORECASE)
    if limit_match:
        try:
            return int(limit_match.group(1)) <= 50
        except ValueError:
            return False
    return bool(re.search(r"\bselect\s+\*\s+from\b", query, re.IGNORECASE))


def _extract_dashboard_dimension_signature(query: str) -> Optional[str]:
    if not _query_looks_aggregated(query):
        return None
    lower = query.lower()
    matched = [
        field
        for field in STRICT_DASHBOARD_DIMENSION_FIELDS
        if re.search(rf"\b{re.escape(field)}\b", lower)
    ]
    if not matched:
        return None
    return "|".join(sorted(set(matched)))
