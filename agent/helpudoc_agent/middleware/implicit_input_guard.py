"""Post-model guard: synthesize a clarification interrupt when the model asked in prose only."""
from __future__ import annotations

import logging
import re
from html import escape
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

FRONTEND_SLIDES_STYLE_PATH_QUESTIONS = [
    {
        "id": "style_path",
        "header": "Style Selection Method",
        "question": "How would you like to choose your presentation style?",
        "options": [
            {
                "id": "guided",
                "label": "Show me options",
                "value": "Show me options",
                "description": "Generate 3 previews based on my needs",
            },
            {
                "id": "direct",
                "label": "I know what I want",
                "value": "I know what I want",
                "description": "Pick from the preset list directly",
            },
        ],
    },
]

FRONTEND_SLIDES_MOOD_QUESTIONS = [
    {
        "id": "mood",
        "header": "Vibe",
        "question": "What feeling should the audience have when viewing your slides?",
        "options": [
            {"id": "impressed", "label": "Impressed/Confident", "value": "Impressed/Confident"},
            {"id": "excited", "label": "Excited/Energized", "value": "Excited/Energized"},
            {"id": "calm", "label": "Calm/Focused", "value": "Calm/Focused"},
            {"id": "inspired", "label": "Inspired/Moved", "value": "Inspired/Moved"},
        ],
    },
]

FRONTEND_SLIDES_DISCOVERY_QUESTIONS = [
    {
        "id": "purpose",
        "header": "Purpose",
        "question": "What is this presentation for?",
        "options": [
            {
                "id": "purpose-pitch-deck",
                "label": "Pitch deck",
                "value": "Pitch deck",
                "description": "Selling an idea, product, or company to investors/clients",
            },
            {
                "id": "purpose-teaching",
                "label": "Teaching/Tutorial",
                "value": "Teaching/Tutorial",
                "description": "Explaining concepts, how-to guides, educational content",
            },
            {
                "id": "purpose-conference",
                "label": "Conference talk",
                "value": "Conference talk",
                "description": "Speaking at an event, tech talk, keynote",
            },
            {
                "id": "purpose-internal",
                "label": "Internal presentation",
                "value": "Internal presentation",
                "description": "Team updates, strategy meetings, company updates",
            },
        ],
    },
    {
        "id": "length",
        "header": "Length",
        "question": "Approximately how many slides?",
        "options": [
            {
                "id": "length-short",
                "label": "Short (5-10)",
                "value": "Short (5-10)",
                "description": "Quick pitch, lightning talk",
            },
            {
                "id": "length-medium",
                "label": "Medium (10-20)",
                "value": "Medium (10-20)",
                "description": "Standard presentation",
            },
            {
                "id": "length-long",
                "label": "Long (20+)",
                "value": "Long (20+)",
                "description": "Deep dive, comprehensive talk",
            },
        ],
    },
    {
        "id": "content",
        "header": "Content",
        "question": "Do you have the content ready, or do you need help structuring it?",
        "options": [
            {
                "id": "content-ready",
                "label": "I have all content ready",
                "value": "I have all content ready",
                "description": "Just need to design the presentation",
            },
            {
                "id": "content-notes",
                "label": "I have rough notes",
                "value": "I have rough notes",
                "description": "Need help organizing into slides",
            },
            {
                "id": "content-topic",
                "label": "I have a topic only",
                "value": "I have a topic only",
                "description": "Need help creating the full outline",
            },
        ],
    },
    {
        "id": "images",
        "header": "Images",
        "question": "Do you have images to include? Select 'No images' or select Other and type/paste your image folder path.",
        "options": [
            {
                "id": "images-none",
                "label": "No images",
                "value": "No images",
                "description": "Text-only presentation",
            },
            {
                "id": "images-assets",
                "label": "./assets",
                "value": "./assets",
                "description": "Use the assets folder in the current project",
            },
        ],
    },
    {
        "id": "editing",
        "header": "Editing",
        "question": "Do you need to edit text directly in the browser after generation?",
        "options": [
            {
                "id": "editing-yes",
                "label": "Yes (Recommended)",
                "value": "Yes (Recommended)",
                "description": "Can edit text in-browser, auto-save to localStorage, export file",
            },
            {
                "id": "editing-no",
                "label": "No",
                "value": "No",
                "description": "Presentation only, keeps file smaller",
            },
        ],
    },
]

DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES = [
    {
        "id": "style-a",
        "label": "Style A",
        "value": "Style A",
        "description": "Use the first generated preview direction.",
    },
    {
        "id": "style-b",
        "label": "Style B",
        "value": "Style B",
        "description": "Use the second generated preview direction.",
    },
    {
        "id": "style-c",
        "label": "Style C",
        "value": "Style C",
        "description": "Use the third generated preview direction.",
    },
    {
        "id": "mix-elements",
        "label": "Mix elements",
        "value": "Mix elements",
        "description": "Combine aspects from the generated previews.",
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


FRONTEND_SLIDES_A2UI_GATES = (
    "presentation_context",
    "outline_confirmation",
    "style_path_selection",
    "mood_or_preset_selection",
    "style_preview_selection",
)


def _is_frontend_slides_skill(skill_id: str | None) -> bool:
    normalized = str(skill_id or "").strip().lower()
    return normalized == "frontend-slides" or normalized.endswith("/frontend-slides")


def _completed_a2ui_gate_ids(context: Any) -> set[str]:
    if not isinstance(context, dict):
        return set()
    raw = context.get("frontend_slides_completed_a2ui_gates")
    if not isinstance(raw, list):
        return set()
    return {str(item).strip() for item in raw if str(item).strip() in FRONTEND_SLIDES_A2UI_GATES}


def _is_edit_existing_frontend_slides_context(context: Any) -> bool:
    if not isinstance(context, dict):
        return False
    raw = " ".join(
        str(context.get(key) or "")
        for key in ("prompt", "user_prompt", "original_prompt", "message")
    ).lower()
    if not raw:
        return False
    mentions_existing_artifact = any(token in raw for token in (".html", ".ppt", ".pptx", "existing deck", "existing slides", "current deck"))
    asks_for_edit = any(token in raw for token in ("edit", "revise", "update", "modify", "fix", "polish"))
    return mentions_existing_artifact and asks_for_edit


def _frontend_slides_required_gate_missing(context: Any) -> str | None:
    if _is_edit_existing_frontend_slides_context(context):
        return None
    completed = _completed_a2ui_gate_ids(context)
    for gate_id in FRONTEND_SLIDES_A2UI_GATES:
        if gate_id not in completed:
            return gate_id
    return None


def _frontend_slides_gate_display_payload(gate_id: str) -> dict[str, Any]:
    expected_component = (
        "style_preview_chooser"
        if gate_id == "style_preview_selection"
        else "clarification_form"
    )
    return {
        "skill": "frontend-slides",
        "gateId": gate_id,
        "uiContract": "a2ui",
        "expectedComponent": expected_component,
        "source": "implicit_input_guard",
    }


def _build_frontend_slides_gate_interrupt(gate_id: str) -> dict[str, Any] | None:
    display_payload = _frontend_slides_gate_display_payload(gate_id)
    if gate_id == "presentation_context":
        return build_clarification_interrupt_value(
            title="Presentation Setup",
            description="Configure the basic settings for your presentation.",
            questions=FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
            choices=[],
            allow_freeform=True,
            submit_label="Continue",
            display_payload=display_payload,
        )
    if gate_id == "outline_confirmation":
        return build_clarification_interrupt_value(
            title="Outline Confirmation",
            description="Review the proposed slide outline and image assignments above.",
            questions=FRONTEND_SLIDES_OUTLINE_QUESTIONS,
            choices=[],
            allow_freeform=True,
            submit_label="Continue",
            display_payload=display_payload,
        )
    if gate_id == "style_path_selection":
        return build_clarification_interrupt_value(
            title="Choose Style Selection Method",
            description="Select how you would like to decide on the presentation design.",
            questions=FRONTEND_SLIDES_STYLE_PATH_QUESTIONS,
            choices=[],
            allow_freeform=False,
            submit_label="Continue",
            display_payload=display_payload,
        )
    if gate_id == "mood_or_preset_selection":
        return build_clarification_interrupt_value(
            title="Vibe & Mood Selection",
            description="Choose the desired vibe for this presentation.",
            questions=FRONTEND_SLIDES_MOOD_QUESTIONS,
            choices=[],
            allow_freeform=False,
            multi_select=True,
            submit_label="Generate style previews",
            display_payload=display_payload,
        )
    if gate_id == "style_preview_selection":
        choices = [dict(choice) for choice in DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES]
        style_previews = [
            {
                "id": choice["id"],
                "label": choice["label"],
                "description": choice.get("description", ""),
                "path": f".claude-design/slide-previews/{choice['id']}.html",
                "html": _build_fallback_style_preview_html(choice),
            }
            for choice in choices
            if re.match(r"^style-[a-c]$", choice["id"])
        ]
        return build_clarification_interrupt_value(
            title="Choose Your Presentation Style",
            description="Preview each direction, then choose the one you want to use for the full deck.",
            choices=choices,
            allow_freeform=False,
            submit_label="Use selected style",
            display_payload={
                **display_payload,
                "chooser": "style-previews",
                "stylePreviews": style_previews,
            },
        )
    return None


def _record_completed_gate(context: Any, gate_id: str | None) -> None:
    if not isinstance(context, dict) or not gate_id:
        return
    existing = context.get("frontend_slides_completed_a2ui_gates")
    gates = [item for item in existing if isinstance(item, str)] if isinstance(existing, list) else []
    if gate_id not in gates:
        gates.append(gate_id)
    context["frontend_slides_completed_a2ui_gates"] = gates


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


def _is_frontend_slides_discovery_context(text: str) -> bool:
    lowered = text.lower()
    if "outline" in lowered and ("confirm" in lowered or "approved" in lowered):
        return False
    if any(
        phrase in lowered
        for phrase in (
            "presentation context",
            "few more details",
            "your goals",
            "visual assets",
            "form above",
            "form below",
            "fill out the form",
            "complete the form",
            "submit the form",
            "get started",
        )
    ):
        return True
    if re.search(
        r"\b(?:fill\s+out|complete|submit)\s+the\s+(?:form|questions?)\b.{0,180}\b(?:preferences?|goals?|details?|context|requirements?|purpose|audience|style|assets?|continue|proceed)\b",
        lowered,
        re.DOTALL,
    ):
        return True
    if re.search(
        r"\bto\s+ensure\b.{0,260}\b(?:deck|slides?|presentation)\b.{0,260}\b(?:expectations|ideal\s+length|length|structure|technical\s+features|audience|visual\s+style)\b",
        lowered,
        re.DOTALL,
    ):
        return True
    if re.search(
        r"\b(?:propose|generate)\s+a?\s*(?:proposed\s+)?slide\s+outline\b",
        lowered,
    ) and re.search(
        r"\b(?:move|proceed|continue)\s+to\s+(?:style\s+discovery|visual\s+(?:direction|aesthetic)|style\s+selection)\b",
        lowered,
    ):
        return True
    return "presentation" in lowered and "form" in lowered and (
        "images" in lowered or "assets" in lowered or "goals" in lowered
    )


def _is_frontend_slides_style_selection_context(text: str) -> bool:
    lowered = text.lower()
    has_style_preview_context = bool(
        re.search(r"\b(?:style|visual)\b.{0,180}\b(?:preview|archetype|aesthetic|selector|chooser|window)\b", lowered, re.DOTALL)
        or re.search(r"\b(?:preview|archetype|aesthetic|selector|chooser|window)\b.{0,180}\b(?:style|visual)\b", lowered, re.DOTALL)
        or re.search(r"\bstyle\s*[a-c]\s*:", lowered)
        or re.search(r"\btheme\s*[a-c]\s*:", lowered)
        or re.search(r"\boption\s*[1-3]\s*:", lowered)
        or re.search(r"\bcustom\s+html\s+slide\s+style\s+options?\b", lowered)
        or re.search(r"\bhtml\s+style\s+previews?\b", lowered)
        or re.search(r"\bvisual\s+theme\s+selection\b", lowered)
        or re.search(r"\b(?:styling|visual)\s+direction\b", lowered)
    )
    asks_for_choice = bool(
        re.search(r"\b(?:choose|select|pick|preferred|favorite)\b.{0,180}\b(?:style|preview|direction|aesthetic|selector|chooser)\b", lowered, re.DOTALL)
        or re.search(r"\b(?:choose|select|pick|preferred|favorite)\b.{0,180}\b(?:theme|styling\s+direction|visual\s+theme)\b", lowered, re.DOTALL)
        or re.search(r"\b(?:selection|choose|select|pick)\b.{0,220}\b(?:generating|complete|deck|slides?)\b", lowered, re.DOTALL)
        or re.search(r"\bonce\s+you\s+confirm\b.{0,180}\b(?:choice|theme|style|deck|slides?)\b", lowered, re.DOTALL)
        or re.search(r"\b(?:interactive|thumbnail)\s+(?:selector|chooser|window)\b", lowered)
    )
    return has_style_preview_context and asks_for_choice


def _extract_frontend_slides_style_choices(text: str) -> list[dict[str, str]]:
    matches = list(
        re.finditer(
            r"(?:(?:Style|Theme)\s*([A-C])|Option\s*([1-3]))\s*(?:\(([^)]+)\))?\s*:\s*([^—\n*]+)?(?:[—-]\s*([^\n]+))?",
            text or "",
            re.IGNORECASE,
        )
    )
    choices: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for index, match in enumerate(matches[:3]):
        option_number = int(match.group(2)) if match.group(2) else None
        letter = (match.group(1) or (chr(ord("A") + option_number - 1) if option_number else chr(ord("A") + index))).lower()
        choice_id = f"style-{letter}"
        if choice_id in seen_ids:
            continue
        seen_ids.add(choice_id)
        name = re.sub(r"[()\"“”]", "", (match.group(3) or match.group(4) or "")).strip()
        description = re.sub(r"\s+", " ", (match.group(5) or "")).strip()
        label = f"Style {letter.upper()}" + (f": {name}" if name else "")
        choices.append(
            {
                "id": choice_id,
                "label": label,
                "value": label,
                "description": description or f"Use {name or f'style {letter.upper()}'} for the final presentation.",
            }
        )

    if len(choices) < 2:
        choices = [dict(choice) for choice in DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES[:3]]

    choices.append(dict(DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES[-1]))
    return choices


def _build_fallback_style_preview_html(choice: dict[str, str]) -> str:
    palette_by_id = {
        "style-a": {"bg": "#f8fafc", "fg": "#0f172a", "accent": "#0ea5e9", "muted": "#475569"},
        "style-b": {"bg": "#111827", "fg": "#f9fafb", "accent": "#22c55e", "muted": "#cbd5e1"},
        "style-c": {"bg": "#fff7ed", "fg": "#1f2937", "accent": "#f97316", "muted": "#64748b"},
    }
    palette = palette_by_id.get(choice.get("id", ""), palette_by_id["style-a"])
    label = escape(choice.get("label") or "Style preview")
    description = escape(choice.get("description") or "Presentation style preview.")
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: {palette["bg"]}; color: {palette["fg"]}; }}
    .slide {{ min-height: 100vh; padding: 9vh 8vw; display: grid; grid-template-rows: auto 1fr auto; gap: 5vh; }}
    .eyebrow {{ color: {palette["accent"]}; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }}
    h1 {{ margin: 0; max-width: 980px; font-size: clamp(42px, 7vw, 88px); line-height: .95; letter-spacing: 0; }}
    p {{ margin: 0; max-width: 740px; color: {palette["muted"]}; font-size: clamp(18px, 2vw, 28px); line-height: 1.35; }}
    .grid {{ display: grid; grid-template-columns: 1.2fr .8fr; align-items: end; gap: 5vw; }}
    .metric {{ border-top: 4px solid {palette["accent"]}; padding-top: 18px; font-size: clamp(38px, 6vw, 72px); font-weight: 900; }}
    .label {{ margin-top: 8px; color: {palette["muted"]}; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }}
  </style>
</head>
<body>
  <main class="slide">
    <div class="eyebrow">HTML style preview</div>
    <section class="grid">
      <div>
        <h1>{label}</h1>
        <p>{description}</p>
      </div>
      <div>
        <div class="metric">01</div>
        <div class="label">Title slide direction</div>
      </div>
    </section>
    <div class="eyebrow">Choose to generate the full deck</div>
  </main>
</body>
</html>"""


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

    if skill_id == "frontend-slides" and _is_frontend_slides_style_selection_context(assistant_text):
        choices = _extract_frontend_slides_style_choices(assistant_text)
        style_previews = [
            {
                "id": choice["id"],
                "label": choice["label"],
                "description": choice.get("description", ""),
                "path": f".claude-design/slide-previews/{choice['id']}.html",
                "html": _build_fallback_style_preview_html(choice),
            }
            for choice in choices
            if re.match(r"^style-[a-c]$", choice["id"])
        ]
        payload = build_clarification_interrupt_value(
            title="Choose Your Presentation Style",
            description="Preview each direction, then choose the one you want me to use for the full deck.",
            choices=choices,
            allow_freeform=False,
            submit_label="Use selected style",
            display_payload={
                **display_payload,
                "chooser": "style-previews",
                "stylePreviews": style_previews,
            },
        )
        if payload is not None:
            response_spec = payload.setdefault("response_spec", {})
            if isinstance(response_spec, dict):
                response_spec["allowDismiss"] = True
                response_spec["dismissLabel"] = "Dismiss"
        return payload

    if skill_id == "frontend-slides" and _is_outline_confirmation_context(assistant_text):
        payload = build_clarification_interrupt_value(
            title="Outline Confirmation",
            description="Review the proposed slide outline and image assignments above.",
            questions=FRONTEND_SLIDES_OUTLINE_QUESTIONS,
            choices=[],
            allow_freeform=True,
            submit_label="Continue",
            display_payload=display_payload,
        )
        if payload is not None:
            response_spec = payload.setdefault("response_spec", {})
            if isinstance(response_spec, dict):
                response_spec["allowDismiss"] = True
                response_spec["dismissLabel"] = "Dismiss"
        return payload

    if skill_id == "frontend-slides" and _is_frontend_slides_discovery_context(assistant_text):
        payload = build_clarification_interrupt_value(
            title="Presentation Context + Images",
            description="Share the setup details so the presentation workflow can continue.",
            questions=FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
            choices=[],
            allow_freeform=True,
            submit_label="Continue",
            display_payload=display_payload,
        )
        if payload is not None:
            response_spec = payload.setdefault("response_spec", {})
            if isinstance(response_spec, dict):
                response_spec["allowDismiss"] = True
                response_spec["dismissLabel"] = "Dismiss"
        return payload

    payload = build_clarification_interrupt_value(
        title="Continue",
        description=description,
        choices=list(_GENERIC_CONTINUE_CHOICES),
        allow_freeform=True,
        submit_label="Continue",
        display_payload=display_payload,
    )
    if payload is not None:
        response_spec = payload.setdefault("response_spec", {})
        if isinstance(response_spec, dict):
            response_spec["allowDismiss"] = True
            response_spec["dismissLabel"] = "Dismiss"
    return payload


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

        runtime_context = getattr(runtime, "context", None)
        assistant_text = _extract_message_text(last_ai_msg)
        detection = detect_implicit_input_awaiting(skill_id=skill_id, assistant_text=assistant_text)
        missing_gate = (
            _frontend_slides_required_gate_missing(runtime_context)
            if _is_frontend_slides_skill(skill_id)
            else None
        )
        if not detection.awaiting and not missing_gate:
            return None

        logger.warning(
            "A2UI input guard: frontend-slides missing required gate=%s or prose implies a UI form without request_clarification. skill=%s",
            missing_gate,
            skill_id,
        )

        if not _is_frontend_slides_skill(skill_id):
            return None

        if missing_gate:
            interrupt_payload = _build_frontend_slides_gate_interrupt(missing_gate)
            if interrupt_payload is None:
                raise ValueError(f"Contract violation: unsupported frontend-slides A2UI gate '{missing_gate}'.")

            logger.info("A2UI input guard: emitting deterministic frontend-slides gate interrupt=%s", missing_gate)
            response = interrupt(interrupt_payload)
            _record_completed_gate(runtime_context, missing_gate)
            questions, choices = _clarification_resume_context(interrupt_payload)
            normalized = normalize_clarification_resume_payload(
                response,
                questions=questions,
                choices=choices,
            )
            human_content = (
                f"[Clarification response — continue the 'frontend-slides' skill from A2UI gate "
                f"'{missing_gate}'; do not restart from the beginning.]\n{normalized}"
            )
            return {
                "messages": [HumanMessage(content=human_content)],
                "jump_to": "model",
            }

        if state.get("implicit_retry"):
            raise ValueError(
                "Contract violation: Model referenced implicit UI form but failed to emit explicit "
                "request_clarification/A2UI tool call on loopback retry."
            )

        if detection.awaiting:
            loopback_instruction = (
                f"You requested the user to fill out a form or select choices in your prose: '{assistant_text}'. "
                "However, you did not call the 'request_clarification' tool. Under our strict A2UI contract, "
                "all user inputs must be requested by calling the 'request_clarification' tool with structured questions. "
                "Please call the 'request_clarification' tool now to request the appropriate questions or style choice form."
            )
        else:
            return None

        return {
            "messages": [HumanMessage(content=loopback_instruction)],
            "jump_to": "model",
            "implicit_retry": True,
        }

    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
