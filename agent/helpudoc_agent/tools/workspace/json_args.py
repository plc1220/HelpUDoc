"""Parse JSON tool arguments that may arrive as strings or native objects."""
from __future__ import annotations

import json
from typing import Any, Dict, List


def parse_json_list_arg(raw: Any) -> List[Any]:
    if isinstance(raw, list):
        return raw
    if raw is None:
        return []
    try:
        parsed = json.loads(str(raw or "[]"))
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def parse_json_dict_arg(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if raw is None:
        return {}
    try:
        parsed = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
