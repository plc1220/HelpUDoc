"""Plan steps must reach the reviewer as readable text, whatever keys the model used.

`request_plan_approval` accepts `steps: Optional[List[Dict[str, Any]]]` with no schema, and skills
document `execution_checklist` rather than `steps`, so the model invents its own key names. The
plan-review UI looked for title/label/description and otherwise rendered a literal "Step 1",
"Step 2"... which replaced the actual plan with positional placeholders in the approval gate.
"""
from __future__ import annotations

import json

from helpudoc_agent.interrupt_payloads import (
    build_plan_approval_interrupt_value,
    normalize_plan_steps,
)


def test_plain_strings_become_titles() -> None:
    assert normalize_plan_steps(["Gather sources", "  Write report  "]) == [
        {"title": "Gather sources"},
        {"title": "Write report"},
    ]


def test_canonical_shape_is_preserved() -> None:
    steps = normalize_plan_steps([
        {"title": "Record question", "detail": "write /question.txt", "state": "completed"},
    ])

    assert steps == [
        {"title": "Record question", "detail": "write /question.txt", "state": "completed"},
    ]


def test_alternate_key_names_are_coerced_to_title() -> None:
    # Each of these is a plausible key the model picks when the schema does not constrain it.
    for key in ("label", "name", "step", "action", "task", "summary", "text", "item", "description"):
        assert normalize_plan_steps([{key: "Collect evidence"}]) == [{"title": "Collect evidence"}]


def test_status_is_mapped_to_state() -> None:
    steps = normalize_plan_steps([{"step": "Get plan approval", "status": "pending"}])

    assert steps == [{"title": "Get plan approval", "state": "pending"}]


def test_description_becomes_detail_when_another_key_supplied_the_title() -> None:
    steps = normalize_plan_steps([{"title": "Synthesize", "description": "cross-source analysis"}])

    assert steps == [{"title": "Synthesize", "detail": "cross-source analysis"}]


def test_unknown_key_still_yields_its_text_rather_than_a_placeholder() -> None:
    steps = normalize_plan_steps([{"activity_description_v2": "Validate every source URL"}])

    assert steps == [{"title": "Validate every source URL"}]


def test_non_string_step_content_is_preserved_as_json() -> None:
    steps = normalize_plan_steps([{"index": 4, "done": False}])

    assert len(steps) == 1
    title = steps[0]["title"]
    assert "index" in title and "4" in title
    assert not title.startswith("Step ")


def test_extra_keys_surface_as_detail_when_no_detail_was_given() -> None:
    steps = normalize_plan_steps([{"title": "Run count_words", "tool": "run_skill_python_script"}])

    assert steps[0]["title"] == "Run count_words"
    assert "run_skill_python_script" in steps[0]["detail"]


def test_empty_and_malformed_inputs_are_dropped_not_faked() -> None:
    assert normalize_plan_steps(None) == []
    assert normalize_plan_steps("not a list") == []
    assert normalize_plan_steps([]) == []
    assert normalize_plan_steps(["", "   "]) == []


def test_interrupt_payload_carries_normalized_steps() -> None:
    """End to end: the payload the UI receives must already be normalized."""
    payload = build_plan_approval_interrupt_value({
        "plan_title": "Research plan",
        "plan_summary": "Summary",
        "steps": [
            {"step": "Record question", "status": "completed"},
            {"action": "Gather sources"},
        ],
    })

    assert payload is not None
    encoded = json.dumps(payload, ensure_ascii=False)
    assert "Record question" in encoded
    assert "Gather sources" in encoded

    request = payload["interactionRequest"]
    steps = request["props"]["steps"]
    assert [step["title"] for step in steps] == ["Record question", "Gather sources"]
    assert steps[0]["state"] == "completed"
