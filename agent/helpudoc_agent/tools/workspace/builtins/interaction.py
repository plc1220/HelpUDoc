"""Agent-to-User Interface (Interaction) native tool definitions and helpers."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
import uuid

from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field, field_validator

from ....interaction_workflows import FRONTEND_SLIDES_GATE_PRESENTATIONS
from ....interaction_contract import gate_is_completed, mark_gate_completed, mark_gate_pending
from ....state import WorkspaceState
from ..interrupt_helpers import interrupt_with_retry
from ..json_args import parse_json_dict_arg

logger = logging.getLogger(__name__)


def _has_outline_review_material(props: Dict[str, Any], context: Dict[str, Any]) -> bool:
    outline_values = [
        props.get("outline"),
        props.get("slides"),
        props.get("slideOutline"),
        props.get("outlineMarkdown"),
        context.get("outline"),
        context.get("slides"),
        context.get("slideOutline"),
        context.get("outlineMarkdown"),
    ]
    return any(bool(value) for value in outline_values)


def _candidate_artifact_paths(workspace_state: WorkspaceState, artifact_refs: List[Any]) -> List[Path]:
    root = Path(workspace_state.root_path)
    candidates: List[Path] = []
    for raw_ref in artifact_refs:
        ref = str(raw_ref or "").strip().lstrip("/")
        if not ref:
            continue
        path = root / ref
        candidates.append(path)
        if not Path(ref).suffix:
            candidates.append(root / f"{ref}.md")
    if not candidates:
        for pattern in ("slide_outline*.md", "*outline*.md"):
            candidates.extend(sorted(root.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True))
    return candidates


def _read_first_text_artifact(workspace_state: WorkspaceState, artifact_refs: List[Any]) -> str:
    for path in _candidate_artifact_paths(workspace_state, artifact_refs):
        try:
            resolved = path.resolve()
            root = Path(workspace_state.root_path).resolve()
            if root not in resolved.parents and resolved != root:
                continue
            if resolved.is_file() and resolved.suffix.lower() in {"", ".md", ".txt"}:
                return resolved.read_text(encoding="utf-8")[:20000].strip()
        except Exception:
            continue
    return ""


def _recent_generated_artifact_refs(workspace_state: WorkspaceState) -> List[Any]:
    raw = workspace_state.context.get("last_generated_artifact_refs")
    return raw if isinstance(raw, list) else []


class RequestInteractionInput(BaseModel):
    presentation: str = Field(description="Semantic interaction presentation (questionnaire, style_preview, action_review, or plan_review)")
    props_json: str = Field(default="{}", description="JSON string containing the structured interaction content")
    context_json: str = Field(default="{}", description="JSON string containing workflow and gate metadata")
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
            "Structured workflow action to take. Use 'request_user_interaction' when user input is needed; "
            "other allowed values are 'generate_artifact', 'revise_artifact', 'call_tool', 'complete', and 'fail'."
        )
    )
    reason: str = Field(default="", description="Short reason for this workflow action")
    gate_id: str = Field(default="", description="Gate id when action is request_user_interaction")
    presentation: str = Field(default="", description="Interaction presentation when action is request_user_interaction")
    props_json: str = Field(default="{}", description="Interaction props JSON when action is request_user_interaction")
    context_json: str = Field(default="{}", description="Workflow/Interaction context JSON")
    required: bool = Field(default=True, description="Whether the Interaction response is required")
    resume_mode: str = Field(default="submit", description="Interaction resume mode")
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


def _record_completed_interaction_gate(workspace_state: WorkspaceState, interaction_request: Dict[str, Any]) -> None:
    skill_id = str(interaction_request.get("skill") or "").strip()
    metadata = interaction_request.get("metadata") if isinstance(interaction_request.get("metadata"), dict) else {}
    if not skill_id:
        skill_id = str(metadata.get("skill") or metadata.get("skillId") or "").strip()
    gate_id = str(interaction_request.get("gateId") or metadata.get("gateId") or metadata.get("gate_id") or "").strip()
    if not gate_id:
        return
    presentation = str(interaction_request.get("presentation") or "").strip()
    mark_gate_completed(
        workspace_state.context,
        run_id=str(workspace_state.context.get("run_id") or ""),
        thread_id=str(workspace_state.context.get("thread_id") or ""),
        skill_id=skill_id,
        gate_id=gate_id,
        presentation=presentation,
        answers=workspace_state.context.get("last_interaction_response"),
    )


def _build_interaction_interrupt_payload(
    *,
    presentation: str,
    props_json: str = "{}",
    context_json: str = "{}",
    gate_id: str = "",
    required: bool = True,
    resume_mode: str = "submit",
) -> tuple[Dict[str, Any] | None, str | None]:
    presentation_kind = (presentation or "").strip()
    if not presentation_kind:
        return None, "Interaction request blocked: presentation is required."

    parsed_props = parse_json_dict_arg(props_json)
    parsed_context = parse_json_dict_arg(context_json)

    skill = parsed_context.get("skill") or parsed_context.get("skillId") or ""
    gate = (gate_id or parsed_context.get("gateId") or parsed_context.get("gate_id") or "").strip()
    if str(skill or "").strip().lower() == "frontend-slides" and gate == "outline_confirmation":
        for key in ("outlineMarkdown", "slideOutline", "slides", "outline"):
            if key not in parsed_props and parsed_context.get(key):
                parsed_props[key] = parsed_context[key]

    interaction_id = f"interaction-{uuid.uuid4().hex[:12]}"
    if gate:
        interaction_id = f"interaction-{gate}"

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

    interaction_request = {
        "contract": "helpudoc.interaction",
        "version": "1",
        "interactionId": interaction_id,
        "presentation": presentation_kind,
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
        "title": parsed_props.get("title") or f"Interaction: {presentation_kind}",
        "description": parsed_props.get("description") or "",
        "interactionRequest": interaction_request,
        "display_payload": parsed_context,
    }
    if endpoint == "act" and isinstance(parsed_props.get("actions"), list):
        interrupt_payload["actions"] = parsed_props["actions"]
    return interrupt_payload, None


def _request_user_interaction(
    workspace_state: WorkspaceState,
    *,
    presentation: str,
    props_json: str = "{}",
    context_json: str = "{}",
    gate_id: str = "",
    required: bool = True,
    resume_mode: str = "submit",
    label: str,
) -> str:
    interrupt_payload, error = _build_interaction_interrupt_payload(
        presentation=presentation,
        props_json=props_json,
        context_json=context_json,
        gate_id=gate_id,
        required=required,
        resume_mode=resume_mode,
    )
    if error:
        return error
    assert interrupt_payload is not None
    interaction_request = interrupt_payload.get("interactionRequest")
    if isinstance(interaction_request, dict):
        skill = str(interaction_request.get("skill") or "").strip()
        gate = str(interaction_request.get("gateId") or "").strip()
        presentation_name = str(interaction_request.get("presentation") or "").strip()
        if skill and gate and gate_is_completed(workspace_state.context, skill_id=skill, gate_id=gate):
            return (
                "Workflow action blocked: Interaction gate "
                f"'{gate}' for skill '{skill}' is already completed in this run. "
                "Continue to the next incomplete gate, or generate the required final artifact if no gates remain."
            )
        if skill and gate:
            mark_gate_pending(
                workspace_state.context,
                run_id=str(workspace_state.context.get("run_id") or ""),
                thread_id=str(workspace_state.context.get("thread_id") or ""),
                skill_id=skill,
                gate_id=gate,
                presentation=presentation_name,
            )

    response = interrupt_with_retry(
        interrupt_payload,
        valid_keys={"actionId", "interactionId", "decision", "values", "answersByQuestionId"},
        stale_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId", "action", "decisions"},
        label=label,
    )

    if isinstance(response, dict):
        workspace_state.context["last_interaction_response"] = response
        if isinstance(interaction_request, dict):
            _record_completed_interaction_gate(workspace_state, interaction_request)
        return json.dumps(response, ensure_ascii=False)
    return str(response)


def _validate_workflow_interaction_gate(
    *,
    action: str,
    gate_id: str | None,
    presentation: str,
    props: Dict[str, Any],
    context: Dict[str, Any],
) -> str | None:
    if action != "request_user_interaction":
        return None
    skill = str(context.get("skill") or context.get("skillId") or "").strip().lower()
    if skill != "frontend-slides":
        return None
    gate = (gate_id or "").strip()
    if gate not in FRONTEND_SLIDES_GATE_PRESENTATIONS:
        return f"Workflow action blocked: unknown frontend-slides Interaction gate '{gate}'."
    presentation_kind = (presentation or "").strip()
    if presentation_kind not in FRONTEND_SLIDES_GATE_PRESENTATIONS[gate]:
        expected = " or ".join(sorted(FRONTEND_SLIDES_GATE_PRESENTATIONS[gate]))
        return f"Workflow action blocked: gate '{gate}' requires presentation {expected}, got '{presentation_kind}'."
    expected_presentation = str(context.get("expectedPresentation") or context.get("expected_presentation") or "").strip()
    if expected_presentation:
        normalized_expected = expected_presentation.replace(".", "_")
        normalized_presentation = presentation_kind.replace(".", "_")
        if gate == "style_preview_selection":
            valid_expected = {"style_preview", "style_previewChooser"}
        else:
            valid_expected = {"questionnaire"}
        if normalized_expected not in valid_expected and normalized_expected != normalized_presentation:
            return (
                "Workflow action blocked: context expectedPresentation does not match "
                f"frontend-slides gate '{gate}'."
            )
    if gate == "outline_confirmation":
        outline_values = [
            props.get("outline"),
            props.get("slides"),
            props.get("slideOutline"),
            props.get("outlineMarkdown"),
            context.get("outline"),
            context.get("slides"),
            context.get("slideOutline"),
            context.get("outlineMarkdown"),
        ]
        if not any(bool(value) for value in outline_values):
            return (
                "Workflow action blocked: gate 'outline_confirmation' requires the proposed "
                "outline in props_json or context_json as outlineMarkdown, slideOutline, slides, or outline."
            )
    return None


def build_request_interaction_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=RequestInteractionInput)
    def request_interaction(
        presentation: str,
        props_json: str = "{}",
        context_json: str = "{}",
        gate_id: str = "",
        required: bool = True,
        resume_mode: str = "submit",
    ) -> str:
        """Pause execution and request a structured user interaction."""
        return _request_user_interaction(
            workspace_state,
            presentation=presentation,
            props_json=props_json,
            context_json=context_json,
            gate_id=gate_id,
            required=required,
            resume_mode=resume_mode,
            label="request_interaction",
        )

    request_interaction.name = "request_interaction"
    request_interaction.description = (
        "Pause the run and request a semantic Interaction presentation. "
        "Use this for rich interactive inputs, plans review, approvals, style selection, and structured forms."
    )
    return request_interaction


def build_workflow_action_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=WorkflowActionInput)
    def workflow_action(
        action: str,
        reason: str = "",
        gate_id: str = "",
        presentation: str = "",
        props_json: str = "{}",
        context_json: str = "{}",
        required: bool = True,
        resume_mode: str = "submit",
        artifact_refs_json: str = "[]",
    ) -> str:
        """Emit one structured workflow action instead of encoding workflow control in prose."""
        normalized_action = (action or "").strip().lower()
        allowed_actions = {
            "request_user_interaction",
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
            "presentation": (presentation or "").strip() or None,
            "artifactRefs": artifact_refs,
            "context": context,
        }
        workspace_state.context["last_workflow_action"] = workflow_record
        if normalized_action == "generate_artifact":
            workspace_state.context["last_generated_artifact_refs"] = artifact_refs

        if normalized_action == "request_user_interaction":
            if not presentation.strip():
                return "Workflow action blocked: request_user_interaction requires presentation."
            if not workflow_record["gateId"]:
                return "Workflow action blocked: request_user_interaction requires gate_id."
            props = parse_json_dict_arg(props_json)
            gate_name = str(workflow_record["gateId"])
            if gate_name in FRONTEND_SLIDES_GATE_PRESENTATIONS:
                context.setdefault("skill", "frontend-slides")
                context.setdefault("skillId", "frontend-slides")
                context.setdefault("gateId", gate_name)
                context.setdefault("interactionContract", "helpudoc.interaction")
                context.setdefault(
                    "expectedPresentation",
                    "style_preview" if gate_name == "style_preview_selection" else "questionnaire",
                )
                context_json = json.dumps(context, ensure_ascii=False)
            if (
                gate_name == "outline_confirmation"
                and not _has_outline_review_material(props, context)
            ):
                outline_markdown = _read_first_text_artifact(
                    workspace_state,
                    artifact_refs or _recent_generated_artifact_refs(workspace_state),
                )
                if outline_markdown:
                    props["outlineMarkdown"] = outline_markdown
                    props_json = json.dumps(props, ensure_ascii=False)
            gate_error = _validate_workflow_interaction_gate(
                action=normalized_action,
                gate_id=str(workflow_record["gateId"]),
                presentation=presentation,
                props=props,
                context=context,
            )
            if gate_error:
                return gate_error
            return _request_user_interaction(
                workspace_state,
                presentation=presentation,
                props_json=props_json,
                context_json=context_json,
                gate_id=str(workflow_record["gateId"]),
                required=required,
                resume_mode=resume_mode,
                label="workflow_action.request_user_interaction",
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
        "Use action='request_user_interaction' for any user input gate; provide gate_id, presentation, props_json, and context_json. "
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
    ui_tool = build_request_interaction_tool(workspace_state)
    props = {
        "title": title,
        "description": description,
        "actions": actions,
    }
    response_str = ui_tool.invoke({
        "presentation": "action_review",
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
    ui_tool = build_request_interaction_tool(workspace_state)
    props = {
        "title": plan_title,
        "summary": plan_summary_markdown,
        "steps": steps,
        "filePath": plan_file_path,
    }
    response_str = ui_tool.invoke({
        "presentation": "plan_review",
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
    ui_tool = build_request_interaction_tool(workspace_state)
    props = {
        "title": title,
        "description": description,
        "previews": previews,
        "choices": choices,
    }
    response_str = ui_tool.invoke({
        "presentation": "style_preview",
        "props_json": json.dumps(props, ensure_ascii=False),
        "context_json": json.dumps(context or {}, ensure_ascii=False),
        "resume_mode": "submit",
    })
    try:
        return json.loads(response_str)
    except Exception:
        return {"error": response_str}
