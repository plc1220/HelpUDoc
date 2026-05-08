"""Policy helpers for tagged-file turns."""
from __future__ import annotations

from typing import Any, Mapping


def is_tagged_files_only(context: Mapping[str, Any] | None) -> bool:
    """Tagged files are scope hints, not a tool-restriction mode."""
    return False


def is_tool_blocked_in_tagged_files_mode(tool_name: str) -> bool:
    """Tagged files no longer block tools; the agent may choose the right source."""
    return False


def tagged_files_mode_block_message() -> str:
    """Return the legacy block message for compatibility."""
    return "Tagged files are scope hints; tools are not blocked."


def tagged_files_mode_guard(context: Mapping[str, Any] | None, tool_name: str) -> str | None:
    """Tagged files no longer impose a tool gate."""
    return None
