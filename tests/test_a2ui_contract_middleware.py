from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage

import helpudoc_agent.tools_and_schemas as tools_and_schemas
from helpudoc_agent.a2ui_contract import (
    A2UI_LEDGER_KEY,
    a2ui_interrupt_value_for_gate,
    mark_gate_completed,
    next_pending_gate,
    validate_workflow_a2ui_call,
)
from helpudoc_agent.middleware.a2ui_contract import A2UIContractMiddleware
from helpudoc_agent.skills_registry import load_skills
from helpudoc_agent.tools.workspace.builtins.a2ui import build_workflow_action_tool


def _gate(skill_id: str = "generic-skill", gate_id: str = "confirm", component: str = "clarification.form"):
    return {
        "skill_id": skill_id,
        "gate_id": gate_id,
        "component": component,
        "required": True,
        "props": {"title": "Confirm", "questions": [{"id": "ok", "question": "Continue?"}]},
        "context": {"skill": skill_id, "skillId": skill_id, "gateId": gate_id, "uiContract": "a2ui"},
    }


def _args(gate=None, **overrides):
    gate = gate or _gate()
    context = dict(gate["context"])
    props = dict(gate["props"])
    payload = {
        "action": "ask_user_a2ui",
        "gate_id": gate["gate_id"],
        "component": gate["component"],
        "props_json": json.dumps(props),
        "context_json": json.dumps(context),
    }
    payload.update(overrides)
    return payload


def _response(args):
    return ModelResponse(
        result=[
            AIMessage(
                content="",
                tool_calls=[{"name": "workflow_action", "args": args, "id": "call-1"}],
            )
        ]
    )


def _request(context):
    return ModelRequest(
        model=object(),
        messages=[],
        runtime=SimpleNamespace(context=context),
        state={"messages": []},
    )


def test_validate_workflow_action_accepts_valid_a2ui_call():
    gate = _gate()
    valid, reason = validate_workflow_a2ui_call(_args(gate), gate)
    assert valid is True
    assert reason == ""


def test_validate_workflow_action_rejects_missing_structured_payload():
    gate = _gate()
    valid, reason = validate_workflow_a2ui_call(_args(gate, props_json="{}"), gate)
    assert valid is False
    assert "props_json" in reason


def test_validate_workflow_action_rejects_wrong_gate_and_component():
    gate = _gate()
    valid, reason = validate_workflow_a2ui_call(_args(gate, gate_id="other"), gate)
    assert valid is False
    assert "gate_id" in reason

    valid, reason = validate_workflow_a2ui_call(_args(gate, component="style.previewChooser"), gate)
    assert valid is False
    assert "component" in reason


def test_validate_frontend_slides_outline_gate_requires_embedded_outline():
    gate = _gate(
        skill_id="frontend-slides",
        gate_id="outline_confirmation",
        component="clarification.form",
    )

    valid, reason = validate_workflow_a2ui_call(_args(gate), gate)

    assert valid is False
    assert "outline_confirmation" in reason
    assert "outlineMarkdown" in reason

    valid, reason = validate_workflow_a2ui_call(
        _args(gate, props_json=json.dumps({**gate["props"], "outlineMarkdown": "## Slide 1\nIntro"})),
        gate,
    )
    assert valid is True
    assert reason == ""


def test_middleware_blocks_prose_only_phantom_ui_and_retries_once():
    context = {
        "active_skill": "generic-skill",
        "active_skill_scope": {"interaction_contract": {"gates": [_gate()]}},
    }
    middleware = A2UIContractMiddleware()
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return ModelResponse(result=[AIMessage(content="I opened the form for you.")])
        return _response(_args())

    response = middleware.wrap_model_call(_request(context), handler)

    assert len(calls) == 2
    assert response_has_tool_call(response)
    assert context[A2UI_LEDGER_KEY][0]["source"] == "corrected"


def test_middleware_records_direct_source_for_valid_first_response():
    context = {
        "active_skill": "generic-skill",
        "active_skill_scope": {"interaction_contract": {"gates": [_gate()]}},
    }
    middleware = A2UIContractMiddleware()

    response = middleware.wrap_model_call(_request(context), lambda _request: _response(_args()))

    assert response_has_tool_call(response)
    assert context[A2UI_LEDGER_KEY][0]["source"] == "direct"


def test_middleware_failed_retry_records_violation_for_fallback_path():
    context = {
        "active_skill": "generic-skill",
        "active_skill_scope": {"interaction_contract": {"gates": [_gate()]}},
    }
    middleware = A2UIContractMiddleware()

    response = middleware.wrap_model_call(
        _request(context),
        lambda _request: ModelResponse(result=[AIMessage(content="The form is open.")]),
    )

    assert response.result[0].content == "The form is open."
    assert context[A2UI_LEDGER_KEY][0]["source"] == "failed"
    assert context[A2UI_LEDGER_KEY][0]["violation_count"] == 1


def test_contract_can_build_synthetic_interrupt_for_declared_gate():
    gate = _gate()
    gate["synthetic_on_pending"] = True
    payload = a2ui_interrupt_value_for_gate(gate)

    assert payload["a2uiRequest"]["contract"] == "a2ui"
    assert payload["a2uiRequest"]["gateId"] == "confirm"
    assert payload["a2uiRequest"]["component"] == "clarification.form"


def test_frontend_slides_contract_sequence_and_resume_skip_completed_gate():
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    contract = skills["frontend-slides"].interaction_contract
    context = {
        "active_skill": "frontend-slides",
        "active_skill_scope": {"interaction_contract": contract},
    }

    first = next_pending_gate(context)
    assert first["gate_id"] == "presentation_context"
    assert first["props"]["questions"][0]["id"] == "purpose"

    mark_gate_completed(
        context,
        skill_id="frontend-slides",
        gate_id="presentation_context",
        component="clarification.form",
        answers={"answersByQuestionId": {"purpose": "Pitch deck"}},
    )

    assert next_pending_gate(context) is None


def test_frontend_slides_defers_outline_gate_until_outline_payload_exists():
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    contract = skills["frontend-slides"].interaction_contract
    context = {
        "active_skill": "frontend-slides",
        "active_skill_scope": {"interaction_contract": contract},
    }
    mark_gate_completed(
        context,
        skill_id="frontend-slides",
        gate_id="presentation_context",
        component="clarification.form",
        answers={"answersByQuestionId": {"purpose": "Pitch deck"}},
    )

    assert next_pending_gate(context) is None

    contract["gates"][1].setdefault("props", {})["outline"] = [
        {"title": "Opening", "summary": "Set context"}
    ]
    second = next_pending_gate(context)
    assert second["gate_id"] == "outline_confirmation"


def test_frontend_slides_ledger_is_scoped_to_current_run():
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    contract = skills["frontend-slides"].interaction_contract
    context = {
        "active_skill": "frontend-slides",
        "run_id": "run-2",
        "thread_id": "thread-2",
        "active_skill_scope": {"interaction_contract": contract},
    }
    mark_gate_completed(
        context,
        run_id="run-1",
        thread_id="thread-1",
        skill_id="frontend-slides",
        gate_id="presentation_context",
        component="clarification.form",
        answers={"answersByQuestionId": {"purpose": "Old deck"}},
    )

    first = next_pending_gate(context)

    assert first["gate_id"] == "presentation_context"


def test_frontend_slides_defers_style_preview_gate_until_previews_exist():
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    contract = skills["frontend-slides"].interaction_contract
    context = {
        "active_skill": "frontend-slides",
        "run_id": "run-1",
        "thread_id": "thread-1",
        "active_skill_scope": {"interaction_contract": contract},
    }
    for gate_id in [
        "presentation_context",
        "outline_confirmation",
        "style_path_selection",
        "mood_or_preset_selection",
    ]:
        mark_gate_completed(
            context,
            run_id="run-1",
            thread_id="thread-1",
            skill_id="frontend-slides",
            gate_id=gate_id,
            component="clarification.form",
            answers={"ok": True},
        )

    assert next_pending_gate(context) is None


def test_frontend_slides_default_contract_defers_dynamic_outline_gate_without_payload():
    context = {
        "active_skill": "frontend-slides",
        "run_id": "run-1",
        "thread_id": "thread-1",
    }
    mark_gate_completed(
        context,
        run_id="run-1",
        thread_id="thread-1",
        skill_id="frontend-slides",
        gate_id="presentation_context",
        component="clarification.form",
        answers={"purpose": "Pitch deck"},
    )

    assert next_pending_gate(context) is None


def test_generic_two_gate_skill_advances_without_repeating_completed_gate():
    gates = [_gate(gate_id="one"), _gate(gate_id="two")]
    context = {
        "active_skill": "generic-skill",
        "active_skill_scope": {"interaction_contract": {"gates": gates}},
    }

    assert next_pending_gate(context)["gate_id"] == "one"
    mark_gate_completed(
        context,
        skill_id="generic-skill",
        gate_id="one",
        component="clarification.form",
        answers={"ok": True},
    )
    assert next_pending_gate(context)["gate_id"] == "two"
    mark_gate_completed(
        context,
        skill_id="generic-skill",
        gate_id="two",
        component="clarification.form",
        answers={"ok": True},
    )
    assert next_pending_gate(context) is None


def test_workflow_action_emits_native_a2ui_and_marks_completed_on_resume(monkeypatch):
    seen_payload = {}

    def fake_interrupt(payload):
        seen_payload.update(payload)
        return {"answersByQuestionId": {"ok": "yes"}}

    monkeypatch.setattr(tools_and_schemas, "interrupt", fake_interrupt)
    workspace = SimpleNamespace(context={"thread_id": "thread-1", "run_id": "run-1"})
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(_args(_gate()))

    assert seen_payload["a2uiRequest"]["contract"] == "a2ui"
    assert seen_payload["a2uiRequest"]["gateId"] == "confirm"
    assert json.loads(result)["answersByQuestionId"]["ok"] == "yes"
    ledger = workspace.context[A2UI_LEDGER_KEY]
    assert ledger[0]["status"] == "completed"
    assert ledger[0]["thread_id"] == "thread-1"
    assert ledger[0]["answers"]["answersByQuestionId"]["ok"] == "yes"


def response_has_tool_call(response):
    return bool(response.result[0].tool_calls)
