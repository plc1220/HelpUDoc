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
    assert payload["title"] == "Continue"
    assert payload["response_spec"].get("questions", []) == []


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


def test_guard_synthesizes_interrupt_and_jumps_to_model() -> None:
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
    runtime = Runtime(context={"active_skill": "frontend-slides"})
    resume_payload = {
        "message": "",
        "selectedChoiceIds": [],
        "selectedValues": [],
        "answersByQuestionId": {"outline": "Looks good, proceed"},
    }

    with patch(
        "helpudoc_agent.middleware.implicit_input_guard.interrupt",
        return_value=resume_payload,
    ) as interrupt_mock:
        result = middleware.after_model(state, runtime)

    assert interrupt_mock.called
    interrupt_arg = interrupt_mock.call_args.args[0]
    assert interrupt_arg["kind"] == "clarification"
    assert interrupt_arg["response_spec"]["questions"][0]["id"] == "outline"

    assert result is not None
    assert result.get("jump_to") == "model"
    messages = result.get("messages") or []
    assert len(messages) == 1
    assert isinstance(messages[0], HumanMessage)
    assert "frontend-slides" in str(messages[0].content)
    assert "Looks good, proceed" in str(messages[0].content)


def test_guard_checkpoint_resume_cycle() -> None:
    """Prove a real LangGraph interrupt + Command(resume) continues on the same thread."""
    model = GenericFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content=(
                        "Here is the proposed outline:\n\n"
                        "1. Title\n2. Challenge\n3. Solution\n\n"
                        "Please confirm the outline using the form above."
                    )
                ),
                AIMessage(content="Proceeding to style selection."),
            ]
        )
    )
    agent = create_agent(
        model=model,
        tools=[],
        middleware=[ImplicitInputGuardMiddleware()],
        checkpointer=MemorySaver(),
    )
    config = {"configurable": {"thread_id": "implicit-guard-integration"}}
    context = {"active_skill": "frontend-slides"}

    first = agent.invoke(
        {"messages": [{"role": "user", "content": "Create slides"}]},
        config=config,
        context=context,
    )
    assert first.get("__interrupt__"), "expected LangGraph checkpoint interrupt"

    interrupt_value = first["__interrupt__"][0].value
    assert interrupt_value["kind"] == "clarification"
    questions = interrupt_value["response_spec"]["questions"]
    assert questions[0]["id"] == "outline"

    resume_payload = {
        "message": "",
        "answersByQuestionId": {"outline": "Looks good, proceed"},
    }
    second = agent.invoke(Command(resume=resume_payload), config=config, context=context)

    human_replies = [m for m in second["messages"] if isinstance(m, HumanMessage)]
    assert any("Clarification response" in str(m.content) for m in human_replies)
    assert any("Looks good, proceed" in str(m.content) for m in human_replies)
    assert second["messages"][-1].content == "Proceeding to style selection."
