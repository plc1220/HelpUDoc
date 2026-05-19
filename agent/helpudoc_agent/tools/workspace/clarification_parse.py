"""Parse options/questions JSON for request_clarification."""
from __future__ import annotations

from typing import Any, Dict, List

from .json_args import parse_json_list_arg


def _choice_id(prefix: str, index: int) -> str:
    return f"{prefix}-{index + 1}"


def _optional_description(item: dict) -> dict[str, str]:
    desc = str(item.get("description") or "").strip()
    return {"description": desc} if desc else {}


def parse_choice_item(item: Any, index: int, *, id_prefix: str = "choice") -> Dict[str, str] | None:
    if isinstance(item, str) and item.strip():
        label = item.strip()
        return {"id": _choice_id(id_prefix, index), "label": label, "value": label}
    if not isinstance(item, dict):
        return None
    label = str(item.get("label") or item.get("value") or "").strip()
    value = str(item.get("value") or label).strip()
    if not label or not value:
        return None
    return {
        "id": str(item.get("id") or _choice_id(id_prefix, index)).strip(),
        "label": label,
        "value": value,
        **_optional_description(item),
    }


def parse_choices_from_json(options_json: str) -> List[Dict[str, str]]:
    parsed: List[Dict[str, str]] = []
    for index, item in enumerate(parse_json_list_arg(options_json)):
        choice = parse_choice_item(item, index)
        if choice:
            parsed.append(choice)
    return parsed


def parse_questions_from_json(questions_json: str) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for index, item in enumerate(parse_json_list_arg(questions_json)):
        if not isinstance(item, dict):
            continue
        header = str(item.get("header") or item.get("title") or f"Question {index + 1}").strip()
        question = str(item.get("question") or item.get("prompt") or item.get("description") or "").strip()
        if not header or not question:
            continue
        id_slug = header.lower().replace(" ", "-")
        question_options: List[Dict[str, str]] = []
        raw_options = item.get("options")
        if isinstance(raw_options, list):
            for option_index, option in enumerate(raw_options):
                choice = parse_choice_item(option, option_index, id_prefix=id_slug)
                if choice:
                    question_options.append(choice)
        parsed.append(
            {
                "id": str(item.get("id") or id_slug).strip(),
                "header": header,
                "question": question,
                **({"options": question_options} if question_options else {}),
            }
        )
    return parsed


def clarification_input_mode(
    parsed_choices: List[Dict[str, str]],
    parsed_questions: List[Dict[str, Any]],
    *,
    allow_freeform: bool,
) -> str:
    if parsed_questions:
        return "text"
    if parsed_choices and allow_freeform:
        return "text_or_choice"
    if parsed_choices:
        return "choice"
    return "text"
