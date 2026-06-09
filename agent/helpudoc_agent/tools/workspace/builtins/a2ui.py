"""Agent-to-User Interface (A2UI) native tool definitions and helpers."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional
import uuid

from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field, field_validator

from ....a2ui_workflows import FRONTEND_SLIDES_GATE_COMPONENTS
from ....a2ui_contract import mark_gate_completed, mark_gate_pending
from ....state import WorkspaceState
from ..interrupt_helpers import interrupt_with_retry
from ..json_args import parse_json_dict_arg

logger = logging.getLogger(__name__)


class RequestUiInput(BaseModel):
    component: str = Field(description="The catalog identifier of the frontend component to render (e.g., 'clarification.form', 'style.previewChooser')")
    props_json: str = Field(default="{}", description="JSON string containing props to pass to the component")
    context_json: str = Field(default="{}", description="JSON string containing contextual metadata to pass down")
    gate_id: str = Field(default="", description="Optional unique identifier for skill-execution gate tracking")
    required: bool = Field(default=True, description="Whether this UI response is mandatory to resume the agent run")
    resume_mode: str = Field(default="submit", description="The resume protocol mode: 'submit' (for standard form respond), 'approve_reject' (for decisions), 'action' (for arbitrary acts)")

    @field_validator("props_json", "context_json", mode="before")
    @classmethod
    def _coerce_json_dict_string(cls, value: Any) -> str:
        if value is None:
            return "{}"
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        return str(value)


class WorkflowActionInput(BaseModel):
    action: str = Field(
        description=(
            "Structured workflow action to take. Use 'ask_user_a2ui' when user input is needed; "
            "other allowed values are 'generate_artifact', 'revise_artifact', 'call_tool', 'complete', and 'fail'."
        )
    )
    reason: str = Field(default="", description="Short reason for this workflow action")
    gate_id: str = Field(default="", description="Gate id when action is ask_user_a2ui")
    component: str = Field(default="", description="A2UI component when action is ask_user_a2ui")
    props_json: str = Field(default="{}", description="A2UI props JSON when action is ask_user_a2ui")
    context_json: str = Field(default="{}", description="Workflow/A2UI context JSON")
    required: bool = Field(default=True, description="Whether the A2UI response is required")
    resume_mode: str = Field(default="submit", description="A2UI resume mode")
    artifact_refs_json: str = Field(default="[]", description="Optional JSON array of artifact ids/paths this action references")

    @field_validator("props_json", "context_json", "artifact_refs_json", mode="before")
    @classmethod
    def _coerce_json_string(cls, value: Any) -> str:
        if value is None:
            return "{}"
        if isinstance(value, str):
            return value
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)


def _record_completed_a2ui_gate(workspace_state: WorkspaceState, a2ui_request: Dict[str, Any]) -> None:
    skill_id = str(a2ui_request.get("skill") or "").strip()
    metadata = a2ui_request.get("metadata") if isinstance(a2ui_request.get("metadata"), dict) else {}
    if not skill_id:
        skill_id = str(metadata.get("skill") or metadata.get("skillId") or "").strip()
    gate_id = str(a2ui_request.get("gateId") or metadata.get("gateId") or metadata.get("gate_id") or "").strip()
    if not gate_id:
        return
    component = str(a2ui_request.get("component") or "").strip()
    mark_gate_completed(
        workspace_state.context,
        run_id=str(workspace_state.context.get("run_id") or ""),
        thread_id=str(workspace_state.context.get("thread_id") or ""),
        skill_id=skill_id,
        gate_id=gate_id,
        component=component,
        answers=workspace_state.context.get("last_a2ui_response"),
    )


def _build_a2ui_interrupt_payload(
    *,
    component: str,
    props_json: str = "{}",
    context_json: str = "{}",
    gate_id: str = "",
    required: bool = True,
    resume_mode: str = "submit",
) -> tuple[Dict[str, Any] | None, str | None]:
    comp = (component or "").strip()
    if not comp:
        return None, "UI request blocked: component is required."

    parsed_props = parse_json_dict_arg(props_json)
    parsed_context = parse_json_dict_arg(context_json)

    skill = parsed_context.get("skill") or parsed_context.get("skillId") or ""
    gate = (gate_id or parsed_context.get("gateId") or parsed_context.get("gate_id") or "").strip()

    surface_id = f"surface-{uuid.uuid4().hex[:12]}"
    if gate:
        surface_id = f"surface-{gate}"

    endpoint = "respond"
    mode = str(resume_mode or "submit").strip().lower()
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
        "surfaceId": surface_id,
        "component": comp,
        "props": parsed_props,
        "gateId": gate or None,
        "skill": skill or None,
        "required": bool(required),
        "resumeAction": {
            "endpoint": endpoint,
            "actionId": "submit"
        },
        "metadata": parsed_context
    }
    return {
        "kind": kind,
        "title": parsed_props.get("title") or f"A2UI: {comp}",
        "description": parsed_props.get("description") or "",
        "a2uiRequest": a2ui_request,
        "display_payload": parsed_context,
    }, None


def _ask_user_a2ui(
    workspace_state: WorkspaceState,
    *,
    component: str,
    props_json: str = "{}",
    context_json: str = "{}",
    gate_id: str = "",
    required: bool = True,
    resume_mode: str = "submit",
    label: str,
) -> str:
    interrupt_payload, error = _build_a2ui_interrupt_payload(
        component=component,
        props_json=props_json,
        context_json=context_json,
        gate_id=gate_id,
        required=required,
        resume_mode=resume_mode,
    )
    if error:
        return error
    assert interrupt_payload is not None
    a2ui_request = interrupt_payload.get("a2uiRequest")
    if isinstance(a2ui_request, dict):
        skill = str(a2ui_request.get("skill") or "").strip()
        gate = str(a2ui_request.get("gateId") or "").strip()
        if skill and gate:
            mark_gate_pending(
                workspace_state.context,
                run_id=str(workspace_state.context.get("run_id") or ""),
                thread_id=str(workspace_state.context.get("thread_id") or ""),
                skill_id=skill,
                gate_id=gate,
                component=str(a2ui_request.get("component") or ""),
            )

    response = interrupt_with_retry(
        interrupt_payload,
        valid_keys={"actionId", "surfaceId", "decision", "values", "answersByQuestionId"},
        stale_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId", "action", "decisions"},
        label=label,
    )

    if isinstance(response, dict):
        workspace_state.context["last_a2ui_response"] = response
        if isinstance(a2ui_request, dict):
            _record_completed_a2ui_gate(workspace_state, a2ui_request)
        return json.dumps(response, ensure_ascii=False)
    return str(response)


def _validate_workflow_a2ui_gate(
    *,
    action: str,
    gate_id: str | None,
    component: str,
    context: Dict[str, Any],
) -> str | None:
    if action != "ask_user_a2ui":
        return None
    skill = str(context.get("skill") or context.get("skillId") or "").strip().lower()
    if skill != "frontend-slides":
        return None
    gate = (gate_id or "").strip()
    if gate not in FRONTEND_SLIDES_GATE_COMPONENTS:
        return f"Workflow action blocked: unknown frontend-slides A2UI gate '{gate}'."
    comp = (component or "").strip()
    if comp not in FRONTEND_SLIDES_GATE_COMPONENTS[gate]:
        expected = " or ".join(sorted(FRONTEND_SLIDES_GATE_COMPONENTS[gate]))
        return f"Workflow action blocked: gate '{gate}' requires component {expected}, got '{comp}'."
    expected_component = str(context.get("expectedComponent") or context.get("expected_component") or "").strip()
    if expected_component:
        normalized_expected = expected_component.replace(".", "_")
        normalized_component = comp.replace(".", "_")
        if gate == "style_preview_selection":
            valid_expected = {"style_preview_chooser", "style_previewChooser"}
        else:
            valid_expected = {"clarification_form"}
        if normalized_expected not in valid_expected and normalized_expected != normalized_component:
            return (
                "Workflow action blocked: context expectedComponent does not match "
                f"frontend-slides gate '{gate}'."
            )
    return None


def build_request_ui_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=RequestUiInput)
    def request_ui(
        component: str,
        props_json: str = "{}",
        context_json: str = "{}",
        gate_id: str = "",
        required: bool = True,
        resume_mode: str = "submit",
    ) -> str:
        """Pause execution to request a custom user interface render.
        
        The frontend will render the requested component using the provided properties and context.
        """
        return _ask_user_a2ui(
            workspace_state,
            component=component,
            props_json=props_json,
            context_json=context_json,
            gate_id=gate_id,
            required=required,
            resume_mode=resume_mode,
            label="request_ui",
        )

    request_ui.name = "request_ui"
    request_ui.description = (
        "Pause the run and ask the frontend to render a specific native A2UI component. "
        "Use this for rich interactive inputs, plans review, approvals, style selection, and structured forms."
    )
    return request_ui


def build_workflow_action_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=WorkflowActionInput)
    def workflow_action(
        action: str,
        reason: str = "",
        gate_id: str = "",
        component: str = "",
        props_json: str = "{}",
        context_json: str = "{}",
        required: bool = True,
        resume_mode: str = "submit",
        artifact_refs_json: str = "[]",
    ) -> str:
        """Emit one structured workflow action instead of encoding workflow control in prose."""
        normalized_action = (action or "").strip().lower()
        allowed_actions = {
            "ask_user_a2ui",
            "generate_artifact",
            "revise_artifact",
            "call_tool",
            "complete",
            "fail",
        }
        if normalized_action not in allowed_actions:
            return (
                "Workflow action blocked: action must be one of "
                + ", ".join(sorted(allowed_actions))
                + "."
            )

        context = parse_json_dict_arg(context_json)
        try:
            refs_raw = json.loads(artifact_refs_json or "[]")
        except Exception:
            refs_raw = []
        artifact_refs = refs_raw if isinstance(refs_raw, list) else []
        workflow_record = {
            "action": normalized_action,
            "reason": (reason or "").strip(),
            "gateId": (gate_id or context.get("gateId") or context.get("gate_id") or "").strip() or None,
            "component": (component or "").strip() or None,
            "artifactRefs": artifact_refs,
            "context": context,
        }
        workspace_state.context["last_workflow_action"] = workflow_record

        if normalized_action == "ask_user_a2ui":
            if not component.strip():
                return "Workflow action blocked: ask_user_a2ui requires component."
            if not workflow_record["gateId"]:
                return "Workflow action blocked: ask_user_a2ui requires gate_id."
            gate_error = _validate_workflow_a2ui_gate(
                action=normalized_action,
                gate_id=str(workflow_record["gateId"]),
                component=component,
                context=context,
            )
            if gate_error:
                return gate_error
            return _ask_user_a2ui(
                workspace_state,
                component=component,
                props_json=props_json,
                context_json=context_json,
                gate_id=str(workflow_record["gateId"]),
                required=required,
                resume_mode=resume_mode,
                label="workflow_action.ask_user_a2ui",
            )

        return json.dumps(
            {
                "ok": True,
                "workflowAction": workflow_record,
                "message": (
                    "Workflow action recorded. Execute the action with the appropriate tool next."
                    if normalized_action in {"generate_artifact", "revise_artifact", "call_tool"}
                    else "Workflow terminal action recorded."
                ),
            },
            ensure_ascii=False,
        )

    workflow_action.name = "workflow_action"
    workflow_action.description = (
        "Planner-level workflow protocol tool. Emit exactly one structured action when deciding the next step. "
        "Use action='ask_user_a2ui' for any user input gate; provide gate_id, component, props_json, and context_json. "
        "Use other actions to record generate/revise/call/complete/fail decisions before executing the corresponding tools."
    )
    return workflow_action


# Specialized helper functions for common workflows (can be used inside python code or skills)

def request_approval(
    workspace_state: WorkspaceState,
    title: str,
    description: str,
    actions: List[Dict[str, Any]],
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Helper to request a structured action approval card."""
    ui_tool = build_request_ui_tool(workspace_state)
    props = {
        "title": title,
        "description": description,
        "actions": actions,
    }
    response_str = ui_tool.invoke({
        "component": "approval.card",
        "props_json": json.dumps(props, ensure_ascii=False),
        "context_json": json.dumps(context or {}, ensure_ascii=False),
        "resume_mode": "action",
    })
    try:
        return json.loads(response_str)
    except Exception:
        return {"error": response_str}


def request_plan_review(
    workspace_state: WorkspaceState,
    plan_title: str,
    plan_summary_markdown: str,
    steps: List[Dict[str, Any]],
    plan_file_path: str = "research_plan.md",
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Helper to request a structured plan review form."""
    ui_tool = build_request_ui_tool(workspace_state)
    props = {
        "title": plan_title,
        "summary": plan_summary_markdown,
        "steps": steps,
        "filePath": plan_file_path,
    }
    response_str = ui_tool.invoke({
        "component": "plan.review",
        "props_json": json.dumps(props, ensure_ascii=False),
        "context_json": json.dumps(context or {}, ensure_ascii=False),
        "resume_mode": "approve_reject",
    })
    try:
        return json.loads(response_str)
    except Exception:
        return {"error": response_str}


def request_style_preview_selection(
    workspace_state: WorkspaceState,
    previews: List[Dict[str, Any]],
    choices: List[Dict[str, Any]],
    title: str = "Select a Style Template",
    description: str = "Choose one of the generated style previews to apply to your presentation.",
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Helper to request a visual template/style preview chooser."""
    ui_tool = build_request_ui_tool(workspace_state)
    props = {
        "title": title,
        "description": description,
        "previews": previews,
        "choices": choices,
    }
    response_str = ui_tool.invoke({
        "component": "style.previewChooser",
        "props_json": json.dumps(props, ensure_ascii=False),
        "context_json": json.dumps(context or {}, ensure_ascii=False),
        "resume_mode": "submit",
    })
    try:
        return json.loads(response_str)
    except Exception:
        return {"error": response_str}
