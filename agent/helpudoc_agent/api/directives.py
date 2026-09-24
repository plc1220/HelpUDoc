"""Parse embedded skill/MCP directives from user-visible chat text."""
from __future__ import annotations

import re
from typing import Match, Tuple

from .constants import (
    _DIRECTIVE_BLOCK_RE,
    _LEGACY_MCP_PROMPT_RE,
    _LEGACY_SKILL_PROMPT_RE,
    _RAW_MCP_DIRECTIVE_RE,
    _RAW_SKILL_DIRECTIVE_RE,
)
from .schemas import EmbeddedDirective

_GAP_RE = re.compile(r"[ \t]{2,}")
_TRAILING_SPACE_RE = re.compile(r"[ \t]+\n")


def _remaining_prompt(text: str, match: Match[str]) -> str:
    """The message with the directive span removed.

    The match may begin with the whitespace or bracket that proved the slash was
    at a word boundary. That character is kept, or the words either side of a
    mid-sentence directive would run together.
    """
    start = match.start()
    if match.group(0)[:1] in " \t\n\r([{":
        start += 1
    remainder = f"{text[:start]}{text[match.end():]}"
    return _TRAILING_SPACE_RE.sub("\n", _GAP_RE.sub(" ", remainder)).strip()


def _extract_directive_from_text(text: str) -> Tuple[EmbeddedDirective | None, str]:
    if not text:
        return None, ""

    block_match = _DIRECTIVE_BLOCK_RE.match(text)
    if block_match:
        payload = block_match.group("payload")
        rest = (block_match.group("rest") or "").strip()
        try:
            directive = EmbeddedDirective.model_validate_json(payload)
        except Exception:
            return None, rest or text
        return directive, rest

    # The legacy prompt shapes are checked before the raw scan. They are exact
    # sentences rather than a token, so letting the looser scan see them first
    # would risk reading a slash out of their free-text tail.
    legacy_skill_match = _LEGACY_SKILL_PROMPT_RE.match(text)
    if legacy_skill_match:
        return (
            EmbeddedDirective(kind="skill", skillId=(legacy_skill_match.group("skill_id") or "").strip()),
            (legacy_skill_match.group("prompt") or "").strip(),
        )

    legacy_mcp_match = _LEGACY_MCP_PROMPT_RE.match(text)
    if legacy_mcp_match:
        return (
            EmbeddedDirective(kind="mcp", serverId=(legacy_mcp_match.group("server_id") or "").strip()),
            (legacy_mcp_match.group("prompt") or "").strip(),
        )

    # Anywhere in the message, and on any line. This used to read the first
    # non-empty line only, so a knowledge-base tag typed ahead of the skill hid
    # it completely. Whichever comes first wins, because a turn carries one.
    raw_skill_match = _RAW_SKILL_DIRECTIVE_RE.search(text)
    raw_mcp_match = _RAW_MCP_DIRECTIVE_RE.search(text)
    if raw_skill_match and (not raw_mcp_match or raw_skill_match.start() <= raw_mcp_match.start()):
        return (
            EmbeddedDirective(kind="skill", skillId=(raw_skill_match.group("skill_id") or "").strip()),
            _remaining_prompt(text, raw_skill_match),
        )
    if raw_mcp_match:
        return (
            EmbeddedDirective(kind="mcp", serverId=(raw_mcp_match.group("server_id") or "").strip()),
            _remaining_prompt(text, raw_mcp_match),
        )

    return None, text
