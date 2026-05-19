"""Parse human-action button definitions from tool arguments."""
from __future__ import annotations

from typing import Any, Dict, List

from .json_args import parse_json_list_arg


def parse_human_actions(raw: Any) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for index, item in enumerate(parse_json_list_arg(raw)):
        if not isinstance(item, dict):
            continue
        action_id = str(item.get("id") or f"action-{index + 1}").strip()
        label = str(item.get("label") or "").strip()
        if not action_id or not label:
            continue
        style = str(item.get("style") or "secondary").strip().lower()
        if style not in {"primary", "secondary", "danger"}:
            style = "secondary"
        input_mode = str(item.get("inputMode") or "none").strip().lower()
        if input_mode not in {"none", "text"}:
            input_mode = "none"
        action: Dict[str, Any] = {
            "id": action_id,
            "label": label,
            "style": style,
            "inputMode": input_mode,
        }
        placeholder = str(item.get("placeholder") or "").strip()
        if placeholder:
            action["placeholder"] = placeholder
        submit_label = str(item.get("submitLabel") or "").strip()
        if submit_label:
            action["submitLabel"] = submit_label
        if isinstance(item.get("confirm"), bool):
            action["confirm"] = item["confirm"]
        value = str(item.get("value") or "").strip()
        if value:
            action["value"] = value
        if isinstance(item.get("payload"), dict):
            action["payload"] = item["payload"]
        parsed.append(action)
    return parsed
