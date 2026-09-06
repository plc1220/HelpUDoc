from types import SimpleNamespace
import json

import pytest

from helpudoc_agent.interaction_contract import is_frontend_slides_edit_existing_context, next_pending_gate
from helpudoc_agent.middleware.interaction_contract import InteractionContractMiddleware
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.interaction import _request_user_interaction


def context(prompt):
    return {
        "active_skill": "frontend-slides",
        "current_user_prompt": prompt,
        "frontend_slides_conversation_history": [
            {"role": "assistant", "content": "Created `/coffee-deck.html`."}
        ],
    }


@pytest.mark.parametrize("prompt", [
    "Make it more minimal", "Add a summary slide", "Use the blue style",
    "Change the visual style of slide 2", "Shorten the title", "Reorder slides 2 and 3",
])
def test_followups_reuse_deck_without_setup(prompt):
    assert is_frontend_slides_edit_existing_context(context(prompt))
    assert next_pending_gate(context(prompt)) is None


@pytest.mark.parametrize("prompt", [
    "Create a new deck and add a summary slide", "Start from scratch", "Update my email address",
])
def test_new_or_unrelated_request_is_not_revision(prompt):
    assert not is_frontend_slides_edit_existing_context(context(prompt))


def test_explicit_new_deck_overrides_stale_edit_hint():
    current = context("Create a new deck")
    current["frontend_slides_edit_existing"] = True
    assert next_pending_gate(current)["gate_id"] == "presentation_context"


def test_middleware_guides_model_after_skill_reload():
    result = InteractionContractMiddleware().before_model({}, SimpleNamespace(context=context("Make it more minimal")))
    assert "does not restart creation" in result["messages"][0].content


def test_tool_blocks_attempt_to_restart_setup(tmp_path, monkeypatch):
    def fail_if_interrupted(*args, **kwargs):
        pytest.fail("Editing must not emit the new-deck setup form")
    monkeypatch.setattr("helpudoc_agent.tools.workspace.builtins.interaction.interrupt_with_retry", fail_if_interrupted)
    workspace = WorkspaceState("test", tmp_path, context=context("Add a summary slide"))
    result = _request_user_interaction(
        workspace, presentation="questionnaire", gate_id="presentation_context",
        props_json=json.dumps({"questions": [{"id": "density", "question": "Deck mode?"}]}),
        context_json=json.dumps({"skill": "frontend-slides"}), label="test",
    )
    assert "without restarting setup" in result
