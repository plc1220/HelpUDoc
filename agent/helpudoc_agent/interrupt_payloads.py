"""Helpers for normalizing interrupt payloads into frontend stream events."""
from __future__ import annotations

import ast
import hashlib
import json
import logging
import uuid
from typing import Any, Dict, List


logger = logging.getLogger(__name__)
_INTERRUPT_PAYLOAD_MARKER = "__HELPUDOC_INTERRUPT_PAYLOAD__"


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
    kind = interrupt_value.get("kind")
    a2ui_request = interrupt_value.get("a2uiRequest") or interrupt_value.get("a2ui_request")
    normalized_interrupt_id = (
        interrupt_id.strip()
        if isinstance(interrupt_id, str) and interrupt_id.strip()
        else _build_interrupt_id(interrupt_value)
    )
    payload["interruptId"] = normalized_interrupt_id
    if not isinstance(a2ui_request, dict) and kind == "clarification":
        response_spec_for_native = response_spec if isinstance(response_spec, dict) else {}
        display_payload_for_native = display_payload if isinstance(display_payload, dict) else {}
        gate_id = str(display_payload_for_native.get("gateId") or display_payload_for_native.get("gate_id") or "").strip()
        skill = str(display_payload_for_native.get("skill") or display_payload_for_native.get("skillId") or "").strip()
        is_style_chooser = bool(
            display_payload_for_native.get("chooser") == "style-previews"
            or display_payload_for_native.get("stylePreviews")
        )
        if is_style_chooser:
            component = "style.previewChooser"
            props = {
                "title": payload.get("title"),
                "description": payload.get("description"),
                "choices": response_spec_for_native.get("choices") or [],
                "previews": display_payload_for_native.get("stylePreviews")
                or display_payload_for_native.get("previews")
                or [],
                "submitLabel": response_spec_for_native.get("submitLabel") or "Continue",
                "multiple": bool(response_spec_for_native.get("multiple")),
            }
        else:
            component = "clarification.form"
            props = {
                "title": payload.get("title"),
                "description": payload.get("description"),
                "questions": response_spec_for_native.get("questions") or [],
                "choices": response_spec_for_native.get("choices") or [],
                "inputMode": response_spec_for_native.get("inputMode") or "text",
                "multiple": bool(response_spec_for_native.get("multiple")),
                "submitLabel": response_spec_for_native.get("submitLabel") or "Continue",
                "placeholder": response_spec_for_native.get("placeholder") or "",
            }
        a2ui_request = {
            "contract": "a2ui",
            "version": "0.9",
            "surfaceId": f"surface-{gate_id}" if gate_id else f"surface-{normalized_interrupt_id}",
            "component": component,
            "props": props,
            "gateId": gate_id or None,
            "skill": skill or None,
            "required": True,
            "resumeAction": {
                "endpoint": "respond",
                "actionId": "submit",
            },
            "metadata": display_payload_for_native,
        }
    if isinstance(a2ui_request, dict):
        payload["a2uiRequest"] = a2ui_request

    # Construct the uiRequest object. Native A2UI requests are the source of
    # truth when present; uiRequest is kept as a compatibility projection for
    # older frontend/status paths and backend gate validation.
    ui_request = None
    if isinstance(a2ui_request, dict):
        component = str(a2ui_request.get("component") or "").strip()
        props = a2ui_request.get("props") if isinstance(a2ui_request.get("props"), dict) else {}
        resume_action = a2ui_request.get("resumeAction") if isinstance(a2ui_request.get("resumeAction"), dict) else {}
        action_id = str(resume_action.get("actionId") or "submit").strip() or "submit"
        component_map = {
            "clarification.form": "clarification_form",
            "clarification_form": "clarification_form",
            "style.previewChooser": "style_preview_chooser",
            "style_preview_chooser": "style_preview_chooser",
            "approval.card": "approval",
            "approval": "approval",
        }
        legacy_component = component_map.get(component)
        if legacy_component:
            ui_request = {
                "id": normalized_interrupt_id,
                "component": legacy_component,
                "props": props,
                "resume": {
                    "action": action_id,
                },
            }

    if ui_request is None and kind == "clarification":
        # Check if it's slide style selection chooser
        is_style_chooser = False
        if isinstance(display_payload, dict):
            if display_payload.get("chooser") == "style-previews" or "stylePreviews" in display_payload:
                is_style_chooser = True

        if is_style_chooser:
            previews = []
            if isinstance(display_payload, dict):
                previews = display_payload.get("stylePreviews") or display_payload.get("previews") or []

            choices = []
            if isinstance(response_spec, dict):
                choices = response_spec.get("choices") or []

            ui_request = {
                "id": normalized_interrupt_id,
                "component": "style_preview_chooser",
                "props": {
                    "previews": previews,
                    "choices": choices,
                    "title": payload.get("title"),
                    "description": payload.get("description")
                },
                "resume": {
                    "action": "style_choice",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "selectedChoiceId": {"type": "string"},
                            "styleSelection": {"type": "string"}
                        },
                        "required": ["selectedChoiceId"]
                    }
                }
            }
        else:
            # Multi-question or single text clarification form
            questions = []
            if isinstance(response_spec, dict):
                questions = response_spec.get("questions") or []

            choices = []
            if isinstance(response_spec, dict):
                choices = response_spec.get("choices") or []

            ui_request = {
                "id": normalized_interrupt_id,
                "component": "clarification_form",
                "props": {
                    "questions": questions,
                    "choices": choices,
                    "title": payload.get("title"),
                    "description": payload.get("description"),
                    "inputMode": response_spec.get("inputMode") if isinstance(response_spec, dict) else "text",
                    "multiple": response_spec.get("multiple") if isinstance(response_spec, dict) else False,
                    "submitLabel": response_spec.get("submitLabel") if isinstance(response_spec, dict) else "Continue"
                },
                "resume": {
                    "action": "submit",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "response": {"type": "string"},
                            "selectedChoiceId": {"type": "string"},
                            "selectedChoiceIds": {"type": "array", "items": {"type": "string"}},
                            "answers": {"type": "object"}
                        }
                    }
                }
            }
    elif kind == "approval":
        ui_request = {
            "id": normalized_interrupt_id,
            "component": "approval",
            "props": {
                "title": payload.get("title"),
                "description": payload.get("description"),
                "displayPayload": display_payload,
                "actions": payload.get("actions", []),
                "actionRequests": payload.get("actionRequests", []),
                "reviewConfigs": payload.get("reviewConfigs", [])
            },
            "resume": {
                "action": "approve_reject",
                "schema": {
                    "type": "object",
                    "properties": {
                        "decision": {"type": "string"},
                        "feedback": {"type": "string"}
                    },
                    "required": ["decision"]
                }
            }
        }

    if ui_request is not None:
        payload["uiRequest"] = ui_request

    return payload


def normalize_interrupt_payload_value(interrupt_value: Dict[str, Any], interrupt_id: str | None = None) -> Dict[str, Any]:
    return _normalize_interrupt_payload(interrupt_value, interrupt_id)


def encode_interrupt_payload_marker(interrupt_value: Dict[str, Any]) -> str:
    """Encode a raw interrupt value as a machine-only assistant message marker."""
    return f"{_INTERRUPT_PAYLOAD_MARKER}{json.dumps(interrupt_value, ensure_ascii=False, separators=(',', ':'))}"


def strip_interrupt_payload_marker(text: str) -> str:
    """Remove any machine-only interrupt marker from user-visible assistant text."""
    marker_index = (text or "").find(_INTERRUPT_PAYLOAD_MARKER)
    if marker_index < 0:
        return text
    return text[:marker_index].rstrip()


def _parse_json_list(raw: Any) -> List[Any]:
    if isinstance(raw, list):
        return raw
    if raw is None:
        return []
    try:
        parsed = json.loads(str(raw or "[]"))
    except (TypeError, json.JSONDecodeError):
        try:
            parsed = ast.literal_eval(str(raw or "[]"))
        except (ValueError, SyntaxError):
            return []
    return parsed if isinstance(parsed, list) else []


def _parse_json_dict(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if raw is None:
        return {}
    try:
        parsed = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError):
        try:
            parsed = ast.literal_eval(str(raw or "{}"))
        except (ValueError, SyntaxError):
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _coerce_int(raw: Any, *, default: int, minimum: int) -> int:
    try:
        parsed = int(raw if raw is not None else default)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, parsed)


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


def build_clarification_interrupt_payload(
    *,
    title: str,
    description: str = "",
    choices: List[Dict[str, str]] | None = None,
    allow_freeform: bool = True,
    multi_select: bool = False,
    placeholder: str = "",
    submit_label: str = "Continue",
    step_index: int = 0,
    step_count: int = 1,
    display_payload: Dict[str, Any] | None = None,
) -> Dict[str, Any] | None:
    """Build a normalized clarification interrupt dict for the frontend stream."""
    raw_value = build_clarification_interrupt_value(
        title=title,
        description=description,
        choices=choices,
        questions=None,
        allow_freeform=allow_freeform,
        multi_select=multi_select,
        placeholder=placeholder,
        submit_label=submit_label,
        step_index=step_index,
        step_count=step_count,
        display_payload=display_payload,
    )
    if raw_value is None:
        return None
    return _normalize_interrupt_payload(raw_value)


def build_clarification_interrupt_value(
    *,
    title: str,
    description: str = "",
    choices: List[Dict[str, str]] | None = None,
    questions: List[Dict[str, Any]] | None = None,
    allow_freeform: bool = True,
    multi_select: bool = False,
    placeholder: str = "",
    submit_label: str = "Continue",
    step_index: int = 0,
    step_count: int = 1,
    display_payload: Dict[str, Any] | None = None,
) -> Dict[str, Any] | None:
    """Build the raw interrupt value passed to langgraph.types.interrupt()."""
    return _build_clarification_interrupt_value(
        {
            "title": title,
            "description": description,
            "options_json": json.dumps(choices or [], ensure_ascii=False),
            "questions_json": json.dumps(questions or [], ensure_ascii=False),
            "allow_freeform": allow_freeform,
            "multi_select": multi_select,
            "placeholder": placeholder,
            "submit_label": submit_label,
            "step_index": step_index,
            "step_count": step_count,
            "context_json": json.dumps(display_payload or {}, ensure_ascii=False),
        }
    )


def _build_clarification_payload(args: Dict[str, Any]) -> Dict[str, Any] | None:
    raw_value = _build_clarification_interrupt_value(args)
    if raw_value is None:
        return None
    return _normalize_interrupt_payload(raw_value)


def _build_clarification_interrupt_value(args: Dict[str, Any]) -> Dict[str, Any] | None:
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
    display_payload = _parse_json_dict(args.get("context_json"))
    gate_id = str(display_payload.get("gateId") or display_payload.get("gate_id") or "").strip()
    skill = str(display_payload.get("skill") or display_payload.get("skillId") or "").strip()
    surface_id = f"surface-{gate_id}" if gate_id else f"surface-clarification-{uuid.uuid4().hex[:8]}"
    is_style_chooser = bool(
        display_payload.get("chooser") == "style-previews" or display_payload.get("stylePreviews")
    )
    if is_style_chooser:
        component = "style.previewChooser"
        a2ui_props: Dict[str, Any] = {
            "title": prompt_title,
            "description": str(args.get("description") or "").strip(),
            "choices": parsed_choices,
            "previews": display_payload.get("stylePreviews") or display_payload.get("previews") or [],
            "submitLabel": submit_label,
            "multiple": multi_select,
        }
    else:
        component = "clarification.form"
        a2ui_props = {
            "title": prompt_title,
            "description": str(args.get("description") or "").strip(),
            "questions": parsed_questions,
            "choices": parsed_choices,
            "inputMode": input_mode,
            "multiple": multi_select,
            "submitLabel": submit_label,
            "placeholder": placeholder,
        }
    a2ui_request = {
        "contract": "a2ui",
        "version": "0.9",
        "surfaceId": surface_id,
        "component": component,
        "props": a2ui_props,
        "gateId": gate_id or None,
        "skill": skill or None,
        "required": True,
        "resumeAction": {
            "endpoint": "respond",
            "actionId": "submit",
        },
        "metadata": display_payload,
    }
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
        "display_payload": display_payload,
        "a2uiRequest": a2ui_request,
    }
    return interrupt_value


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

    display_payload = _parse_json_dict(args.get("context_json"))
    gate_id = str(display_payload.get("gateId") or display_payload.get("gate_id") or "").strip()
    skill = str(display_payload.get("skill") or display_payload.get("skillId") or "").strip()
    surface_id = f"surface-{gate_id}" if gate_id else f"surface-action-{uuid.uuid4().hex[:8]}"
    a2ui_request = {
        "contract": "a2ui",
        "version": "0.9",
        "surfaceId": surface_id,
        "component": "approval.card",
        "props": {
            "title": prompt_title,
            "description": str(args.get("description") or "").strip(),
            "actions": parsed_actions,
            "kind": interrupt_kind,
        },
        "gateId": gate_id or None,
        "skill": skill or None,
        "required": True,
        "resumeAction": {
            "endpoint": "act",
            "actionId": "submit",
        },
        "metadata": display_payload,
    }

    interrupt_value: Dict[str, Any] = {
        "kind": interrupt_kind,
        "title": prompt_title,
        "description": str(args.get("description") or "").strip(),
        "step_index": max(0, int(args.get("step_index") or 0)),
        "step_count": max(1, int(args.get("step_count") or 1)),
        "actions": parsed_actions,
        "display_payload": display_payload,
        "a2uiRequest": a2ui_request,
    }
    return _normalize_interrupt_payload(interrupt_value)


def build_plan_approval_interrupt_value(args: Dict[str, Any]) -> Dict[str, Any] | None:
    prompt_title = str(args.get("plan_title") or args.get("title") or "").strip()
    if not prompt_title:
        return None

    summary_markdown = str(args.get("plan_summary_markdown") or "").strip()
    summary = str(args.get("plan_summary") or "").strip()
    checklist = str(args.get("execution_checklist") or "").strip()
    raw_steps = args.get("steps")
    steps = raw_steps if isinstance(raw_steps, list) else []
    plan_file_path = str(args.get("plan_file_path") or "research_plan.md").strip() or "research_plan.md"
    status_label = str(args.get("status_label") or "Pending Approval").strip() or "Pending Approval"
    risky_actions = str(args.get("risky_actions") or "None").strip() or "None"

    action_args = {
        "plan_title": prompt_title,
        "plan_summary": summary,
        "execution_checklist": checklist,
        "plan_summary_markdown": summary_markdown,
        "steps": steps,
        "plan_file_path": plan_file_path,
        "status_label": status_label,
        "step_index": _coerce_int(args.get("step_index"), default=0, minimum=0),
        "step_count": _coerce_int(args.get("step_count"), default=1, minimum=1),
        "risky_actions": risky_actions,
    }

    import uuid
    surface_id = f"surface-plan-review-{uuid.uuid4().hex[:8]}"
    a2ui_request = {
        "contract": "a2ui",
        "version": "0.9",
        "surfaceId": surface_id,
        "component": "plan.review",
        "props": {
            "title": prompt_title,
            "summary": summary_markdown or summary,
            "summaryMarkdown": summary_markdown or summary,
            "checklist": checklist,
            "steps": steps,
            "filePath": plan_file_path,
            "planFilePath": plan_file_path,
            "riskyActions": risky_actions,
            "statusLabel": status_label,
            "stepIndex": action_args["step_index"],
            "stepCount": action_args["step_count"],
        },
        "gateId": None,
        "skill": None,
        "required": True,
        "resumeAction": {
            "endpoint": "decision",
            "actionId": "submit",
        },
        "metadata": {
            "planTitle": prompt_title,
            "planFilePath": plan_file_path,
        }
    }

    return {
        "kind": "approval",
        "title": status_label,
        "description": summary_markdown or summary or "Review the proposed plan before execution continues.",
        "step_index": action_args["step_index"],
        "step_count": action_args["step_count"],
        "action_requests": [
            {
                "name": "request_plan_approval",
                "args": action_args,
            }
        ],
        "review_configs": [
            {
                "action_name": "request_plan_approval",
                "allowed_decisions": ["approve", "edit", "reject"],
            }
        ],
        "display_payload": {
            "planTitle": prompt_title,
            "planSummary": summary,
            "planSummaryMarkdown": summary_markdown,
            "executionChecklist": checklist,
            "steps": steps,
            "planFilePath": plan_file_path,
            "statusLabel": status_label,
            "riskyActions": risky_actions,
        },
        "a2uiRequest": a2ui_request,
    }


def _build_plan_approval_payload(args: Dict[str, Any]) -> Dict[str, Any] | None:
    interrupt_value = build_plan_approval_interrupt_value(args)
    if interrupt_value is None:
        return None
    return _normalize_interrupt_payload(interrupt_value)


def extract_interrupt_payload_from_tool_call(tool_name: str, tool_input: str) -> Dict[str, Any] | None:
    """Build an interrupt payload directly from a clarification/action tool call."""
    try:
        raw = (tool_input or "").strip()
        parsed = json.loads(raw)
    except (ValueError, SyntaxError):
        try:
            parsed = ast.literal_eval((tool_input or "").strip())
        except (ValueError, SyntaxError):
            logger.warning("Failed to parse interrupt tool input: %s", (tool_input or "")[:240])
            return None
    if not isinstance(parsed, dict):
        return None
    return extract_interrupt_payload_from_tool_args(tool_name, parsed)


def extract_interrupt_payload_from_tool_args(tool_name: str, parsed: Dict[str, Any]) -> Dict[str, Any] | None:
    """Build an interrupt payload from already-structured tool arguments."""
    if tool_name == "request_clarification":
        return _build_clarification_payload(parsed)
    if tool_name == "request_human_action":
        return _build_human_action_payload(parsed)
    if tool_name == "request_plan_approval":
        return _build_plan_approval_payload(parsed)
    return None


def extract_interrupt_payload_from_tool_text(text: str) -> Dict[str, Any] | None:
    """Parse stringified `Interrupt(value=..., id='...')` tool outputs into stream payloads."""
    raw = (text or "").strip()
    marker_index = raw.find(_INTERRUPT_PAYLOAD_MARKER)
    if marker_index >= 0:
        try:
            decoder = json.JSONDecoder()
            interrupt_value, _ = decoder.raw_decode(raw[marker_index + len(_INTERRUPT_PAYLOAD_MARKER):].strip())
        except json.JSONDecodeError:
            logger.warning("Failed to parse interrupt payload marker: %s", raw[:240])
            return None
        if not isinstance(interrupt_value, dict):
            return None
        return _normalize_interrupt_payload(interrupt_value)

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
