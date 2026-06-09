"""Runtime A2UI gate contracts and ledger helpers."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage

from .a2ui_workflows import (
    FRONTEND_SLIDES_A2UI_GATE_IDS,
    FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
    FRONTEND_SLIDES_EXPECTED_COMPONENTS,
    FRONTEND_SLIDES_GATE_COMPONENTS,
    FRONTEND_SLIDES_MOOD_QUESTIONS,
    FRONTEND_SLIDES_OUTLINE_QUESTIONS,
    FRONTEND_SLIDES_STYLE_PATH_QUESTIONS,
    frontend_slides_gate_id,
)

A2UI_LEDGER_KEY = "a2ui_gate_ledger"
A2UI_TELEMETRY_KEY = "a2ui_gate_telemetry"

GATE_STATUSES = {"pending", "completed", "cancelled", "failed"}
GATE_SOURCES = {"direct", "corrected", "synthetic", "failed"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def normalize_component(value: Any) -> str:
    return str(value or "").strip()


def normalize_gate_id(value: Any) -> str:
    return str(value or "").strip()


def normalize_skill_id(value: Any) -> str:
    return str(value or "").strip()


def active_skill_id(context: Any) -> str:
    if not isinstance(context, dict):
        return ""
    skill_id = normalize_skill_id(context.get("active_skill"))
    if skill_id:
        return skill_id
    scope = context.get("active_skill_scope")
    if isinstance(scope, dict):
        return normalize_skill_id(scope.get("skill_id") or scope.get("id"))
    return ""


def is_frontend_slides_skill(skill_id: str | None) -> bool:
    normalized = normalize_skill_id(skill_id).lower()
    return normalized == "frontend-slides" or normalized.endswith("/frontend-slides")


def _frontend_slides_default_props(gate_id: str) -> dict[str, Any]:
    if gate_id == "presentation_context":
        return {
            "title": "Presentation Context + Images",
            "description": "Tell me enough to shape the deck before I design it.",
            "questions": deepcopy(FRONTEND_SLIDES_DISCOVERY_QUESTIONS),
            "submitLabel": "Continue",
        }
    if gate_id == "outline_confirmation":
        return {
            "title": "Confirm Outline",
            "description": "Confirm the slide outline before style discovery.",
            "questions": deepcopy(FRONTEND_SLIDES_OUTLINE_QUESTIONS),
            "submitLabel": "Confirm outline",
        }
    if gate_id == "style_path_selection":
        return {
            "title": "Choose Style Path",
            "description": "Choose how you want to select the presentation style.",
            "questions": deepcopy(FRONTEND_SLIDES_STYLE_PATH_QUESTIONS),
            "submitLabel": "Continue",
        }
    if gate_id == "mood_or_preset_selection":
        return {
            "title": "Choose Presentation Vibe",
            "description": "Pick the feeling the visual direction should create.",
            "questions": deepcopy(FRONTEND_SLIDES_MOOD_QUESTIONS),
            "submitLabel": "Generate style previews",
        }
    if gate_id == "style_preview_selection":
        return {
            "title": "Choose Presentation Style",
            "description": "Select a generated style preview.",
            "choices": [],
            "submitLabel": "Use selected style",
        }
    return {}


def _frontend_slides_gate_contract(skill_id: str, gate_id: str) -> dict[str, Any]:
    return {
        "skill_id": skill_id,
        "gate_id": gate_id,
        "component": FRONTEND_SLIDES_EXPECTED_COMPONENTS.get(gate_id, "clarification_form"),
        "component_aliases": sorted(FRONTEND_SLIDES_GATE_COMPONENTS.get(gate_id, set())),
        "required": True,
        "synthetic_on_pending": True,
        "props": _frontend_slides_default_props(gate_id),
        "context": {
            "skill": "frontend-slides",
            "skillId": "frontend-slides",
            "gateId": gate_id,
            "uiContract": "a2ui",
            "expectedComponent": FRONTEND_SLIDES_EXPECTED_COMPONENTS.get(gate_id, ""),
        },
    }


def normalize_interaction_contract(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    gates_raw = raw.get("gates")
    gates: list[dict[str, Any]] = []
    if isinstance(gates_raw, list):
        for item in gates_raw:
            if not isinstance(item, dict):
                continue
            gate_id = normalize_gate_id(item.get("gate_id") or item.get("gateId") or item.get("id"))
            component = normalize_component(item.get("component"))
            if not gate_id or not component:
                continue
            normalized = dict(item)
            normalized["gate_id"] = gate_id
            normalized["component"] = component
            normalized["required"] = bool(item.get("required", True))
            gates.append(normalized)
    if not gates:
        return {}
    return {"gates": gates}


def _declared_gate_contracts(context: dict[str, Any], skill_id: str) -> list[dict[str, Any]]:
    scope = context.get("active_skill_scope")
    raw_contract = scope.get("interaction_contract") if isinstance(scope, dict) else None
    contract = normalize_interaction_contract(raw_contract)
    gates: list[dict[str, Any]] = []
    for gate in contract.get("gates", []):
        if is_frontend_slides_skill(skill_id):
            gate_id = normalize_gate_id(gate.get("gate_id"))
            default_gate = _frontend_slides_gate_contract(skill_id, gate_id)
            next_gate = deepcopy(default_gate)
            next_gate.update(deepcopy(gate))
            default_props = default_gate.get("props") if isinstance(default_gate.get("props"), dict) else {}
            declared_props = gate.get("props") if isinstance(gate.get("props"), dict) else {}
            next_gate["props"] = {**default_props, **declared_props}
            default_context = default_gate.get("context") if isinstance(default_gate.get("context"), dict) else {}
            declared_context = gate.get("context") if isinstance(gate.get("context"), dict) else {}
            next_gate["context"] = {**default_context, **declared_context}
        else:
            next_gate = deepcopy(gate)
        next_gate["skill_id"] = skill_id
        next_gate.setdefault("context", {})
        if isinstance(next_gate["context"], dict):
            next_gate["context"].setdefault("skill", skill_id)
            next_gate["context"].setdefault("skillId", skill_id)
            next_gate["context"].setdefault("gateId", next_gate["gate_id"])
            next_gate["context"].setdefault("uiContract", "a2ui")
        gates.append(next_gate)
    return gates


def _legacy_frontend_completed(context: dict[str, Any]) -> set[str]:
    raw = context.get("frontend_slides_completed_a2ui_gates")
    if not isinstance(raw, list):
        return set()
    return {str(item).strip() for item in raw if frontend_slides_gate_id(item)}


def get_gate_ledger(context: dict[str, Any]) -> list[dict[str, Any]]:
    raw = context.get(A2UI_LEDGER_KEY)
    if not isinstance(raw, list):
        raw = []
        context[A2UI_LEDGER_KEY] = raw
    return raw


def find_gate_record(context: dict[str, Any], *, skill_id: str, gate_id: str) -> dict[str, Any] | None:
    for record in get_gate_ledger(context):
        if not isinstance(record, dict):
            continue
        if record.get("skill_id") == skill_id and record.get("gate_id") == gate_id:
            return record
    return None


def gate_is_completed(context: dict[str, Any], *, skill_id: str, gate_id: str) -> bool:
    record = find_gate_record(context, skill_id=skill_id, gate_id=gate_id)
    if isinstance(record, dict) and record.get("status") == "completed":
        return True
    if is_frontend_slides_skill(skill_id) and gate_id in _legacy_frontend_completed(context):
        return True
    return False


def ensure_gate_record(
    context: dict[str, Any],
    *,
    run_id: str = "",
    thread_id: str = "",
    skill_id: str,
    gate_id: str,
    component: str,
    status: str = "pending",
    source: str | None = None,
) -> dict[str, Any]:
    record = find_gate_record(context, skill_id=skill_id, gate_id=gate_id)
    now = utc_now_iso()
    if record is None:
        record = {
            "run_id": run_id,
            "thread_id": thread_id,
            "skill_id": skill_id,
            "gate_id": gate_id,
            "component": component,
            "status": status if status in GATE_STATUSES else "pending",
            "source": source if source in GATE_SOURCES else None,
            "answers": None,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "violation_count": 0,
        }
        get_gate_ledger(context).append(record)
        return record
    record.setdefault("created_at", now)
    record["updated_at"] = now
    if run_id:
        record["run_id"] = run_id
    if thread_id:
        record["thread_id"] = thread_id
    record["component"] = component or record.get("component") or ""
    if status in GATE_STATUSES:
        record["status"] = status
    if source in GATE_SOURCES:
        record["source"] = source
    record.setdefault("violation_count", 0)
    return record


def mark_gate_pending(
    context: dict[str, Any],
    *,
    run_id: str = "",
    thread_id: str = "",
    skill_id: str,
    gate_id: str,
    component: str,
    source: str | None = None,
) -> dict[str, Any]:
    return ensure_gate_record(
        context,
        run_id=run_id,
        thread_id=thread_id,
        skill_id=skill_id,
        gate_id=gate_id,
        component=component,
        status="pending",
        source=source,
    )


def mark_gate_completed(
    context: dict[str, Any],
    *,
    run_id: str = "",
    thread_id: str = "",
    skill_id: str,
    gate_id: str,
    component: str,
    answers: Any,
    source: str | None = None,
) -> dict[str, Any]:
    record = ensure_gate_record(
        context,
        run_id=run_id,
        thread_id=thread_id,
        skill_id=skill_id,
        gate_id=gate_id,
        component=component,
        status="completed",
        source=source,
    )
    record["answers"] = deepcopy(answers)
    record["completed_at"] = utc_now_iso()
    record["updated_at"] = record["completed_at"]
    if is_frontend_slides_skill(skill_id):
        existing = context.get("frontend_slides_completed_a2ui_gates")
        gates = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
        if gate_id not in gates:
            gates.append(gate_id)
        context["frontend_slides_completed_a2ui_gates"] = gates
    return record


def record_gate_violation(context: dict[str, Any], gate: dict[str, Any], *, source: str = "failed") -> dict[str, Any]:
    skill_id = normalize_skill_id(gate.get("skill_id"))
    gate_id = normalize_gate_id(gate.get("gate_id"))
    component = normalize_component(gate.get("component"))
    record = ensure_gate_record(
        context,
        skill_id=skill_id,
        gate_id=gate_id,
        component=component,
        status="pending",
        source=source,
    )
    record["violation_count"] = int(record.get("violation_count") or 0) + 1
    record["updated_at"] = utc_now_iso()
    telemetry = context.get(A2UI_TELEMETRY_KEY)
    if not isinstance(telemetry, list):
        telemetry = []
        context[A2UI_TELEMETRY_KEY] = telemetry
    telemetry.append(
        {
            "timestamp": record["updated_at"],
            "skill_id": skill_id,
            "gate_id": gate_id,
            "component": component,
            "source": source,
            "violation_count": record["violation_count"],
        }
    )
    return record


def record_gate_source(context: dict[str, Any], gate: dict[str, Any], *, source: str) -> None:
    if source not in GATE_SOURCES:
        return
    record = mark_gate_pending(
        context,
        skill_id=normalize_skill_id(gate.get("skill_id")),
        gate_id=normalize_gate_id(gate.get("gate_id")),
        component=normalize_component(gate.get("component")),
        source=source,
    )
    telemetry = context.get(A2UI_TELEMETRY_KEY)
    if not isinstance(telemetry, list):
        telemetry = []
        context[A2UI_TELEMETRY_KEY] = telemetry
    telemetry.append(
        {
            "timestamp": record["updated_at"],
            "skill_id": record["skill_id"],
            "gate_id": record["gate_id"],
            "component": record["component"],
            "source": source,
            "violation_count": int(record.get("violation_count") or 0),
        }
    )


def next_pending_gate(context: Any) -> dict[str, Any] | None:
    if not isinstance(context, dict):
        return None
    skill_id = active_skill_id(context)
    if not skill_id:
        return None
    declared = _declared_gate_contracts(context, skill_id)
    if declared:
        for gate in declared:
            if gate.get("required", True) and not gate_is_completed(
                context,
                skill_id=skill_id,
                gate_id=normalize_gate_id(gate.get("gate_id")),
            ):
                return gate
        return None
    if is_frontend_slides_skill(skill_id):
        for gate_id in FRONTEND_SLIDES_A2UI_GATE_IDS:
            if not gate_is_completed(context, skill_id=skill_id, gate_id=gate_id):
                return _frontend_slides_gate_contract(skill_id, gate_id)
    return None


def _message_tool_calls(message: Any) -> list[dict[str, Any]]:
    calls = getattr(message, "tool_calls", None)
    if isinstance(calls, list):
        return [call for call in calls if isinstance(call, dict)]
    additional = getattr(message, "additional_kwargs", None)
    raw_calls = additional.get("tool_calls") if isinstance(additional, dict) else None
    normalized: list[dict[str, Any]] = []
    if isinstance(raw_calls, list):
        for raw in raw_calls:
            if not isinstance(raw, dict):
                continue
            fn = raw.get("function")
            if isinstance(fn, dict):
                args = fn.get("arguments")
                normalized.append({"name": fn.get("name"), "args": parse_json_dict(args)})
    return normalized


def _response_messages(response: Any) -> list[Any]:
    result = getattr(response, "result", None)
    if isinstance(result, list):
        return result
    if isinstance(response, BaseMessage):
        return [response]
    return []


def workflow_a2ui_calls_from_response(response: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for message in _response_messages(response):
        if not isinstance(message, AIMessage):
            continue
        for call in _message_tool_calls(message):
            name = str(call.get("name") or "").strip()
            args = call.get("args")
            if not isinstance(args, dict):
                args = parse_json_dict(args)
            if name == "workflow_action" and str(args.get("action") or "").strip().lower() == "ask_user_a2ui":
                calls.append({"name": name, "args": args, "id": call.get("id")})
    return calls


def _component_matches(actual: str, expected: str, aliases: Any) -> bool:
    values = {expected, expected.replace("_", "."), expected.replace(".", "_")}
    if isinstance(aliases, list):
        values.update(str(item).strip() for item in aliases if str(item).strip())
    return actual in values


def validate_workflow_a2ui_call(call_args: dict[str, Any], gate: dict[str, Any] | None = None) -> tuple[bool, str]:
    action = str(call_args.get("action") or "").strip().lower()
    if action != "ask_user_a2ui":
        return False, "workflow_action.action must be ask_user_a2ui"
    context = parse_json_dict(call_args.get("context_json"))
    props = parse_json_dict(call_args.get("props_json"))
    if not props:
        return False, "workflow_action.props_json must be a non-empty JSON object"
    if not context:
        return False, "workflow_action.context_json must be a non-empty JSON object"
    skill = normalize_skill_id(context.get("skill") or context.get("skillId"))
    if not skill:
        return False, "workflow_action.context_json must include skill or skillId"
    gate_id = normalize_gate_id(call_args.get("gate_id") or context.get("gateId") or context.get("gate_id"))
    if not gate_id:
        return False, "workflow_action must include gate_id or context_json.gateId"
    component = normalize_component(call_args.get("component"))
    if not component:
        return False, "workflow_action.component is required"
    if gate is None:
        return True, ""
    expected_skill = normalize_skill_id(gate.get("skill_id"))
    expected_gate = normalize_gate_id(gate.get("gate_id"))
    expected_component = normalize_component(gate.get("component"))
    if expected_skill and skill != expected_skill and not (
        is_frontend_slides_skill(expected_skill) and is_frontend_slides_skill(skill)
    ):
        return False, f"workflow_action skill '{skill}' does not match pending skill '{expected_skill}'"
    if gate_id != expected_gate:
        return False, f"workflow_action gate_id '{gate_id}' does not match pending gate '{expected_gate}'"
    if not _component_matches(component, expected_component, gate.get("component_aliases")):
        return False, f"workflow_action component '{component}' does not match pending component '{expected_component}'"
    return True, ""


def response_has_valid_a2ui_call(response: Any, gate: dict[str, Any]) -> tuple[bool, str]:
    calls = workflow_a2ui_calls_from_response(response)
    if not calls:
        return False, "model response did not include workflow_action(action='ask_user_a2ui')"
    errors: list[str] = []
    for call in calls:
        valid, reason = validate_workflow_a2ui_call(call.get("args") or {}, gate)
        if valid:
            return True, ""
        errors.append(reason)
    return False, "; ".join(error for error in errors if error) or "invalid workflow_action call"


def gate_instruction(gate: dict[str, Any], *, correction: str | None = None) -> str:
    props = gate.get("props") if isinstance(gate.get("props"), dict) else {}
    context = gate.get("context") if isinstance(gate.get("context"), dict) else {}
    payload_context = deepcopy(context)
    payload_context.setdefault("skill", gate.get("skill_id"))
    payload_context.setdefault("skillId", gate.get("skill_id"))
    payload_context.setdefault("gateId", gate.get("gate_id"))
    payload_context.setdefault("uiContract", "a2ui")
    intro = (
        "A required A2UI user-input gate is pending. The only valid next assistant action is a "
        "structured tool call: workflow_action(action='ask_user_a2ui'). Do not answer in prose, "
        "do not say a form was opened, and do not continue the workflow."
    )
    if correction:
        intro = f"A2UI contract violation: {correction}\n\n{intro}"
    return (
        f"{intro}\n\n"
        f"Required tool arguments:\n"
        f"- gate_id: {gate.get('gate_id')}\n"
        f"- component: {gate.get('component')}\n"
        f"- props_json: {json.dumps(props, ensure_ascii=False)}\n"
        f"- context_json: {json.dumps(payload_context, ensure_ascii=False)}"
    )


def workflow_a2ui_tool_args_for_gate(gate: dict[str, Any]) -> dict[str, Any]:
    props = gate.get("props") if isinstance(gate.get("props"), dict) else {}
    context = gate.get("context") if isinstance(gate.get("context"), dict) else {}
    payload_context = deepcopy(context)
    payload_context.setdefault("skill", gate.get("skill_id"))
    payload_context.setdefault("skillId", gate.get("skill_id"))
    payload_context.setdefault("gateId", gate.get("gate_id"))
    payload_context.setdefault("uiContract", "a2ui")
    return {
        "action": "ask_user_a2ui",
        "gate_id": normalize_gate_id(gate.get("gate_id")),
        "component": normalize_component(gate.get("component")),
        "props_json": json.dumps(props, ensure_ascii=False),
        "context_json": json.dumps(payload_context, ensure_ascii=False),
        "required": bool(gate.get("required", True)),
        "resume_mode": str(gate.get("resume_mode") or "submit"),
    }


def a2ui_interrupt_value_for_gate(gate: dict[str, Any]) -> dict[str, Any]:
    args = workflow_a2ui_tool_args_for_gate(gate)
    props = parse_json_dict(args.get("props_json"))
    context = parse_json_dict(args.get("context_json"))
    component = normalize_component(args.get("component"))
    gate_id = normalize_gate_id(args.get("gate_id") or context.get("gateId") or context.get("gate_id"))
    skill_id = normalize_skill_id(context.get("skill") or context.get("skillId") or gate.get("skill_id"))
    mode = str(args.get("resume_mode") or "submit").strip().lower()
    if mode in {"approve_reject", "decision", "approval"}:
        endpoint = "decision"
        kind = "approval"
    elif mode in {"action", "act"}:
        endpoint = "act"
        kind = "approval"
    else:
        endpoint = "respond"
        kind = "clarification"
    a2ui_request = {
        "contract": "a2ui",
        "version": "0.9",
        "surfaceId": f"surface-{gate_id}" if gate_id else "surface-a2ui-gate",
        "component": component,
        "props": props,
        "gateId": gate_id or None,
        "skill": skill_id or None,
        "required": bool(args.get("required", True)),
        "resumeAction": {
            "endpoint": endpoint,
            "actionId": "submit",
        },
        "metadata": context,
    }
    return {
        "kind": kind,
        "title": props.get("title") or f"A2UI: {component}",
        "description": props.get("description") or "",
        "a2uiRequest": a2ui_request,
        "display_payload": context,
    }
