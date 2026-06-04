"""Agent-to-User Interface (A2UI) native tool definitions and helpers."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional
import uuid

from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field, field_validator

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


def _record_completed_a2ui_gate(workspace_state: WorkspaceState, a2ui_request: Dict[str, Any]) -> None:
    if str(a2ui_request.get("skill") or "").strip().lower() != "frontend-slides":
        return
    gate_id = a2ui_request.get("gateId")
    if not gate_id:
        return
    existing = workspace_state.context.get("frontend_slides_completed_a2ui_gates")
    gates = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
    if gate_id not in gates:
        gates.append(gate_id)
    workspace_state.context["frontend_slides_completed_a2ui_gates"] = gates


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
        comp = (component or "").strip()
        if not comp:
            return "UI request blocked: component is required."

        parsed_props = parse_json_dict_arg(props_json)
        parsed_context = parse_json_dict_arg(context_json)

        skill = parsed_context.get("skill") or parsed_context.get("skillId") or ""
        gate = (gate_id or "").strip()

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

        interrupt_payload = {
            "kind": kind,
            "title": parsed_props.get("title") or f"A2UI: {comp}",
            "description": parsed_props.get("description") or "",
            "a2uiRequest": a2ui_request,
            "display_payload": parsed_context,
        }

        response = interrupt_with_retry(
            interrupt_payload,
            valid_keys={"actionId", "surfaceId", "decision", "values"},
            stale_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId", "action", "decisions"},
            label="request_ui",
        )

        if isinstance(response, dict):
            _record_completed_a2ui_gate(workspace_state, a2ui_request)
            return json.dumps(response, ensure_ascii=False)
        return str(response)

    request_ui.name = "request_ui"
    request_ui.description = (
        "Pause the run and ask the frontend to render a specific native A2UI component. "
        "Use this for rich interactive inputs, plans review, approvals, style selection, and structured forms."
    )
    return request_ui


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
