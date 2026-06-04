"""Human-in-the-loop tools: plan approval, clarification, and custom actions."""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from langchain_core.tools import Tool, tool

from ....clarification_responses import normalize_clarification_resume_payload
from ....interrupt_payloads import build_plan_approval_interrupt_value
from ....state import WorkspaceState
from ..clarification_parse import (
    clarification_input_mode,
    parse_choices_from_json,
    parse_questions_from_json,
)
from ..interrupt_helpers import (
    edited_action_args,
    first_decision,
    interrupt_with_retry,
)
from ..human_action_parse import parse_human_actions
from ..json_args import parse_json_dict_arg
from ..schemas import RequestClarificationInput

FRONTEND_SLIDES_A2UI_GATES = (
    "presentation_context",
    "outline_confirmation",
    "style_path_selection",
    "mood_or_preset_selection",
    "style_preview_selection",
)


def _extract_a2ui_gate_id(display_payload: Dict[str, Any]) -> str:
    gate_id = display_payload.get("gateId")
    if not isinstance(gate_id, str) or not gate_id.strip():
        nested_payload = display_payload.get("display_payload") or display_payload.get("displayPayload")
        if isinstance(nested_payload, dict):
            gate_id = nested_payload.get("gateId")
    normalized = str(gate_id or "").strip()
    return normalized if normalized in FRONTEND_SLIDES_A2UI_GATES else ""


def _record_completed_a2ui_gate(workspace_state: WorkspaceState, display_payload: Dict[str, Any]) -> None:
    if str(display_payload.get("skill") or "").strip().lower() != "frontend-slides":
        return
    gate_id = _extract_a2ui_gate_id(display_payload)
    if not gate_id:
        return
    existing = workspace_state.context.get("frontend_slides_completed_a2ui_gates")
    gates = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
    if gate_id not in gates:
        gates.append(gate_id)
    workspace_state.context["frontend_slides_completed_a2ui_gates"] = gates


def build_request_plan_approval_tool(workspace_state: WorkspaceState) -> Tool:
    @tool
    def request_plan_approval(
        plan_title: str,
        plan_summary: str = "",
        execution_checklist: str = "",
        plan_summary_markdown: str = "",
        steps: Optional[List[Dict[str, Any]]] = None,
        plan_file_path: str = "",
        status_label: str = "Pending Approval",
        step_index: int = 0,
        step_count: int = 1,
        risky_actions: str = "None",
        reviewer_feedback: str = "",
        edited_plan_content: str = "",
    ) -> str:
        """Request human approval/edit/rejection for a proposed execution plan."""
        title = (plan_title or "").strip()
        summary = (plan_summary or "").strip()
        summary_markdown = (plan_summary_markdown or "").strip()
        checklist = (execution_checklist or "").strip()
        normalized_steps = steps if isinstance(steps, list) else []
        plan_path = (plan_file_path or "").strip() or "research_plan.md"
        status = (status_label or "").strip() or "Pending Approval"
        risks = (risky_actions or "").strip()
        feedback = (reviewer_feedback or "").strip()
        draft_content = (edited_plan_content or "").strip()

        if not title:
            return "Plan approval blocked: plan_title is required."
        if not summary_markdown and not summary:
            return "Plan approval blocked: plan_summary_markdown or plan_summary is required."
        if not normalized_steps and not checklist:
            return "Plan approval blocked: steps or execution_checklist is required."

        workspace_state.context["last_plan_feedback"] = feedback
        workspace_state.context["last_plan_file_path"] = plan_path

        checklist_display = checklist or json.dumps(normalized_steps, ensure_ascii=False)

        if workspace_state.context.get("skip_plan_approvals"):
            workspace_state.context["plan_approved"] = True
            return (
                "PLAN_APPROVAL_SKIPPED_TRUSTED_MODE\n"
                f"Title: {title}\n"
                f"Summary: {summary_markdown or summary}\n"
                f"Execution checklist: {checklist_display}\n"
                f"Plan file path: {plan_path}\n"
                f"Status label: {status}\n"
                f"Risky actions: {risks}\n"
                "Workspace trusted mode is enabled, so plan approval was skipped. Continue executing the plan."
            )

        interrupt_payload = build_plan_approval_interrupt_value(
            {
                "plan_title": title,
                "plan_summary": summary,
                "execution_checklist": checklist,
                "plan_summary_markdown": summary_markdown,
                "steps": normalized_steps,
                "plan_file_path": plan_path,
                "status_label": status,
                "step_index": step_index,
                "step_count": step_count,
                "risky_actions": risks,
            }
        )
        if interrupt_payload is None:
            return "Plan approval blocked: unable to build review payload."

        response = interrupt_with_retry(
            interrupt_payload,
            valid_keys={"decisions"},
            stale_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId", "action"},
            label="request_plan_approval",
        )
        decision = first_decision(response)
        if not decision:
            workspace_state.context["plan_approved"] = False
            return (
                "PLAN_APPROVAL_DECISION_MISSING\n"
                "Do not execute yet. Ask for plan approval again."
            )

        decision_type = str(decision.get("type") or "").strip().lower()
        edited_args = edited_action_args(decision)
        decision_message = str(decision.get("message") or "").strip()
        edit_feedback = ""
        if decision_type == "edit":
            edit_feedback = (
                str(edited_args.get("reviewer_feedback") or "").strip() or decision_message or feedback
            )
        elif feedback:
            edit_feedback = feedback
        edited_draft_content = str(edited_args.get("edited_plan_content") or "").strip() or draft_content
        edited_plan_path = str(edited_args.get("plan_file_path") or "").strip()
        if edited_plan_path:
            plan_path = edited_plan_path
            workspace_state.context["last_plan_file_path"] = plan_path

        base_fields = (
            f"Title: {title}\n"
            f"Summary: {summary_markdown or summary}\n"
            f"Execution checklist: {checklist_display}\n"
            f"Plan file path: {plan_path}\n"
            f"Status label: {status}\n"
            f"Risky actions: {risks}\n"
        )

        if decision_type == "reject":
            workspace_state.context["plan_approved"] = False
            workspace_state.context["last_plan_feedback"] = decision_message or "Rejected by user"
            return (
                "PLAN_REJECTION_RECORDED\n"
                f"{base_fields}"
                f"Reviewer feedback: {workspace_state.context['last_plan_feedback']}\n"
                "Do not execute this plan. Ask for a revised direction before continuing."
            )

        if decision_type == "edit" or edit_feedback:
            feedback = edit_feedback
            draft_content = edited_draft_content
            workspace_state.context["last_plan_feedback"] = feedback
            workspace_state.context["plan_approved"] = False
            return (
                "PLAN_EDIT_FEEDBACK_RECORDED\n"
                f"{base_fields}"
                f"Reviewer feedback: {feedback}\n"
                f"Edited draft included: {'yes' if draft_content else 'no'}\n"
                "Do not execute yet. Revise the plan and call request_plan_approval again for final approval."
            )

        if decision_type and decision_type != "approve":
            workspace_state.context["plan_approved"] = False
            return (
                "PLAN_APPROVAL_DECISION_UNRECOGNIZED\n"
                f"Decision: {decision_type}\n"
                "Do not execute yet. Ask for plan approval again."
            )

        workspace_state.context["plan_approved"] = True
        return (
            "PLAN_APPROVAL_RECORDED\n"
            f"{base_fields}"
            "Reviewer feedback: None\n"
            "Plan decision has been applied. Continue executing the approved plan."
        )

    request_plan_approval.name = "request_plan_approval"
    request_plan_approval.description = (
        "Ask human to approve, edit, or reject a proposed plan before execution."
    )
    return request_plan_approval


def build_request_clarification_tool(workspace_state: WorkspaceState) -> Tool:
    @tool(args_schema=RequestClarificationInput)
    def request_clarification(
        title: str,
        description: str = "",
        options_json: str = "[]",
        questions_json: str = "[]",
        allow_freeform: bool = True,
        multi_select: bool = False,
        placeholder: str = "",
        submit_label: str = "Continue",
        step_index: int = 0,
        step_count: int = 1,
        context_json: str = "{}",
    ) -> str:
        """Ask the human for clarification with optional selectable choices and typed feedback."""
        prompt_title = (title or "").strip()
        prompt_description = (description or "").strip()
        if not prompt_title:
            return "Clarification request blocked: title is required."

        parsed_choices = parse_choices_from_json(options_json)
        parsed_questions = parse_questions_from_json(questions_json)
        input_mode = clarification_input_mode(
            parsed_choices, parsed_questions, allow_freeform=allow_freeform
        )
        display_payload = parse_json_dict_arg(context_json)
        submit = (submit_label or "Continue").strip() or "Continue"
        action_choices = [] if parsed_questions else parsed_choices

        # Build A2UI request payload for modern frontend
        import uuid
        is_style_chooser = False
        if isinstance(display_payload, dict):
            if display_payload.get("chooser") == "style-previews" or "stylePreviews" in display_payload:
                is_style_chooser = True

        comp = "style.previewChooser" if is_style_chooser else "clarification.form"

        if is_style_chooser:
            previews = []
            if isinstance(display_payload, dict):
                previews = display_payload.get("stylePreviews") or display_payload.get("previews") or []
            a2ui_props = {
                "title": prompt_title,
                "description": prompt_description,
                "previews": previews,
                "choices": parsed_choices,
            }
        else:
            a2ui_props = {
                "title": prompt_title,
                "description": prompt_description,
                "questions": parsed_questions,
                "choices": parsed_choices,
                "inputMode": input_mode,
                "multiple": bool(multi_select),
                "placeholder": (placeholder or "").strip(),
                "submitLabel": submit,
            }

        gate_id = display_payload.get("gateId") or display_payload.get("gate_id") or ""
        skill = display_payload.get("skill") or display_payload.get("skillId") or ""

        surface_id = f"surface-{uuid.uuid4().hex[:12]}" if not gate_id else f"surface-{gate_id}"

        a2ui_request = {
            "contract": "a2ui",
            "version": "0.9",
            "surfaceId": surface_id,
            "component": comp,
            "props": a2ui_props,
            "gateId": gate_id or None,
            "skill": skill or None,
            "required": True,
            "resumeAction": {
                "endpoint": "respond",
                "actionId": "submit"
            },
            "metadata": display_payload
        }

        interrupt_payload = {
            "kind": "clarification",
            "title": prompt_title,
            "description": prompt_description,
            "a2uiRequest": a2ui_request,
            "step_index": max(0, int(step_index or 0)),
            "step_count": max(1, int(step_count or 1)),
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
                        "label": submit,
                        "style": "primary",
                        "inputMode": "text",
                        "placeholder": (placeholder or "").strip(),
                        "submitLabel": submit,
                    }
                ]
                if allow_freeform or not parsed_choices
                else []
            ),
            "response_spec": {
                "inputMode": input_mode,
                "multiple": bool(multi_select),
                "submitLabel": submit,
                "placeholder": (placeholder or "").strip(),
                "choices": parsed_choices,
                **({"questions": parsed_questions} if parsed_questions else {}),
            },
            "display_payload": display_payload,
        }

        response = interrupt_with_retry(
            interrupt_payload,
            valid_keys={"message", "selectedChoiceIds", "selectedValues", "answersByQuestionId"},
            stale_keys={"decisions", "action"},
            label="request_clarification",
        )
        if isinstance(response, dict):
            _record_completed_a2ui_gate(workspace_state, display_payload)
            return normalize_clarification_resume_payload(
                response,
                questions=parsed_questions,
                choices=parsed_choices,
            )
        return str(response)

    request_clarification.name = "request_clarification"
    request_clarification.description = (
        "Pause execution to ask the human a clarification question. "
        "If a loaded skill says AskUserQuestion, AskUserChoice, or otherwise requires a structured user choice, use this tool instead of asking in chat prose. "
        "Use options_json for clickable suggestions and allow_freeform for typed input. "
        "For multi-question discovery forms, pass questions_json with objects like "
        '{"header":"Purpose","question":"What is this presentation for?","options":[{"label":"Pitch deck","value":"Pitch deck","description":"Selling an idea to investors"}]}. '
        "Do not pass section headers like Purpose or Length as the only options."
    )
    return request_clarification


def build_request_human_action_tool(workspace_state: WorkspaceState) -> Tool:
    @tool
    def request_human_action(
        title: str,
        description: str = "",
        actions_json: str = "[]",
        kind: str = "approval",
        step_index: int = 0,
        step_count: int = 1,
        context_json: str = "{}",
    ) -> str:
        """Ask the human to choose an action, optionally with scoped text input."""
        prompt_title = (title or "").strip()
        prompt_description = (description or "").strip()
        interrupt_kind = (kind or "approval").strip().lower()
        if interrupt_kind not in {"approval", "clarification"}:
            interrupt_kind = "approval"
        if not prompt_title:
            return "Human action request blocked: title is required."

        parsed_actions = parse_human_actions(actions_json)
        if not parsed_actions:
            return "Human action request blocked: provide at least one valid action in actions_json."

        display_payload = parse_json_dict_arg(context_json)

        interrupt_payload = {
            "kind": interrupt_kind,
            "title": prompt_title,
            "description": prompt_description,
            "step_index": max(0, int(step_index or 0)),
            "step_count": max(1, int(step_count or 1)),
            "actions": parsed_actions,
            "display_payload": display_payload,
        }

        response = interrupt_with_retry(
            interrupt_payload,
            valid_keys={"action"},
            stale_keys={"decisions", "message", "selectedChoiceIds", "selectedValues"},
            label="request_human_action",
        )
        if isinstance(response, dict):
            return json.dumps(response, ensure_ascii=False)
        return str(response)

    request_human_action.name = "request_human_action"
    request_human_action.description = (
        "Pause execution and ask the human to choose from arbitrary actions. "
        "Each action can be button-only or require scoped text input."
    )
    return request_human_action
