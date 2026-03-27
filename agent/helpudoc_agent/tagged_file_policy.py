"""Policy helpers for tagged-file RAG-only turns."""
from __future__ import annotations

from typing import Any, Mapping


_ALLOWED_TOOLS_IN_TAGGED_FILES_MODE = frozenset({
    "list_skills",
    "load_skill",
    "request_plan_approval",
    "request_clarification",
    "request_human_action",
})

_BLOCK_MESSAGE = "Tool disabled: tagged files were provided, use rag_query only."


def is_tagged_files_only(context: Mapping[str, Any] | None) -> bool:
    """Return true when the current turn is restricted to tagged-file RAG access."""
    return bool((context or {}).get("tagged_files_only"))


def is_tool_blocked_in_tagged_files_mode(tool_name: str) -> bool:
    """Return true when a tool should be blocked during tagged-file RAG-only turns."""
    normalized = (tool_name or "").strip()
    return normalized not in _ALLOWED_TOOLS_IN_TAGGED_FILES_MODE


def tagged_files_mode_block_message() -> str:
    """Consistent user-facing message for blocked tools in tagged-file mode."""
    return _BLOCK_MESSAGE


def tagged_files_mode_guard(context: Mapping[str, Any] | None, tool_name: str) -> str | None:
    """Return a block message when the tool should not run in tagged-file mode."""
    if is_tagged_files_only(context) and is_tool_blocked_in_tagged_files_mode(tool_name):
        return _BLOCK_MESSAGE
    return None
