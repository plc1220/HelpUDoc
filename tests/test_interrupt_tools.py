from __future__ import annotations

from pathlib import Path

from helpudoc_agent.tagged_file_policy import is_tool_blocked_in_tagged_files_mode


TOOLS_FILE = Path(__file__).resolve().parents[1] / "agent" / "helpudoc_agent" / "tools_and_schemas.py"


def _method_block(name: str) -> str:
    source = TOOLS_FILE.read_text(encoding="utf-8")
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


def test_tagged_file_policy_blocks_context_expanding_tools() -> None:
    assert is_tool_blocked_in_tagged_files_mode("append_to_report") is True
    assert is_tool_blocked_in_tagged_files_mode("gemini_image") is True
