"""A tool call that Gemini wrote as reply text instead of making it.

Gemini sometimes sends `call:default_api:read_file{path:/a}` as plain text. Nothing runs, and the
agent loop takes the text for the final answer. `default_api` is Gemini's own name for its tools.
The text is never run: its values have no quotes, so reading them back would be a guess.
"""
from __future__ import annotations

import re
from typing import Any

_STARTS = ("call:default_api:", ":call:default_api:", "<call:default_api:", "print(default_api.", "```tool_code")
# The whole reply, so an answer that only mentions this syntax is kept.
_WHOLE = re.compile(
    r"\s*(?:```tool_code\s*)?"
    r"(?::?call:default_api:[\w.-]+\s*\{.*\}"
    r"|<call:default_api:[\w.-]+\b[^\n]*/?>"
    r"|print\(default_api\.[\w.-]+\(.*\)\))"
    r"\s*(?:```)?\s*",
    re.DOTALL,
)

STILL_WRITTEN_TEXT = (
    "Lumo could not finish this request because the model kept returning an unusable reply. "
    "Please send your message again."
)


class WrittenToolCallError(RuntimeError):
    """The model kept writing its call. Its text is shown to the user as it is."""

    def __init__(self) -> None:
        super().__init__(STILL_WRITTEN_TEXT)


def is_written_tool_call(text: Any) -> bool:
    return isinstance(text, str) and _WHOLE.fullmatch(text) is not None


def may_be_written_tool_call(text: str) -> bool:
    """Whether the start of a reply could still turn out to be one."""
    start = text.lstrip()
    return any(start.startswith(s) or s.startswith(start) for s in _STARTS)
