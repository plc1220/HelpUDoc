from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.clarification_responses import normalize_clarification_resume_payload  # noqa: E402


def test_normalize_clarification_resume_payload_preserves_structured_answers() -> None:
    payload = json.loads(
        normalize_clarification_resume_payload(
            {
                "message": "Need a concise investor story.",
                "answersByQuestionId": {
                    "purpose": "Pitch deck",
                    "length": "Short (5-10)",
                },
            },
            questions=[
                {"id": "purpose", "header": "Purpose", "question": "What is this presentation for?"},
                {"id": "length", "header": "Length", "question": "How many slides?"},
            ],
        )
    )

    assert payload["answersByQuestionId"]["purpose"] == "Pitch deck"
    assert payload["answersByQuestionId"]["length"] == "Short (5-10)"
    assert payload["questionAnswers"][0]["header"] == "Purpose"
    assert "Notes: Need a concise investor story." in payload["summary"]


def test_normalize_clarification_resume_payload_migrates_legacy_message_lines() -> None:
    payload = json.loads(
        normalize_clarification_resume_payload(
            {
                "message": "Purpose: Teaching / Tutorial\nLength: Medium (10-20)",
            },
            questions=[
                {"id": "purpose", "header": "Purpose", "question": "What is this presentation for?"},
                {"id": "length", "header": "Length", "question": "How many slides?"},
            ],
        )
    )

    assert payload["answersByQuestionId"] == {
        "purpose": "Teaching / Tutorial",
        "length": "Medium (10-20)",
    }
    assert payload["summary"] == "Purpose: Teaching / Tutorial\nLength: Medium (10-20)"


def test_normalize_clarification_resume_payload_derives_selected_values_from_choice_ids() -> None:
    payload = json.loads(
        normalize_clarification_resume_payload(
            {
                "selectedChoiceIds": ["choice-2"],
            },
            choices=[
                {"id": "choice-1", "label": "Short", "value": "Short"},
                {"id": "choice-2", "label": "Medium", "value": "Medium"},
            ],
        )
    )

    assert payload["selectedChoiceIds"] == ["choice-2"]
    assert payload["selectedValues"] == ["Medium"]
    assert payload["summary"] == "Selected: Medium"
