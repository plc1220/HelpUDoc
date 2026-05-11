"""Parse embedded skill/MCP directives from user-visible chat text."""
from __future__ import annotations

from typing import Tuple

from .constants import (
    _DIRECTIVE_BLOCK_RE,
    _LEGACY_MCP_PROMPT_RE,
    _LEGACY_SKILL_PROMPT_RE,
    _LINE_MCP_DIRECTIVE_RE,
    _LINE_SKILL_DIRECTIVE_RE,
    _RAW_MCP_DIRECTIVE_RE,
    _RAW_SKILL_DIRECTIVE_RE,
)
from .schemas import EmbeddedDirective


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

    raw_skill_match = _RAW_SKILL_DIRECTIVE_RE.match(text)
    if raw_skill_match:
        return (
            EmbeddedDirective(kind="skill", skillId=(raw_skill_match.group("skill_id") or "").strip()),
            (raw_skill_match.group("prompt") or "").strip(),
        )

    raw_mcp_match = _RAW_MCP_DIRECTIVE_RE.match(text)
    if raw_mcp_match:
        return (
            EmbeddedDirective(kind="mcp", serverId=(raw_mcp_match.group("server_id") or "").strip()),
            (raw_mcp_match.group("prompt") or "").strip(),
        )

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

    lines = text.splitlines()
    for index, raw_line in enumerate(lines):
        if not raw_line.strip():
            continue
        skill_line_match = _LINE_SKILL_DIRECTIVE_RE.match(raw_line)
        if skill_line_match:
            remainder = "\n".join(lines[index + 1 :]).strip()
            prompt_parts = [
                (skill_line_match.group("prompt") or "").strip(),
                remainder,
            ]
            prompt = "\n\n".join(part for part in prompt_parts if part)
            return (
                EmbeddedDirective(kind="skill", skillId=(skill_line_match.group("skill_id") or "").strip()),
                prompt,
            )

        mcp_line_match = _LINE_MCP_DIRECTIVE_RE.match(raw_line)
        if mcp_line_match:
            remainder = "\n".join(lines[index + 1 :]).strip()
            prompt_parts = [
                (mcp_line_match.group("prompt") or "").strip(),
                remainder,
            ]
            prompt = "\n\n".join(part for part in prompt_parts if part)
            return (
                EmbeddedDirective(kind="mcp", serverId=(mcp_line_match.group("server_id") or "").strip()),
                prompt,
            )
        break

    return None, text
