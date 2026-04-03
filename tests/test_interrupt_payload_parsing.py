from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.interrupt_payloads import (  # noqa: E402
    extract_interrupt_payload_from_tool_call,
    extract_interrupt_payload_from_tool_text,
    normalize_interrupt_payload_value,
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
