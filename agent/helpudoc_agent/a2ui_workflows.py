"""Shared A2UI workflow contracts used by agent-side tools and guards."""
from __future__ import annotations

from typing import Any

FRONTEND_SLIDES_GATE_COMPONENTS: dict[str, set[str]] = {
    "presentation_context": {"clarification.form", "clarification_form"},
    "outline_confirmation": {"clarification.form", "clarification_form"},
    "style_path_selection": {"clarification.form", "clarification_form"},
    "mood_or_preset_selection": {"clarification.form", "clarification_form"},
    "style_preview_selection": {"style.previewChooser", "style_preview_chooser"},
}

FRONTEND_SLIDES_A2UI_GATE_IDS: tuple[str, ...] = (
    "presentation_context",
    "outline_confirmation",
    "style_preview_selection",
)

FRONTEND_SLIDES_LEGACY_GATE_IDS: tuple[str, ...] = (
    "style_path_selection",
    "mood_or_preset_selection",
)

FRONTEND_SLIDES_EXPECTED_COMPONENTS: dict[str, str] = {
    "presentation_context": "clarification_form",
    "outline_confirmation": "clarification_form",
    "style_path_selection": "clarification_form",
    "mood_or_preset_selection": "clarification_form",
    "style_preview_selection": "style_preview_chooser",
}

FRONTEND_SLIDES_OUTLINE_QUESTIONS: list[dict[str, Any]] = [
    {
        "id": "outline",
        "header": "Outline",
        "question": "Does this slide outline and image selection look right?",
        "options": [
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
        ],
    },
]

FRONTEND_SLIDES_STYLE_PATH_QUESTIONS: list[dict[str, Any]] = [
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

FRONTEND_SLIDES_MOOD_QUESTIONS: list[dict[str, Any]] = [
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

FRONTEND_SLIDES_DISCOVERY_QUESTIONS: list[dict[str, Any]] = [
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
        "question": "Do you have content ready?",
        "options": [
            {
                "id": "content-ready",
                "label": "All content ready",
                "value": "All content ready",
                "description": "Design the deck from complete source material",
            },
            {
                "id": "content-notes",
                "label": "Rough notes",
                "value": "Rough notes",
                "description": "Organize notes into a slide narrative",
            },
            {
                "id": "content-topic",
                "label": "Topic only",
                "value": "Topic only",
                "description": "Create the outline and content structure",
            },
        ],
    },
    {
        "id": "density",
        "header": "Density",
        "question": "How dense should the deck feel?",
        "options": [
            {
                "id": "density-low",
                "label": "Low density / speaker-led",
                "value": "Low density / speaker-led",
                "description": "Big ideas, fewer words, more visual breathing room",
            },
            {
                "id": "density-high",
                "label": "High density / reading-first",
                "value": "High density / reading-first",
                "description": "More self-contained detail for async reading",
            },
        ],
    },
]

DEFAULT_FRONTEND_SLIDES_STYLE_CHOICES: list[dict[str, str]] = [
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


def frontend_slides_gate_id(value: Any) -> str:
    normalized = str(value or "").strip()
    return normalized if normalized in FRONTEND_SLIDES_GATE_COMPONENTS else ""


def frontend_slides_expected_component(gate_id: str) -> str:
    return FRONTEND_SLIDES_EXPECTED_COMPONENTS.get(gate_id, "")
