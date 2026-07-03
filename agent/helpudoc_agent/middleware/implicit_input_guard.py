"""Post-model guard: synthesize a clarification interrupt when the model asked in prose only."""
from __future__ import annotations

import logging
import re
from html import escape
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState, hook_config
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

from helpudoc_agent.a2ui_workflows import (
    DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES,
    FRONTEND_SLIDES_A2UI_GATE_IDS,
    FRONTEND_SLIDES_DISCOVERY_QUESTIONS,
    FRONTEND_SLIDES_EXPECTED_COMPONENTS,
    FRONTEND_SLIDES_MOOD_QUESTIONS,
    FRONTEND_SLIDES_OUTLINE_QUESTIONS,
    FRONTEND_SLIDES_STYLE_PATH_QUESTIONS,
    frontend_slides_gate_id,
)
from helpudoc_agent.implicit_input_detection import detect_implicit_input_awaiting
from helpudoc_agent.interrupt_payloads import build_clarification_interrupt_value, encode_interrupt_payload_marker

logger = logging.getLogger(__name__)

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


def _extract_recent_human_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
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
    return ""


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


def _is_frontend_slides_skill(skill_id: str | None) -> bool:
    normalized = str(skill_id or "").strip().lower()
    return normalized == "frontend-slides" or normalized.endswith("/frontend-slides")


def _completed_a2ui_gate_ids(context: Any) -> set[str]:
    if not isinstance(context, dict):
        return set()
    raw = context.get("frontend_slides_completed_a2ui_gates")
    if not isinstance(raw, list):
        return set()
    return {str(item).strip() for item in raw if frontend_slides_gate_id(item)}


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
    for gate_id in FRONTEND_SLIDES_A2UI_GATE_IDS:
        if gate_id not in completed:
            return gate_id
    return None


def _frontend_slides_gate_matches_context(gate_id: str | None, text: str) -> bool:
    lowered = (text or "").lower()
    if gate_id == "presentation_context":
        return True
    if gate_id == "outline_confirmation":
        return _is_outline_confirmation_context(text)
    if gate_id == "style_path_selection":
        return bool(
            re.search(r"\b(?:style|visual|design)\b.{0,160}\b(?:path|method|approach|selection)\b", lowered, re.DOTALL)
            or re.search(r"\b(?:choose|select|pick)\b.{0,160}\b(?:generate(?:d)? previews?|use presets?|style)\b", lowered, re.DOTALL)
        )
    if gate_id == "mood_or_preset_selection":
        return bool(
            re.search(r"\b(?:mood|vibe|preset|tone|visual direction)\b", lowered)
            and re.search(r"\b(?:choose|select|pick|confirm|form|preference)\b", lowered)
        )
    if gate_id == "style_preview_selection":
        return _is_frontend_slides_style_selection_context(text)
    return False


def _frontend_slides_gate_display_payload(gate_id: str) -> dict[str, Any]:
    return {
        "synthetic": True,
        "skill": "frontend-slides",
        "gateId": gate_id,
        "uiContract": "a2ui",
        "expectedComponent": FRONTEND_SLIDES_EXPECTED_COMPONENTS.get(gate_id, ""),
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
                "path": f".frontend-slides/slide-previews/{choice['id']}.html",
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


def _frontend_slides_gate_loopback_instruction(gate_id: str | None, assistant_text: str) -> str:
    base = (
        f"You requested the user to fill out a form or select choices in your prose: '{assistant_text}'. "
        "However, you did not emit an actual A2UI workflow action. Under our strict A2UI contract, "
        "all user inputs must be requested with workflow_action(action='ask_user_a2ui'), not prose."
    )
    if gate_id == "outline_confirmation":
        return (
            f"{base} The Presentation Context gate is already complete. Do not ask for the Presentation Setup "
            "form again. First write a concrete proposed slide outline in your assistant response, then call "
            "workflow_action with action='ask_user_a2ui', component='clarification.form', gate_id='outline_confirmation', and context_json "
            "containing skill='frontend-slides', gateId='outline_confirmation', uiContract='a2ui', and "
            "expectedComponent='clarification_form'. The form must ask the user to approve or revise the "
            "outline."
        )
    if gate_id == "style_path_selection":
        return (
            f"{base} The outline is already confirmed. Do not ask for Presentation Setup or Outline "
            "Confirmation again. Call workflow_action with action='ask_user_a2ui', component='clarification.form', and "
            "gate_id='style_path_selection' to ask how the user wants to choose the deck style."
        )
    if gate_id == "mood_or_preset_selection":
        return (
            f"{base} The style path is already selected. Call workflow_action with action='ask_user_a2ui', component='clarification.form' "
            "and gate_id='mood_or_preset_selection' to collect the desired visual mood or preset direction."
        )
    if gate_id == "style_preview_selection":
        return (
            f"{base} Generate the three style previews, then call "
            "workflow_action with action='ask_user_a2ui', component='style.previewChooser', and gate_id='style_preview_selection'."
        )
    return (
        f"{base} Please call workflow_action(action='ask_user_a2ui') now with the appropriate structured "
        "questions or style choice form."
    )


def _generic_a2ui_loopback_instruction(skill_id: str, assistant_text: str) -> str:
    return (
        f"You requested user input in prose while running the '{skill_id}' skill: '{assistant_text}'. "
        "That creates dead text instead of an interactive surface. Under the A2UI contract, ask for "
        "human input with workflow_action(action='ask_user_a2ui') and then stop. Use component="
        "'clarification.form', a short gate_id describing this decision, props_json with a title, "
        "description, questions/options, and context_json containing skill and uiContract='a2ui'. "
        "After the user responds, continue from this exact point instead of restarting the skill."
    )


def _is_outline_confirmation_context(text: str) -> bool:
    lowered = text.lower()
    if "outline" not in lowered:
        return False
    if _is_frontend_slides_discovery_context(text):
        return False
    if "outline" in lowered and "approved" in lowered:
        return False
    if "outline" not in lowered and any(
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
            "presentation setup",
            "setup form",
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


def _clean_generic_choice_label(raw: str) -> str:
    label = re.sub(r"[*_`]+", "", str(raw or "")).strip()
    label = re.sub(r"^(?:or|and)\s+", "", label, flags=re.IGNORECASE)
    label = re.sub(r"\s+", " ", label)
    label = re.sub(r"^[\"'“”]+|[\"'“”.,;:]+$", "", label).strip()
    return label


def _generic_choice_id(label: str, index: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return slug[:40] or f"option-{index + 1}"


def _extract_generic_choice_options(text: str) -> list[dict[str, str]]:
    """Best-effort extraction for generic non-slide A2UI recovery choices."""
    source = (text or "").strip()
    if not source:
        return []

    candidates: list[str] = []
    seen: set[str] = set()

    if len(candidates) < 2:
        paren_matches = re.findall(r"\(([^()]{8,180})\)", source)
        for raw_group in paren_matches:
            if not re.search(r"\b(?:or|and)\b|,", raw_group, re.IGNORECASE):
                continue
            parts = re.split(r"\s*,\s*|\s+\bor\b\s+|\s+\band\b\s+", raw_group, flags=re.IGNORECASE)
            group_labels = [_clean_generic_choice_label(part) for part in parts]
            group_labels = [label for label in group_labels if 1 < len(label) <= 80]
            if len(group_labels) >= 2:
                candidates = []
                seen = set()
                for label in group_labels:
                    key = label.lower()
                    if key not in seen:
                        seen.add(key)
                        candidates.append(label)
                break

    if len(candidates) < 2:
        colon_match = re.search(
            r"\b(?:format|option|choice|selection|path|audience|tone|scope|depth)s?\s*:\s*([^.!?\n]{8,180})",
            source,
            re.IGNORECASE | re.DOTALL,
        )
        if colon_match:
            parts = re.split(r"\s*,\s*|\s+\bor\b\s+|\s+\band\b\s+", colon_match.group(1), flags=re.IGNORECASE)
            candidates = []
            seen = set()
            for part in parts:
                label = _clean_generic_choice_label(part)
                if 1 < len(label) <= 80:
                    key = label.lower()
                    if key not in seen:
                        seen.add(key)
                        candidates.append(label)

    if len(candidates) < 2:
        from_matches = re.finditer(
            r"\b(?:choose|select|pick)\b.{0,80}\b(?:from|between)\b\s+([^.!?\n]{8,180})",
            source,
            re.IGNORECASE | re.DOTALL,
        )
        for from_match in from_matches:
            parts = re.split(
                r"\s*,\s*|\s+\bor\b\s+|\s+\band\b\s+",
                from_match.group(1),
                flags=re.IGNORECASE,
            )
            group_candidates: list[str] = []
            group_seen: set[str] = set()
            for part in parts:
                label = _clean_generic_choice_label(part)
                if 1 < len(label) <= 80:
                    key = label.lower()
                    if key not in group_seen:
                        group_seen.add(key)
                        group_candidates.append(label)
            if len(group_candidates) >= 2:
                candidates = group_candidates
                break

    if len(candidates) < 2:
        for match in re.finditer(r"(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+(.+)", source):
            label = _clean_generic_choice_label(match.group(1).split(" — ", 1)[0].split(" - ", 1)[0])
            if label and len(label) <= 80:
                key = label.lower()
                if key not in seen:
                    seen.add(key)
                    candidates.append(label)

    if len(candidates) < 2:
        return []

    return [
        {
            "id": _generic_choice_id(label, index),
            "label": label,
            "value": label,
            "description": f"Use {label} for the next step.",
        }
        for index, label in enumerate(candidates[:6])
    ]


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
    html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; background: {palette["bg"]}; color: {palette["fg"]}; }}
    body {{ font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; }}
    .slide {{ width: min(100vw, calc(100dvh * 16 / 9)); aspect-ratio: 16 / 9; padding: 5%; display: grid; grid-template-rows: auto 1fr auto; gap: 6%; }}
    .eyebrow {{ color: {palette["accent"]}; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }}
    h1 {{ margin: 0; max-width: 980px; font-size: 88px; line-height: .95; letter-spacing: 0; }}
    p {{ margin: 0; max-width: 740px; color: {palette["muted"]}; font-size: 28px; line-height: 1.35; }}
    .grid {{ display: grid; grid-template-columns: 1.2fr .8fr; align-items: end; gap: 96px; }}
    .metric {{ border-top: 4px solid {palette["accent"]}; padding-top: 18px; font-size: 72px; font-weight: 900; }}
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
        "uiContract": "a2ui",
    }

    if skill_id == "frontend-slides" and _is_frontend_slides_style_selection_context(assistant_text):
        choices = _extract_frontend_slides_style_choices(assistant_text)
        style_previews = [
            {
                "id": choice["id"],
                "label": choice["label"],
                "description": choice.get("description", ""),
                "path": f".frontend-slides/slide-previews/{choice['id']}.html",
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
            title="Presentation Context",
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

    generic_choices = _extract_generic_choice_options(assistant_text)
    generic_question = {
        "id": "response",
        "header": "Input",
        "question": description,
        "options": generic_choices,
    }
    payload = build_clarification_interrupt_value(
        title="Input Needed",
        description=description,
        questions=[generic_question],
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
        recent_human_text = _extract_recent_human_text(messages)
        generic_choice_source_text = "\n".join(
            part for part in (assistant_text, recent_human_text) if part
        )
        detection = detect_implicit_input_awaiting(skill_id=skill_id, assistant_text=assistant_text)
        raw_missing_gate = (
            _frontend_slides_required_gate_missing(runtime_context)
            if _is_frontend_slides_skill(skill_id)
            else None
        )
        # Gate 1 is mandatory at the start of a new frontend-slides run. Later gates
        # should be emitted deterministically when the model asks for UI in prose,
        # but only when the prose matches that specific gate. Otherwise a repeated
        # stale setup-form prompt can incorrectly advance to the next gate.
        missing_gate = (
            raw_missing_gate
            if raw_missing_gate == "presentation_context"
            or (
                raw_missing_gate
                and detection.awaiting
                and _frontend_slides_gate_matches_context(raw_missing_gate, assistant_text)
            )
            else None
        )
        if not detection.awaiting and not missing_gate:
            return None

        logger.warning(
            "A2UI input guard: missing required gate=%s or prose implies a UI form without workflow_action/A2UI. skill=%s",
            missing_gate,
            skill_id,
        )

        if missing_gate:
            interrupt_payload = _build_frontend_slides_gate_interrupt(missing_gate)
            if interrupt_payload is None:
                raise ValueError(f"Contract violation: unsupported frontend-slides A2UI gate '{missing_gate}'.")

            if isinstance(runtime_context, dict):
                runtime_context["a2ui_synthetic_interrupt_pending"] = missing_gate
                runtime_context["a2ui_synthetic_resume_context"] = assistant_text
            logger.info("A2UI input guard: emitting deterministic frontend-slides gate interrupt=%s", missing_gate)
            return {
                "messages": [AIMessage(content=encode_interrupt_payload_marker(interrupt_payload))],
            }

        if state.get("implicit_retry"):
            if _is_frontend_slides_skill(skill_id):
                raise ValueError(
                    "Contract violation: Model referenced implicit UI form but failed to emit explicit "
                    "workflow_action(action='ask_user_a2ui')/A2UI tool call on loopback retry."
                )
            interrupt_payload = build_synthetic_clarification_interrupt(
                skill_id=skill_id,
                assistant_text=generic_choice_source_text,
                prompt_hint=detection.prompt,
            )
            if interrupt_payload is None:
                return None
            if isinstance(runtime_context, dict):
                runtime_context["a2ui_synthetic_interrupt_pending"] = interrupt_payload.get("a2uiRequest", {}).get("gateId") or "generic_input"
                runtime_context["a2ui_synthetic_resume_context"] = generic_choice_source_text
            logger.info("A2UI input guard: emitting generic synthetic clarification for skill=%s", skill_id)
            return {
                "messages": [AIMessage(content=encode_interrupt_payload_marker(interrupt_payload))],
            }

        if detection.awaiting and not _is_frontend_slides_skill(skill_id):
            interrupt_payload = build_synthetic_clarification_interrupt(
                skill_id=skill_id,
                assistant_text=generic_choice_source_text,
                prompt_hint=detection.prompt,
            )
            if interrupt_payload is None:
                return None
            if isinstance(runtime_context, dict):
                runtime_context["a2ui_synthetic_interrupt_pending"] = interrupt_payload.get("a2uiRequest", {}).get("gateId") or "generic_input"
                runtime_context["a2ui_synthetic_resume_context"] = generic_choice_source_text
            logger.info("A2UI input guard: emitting generic synthetic clarification for skill=%s", skill_id)
            return {
                "messages": [AIMessage(content=encode_interrupt_payload_marker(interrupt_payload))],
            }

        if detection.awaiting:
            loopback_instruction = (
                _frontend_slides_gate_loopback_instruction(raw_missing_gate, assistant_text)
                if _is_frontend_slides_skill(skill_id)
                else _generic_a2ui_loopback_instruction(skill_id, assistant_text)
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
