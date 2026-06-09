from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.interrupt_payloads import (  # noqa: E402
    encode_interrupt_payload_marker,
    extract_interrupt_payload_from_tool_call,
    extract_interrupt_payload_from_tool_text,
    normalize_interrupt_payload_value,
    strip_interrupt_payload_marker,
)


def test_extract_interrupt_payload_from_tool_text_parses_clarification_payload() -> None:
    payload = (
        "Interrupt(value={'kind': 'clarification', 'title': 'Presentation Context + Images', "
        "'description': 'Pick the setup details.', 'step_index': 0, 'step_count': 1, 'actions': [], "
        "'response_spec': {'inputMode': 'choice', 'choices': [{'id': 'purpose-pitch', 'label': 'Pitch deck', "
        "'value': 'Pitch deck'}], 'questions': [{'header': 'Purpose', 'question': 'What is this presentation for?', "
        "'options': [{'id': 'purpose-pitch', 'label': 'Pitch deck', 'value': 'Pitch deck'}]}]}, "
        "'display_payload': {'skill': 'frontend-slides'}}, "
        "id='interrupt-123')"
    )

    parsed = extract_interrupt_payload_from_tool_text(payload)

    assert parsed is not None
    assert parsed["type"] == "interrupt"
    assert parsed["kind"] == "clarification"
    assert parsed["interruptId"] == "interrupt-123"
    assert parsed["responseSpec"]["questions"][0]["header"] == "Purpose"
    assert parsed["displayPayload"]["skill"] == "frontend-slides"


def test_extract_interrupt_payload_from_tool_text_ignores_non_interrupt_output() -> None:
    assert extract_interrupt_payload_from_tool_text("plain tool output") is None


def test_extract_interrupt_payload_from_internal_marker() -> None:
    marker = encode_interrupt_payload_marker(
        {
            "kind": "clarification",
            "title": "Presentation Setup",
            "description": "Configure the presentation.",
            "response_spec": {
                "questions": [
                    {
                        "id": "purpose",
                        "header": "Purpose",
                        "question": "What is this presentation for?",
                        "options": [{"id": "pitch", "label": "Pitch deck", "value": "Pitch deck"}],
                    }
                ],
                "choices": [],
            },
            "display_payload": {
                "skill": "frontend-slides",
                "gateId": "presentation_context",
                "uiContract": "a2ui",
            },
        }
    )

    parsed = extract_interrupt_payload_from_tool_text(marker)

    assert parsed is not None
    assert parsed["type"] == "interrupt"
    assert parsed["kind"] == "clarification"
    assert parsed["displayPayload"]["gateId"] == "presentation_context"
    assert parsed["uiRequest"]["component"] == "clarification_form"


def test_extract_interrupt_payload_from_embedded_internal_marker_and_strip_visible_text() -> None:
    marker = encode_interrupt_payload_marker(
        {
            "kind": "clarification",
            "title": "Presentation Setup",
            "description": "Configure the presentation.",
            "response_spec": {"questions": [], "choices": []},
            "display_payload": {"skill": "frontend-slides", "gateId": "presentation_context"},
        }
    )
    text = f"I prepared the form for you. {marker}"

    parsed = extract_interrupt_payload_from_tool_text(text)

    assert parsed is not None
    assert parsed["kind"] == "clarification"
    assert parsed["displayPayload"]["gateId"] == "presentation_context"
    assert strip_interrupt_payload_marker(text) == "I prepared the form for you."


def test_extract_interrupt_payload_from_clarification_tool_call() -> None:
    tool_input = """{
        'title': 'Presentation Discovery',
        'description': 'Confirm the setup.',
        'questions_json': '[{"header":"Purpose","question":"What is this presentation for?","options":[{"label":"Pitch deck","value":"Pitch deck"}]}]',
        'allow_freeform': False,
        'submit_label': 'Continue',
        'step_index': 0,
        'step_count': 1,
        'context_json': '{"skill":"frontend-slides"}'
    }"""

    parsed = extract_interrupt_payload_from_tool_call("request_clarification", tool_input)

    assert parsed is not None
    assert parsed["type"] == "interrupt"
    assert parsed["kind"] == "clarification"
    assert parsed["title"] == "Presentation Discovery"
    assert parsed["responseSpec"]["questions"][0]["header"] == "Purpose"
    assert parsed["displayPayload"]["skill"] == "frontend-slides"


def test_extract_interrupt_payload_from_clarification_tool_call_accepts_native_lists() -> None:
    tool_input = """{
        'title': 'Presentation Discovery',
        'description': 'Confirm the setup.',
        'questions_json': [{'header':'Purpose','question':'What is this presentation for?','options':[{'label':'Pitch deck','value':'Pitch deck'}]}],
        'options_json': [],
        'allow_freeform': False,
        'submit_label': 'Continue',
        'context_json': {'skill':'frontend-slides'}
    }"""

    parsed = extract_interrupt_payload_from_tool_call("request_clarification", tool_input)

    assert parsed is not None
    assert parsed["responseSpec"]["questions"][0]["header"] == "Purpose"
    assert parsed["responseSpec"]["questions"][0]["options"][0]["label"] == "Pitch deck"
    assert parsed["displayPayload"]["skill"] == "frontend-slides"


def test_extract_interrupt_payload_from_clarification_tool_call_accepts_json_preview() -> None:
    tool_input = """{
        "title": "Presentation Discovery",
        "description": "Confirm the setup.",
        "questions_json": [{"header":"Purpose","question":"What is this presentation for?","options":[{"label":"Pitch deck","value":"Pitch deck"}]}],
        "options_json": [],
        "allow_freeform": false,
        "submit_label": "Continue",
        "context_json": {"skill":"frontend-slides"}
    }"""

    parsed = extract_interrupt_payload_from_tool_call("request_clarification", tool_input)

    assert parsed is not None
    assert parsed["responseSpec"]["questions"][0]["header"] == "Purpose"
    assert parsed["responseSpec"]["inputMode"] == "text"
    assert parsed["displayPayload"]["skill"] == "frontend-slides"


def test_extract_interrupt_payload_from_human_action_tool_call() -> None:
    tool_input = """{
        'title': 'Choose a style',
        'description': 'Pick one preview to continue.',
        'actions_json': '[{"id":"style-a","label":"Style A","style":"primary","inputMode":"none","value":"Style A"}]',
        'kind': 'clarification',
        'step_index': 1,
        'step_count': 2,
        'context_json': '{}'
    }"""

    parsed = extract_interrupt_payload_from_tool_call("request_human_action", tool_input)

    assert parsed is not None
    assert parsed["type"] == "interrupt"
    assert parsed["kind"] == "clarification"
    assert parsed["actions"][0]["id"] == "style-a"


def test_extract_interrupt_payload_from_plan_approval_tool_call() -> None:
    tool_input = """{
        'plan_title': 'Manufacturing Dashboard Plan',
        'plan_summary_markdown': 'Build the four requested dashboard pages.',
        'execution_checklist': '- Inspect Parquet schemas\\n- Build dashboard',
        'steps': [{'title': 'Inspect data', 'toolNames': ['get_table_schema'], 'fileImpacts': []}],
        'plan_file_path': 'research_plan.md',
        'status_label': 'Pending Dashboard Approval',
        'step_index': 0,
        'step_count': 1,
        'risky_actions': 'Creates dashboard files'
    }"""

    parsed = extract_interrupt_payload_from_tool_call("request_plan_approval", tool_input)

    assert parsed is not None
    assert parsed["type"] == "interrupt"
    assert parsed["kind"] == "approval"
    assert parsed["title"] == "Pending Dashboard Approval"
    assert parsed["actionRequests"][0]["name"] == "request_plan_approval"
    assert parsed["actionRequests"][0]["args"]["plan_title"] == "Manufacturing Dashboard Plan"
    assert parsed["reviewConfigs"][0]["allowed_decisions"] == ["approve", "edit", "reject"]
    assert parsed["displayPayload"]["planTitle"] == "Manufacturing Dashboard Plan"


def test_normalize_interrupt_payload_value_synthesizes_stable_interrupt_id() -> None:
    payload = {
        "kind": "clarification",
        "title": "Presentation Discovery",
        "description": "Confirm the setup.",
        "step_index": 0,
        "step_count": 1,
        "actions": [],
        "response_spec": {
            "inputMode": "choice",
            "questions": [
                {
                    "id": "purpose",
                    "header": "Purpose",
                    "question": "What is this presentation for?",
                }
            ],
        },
        "display_payload": {"skill": "frontend-slides"},
    }

    normalized_first = normalize_interrupt_payload_value(payload)
    normalized_second = normalize_interrupt_payload_value(dict(reversed(list(payload.items()))))

    assert normalized_first["interruptId"].startswith("interrupt-")
    assert normalized_first["interruptId"] == normalized_second["interruptId"]


def test_presentation_context_gate_produces_clarification_form() -> None:
    payload = {
        "kind": "clarification",
        "title": "Presentation Discovery",
        "description": "Confirm the setup.",
        "response_spec": {
            "questions": [
                {
                    "id": "purpose",
                    "header": "Purpose",
                    "question": "What is this presentation for?",
                }
            ]
        },
        "display_payload": {
            "skill": "frontend-slides",
            "gateId": "presentation_context",
            "uiContract": "a2ui",
            "expectedComponent": "clarification_form"
        }
    }
    normalized = normalize_interrupt_payload_value(payload)
    assert normalized.get("a2uiRequest") is not None
    assert normalized["a2uiRequest"]["contract"] == "a2ui"
    assert normalized["a2uiRequest"]["component"] == "clarification.form"
    assert normalized.get("uiRequest") is not None
    assert normalized["uiRequest"]["component"] == "clarification_form"
    assert normalized["uiRequest"]["props"]["questions"][0]["id"] == "purpose"


def test_style_preview_gate_produces_style_preview_chooser() -> None:
    payload = {
        "kind": "clarification",
        "title": "Choose Style",
        "description": "Pick a style preview.",
        "response_spec": {
            "choices": [
                {"id": "style-a", "label": "Style A", "value": "Style A"}
            ]
        },
        "display_payload": {
            "skill": "frontend-slides",
            "gateId": "style_preview_selection",
            "chooser": "style-previews",
            "stylePreviews": [
                {"id": "style-a", "html": "<html>Style A</html>"}
            ]
        }
    }
    normalized = normalize_interrupt_payload_value(payload)
    assert normalized.get("a2uiRequest") is not None
    assert normalized["a2uiRequest"]["component"] == "style.previewChooser"
    assert normalized.get("uiRequest") is not None
    assert normalized["uiRequest"]["component"] == "style_preview_chooser"
    assert normalized["uiRequest"]["props"]["choices"][0]["id"] == "style-a"
    assert normalized["uiRequest"]["props"]["previews"][0]["id"] == "style-a"


def test_native_a2ui_style_preview_request_projects_to_style_preview_chooser() -> None:
    payload = {
        "kind": "clarification",
        "title": "Select a Style Template",
        "description": "Pick a generated template.",
        "a2uiRequest": {
            "contract": "a2ui",
            "version": "0.9",
            "surfaceId": "surface-style-preview-selection",
            "component": "style.previewChooser",
            "props": {
                "title": "Select a Style Template",
                "choices": [
                    {"id": "style-a", "label": "Style A", "value": "Style A"}
                ],
                "previews": [
                    {"id": "style-a", "html": "<html>Style A</html>"}
                ],
            },
            "gateId": "style_preview_selection",
            "skill": "frontend-slides",
            "required": True,
            "resumeAction": {"endpoint": "respond", "actionId": "submit"},
        },
        "display_payload": {
            "skill": "frontend-slides",
            "gateId": "style_preview_selection",
            "uiContract": "a2ui",
            "expectedComponent": "style_preview_chooser",
        },
    }

    normalized = normalize_interrupt_payload_value(payload)

    assert normalized["a2uiRequest"]["component"] == "style.previewChooser"
    assert normalized["uiRequest"]["component"] == "style_preview_chooser"
    assert normalized["uiRequest"]["props"]["choices"][0]["id"] == "style-a"
    assert normalized["uiRequest"]["props"]["previews"][0]["id"] == "style-a"
