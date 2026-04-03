"""Helpers for normalizing interrupt payloads into frontend stream events."""
from __future__ import annotations

import ast
import hashlib
import json
import logging
from typing import Any, Dict, List


logger = logging.getLogger(__name__)


def _build_interrupt_id(interrupt_value: Dict[str, Any]) -> str:
    canonical = {
        key: value
        for key, value in interrupt_value.items()
        if key not in {"interrupt_id", "interruptId", "id"}
    }
    digest = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return f"interrupt-{digest[:20]}"


def _normalize_interrupt_payload(interrupt_value: Dict[str, Any], interrupt_id: str | None = None) -> Dict[str, Any]:
    action_requests = interrupt_value.get("action_requests")
    review_configs = interrupt_value.get("review_configs")
    actions = interrupt_value.get("actions")
    payload: Dict[str, Any] = {
        "type": "interrupt",
        "kind": interrupt_value.get("kind"),
        "title": interrupt_value.get("title"),
        "description": interrupt_value.get("description"),
        "stepIndex": interrupt_value.get("step_index"),
        "stepCount": interrupt_value.get("step_count"),
        "actions": actions if isinstance(actions, list) else [],
        "actionRequests": action_requests if isinstance(action_requests, list) else [],
        "reviewConfigs": review_configs if isinstance(review_configs, list) else [],
    }
    response_spec = interrupt_value.get("response_spec")
    if isinstance(response_spec, dict):
        payload["responseSpec"] = response_spec
    display_payload = interrupt_value.get("display_payload")
    if isinstance(display_payload, dict):
        payload["displayPayload"] = display_payload
    normalized_interrupt_id = (
        interrupt_id.strip()
        if isinstance(interrupt_id, str) and interrupt_id.strip()
        else _build_interrupt_id(interrupt_value)
    )
    payload["interruptId"] = normalized_interrupt_id
    return payload


def normalize_interrupt_payload_value(interrupt_value: Dict[str, Any], interrupt_id: str | None = None) -> Dict[str, Any]:
    return _normalize_interrupt_payload(interrupt_value, interrupt_id)


def _parse_json_list(raw: Any) -> List[Any]:
    try:
        parsed = json.loads(str(raw or "[]"))
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _parse_json_dict(raw: Any) -> Dict[str, Any]:
    try:
        parsed = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_clarification_questions(raw: Any) -> List[Dict[str, Any]]:
    parsed_questions: List[Dict[str, Any]] = []
    for index, item in enumerate(_parse_json_list(raw)):
        if not isinstance(item, dict):
            continue
        header = str(item.get("header") or item.get("title") or f"Question {index + 1}").strip()
        question = str(item.get("question") or item.get("prompt") or item.get("description") or "").strip()
        if not header or not question:
            continue
        options: List[Dict[str, str]] = []
        raw_options = item.get("options")
        if isinstance(raw_options, list):
            for option_index, option in enumerate(raw_options):
                if isinstance(option, str) and option.strip():
                    label = option.strip()
                    options.append(
                        {
                            "id": f"{header.lower().replace(' ', '-')}-{option_index + 1}",
                            "label": label,
                            "value": label,
                        }
                    )
                    continue
                if not isinstance(option, dict):
                    continue
                label = str(option.get("label") or option.get("value") or "").strip()
                value = str(option.get("value") or label).strip()
                if not label or not value:
                    continue
                parsed_option = {
                    "id": str(option.get("id") or f"{header.lower().replace(' ', '-')}-{option_index + 1}").strip(),
                    "label": label,
                    "value": value,
                }
                description = str(option.get("description") or "").strip()
                if description:
                    parsed_option["description"] = description
                options.append(parsed_option)
        parsed_question = {
            "id": str(item.get("id") or header.lower().replace(" ", "-")).strip(),
            "header": header,
            "question": question,
        }
        if options:
            parsed_question["options"] = options
        parsed_questions.append(parsed_question)
    return parsed_questions


def _parse_clarification_choices(raw: Any) -> List[Dict[str, str]]:
    parsed_choices: List[Dict[str, str]] = []
    for index, item in enumerate(_parse_json_list(raw)):
        if isinstance(item, str) and item.strip():
            label = item.strip()
            parsed_choices.append(
                {
                    "id": f"choice-{index + 1}",
                    "label": label,
                    "value": label,
                }
            )
            continue
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or item.get("value") or "").strip()
        value = str(item.get("value") or label).strip()
        if not label or not value:
            continue
        parsed_choice = {
            "id": str(item.get("id") or f"choice-{index + 1}").strip(),
            "label": label,
            "value": value,
        }
        description = str(item.get("description") or "").strip()
        if description:
            parsed_choice["description"] = description
        parsed_choices.append(parsed_choice)
    return parsed_choices


def _build_clarification_payload(args: Dict[str, Any]) -> Dict[str, Any] | None:
    prompt_title = str(args.get("title") or "").strip()
    if not prompt_title:
        return None

    parsed_questions = _parse_clarification_questions(args.get("questions_json"))
    parsed_choices = _parse_clarification_choices(args.get("options_json"))
    allow_freeform = bool(args.get("allow_freeform", True))
    multi_select = bool(args.get("multi_select", False))
    submit_label = str(args.get("submit_label") or "Continue").strip() or "Continue"
    placeholder = str(args.get("placeholder") or "").strip()

    input_mode = "text"
    if not parsed_questions:
        if parsed_choices and allow_freeform:
            input_mode = "text_or_choice"
        elif parsed_choices:
            input_mode = "choice"

    action_choices = [] if parsed_questions else parsed_choices
    interrupt_value: Dict[str, Any] = {
        "kind": "clarification",
        "title": prompt_title,
        "description": str(args.get("description") or "").strip(),
        "step_index": max(0, int(args.get("step_index") or 0)),
        "step_count": max(1, int(args.get("step_count") or 1)),
        "actions": [
            {
                "id": choice["id"],
                "label": choice["label"],
                "style": "secondary",
                "inputMode": "none",
                "value": choice["value"],
                **({"payload": {"selectedChoiceId": choice["id"]}} if choice.get("id") else {}),
            }
            for choice in action_choices
        ]
        + (
            [
                {
                    "id": "clarification-text",
                    "label": submit_label,
                    "style": "primary",
                    "inputMode": "text",
                    "placeholder": placeholder,
                    "submitLabel": submit_label,
                }
            ]
            if allow_freeform or not parsed_choices
            else []
        ),
        "response_spec": {
            "inputMode": input_mode,
            "multiple": multi_select,
            "submitLabel": submit_label,
            "placeholder": placeholder,
            "choices": parsed_choices,
            **({"questions": parsed_questions} if parsed_questions else {}),
        },
        "display_payload": _parse_json_dict(args.get("context_json")),
    }
    return _normalize_interrupt_payload(interrupt_value)


def _build_human_action_payload(args: Dict[str, Any]) -> Dict[str, Any] | None:
    prompt_title = str(args.get("title") or "").strip()
    if not prompt_title:
        return None

    parsed_actions: List[Dict[str, Any]] = []
    for index, item in enumerate(_parse_json_list(args.get("actions_json"))):
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
        parsed_actions.append(action)

    if not parsed_actions:
        return None

    interrupt_kind = str(args.get("kind") or "approval").strip().lower()
    if interrupt_kind not in {"approval", "clarification"}:
        interrupt_kind = "approval"

    interrupt_value: Dict[str, Any] = {
        "kind": interrupt_kind,
        "title": prompt_title,
        "description": str(args.get("description") or "").strip(),
        "step_index": max(0, int(args.get("step_index") or 0)),
        "step_count": max(1, int(args.get("step_count") or 1)),
        "actions": parsed_actions,
        "display_payload": _parse_json_dict(args.get("context_json")),
    }
    return _normalize_interrupt_payload(interrupt_value)


def extract_interrupt_payload_from_tool_call(tool_name: str, tool_input: str) -> Dict[str, Any] | None:
    """Build an interrupt payload directly from a clarification/action tool call."""
    try:
        parsed = ast.literal_eval((tool_input or "").strip())
    except (ValueError, SyntaxError):
        logger.warning("Failed to parse interrupt tool input: %s", (tool_input or "")[:240])
        return None
    if not isinstance(parsed, dict):
        return None
    if tool_name == "request_clarification":
        return _build_clarification_payload(parsed)
    if tool_name == "request_human_action":
        return _build_human_action_payload(parsed)
    return None


def extract_interrupt_payload_from_tool_text(text: str) -> Dict[str, Any] | None:
    """Parse stringified `Interrupt(value=..., id='...')` tool outputs into stream payloads."""
    raw = (text or "").strip()
    if not raw.startswith("Interrupt(value="):
        return None

    prefix = "Interrupt(value="
    suffix_marker = ", id="
    if not raw.endswith(")"):
        return None
    suffix_index = raw.rfind(suffix_marker)
    if suffix_index <= len(prefix):
        return None

    value_literal = raw[len(prefix):suffix_index].strip()
    id_literal = raw[suffix_index + len(suffix_marker):-1].strip()

    try:
        interrupt_value = ast.literal_eval(value_literal)
        interrupt_id = ast.literal_eval(id_literal)
    except (ValueError, SyntaxError):
        logger.warning("Failed to parse interrupt tool output: %s", raw[:240])
        return None

    if not isinstance(interrupt_value, dict) or not isinstance(interrupt_id, str):
        return None

    return _normalize_interrupt_payload(interrupt_value, interrupt_id)
