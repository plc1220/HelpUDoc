from __future__ import annotations

from unittest.mock import patch

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.runtime import Runtime
from langgraph.types import Command

from helpudoc_agent.implicit_input_detection import detect_implicit_input_awaiting
from helpudoc_agent.middleware.implicit_input_guard import (
    ImplicitInputGuardMiddleware,
    build_synthetic_clarification_interrupt,
)


def test_detect_implicit_input_requires_skill() -> None:
    result = detect_implicit_input_awaiting(skill_id=None, assistant_text="Please confirm?")
    assert result.awaiting is False


def test_detect_implicit_input_strong_gate_outline_confirm() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text="Please confirm if this outline looks correct.",
    )
    assert result.awaiting is True


def test_detect_implicit_input_rejects_post_deck_courtesy() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text="Your deck is ready at output/slides.html. Would you like any refinements?",
    )
    assert result.awaiting is False


def test_detect_implicit_input_using_form_above() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="research",
        assistant_text=(
            "1. Title\n2. Body\n\n"
            "Please confirm if this outline looks correct using the form above."
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_fill_out_form_above() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "I've reviewed the Texas Chicken Malaysia Sales Intelligence Proposal. "
            "I need a few more details about your goals and any visual assets you'd like to use.\n\n"
            "Please fill out the form above to get started."
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_context_form_below_fill_this_out() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "I've analyzed the Final_Proposal.md for the Texas Chicken Malaysia project. "
            "I've prepared a context form below.\n\n"
            "Please fill this out so I can structure the slides correctly. "
            "After you submit, I'll provide a proposed slide outline for your review."
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_context_gate_without_form_wording() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "I've analyzed the Texas Chicken Malaysia Sales Intelligence Proposal and am ready "
            "to transform it into a professional presentation. To ensure the deck meets your "
            "expectations, This will help me determine the ideal length, structure, and technical "
            "features (like inline editing). Once submitted, I will:\n\n"
            "Propose a slide outline based on the proposal's sections (Executive Summary, "
            "Business Requirements, Architecture, etc.).\n\n"
            "Move to Style Discovery to find the perfect visual aesthetic for your audience."
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_style_selector_above() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "I have successfully generated 3 distinctive HTML style previews.\n\n"
            "Style A: Swiss Modern — Clean and precise.\n"
            "Style B: Bold Signal — High impact.\n"
            "Style C: Notebook Tabs — Editorial and structured.\n\n"
            "Please choose your favorite direction in the interactive selector above."
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_visual_theme_selection_without_preview_wording() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "The visual theme selection form is now active! Please choose your preferred styling direction:\n\n"
            "*   Theme A (Bold QSR Modern - Brand Dark): Uses Texas Orange-Gold and Crimson Red on Deep Charcoal.\n"
            "*   Theme B (Sleek Enterprise Tech - Data Dark): Cool Slate Navy, Teal, and Amber.\n"
            "*   Theme C (Clean Minimalist Light - Editorial Light): Clean off-white and cream layout.\n\n"
            "Once you confirm your choice, I will immediately construct the self-contained, interactive HTML slide deck!"
        ),
    )
    assert result.awaiting is True


def test_detect_implicit_input_option_numbered_html_style_chooser() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "Based on your selected configuration, I have developed three custom HTML slide style options:\n\n"
            "### Option 1: Bold & Energetic (Texas Chicken Brand Core)\n"
            "### Option 2: Sleek Enterprise Tech (Data Dark)\n"
            "### Option 3: Clean Minimalist Light (Editorial Light)\n\n"
            "Please select one for generating the complete slide deck."
        ),
    )
    assert result.awaiting is True


def test_build_synthetic_interrupt_uses_structured_outline_question() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text="Here is the outline. Please confirm the outline above.",
        prompt_hint="Does this outline look right?",
    )
    assert payload is not None
    assert payload["kind"] == "clarification"
    assert payload["title"] == "Outline Confirmation"
    assert payload["display_payload"]["synthetic"] is True

    response_spec = payload["response_spec"]
    assert isinstance(response_spec, dict)
    questions = response_spec.get("questions")
    assert isinstance(questions, list) and len(questions) == 1
    assert questions[0]["id"] == "outline"
    assert questions[0]["header"] == "Outline"
    option_labels = [opt["label"] for opt in questions[0]["options"]]
    assert "Looks good, proceed" in option_labels

    assert payload["actions"] == [
        {
            "id": "clarification-text",
            "label": "Continue",
            "style": "primary",
            "inputMode": "text",
            "placeholder": "",
            "submitLabel": "Continue",
        }
    ]


def test_build_synthetic_interrupt_uses_frontend_slides_discovery_form() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "I've reviewed the Texas Chicken Malaysia Sales Intelligence Proposal. "
            "I need a few more details about your goals and any visual assets you'd like to use.\n\n"
            "Please fill out the form above to get started."
        ),
        prompt_hint=None,
    )
    assert payload is not None
    assert payload["kind"] == "clarification"
    assert payload["title"] == "Presentation Context + Images"
    assert payload["display_payload"]["synthetic"] is True

    questions = payload["response_spec"]["questions"]
    assert [question["id"] for question in questions] == [
        "purpose",
        "length",
        "content",
        "images",
        "editing",
    ]
    assert questions[0]["header"] == "Purpose"
    assert questions[3]["options"][0]["label"] == "No images"
    assert payload["response_spec"]["allowDismiss"] is True


def test_build_synthetic_interrupt_detects_generic_form_preference_request() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "I have initiated the presentation creation process based on the proposal. "
            "Please fill out the form to let me know your preferences, and I will proceed "
            "with structure and design as soon as I receive your response."
        ),
        prompt_hint=None,
    )
    assert payload is not None
    assert payload["kind"] == "clarification"
    assert payload["title"] == "Presentation Context + Images"
    assert payload["response_spec"]["questions"]


def test_build_synthetic_interrupt_does_not_regress_style_selection_to_outline_confirmation() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "Now that the outline is approved, we'll move on to selecting the visual direction "
            "for the EcoWorld pitch deck. Please choose a style selection method in the form below."
        ),
        prompt_hint="Please choose a style selection method in the form below.",
    )
    assert payload is not None
    assert payload["title"] == "Choose Your Presentation Style"
    assert payload["response_spec"].get("questions", []) == []


def test_build_synthetic_interrupt_uses_style_preview_chooser() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "I have successfully generated 3 distinctive HTML style previews.\n\n"
            "Style A: Swiss Modern — Clean, high-contrast, orange safety accents.\n"
            "Style B: Bold Signal — Dark mode, vibrant neon teal glows.\n"
            "Style C: Notebook Tabs — Clean paper interface.\n\n"
            "Please choose your favorite direction in the interactive selector above."
        ),
        prompt_hint=None,
    )
    assert payload is not None
    assert payload["title"] == "Choose Your Presentation Style"
    assert payload["display_payload"]["chooser"] == "style-previews"
    assert payload["response_spec"]["inputMode"] == "choice"
    assert payload["response_spec"]["allowDismiss"] is True
    assert [choice["id"] for choice in payload["response_spec"]["choices"][:3]] == [
        "style-a",
        "style-b",
        "style-c",
    ]
    assert payload["display_payload"]["stylePreviews"][0]["path"] == ".claude-design/slide-previews/style-a.html"
    assert "<!doctype html>" in payload["display_payload"]["stylePreviews"][0]["html"]


def test_build_synthetic_interrupt_parses_theme_choices_as_style_previews() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "The visual theme selection form is now active! Please choose your preferred styling direction:\n\n"
            "Theme A (Bold QSR Modern - Brand Dark): Uses Texas Orange-Gold and Crimson Red.\n"
            "Theme B (Sleek Enterprise Tech - Data Dark): Cool Slate Navy and Teal.\n"
            "Theme C (Clean Minimalist Light - Editorial Light): Clean off-white layout.\n\n"
            "Once you confirm your choice, I will construct the HTML slide deck."
        ),
        prompt_hint=None,
    )
    assert payload is not None
    assert payload["title"] == "Choose Your Presentation Style"
    assert payload["response_spec"]["choices"][0]["label"].startswith("Style A: Bold QSR")
    assert "<!doctype html>" in payload["display_payload"]["stylePreviews"][0]["html"]


def test_build_synthetic_interrupt_parses_option_choices_as_style_previews() -> None:
    payload = build_synthetic_clarification_interrupt(
        skill_id="frontend-slides",
        assistant_text=(
            "I have developed three custom HTML slide style options:\n\n"
            "Option 1: Bold & Energetic (Texas Chicken Brand Core)\n"
            "Option 2: Sleek Enterprise Tech (Data Dark)\n"
            "Option 3: Clean Minimalist Light (Editorial Light)\n\n"
            "Please select one for generating the complete slide deck."
        ),
        prompt_hint=None,
    )
    assert payload is not None
    assert payload["title"] == "Choose Your Presentation Style"
    assert payload["response_spec"]["choices"][0]["id"] == "style-a"
    assert payload["response_spec"]["choices"][0]["label"].startswith("Style A: Bold")


def test_guard_skips_when_tool_calls_present() -> None:
    middleware = ImplicitInputGuardMiddleware()
    state = {
        "messages": [
            AIMessage(
                content="Please confirm?",
                tool_calls=[{"name": "write_file", "args": {"path": "a.md"}, "id": "tc1"}],
            )
        ]
    }
    runtime = Runtime(context={"active_skill": "frontend-slides"})
    assert middleware.after_model(state, runtime) is None


def test_detect_implicit_input_initialized_form_no_above_below() -> None:
    result = detect_implicit_input_awaiting(
        skill_id="frontend-slides",
        assistant_text=(
            "I have initialized the Presentation Context + Settings form. "
            "Please submit your preferences, and once received, I will analyze the research report, "
            "structure the slides, and guide you through the outline and style selection gates!"
        ),
    )
    assert result.awaiting is True


def test_guard_emits_deterministic_gate_interrupt_without_regex_signal() -> None:
    middleware = ImplicitInputGuardMiddleware()
    state = {
        "messages": [
            AIMessage(content="I reviewed the report and am ready to continue.")
        ]
    }
    runtime = Runtime(context={"active_skill": "frontend-slides"})

    resume_payload = {
        "message": "",
        "answersByQuestionId": {"purpose": "Pitch deck"},
    }
    with patch(
        "helpudoc_agent.middleware.implicit_input_guard.interrupt",
        return_value=resume_payload,
    ) as interrupt_mock:
        result = middleware.after_model(state, runtime)

    assert interrupt_mock.called
    interrupt_payload = interrupt_mock.call_args.args[0]
    assert interrupt_payload["kind"] == "clarification"
    assert interrupt_payload["display_payload"]["gateId"] == "presentation_context"
    assert interrupt_payload["display_payload"]["uiContract"] == "a2ui"
    assert interrupt_payload["response_spec"]["questions"][0]["id"] == "purpose"
    assert runtime.context["frontend_slides_completed_a2ui_gates"] == ["presentation_context"]

    assert result is not None
    assert result.get("jump_to") == "model"
    messages = result.get("messages") or []
    assert "presentation_context" in messages[0].content
    assert "Purpose: Pitch deck" in messages[0].content


def test_guard_allows_frontend_slides_after_all_gates_completed() -> None:
    middleware = ImplicitInputGuardMiddleware()
    state = {
        "messages": [
            AIMessage(content="Your deck is ready at output/slides.html.")
        ]
    }
    runtime = Runtime(
        context={
            "active_skill": "frontend-slides",
            "frontend_slides_completed_a2ui_gates": [
                "presentation_context",
                "outline_confirmation",
                "style_path_selection",
                "mood_or_preset_selection",
                "style_preview_selection",
            ],
        }
    )

    assert middleware.after_model(state, runtime) is None


def test_guard_loops_once_and_raises_contract_error_on_retry() -> None:
    middleware = ImplicitInputGuardMiddleware()
    state = {
        "messages": [
            AIMessage(
                content=(
                    "Here is the proposed outline:\n\n"
                    "1. Title\n2. Challenge\n3. Solution\n\n"
                    "Please confirm the outline above."
                )
            )
        ]
    }
    completed_gates = [
        "presentation_context",
        "outline_confirmation",
        "style_path_selection",
        "mood_or_preset_selection",
        "style_preview_selection",
    ]
    runtime = Runtime(
        context={
            "active_skill": "frontend-slides",
            "frontend_slides_completed_a2ui_gates": completed_gates,
        }
    )

    # First occurrence: Should loop back to model and set implicit_retry
    result = middleware.after_model(state, runtime)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result.get("implicit_retry") is True
    messages = result.get("messages") or []
    assert len(messages) == 1
    assert isinstance(messages[0], HumanMessage)
    assert "request_clarification" in messages[0].content

    # Second occurrence (implicit_retry is True): Should raise ValueError immediately
    state_retry = {
        **state,
        "implicit_retry": True,
    }
    import pytest
    with pytest.raises(ValueError, match="Contract violation"):
        middleware.after_model(state_retry, runtime)
