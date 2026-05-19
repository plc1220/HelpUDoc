from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from helpudoc_agent.tagged_file_policy import is_tool_blocked_in_tagged_files_mode
import helpudoc_agent.tools_and_schemas as tools_and_schemas
from helpudoc_agent.tools.workspace.builtins.human_interrupts import (
    build_request_clarification_tool,
    build_request_plan_approval_tool,
)


HUMAN_INTERRUPTS_FILE = (
    Path(__file__).resolve().parents[1]
    / "agent"
    / "helpudoc_agent"
    / "tools"
    / "workspace"
    / "builtins"
    / "human_interrupts.py"
)


def _method_block(name: str) -> str:
    source = HUMAN_INTERRUPTS_FILE.read_text(encoding="utf-8")
    marker = f"def {name}("
    start = source.index(marker)
    next_method = source.find("\n    def _build_", start + len(marker))
    if next_method == -1:
        return source[start:]
    return source[start:next_method]


def test_request_clarification_not_blocked_by_tagged_files_only() -> None:
    block = _method_block("request_clarification")
    assert 'tagged_files_mode_guard(workspace_state.context, "request_clarification")' not in block
    assert '"kind": "clarification"' in block


def test_request_human_action_not_blocked_by_tagged_files_only() -> None:
    block = _method_block("request_human_action")
    assert 'tagged_files_mode_guard(workspace_state.context, "request_human_action")' not in block
    assert "interrupt_kind" in block


def test_tagged_file_policy_allows_control_flow_interrupt_tools() -> None:
    assert is_tool_blocked_in_tagged_files_mode("list_skills") is False
    assert is_tool_blocked_in_tagged_files_mode("load_skill") is False
    assert is_tool_blocked_in_tagged_files_mode("request_plan_approval") is False
    assert is_tool_blocked_in_tagged_files_mode("request_clarification") is False
    assert is_tool_blocked_in_tagged_files_mode("request_human_action") is False


def test_tagged_file_policy_allows_context_expanding_tools() -> None:
    assert is_tool_blocked_in_tagged_files_mode("append_to_report") is False
    assert is_tool_blocked_in_tagged_files_mode("gemini_image") is False


def test_interrupt_with_retry_stops_after_stale_resume_payload(monkeypatch) -> None:
    calls = 0

    def fake_interrupt(_payload):
        nonlocal calls
        calls += 1
        return {"decisions": [{"type": "approve"}]}

    monkeypatch.setattr(tools_and_schemas, "interrupt", fake_interrupt)

    try:
        tools_and_schemas._interrupt_with_retry(
            {"kind": "clarification", "title": "Need input"},
            valid_keys={"message"},
            stale_keys={"decisions"},
            label="request_clarification",
            attempts=2,
        )
    except RuntimeError as exc:
        assert "avoid re-entering the same interrupt loop" in str(exc)
    else:
        raise AssertionError("expected stale interrupt resume payload to stop the run")

    assert calls == 2


def test_request_plan_approval_retries_stale_clarification_payload(monkeypatch) -> None:
    responses = [
        {"message": "Use a tighter scope"},
        {"decisions": [{"type": "approve"}]},
    ]

    def fake_interrupt(_payload):
        return responses.pop(0)

    monkeypatch.setattr(tools_and_schemas, "interrupt", fake_interrupt)
    workspace = SimpleNamespace(context={})
    tool = build_request_plan_approval_tool(workspace)

    result = tool.invoke(
        {
            "plan_title": "Dashboard plan",
            "plan_summary": "Build the dashboard",
            "execution_checklist": "- Inspect data\n- Generate pages",
        }
    )

    assert "PLAN_APPROVAL_RECORDED" in result
    assert workspace.context["plan_approved"] is True
    assert responses == []


def test_request_plan_approval_records_edit_decision(monkeypatch) -> None:
    def fake_interrupt(_payload):
        return {
            "decisions": [
                {
                    "type": "edit",
                    "message": "Narrow to tagged files only",
                    "edited_action": {
                        "name": "request_plan_approval",
                        "args": {
                            "reviewer_feedback": "Use only the tagged Parquet files.",
                            "edited_plan_content": "# Revised plan",
                        },
                    },
                }
            ]
        }

    monkeypatch.setattr(tools_and_schemas, "interrupt", fake_interrupt)
    workspace = SimpleNamespace(context={})
    tool = build_request_plan_approval_tool(workspace)

    result = tool.invoke(
        {
            "plan_title": "Dashboard plan",
            "plan_summary": "Build the dashboard",
            "execution_checklist": "- Inspect data\n- Generate pages",
        }
    )

    assert "PLAN_EDIT_FEEDBACK_RECORDED" in result
    assert "Use only the tagged Parquet files." in result
    assert "Edited draft included: yes" in result
    assert workspace.context["plan_approved"] is False


def test_request_clarification_accepts_native_question_and_context_payloads(monkeypatch) -> None:
    seen_payload = {}

    def fake_interrupt(payload):
        seen_payload.update(payload)
        return {
            "answersByQuestionId": {
                "purpose": "Pitch deck",
            }
        }

    monkeypatch.setattr(tools_and_schemas, "interrupt", fake_interrupt)
    workspace = SimpleNamespace(context={})
    tool = build_request_clarification_tool(workspace)

    result = tool.invoke(
        {
            "title": "Presentation Discovery",
            "questions_json": [
                {
                    "id": "purpose",
                    "header": "Purpose",
                    "question": "What is this presentation for?",
                    "options": [
                        {
                            "label": "Pitch deck",
                            "value": "Pitch deck",
                            "description": "Selling an idea",
                        }
                    ],
                }
            ],
            "options_json": [],
            "allow_freeform": False,
            "context_json": {"skill": "frontend-slides"},
        }
    )

    assert seen_payload["response_spec"]["questions"][0]["header"] == "Purpose"
    assert seen_payload["response_spec"]["questions"][0]["options"][0]["label"] == "Pitch deck"
    assert seen_payload["display_payload"]["skill"] == "frontend-slides"
    assert "Purpose: Pitch deck" in result


def test_request_clarification_schema_keeps_json_payload_fields_as_strings() -> None:
    workspace = SimpleNamespace(context={})
    tool = build_request_clarification_tool(workspace)

    schema = tool.args_schema.model_json_schema()

    assert schema["properties"]["options_json"]["type"] == "string"
    assert schema["properties"]["questions_json"]["type"] == "string"
    assert schema["properties"]["context_json"]["type"] == "string"
