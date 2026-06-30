"""Shared constants and compiled patterns for the agent HTTP API."""
from __future__ import annotations

import re
from typing import Set

_INTERRUPT_TOOL_NAMES: Set[str] = {
    "request_clarification",
    "request_human_action",
    "request_plan_approval",
    "request_ui",
    "workflow_action",
}
_LOADED_SKILL_OUTPUT_ID = re.compile(r"^Loaded skill:\s*(\S+)", re.MULTILINE)
_LOCAL_DEV_AGENT_JWT_SECRET = "helpudoc-local-dev-agent-jwt-secret"
_RAG_PREFETCHABLE_EXTENSIONS: Set[str] = {".pdf", ".doc", ".docx", ".md", ".html", ".htm"}
_TAGGED_HTML_EXTENSIONS: Set[str] = {".html", ".htm"}
_TAGGED_DATASET_EXTENSIONS: Set[str] = {".parquet", ".csv"}
_TAGGED_RAG_CONTEXT_CHAR_BUDGET = 6000
_STRICT_DASHBOARD_QUERY_BUDGET = 5
_STRICT_DASHBOARD_PREVIEW_BUDGET = 1
_STRICT_DASHBOARD_SCHEMA_BUDGET = 1
_STRICT_DASHBOARD_CHART_BUDGET = 5

_FILE_RESULT_PATTERNS = [
    re.compile(r"Updated file (?P<path>/[^\s]+)"),
    re.compile(r"in '(?P<path>/[^']+)'"),
    re.compile(r"Appended (?P<src>/[^\s]+) to (?P<dst>/[^\s]+)"),
    re.compile(r"Created PDF (?P<path>/[^\s]+)"),
]
_DIRECTIVE_BLOCK_RE = re.compile(
    r"^\s*<<<HELPUDOC_DIRECTIVE\s*\n(?P<payload>\{.*?\})\n>>>\s*(?P<rest>[\s\S]*)$",
    re.DOTALL,
)
_RAW_SKILL_DIRECTIVE_RE = re.compile(
    r"^\s*/skill\s+(?P<skill_id>[^\s]+)(?:\s+(?P<prompt>[\s\S]*))?$",
    re.IGNORECASE,
)
_RAW_MCP_DIRECTIVE_RE = re.compile(
    r"^\s*/mcp\s+(?P<server_id>[^\s]+)(?:\s+(?P<prompt>[\s\S]*))?$",
    re.IGNORECASE,
)
_LEGACY_SKILL_PROMPT_RE = re.compile(
    r'^\s*Use the "(?P<skill_id>[^"]+)" skill for this task\.\s*'
    r'First call load_skill with "(?P=skill_id)" to load the skill instructions, then follow that skill closely\.\s*'
    r'(?:User request:\s*(?P<prompt>[\s\S]*))?$',
    re.IGNORECASE,
)
_LEGACY_MCP_PROMPT_RE = re.compile(
    r'^\s*Prefer tools from the MCP server "(?P<server_id>[^"]+)" for this task\.\s*'
    r'[\s\S]*?(?:User request:\s*(?P<prompt>[\s\S]*))?$',
    re.IGNORECASE,
)
_LINE_SKILL_DIRECTIVE_RE = re.compile(
    r"^\s*(?:(?:please\s+)?use\s+)?/skill\s+(?P<skill_id>[^\s]+)(?:\s+(?P<prompt>[\s\S]*))?$",
    re.IGNORECASE,
)
_LINE_MCP_DIRECTIVE_RE = re.compile(
    r"^\s*(?:(?:please\s+)?use\s+)?/mcp\s+(?P<server_id>[^\s]+)(?:\s+(?P<prompt>[\s\S]*))?$",
    re.IGNORECASE,
)

_INTERNAL_STREAM_TEXT_PATTERNS = (
    re.compile(r"^PLAN_(APPROVAL|EDIT|REJECTION|REJECT|CLARIFICATION|ACTION)_[A-Z_]+", re.IGNORECASE),
    re.compile(r"^Command\s*\(", re.IGNORECASE),
    re.compile(r"^\(?HumanMessage\s*\(", re.IGNORECASE),
    re.compile(r"^\[Clarification response\b", re.IGNORECASE),
    re.compile(r"^\(\s*\{\s*['\"]event['\"]\s*:\s*['\"](?:message|content-block)-", re.IGNORECASE),
    re.compile(r"^\{\s*['\"]event['\"]\s*:\s*['\"](?:message|content-block)-", re.IGNORECASE),
    re.compile(r"^\[\s*\{\s*['\"]event['\"]\s*:\s*['\"]content-block-", re.IGNORECASE),
)

_ASSISTANT_ROLES = {"assistant", "ai", "aimessagechunk"}
_TOOL_ROLES = {"tool"}
