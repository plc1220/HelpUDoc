"""A default data project for MCP tools that take one (BigQuery's projectId).

Guidance, not a block: the default fills an omitted project, and a project the
user names explicitly still goes through.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))
AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from helpudoc_agent.configuration import MCPProjectGuidance, MCPServerConfig, load_settings  # noqa: E402
from helpudoc_agent.mcp_manager import _preflight_gemini_tools, _wrap_tool_for_gemini  # noqa: E402

GUIDANCE = MCPProjectGuidance(default="ccob-my-cdlp-dev", also_available=["ccob-my-ai-engine-dev"])

# Shape of BigQuery MCP's list_table_ids, from its live tools/list on 2026-10-28.
LIST_TABLE_IDS_SCHEMA = {
    "type": "object",
    "properties": {
        "projectId": {"type": "string", "description": "Required. Project ID of the dataset request."},
        "datasetId": {"type": "string", "description": "Required. Dataset ID of the tables request."},
        "pageSize": {"type": "integer"},
    },
    "required": ["datasetId", "projectId"],
}


class FakeBigQueryTool:
    name = "list_table_ids"
    description = "List table ids in a BigQuery dataset."
    return_direct = False
    response_format = "content"

    def __init__(self, schema=LIST_TABLE_IDS_SCHEMA):
        self.args_schema = schema
        self.calls: list[dict] = []

    def invoke(self, payload, config=None, **kwargs):
        self.calls.append(dict(payload))
        return "ok"


def test_runtime_yaml_sets_the_bigquery_default_project():
    settings = load_settings()
    guidance = settings.mcp_servers["bigquery-managed"].project_guidance
    assert guidance is not None
    assert guidance.argument == "projectId"
    assert guidance.default == "ccob-my-cdlp-dev"
    assert guidance.also_available == ["ccob-my-ai-engine-dev"]


def test_config_accepts_camelcase_keys():
    cfg = MCPServerConfig.model_validate({
        "name": "bigquery-managed",
        "transport": "http",
        "url": "https://bigquery.googleapis.com/mcp",
        "projectGuidance": {"default": "ccob-my-cdlp-dev", "alsoAvailable": ["ccob-my-ai-engine-dev"]},
    })
    assert cfg.project_guidance.also_available == ["ccob-my-ai-engine-dev"]


def test_schema_names_the_default_and_no_longer_requires_the_project():
    wrapped, schema = _wrap_tool_for_gemini("bigquery-managed", FakeBigQueryTool(), GUIDANCE)
    description = schema["properties"]["projectId"]["description"]
    assert "Defaults to ccob-my-cdlp-dev when omitted." in description
    assert "Also available: ccob-my-ai-engine-dev." in description
    assert "Use another project only when the user names it." in description
    assert schema["required"] == ["datasetId"]
    # The original schema is not mutated; other servers keep it as they were.
    assert LIST_TABLE_IDS_SCHEMA["required"] == ["datasetId", "projectId"]


def test_an_omitted_project_gets_the_default():
    original = FakeBigQueryTool()
    wrapped, _ = _wrap_tool_for_gemini("bigquery-managed", original, GUIDANCE)
    wrapped.invoke({"datasetId": "complaints_published"})
    assert original.calls[-1] == {"datasetId": "complaints_published", "projectId": "ccob-my-cdlp-dev"}


def test_a_named_project_is_not_overridden():
    # Discouraged, not blocked: an explicit project, even one outside the list, runs.
    original = FakeBigQueryTool()
    wrapped, _ = _wrap_tool_for_gemini("bigquery-managed", original, GUIDANCE)
    wrapped.invoke({"datasetId": "x", "projectId": "ccob-my-cdlp-prd"})
    assert original.calls[-1]["projectId"] == "ccob-my-cdlp-prd"


def test_tools_without_the_argument_and_servers_without_guidance_are_unchanged():
    no_project = {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
    _, schema = _wrap_tool_for_gemini("bigquery-managed", FakeBigQueryTool(no_project), GUIDANCE)
    assert schema == no_project
    _, schema = _wrap_tool_for_gemini("bigquery-managed", FakeBigQueryTool(), None)
    assert schema["required"] == ["datasetId", "projectId"]


def test_wrapped_bigquery_tool_still_passes_gemini_preflight():
    pytest.importorskip("langchain_google_genai")
    wrapped, _ = _wrap_tool_for_gemini("bigquery-managed", FakeBigQueryTool(), GUIDANCE)
    _preflight_gemini_tools([wrapped])
