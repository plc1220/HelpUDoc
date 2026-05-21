"""Post-model guard: synthesize a clarification interrupt when the model asked in prose only."""
from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState, hook_config
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from helpudoc_agent.clarification_responses import normalize_clarification_resume_payload
from helpudoc_agent.implicit_input_detection import detect_implicit_input_awaiting
from helpudoc_agent.interrupt_payloads import build_clarification_interrupt_value

logger = logging.getLogger(__name__)

_OUTLINE_QUESTION_OPTIONS = [
    {
        "id": "confirm",
        "label": "Looks good, proceed",
        "value": "Looks good, proceed",
        "description": "Move on to style selection",
    },
    {
        "id": "adjust-images",
        "label": "Adjust images",
        "value": "Adjust images",
        "description": "Change which images go where",
    },
    {
        "id": "adjust-outline",
        "label": "Adjust outline",
        "value": "Adjust outline",
        "description": "Change the slide structure",
    },
]

FRONTEND_SLIDES_OUTLINE_QUESTIONS = [
    {
        "id": "outline",
        "header": "Outline",
        "question": "Does this slide outline and image selection look right?",
        "options": _OUTLINE_QUESTION_OPTIONS,
    },
]

_GENERIC_CONTINUE_CHOICES = [
    {
        "id": "continue",
        "label": "Continue",
        "value": "Continue",
        "description": "Proceed with the next step",
    },
]


def _extract_message_text(message: AIMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(part for part in parts if part).strip()
    return str(content or "").strip()


def _resolve_active_skill_id(context: Any) -> str | None:
    if not isinstance(context, dict):
        return None
    skill_id = context.get("active_skill")
    if isinstance(skill_id, str) and skill_id.strip():
        return skill_id.strip()
    scope = context.get("active_skill_scope")
    if isinstance(scope, dict):
        scoped = scope.get("skill_id") or scope.get("id")
        if isinstance(scoped, str) and scoped.strip():
            return scoped.strip()
    return None


def _is_outline_confirmation_context(text: str) -> bool:
    lowered = text.lower()
    if "outline" in lowered and "approved" in lowered:
        return False
    if any(
        phrase in lowered
        for phrase in (
            "style selection",
            "visual direction",
            "design presets",
            "right \"vibe\"",
            "right vibe",
        )
    ):
        return False
    return "outline" in lowered and (
        "confirm" in lowered
        or "form" in lowered
        or "sidebar" in lowered
        or "proceed" in lowered
    )


def _clarification_resume_context(
    interrupt_payload: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    response_spec = interrupt_payload.get("response_spec")
    if not isinstance(response_spec, dict):
        return [], []

    raw_questions = response_spec.get("questions")
    questions = [item for item in raw_questions if isinstance(item, dict)] if isinstance(raw_questions, list) else []

    raw_choices = response_spec.get("choices")
    choices = [item for item in raw_choices if isinstance(item, dict)] if isinstance(raw_choices, list) else []

    return questions, choices


def build_synthetic_clarification_interrupt(
    *,
    skill_id: str,
    assistant_text: str,
    prompt_hint: str | None,
) -> dict[str, Any] | None:
    """Build a clarification interrupt payload compatible with request_clarification /respond."""
    description = (prompt_hint or "").strip()
    if not description:
        description = (
            "The agent asked for your input above but did not open a structured form. "
            "Please confirm or reply below to continue."
        )

    display_payload = {
        "synthetic": True,
        "source": "implicit_input_guard",
        "skill": skill_id,
    }

    if skill_id == "frontend-slides" and _is_outline_confirmation_context(assistant_text):
        return build_clarification_interrupt_value(
            title="Outline Confirmation",
            description="Review the proposed slide outline and image assignments above.",
            questions=FRONTEND_SLIDES_OUTLINE_QUESTIONS,
            choices=[],
            allow_freeform=True,
            submit_label="Continue",
            display_payload=display_payload,
        )

    return build_clarification_interrupt_value(
        title="Continue",
        description=description,
        choices=list(_GENERIC_CONTINUE_CHOICES),
        allow_freeform=True,
        submit_label="Continue",
        display_payload=display_payload,
    )


class ImplicitInputGuardMiddleware(AgentMiddleware):
    """Emit a real LangGraph interrupt when a skill turn ends with prose-only input requests."""

    def __init__(self, *, enabled: bool = True) -> None:
        super().__init__()
        self.enabled = enabled

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not self.enabled:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None

        last_ai_msg: AIMessage | None = None
        for message in reversed(messages):
            if isinstance(message, AIMessage):
                last_ai_msg = message
                break

        if last_ai_msg is None:
            return None

        if last_ai_msg.tool_calls:
            return None

        skill_id = _resolve_active_skill_id(getattr(runtime, "context", None))
        if not skill_id:
            return None

        assistant_text = _extract_message_text(last_ai_msg)
        detection = detect_implicit_input_awaiting(skill_id=skill_id, assistant_text=assistant_text)
        if not detection.awaiting:
            return None

        interrupt_payload = build_synthetic_clarification_interrupt(
            skill_id=skill_id,
            assistant_text=assistant_text,
            prompt_hint=detection.prompt,
        )
        if interrupt_payload is None:
            return None

        logger.info(
            "Implicit input guard: synthesizing clarification interrupt for skill=%s",
            skill_id,
        )

        questions, choices = _clarification_resume_context(interrupt_payload)
        response = interrupt(interrupt_payload)
        normalized = normalize_clarification_resume_payload(
            response,
            questions=questions,
            choices=choices,
        )
        human_content = (
            f"[Clarification response — continue the '{skill_id}' skill from where you left off; "
            f"do not restart from the beginning.]\n{normalized}"
        )
        return {
            "messages": [HumanMessage(content=human_content)],
            "jump_to": "model",
        }

    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
