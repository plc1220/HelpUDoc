"""Runtime contracts around the trusted document inspection primitives."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "agent"))

from helpudoc_agent.api.routes.chat import (  # noqa: E402
    _configured_recursion_limit,
    _is_terminal_tool_failure,
)
from helpudoc_agent.configuration import load_settings  # noqa: E402
from helpudoc_agent.document_tool_guard import LOOP_BREAK_ERROR_CODE  # noqa: E402


def test_terminal_tool_failure_recognizes_json_status_error() -> None:
    non_retryable = json.dumps(
        {
            "status": "error",
            "tool": "inspect_document",
            "message": "Document inspection failed: Workspace file not found: a.xlsx",
            "errorCode": "FILE_NOT_FOUND",
            "retryable": False,
            "suggestedNextCall": "ls(path='/')",
        }
    )
    assert _is_terminal_tool_failure("inspect_document", non_retryable) is True

    loop_break = json.dumps(
        {
            "status": "error",
            "tool": "search_document",
            "errorCode": LOOP_BREAK_ERROR_CODE,
            "retryable": False,
        }
    )
    assert _is_terminal_tool_failure("search_document", loop_break) is True

    retryable = json.dumps(
        {"status": "error", "errorCode": "DOCUMENT_READ_FAILED", "retryable": True}
    )
    assert _is_terminal_tool_failure("inspect_document", retryable) is False

    success = json.dumps({"status": "ok", "kind": "xlsx", "sheets": []})
    assert _is_terminal_tool_failure("inspect_document", success) is False


def test_terminal_tool_failure_keeps_legacy_google_search_detection() -> None:
    assert _is_terminal_tool_failure("google_search", '{"ok": false, "message": "x"}') is True
    assert _is_terminal_tool_failure("google_search", "Google search timed out") is True
    assert _is_terminal_tool_failure("google_search", '{"ok": true}') is False
    assert _is_terminal_tool_failure("write_file", "wrote /a.md") is False


def test_terminal_tool_failure_honors_structured_search_retryability() -> None:
    retryable = json.dumps(
        {
            "status": "error",
            "tool": "google_search",
            "errorCode": "SEARCH_TIMEOUT",
            "retryable": True,
        }
    )
    terminal = json.dumps(
        {
            "status": "error",
            "tool": "google_search",
            "errorCode": "SEARCH_CIRCUIT_OPEN",
            "retryable": False,
        }
    )

    assert _is_terminal_tool_failure("google_search", retryable) is False
    assert _is_terminal_tool_failure("google_search", terminal) is True


def test_recursion_limit_defaults_to_one_thousand() -> None:
    settings = load_settings()

    assert settings.backend.recursion_limit == 1000
    assert _configured_recursion_limit(settings) == 1000


def test_recursion_limit_is_configurable_by_env(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_RECURSION_LIMIT", "2500")
    assert load_settings().backend.recursion_limit == 2500

    # Invalid or non-positive values keep the configured default.
    monkeypatch.setenv("AGENT_RECURSION_LIMIT", "not-a-number")
    assert load_settings().backend.recursion_limit == 1000
    monkeypatch.setenv("AGENT_RECURSION_LIMIT", "0")
    assert load_settings().backend.recursion_limit == 1000


def test_agent_registry_uses_configured_recursion_limit() -> None:
    source = (REPO_ROOT / "agent" / "helpudoc_agent" / "runtime" / "agent_registry.py").read_text(
        encoding="utf-8"
    )

    assert 'with_config({"recursion_limit": int(self.settings.backend.recursion_limit)})' in source
    assert 'with_config({"recursion_limit": 1000})' not in source


def test_prompts_and_skills_describe_document_tool_contract() -> None:
    core_prompt = (REPO_ROOT / "agent" / "prompts" / "general" / "core.md").read_text(
        encoding="utf-8"
    )
    xlsx_skill = (REPO_ROOT / "skills" / "xlsx" / "SKILL.md").read_text(encoding="utf-8")
    proposal_skill = (REPO_ROOT / "skills" / "proposal-writing" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    for content in (core_prompt, xlsx_skill, proposal_skill):
        assert "LOOP_BREAK" in content
        assert "retryable" in content

    def _flat(text: str) -> str:
        return " ".join(text.split())

    flat_core = _flat(core_prompt)
    flat_xlsx = _flat(xlsx_skill)
    flat_proposal = _flat(proposal_skill)

    # Direct calls for small lookups, batching only for enumerable multi-reads.
    assert "One or two lookups" in flat_core
    assert "single Python tool-calling batch" in flat_core
    assert "One or two lookups" in flat_xlsx
    assert "Python tool-calling (PTC) batch" in flat_xlsx
    assert "Do not use batching to retry, poll, or explore blindly." in flat_core

    # An attachment must not displace an active multi-section skill.
    assert "An attached document does not displace an active skill" in flat_core
    assert "Attachments do not displace this skill" in flat_proposal
    assert "does not hand the run over to the" in flat_proposal
    assert "does not by itself take over the run" in flat_xlsx
    assert "proposal-writing" in flat_xlsx

    # Unsized Google exports are a documented, recoverable condition.
    assert "dimensionsError" in flat_xlsx
