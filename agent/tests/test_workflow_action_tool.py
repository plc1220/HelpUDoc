import json

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.interrupt_payloads import extract_interrupt_payload_from_tool_call
from helpudoc_agent.tools.workspace.builtins.interaction import build_workflow_action_tool
from helpudoc_agent.tools.workspace.builtins.human_interrupts import build_request_human_action_tool


def test_workflow_action_request_user_interaction_emits_structured_interrupt(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {
            "interactionId": "interaction-presentation_context",
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
            "action": "request_user_interaction",
            "reason": "Need setup before outline.",
            "gate_id": "presentation_context",
            "presentation": "questionnaire",
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
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
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
    assert payload["interactionRequest"]["presentation"] == "questionnaire"
    assert payload["interactionRequest"]["gateId"] == "presentation_context"
    assert workspace.context["frontend_slides_completed_interaction_gates"] == ["presentation_context"]


def test_workflow_action_rejects_unknown_action(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke({"action": "ask_in_prose"})

    assert result.startswith("Workflow action blocked:")


def test_workflow_action_rejects_unknown_frontend_slides_gate(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "surprise_gate",
            "presentation": "questionnaire",
            "props_json": json.dumps({"title": "Surprise", "questions": [{"id": "q", "question": "Q?"}]}),
            "context_json": json.dumps({"skill": "frontend-slides", "gateId": "surprise_gate"}),
        }
    )

    assert "unknown frontend-slides Interaction gate" in result


def test_workflow_action_rejects_completed_interaction_gate(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    workspace.context.update(
        {
            "run_id": "run-completed-gate",
            "thread_id": "thread-completed-gate",
            "interaction_gate_ledger": [
                {
                    "run_id": "run-completed-gate",
                    "thread_id": "thread-completed-gate",
                    "skill_id": "frontend-slides",
                    "gate_id": "presentation_context",
                    "presentation": "questionnaire",
                    "status": "completed",
                }
            ],
        }
    )
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"interactionId": "interaction-presentation_context", "actionId": "submit"}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "presentation_context",
            "presentation": "questionnaire",
            "props_json": json.dumps(
                {
                    "title": "Presentation Setup",
                    "questions": [{"id": "purpose", "question": "What is this for?"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "presentation_context",
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
                }
            ),
        }
    )

    assert "already completed" in result
    assert captured == {}


def test_workflow_action_rejects_frontend_slides_component_mismatch(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "style_preview_selection",
            "presentation": "questionnaire",
            "props_json": json.dumps({"title": "Style", "questions": [{"id": "style", "question": "Style?"}]}),
            "context_json": json.dumps({"skill": "frontend-slides", "gateId": "style_preview_selection"}),
        }
    )

    assert "requires presentation" in result


def test_workflow_action_frontend_slides_gate_forces_clarification_resume(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {
            "interactionId": "interaction-style_preview_selection",
            "actionId": "submit",
            "values": {"selectedChoiceId": "style-a"},
        }

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "style_preview_selection",
            "presentation": "style_preview",
            "resume_mode": "approval",
            "props_json": json.dumps(
                {
                    "title": "Choose Presentation Style",
                    "choices": [{"id": "style-a", "label": "Style A"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "style_preview_selection",
                    "interactionContract": "helpudoc.interaction",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "submit"
    payload = captured["payload"]
    assert payload["kind"] == "clarification"
    assert payload["interactionRequest"]["resumeAction"]["endpoint"] == "respond"


def test_workflow_action_normalizes_legacy_style_preview_options(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-style-options", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {
            "interactionId": "interaction-style_preview_selection",
            "actionId": "submit",
            "values": {"selectedChoiceId": "style-c"},
        }

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "style_preview_selection",
            "presentation": "style_preview",
            "props_json": json.dumps(
                {
                    "title": "Choose Presentation Style",
                    "options": [
                        {
                            "id": "style-a",
                            "label": "Blue Professional",
                            "preview_path": "/style-a.html",
                        },
                        {
                            "id": "style-b",
                            "label": "Signal",
                            "preview_path": "/style-b.html",
                        },
                        {
                            "id": "style-c",
                            "label": "Cobalt Grid",
                            "preview_path": "/style-c.html",
                        },
                    ],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "style_preview_selection",
                    "interactionContract": "helpudoc.interaction",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "submit"
    props = captured["payload"]["interactionRequest"]["props"]
    assert [(choice["id"], choice["label"]) for choice in props["choices"]] == [
        ("style-a", "Blue Professional"),
        ("style-b", "Signal"),
        ("style-c", "Cobalt Grid"),
    ]
    assert [(preview["id"], preview["path"]) for preview in props["previews"]] == [
        ("style-a", "/style-a.html"),
        ("style-b", "/style-b.html"),
        ("style-c", "/style-c.html"),
    ]


def test_workflow_action_rejects_outline_gate_without_embedded_outline(tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    tool = build_workflow_action_tool(workspace)

    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "outline_confirmation",
            "presentation": "questionnaire",
            "props_json": json.dumps(
                {
                    "title": "Outline Confirmation",
                    "description": "Review the proposed slide outline above.",
                    "questions": [{"id": "outline", "question": "Does this look right?"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "outline_confirmation",
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
                }
            ),
        }
    )

    assert "requires the proposed outline" in result


def test_workflow_action_promotes_recent_artifact_to_outline_props(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    (tmp_path / "slide_outline_v1.md").write_text("# Proposed Outline\n\n1. Title\n2. Result", encoding="utf-8")
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"interactionId": "interaction-outline_confirmation", "actionId": "submit"}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    generate_result = tool.invoke(
        {
            "action": "generate_artifact",
            "reason": "Draft outline.",
            "artifact_refs_json": json.dumps(["slide_outline_v1"]),
        }
    )
    assert json.loads(generate_result)["ok"] is True

    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "outline_confirmation",
            "presentation": "questionnaire",
            "props_json": json.dumps(
                {
                    "title": "Outline Confirmation",
                    "questions": [{"id": "outline", "question": "Does this look right?"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "outline_confirmation",
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "submit"
    props = captured["payload"]["interactionRequest"]["props"]
    assert props["outlineMarkdown"].startswith("# Proposed Outline")


def test_workflow_action_promotes_workspace_outline_file_without_refs(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    (tmp_path / "slide_outline_v1.md").write_text("# Workspace Outline\n\n1. Title", encoding="utf-8")
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"interactionId": "interaction-outline_confirmation", "actionId": "submit"}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "outline_confirmation",
            "presentation": "questionnaire",
            "props_json": json.dumps(
                {
                    "title": "Outline Confirmation",
                    "questions": [{"id": "outline", "question": "Does this look right?"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "outline_confirmation",
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "submit"
    assert captured["payload"]["interactionRequest"]["props"]["outlineMarkdown"].startswith("# Workspace Outline")
    assert captured["payload"]["interactionRequest"]["metadata"]["skill"] == "frontend-slides"


def test_workflow_action_promotes_context_outline_to_interaction_props(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"interactionId": "interaction-outline_confirmation", "actionId": "submit", "values": {"answers": {}}}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "gate_id": "outline_confirmation",
            "presentation": "questionnaire",
            "props_json": json.dumps(
                {
                    "title": "Outline Confirmation",
                    "questions": [{"id": "outline", "question": "Does this look right?"}],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "frontend-slides",
                    "gateId": "outline_confirmation",
                    "interactionContract": "helpudoc.interaction",
                    "expectedPresentation": "questionnaire",
                    "outlineMarkdown": "## Proposed outline\n\n1. Title\n2. Takeaways",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "submit"
    props = captured["payload"]["interactionRequest"]["props"]
    assert props["outlineMarkdown"] == "## Proposed outline\n\n1. Title\n2. Takeaways"


def test_workflow_action_act_mode_preserves_top_level_actions(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="workflow-interaction-actions", root_path=tmp_path)
    captured = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"interactionId": "interaction-next_step", "actionId": "revise", "values": {"action": {"id": "revise"}}}

    monkeypatch.setattr("helpudoc_agent.tools_and_schemas.interrupt", fake_interrupt)

    tool = build_workflow_action_tool(workspace)
    result = tool.invoke(
        {
            "action": "request_user_interaction",
            "reason": "Need a human action choice.",
            "gate_id": "next_step",
            "presentation": "action_review",
            "resume_mode": "action",
            "props_json": json.dumps(
                {
                    "title": "Choose Next Step",
                    "actions": [
                        {
                            "id": "revise",
                            "label": "Revise",
                            "inputMode": "text",
                        },
                        {
                            "id": "approve",
                            "label": "Approve",
                            "style": "primary",
                        },
                    ],
                }
            ),
            "context_json": json.dumps(
                {
                    "skill": "research",
                    "gateId": "next_step",
                    "interactionContract": "helpudoc.interaction",
                }
            ),
        }
    )

    assert json.loads(result)["actionId"] == "revise"
    payload = captured["payload"]
    assert payload["kind"] == "approval"
    assert payload["interactionRequest"]["resumeAction"]["endpoint"] == "act"
    assert payload["interactionRequest"]["props"]["actions"][0]["id"] == "revise"
    assert payload["actions"][0]["id"] == "revise"


def test_request_human_action_tool_call_extracts_native_interaction_payload():
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
                        "interactionContract": "helpudoc.interaction",
                    }
                ),
            }
        ),
    )

    assert payload is not None
    assert payload["kind"] == "approval"
    assert payload["interactionRequest"]["presentation"] == "action_review"
    assert payload["interactionRequest"]["skill"] == "research"
    assert payload["interactionRequest"]["gateId"] == "next_step"
    assert payload["interactionRequest"]["props"]["actions"][0]["inputMode"] == "text"
    assert payload["interactionRequest"]["presentation"] == "action_review"


def test_request_human_action_runtime_emits_native_interaction_payload(monkeypatch, tmp_path):
    workspace = WorkspaceState(workspace_id="human-action-interaction", root_path=tmp_path)
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
                    "interactionContract": "helpudoc.interaction",
                }
            ),
        }
    )

    parsed = json.loads(result)
    assert parsed["action"]["id"] == "approve"
    payload = captured["payload"]
    assert payload["kind"] == "approval"
    assert payload["interactionRequest"]["presentation"] == "action_review"
    assert payload["interactionRequest"]["skill"] == "research"
    assert payload["interactionRequest"]["gateId"] == "next_step"
