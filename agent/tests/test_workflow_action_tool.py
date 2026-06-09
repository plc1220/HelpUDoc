import json

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.interrupt_payloads import extract_interrupt_payload_from_tool_call
from helpudoc_agent.tools.workspace.builtins.a2ui import build_workflow_action_tool
from helpudoc_agent.tools.workspace.builtins.human_interrupts import build_request_human_action_tool


def test_workflow_action_ask_user_a2ui_emits_structured_interrupt(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-a2ui", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {
            "surfaceId": "surface-presentation_context",
            "actionId": "submit",
            "values": {
                "answers": {
                    "purpose": "Teaching/Tutorial",
                },
            },
        }

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "ask_user_a2ui",
            "reason": "Need setup before outline.",
            "gate_id": "presentation_context",
            "component": "clarification.form",
            "props_json": json.dumps(
                {
                    "title": "Presentation Setup",
                    "questions": [
                        {
                            "id": "purpose",
                            "question": "What is this presentation for?",
                            "options": [
                                {
                                    "id": "purpose-teaching",
                                    "label": "Teaching/Tutorial",
                                    "value": "Teaching/Tutorial",
                                }
                            ],
                        }
                    ],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "presentation_context",
                    "uiContract": "a2ui",
                    "expectedComponent": "clarification_form",
                }
            ),
        }
    )

    parsed = json.loads(result)
    assert parsed["values"]["answers"]["purpose"] == "Teaching/Tutorial"
    payload = captured["payload"]
    assert payload["kind"] == "clarification"
    assert payload["title"] == "Presentation Setup"
    assert payload["display_payload"]["gateId"] == "presentation_context"
    assert payload["a2uiRequest"]["component"] == "clarification.form"
    assert payload["a2uiRequest"]["gateId"] == "presentation_context"
    assert workspace.context["frontend_slides_completed_a2ui_gates"] == ["presentation_context"]


def test_workflow_action_rejects_unknown_action(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-a2ui", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke({"action": "ask_in_prose"})

    assert result.startswith("Workflow action blocked:")


def test_workflow_action_rejects_unknown_frontend_slides_gate(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-a2ui", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(
        {
            "action": "ask_user_a2ui",
            "gate_id": "surprise_gate",
            "component": "clarification.form",
            "props_json": json.dumps({"title": "Surprise", "questions": [{"id": "q", "question": "Q?"}]}),
            "context_json": json.dumps({"skill": "frontend-slides", "gateId": "surprise_gate"}),
        }
    )

    assert "unknown frontend-slides A2UI gate" in result


def test_workflow_action_rejects_frontend_slides_component_mismatch(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-a2ui", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(
        {
            "action": "ask_user_a2ui",
            "gate_id": "style_preview_selection",
            "component": "clarification.form",
            "props_json": json.dumps({"title": "Style", "questions": [{"id": "style", "question": "Style?"}]}),
            "context_json": json.dumps({"skill": "frontend-slides", "gateId": "style_preview_selection"}),
        }
    )

    assert "requires component" in result


def test_request_human_action_tool_call_extracts_native_a2ui_payload():
    payload = extract_interrupt_payload_from_tool_call(
        "request_human_action",
        json.dumps(
            {
                "title": "Choose Next Step",
                "description": "Pick how the workflow should continue.",
                "actions_json": json.dumps(
                    [
                        {
                            "id": "revise",
                            "label": "Revise",
                            "style": "secondary",
                            "inputMode": "text",
                            "placeholder": "What should change?",
                        },
                        {
                            "id": "approve",
                            "label": "Approve",
                            "style": "primary",
                        },
                    ]
                ),
                "context_json": json.dumps(
                    {
                        "skill": "research",
                        "gateId": "next_step",
                        "uiContract": "a2ui",
                    }
                ),
            }
        ),
    )

    assert payload is not None
    assert payload["kind"] == "approval"
    assert payload["a2uiRequest"]["component"] == "approval.card"
    assert payload["a2uiRequest"]["skill"] == "research"
    assert payload["a2uiRequest"]["gateId"] == "next_step"
    assert payload["a2uiRequest"]["props"]["actions"][0]["inputMode"] == "text"
    assert payload["uiRequest"]["component"] == "approval"


def test_request_human_action_runtime_emits_native_a2ui_payload(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="human-action-a2ui", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"action": {"id": "approve"}}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_request_human_action_tool(workspace)
    result = tool.invoke(
        {
            "title": "Choose Next Step",
            "description": "Pick how the workflow should continue.",
            "actions_json": json.dumps(
                [
                    {
                        "id": "approve",
                        "label": "Approve",
                        "style": "primary",
                    }
                ]
            ),
            "context_json": json.dumps(
                {
                    "skill": "research",
                    "gateId": "next_step",
                    "uiContract": "a2ui",
                }
            ),
        }
    )

    parsed = json.loads(result)
    assert parsed["action"]["id"] == "approve"
    payload = captured["payload"]
    assert payload["kind"] == "approval"
    assert payload["a2uiRequest"]["component"] == "approval.card"
    assert payload["a2uiRequest"]["skill"] == "research"
    assert payload["a2uiRequest"]["gateId"] == "next_step"
