from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from types import ModuleType

import pytest
from pydantic import BaseModel


CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from langchain_core.tools import StructuredTool, tool  # noqa: E402

from helpudoc_agent.configuration import Settings  # noqa: E402
from helpudoc_agent.graph import AgentRegistry, _clone_preservable_context  # noqa: E402
from helpudoc_agent.mcp_manager import (  # noqa: E402
    MCPServerManager,
    _preflight_gemini_tools,
    _wrap_tool_for_gemini,
)
from helpudoc_agent.skills_registry import (  # noqa: E402
    SkillMetadata,
    SkillPolicy,
    activate_skill_context,
    get_candidate_mcp_servers,
)
from helpudoc_agent.state import WorkspaceState  # noqa: E402


class PricingFilter(BaseModel):
    Field: str
    Value: str | list[str]
    Type: str = "EQUALS"


class BadPricingArgs(BaseModel):
    service_code: str
    filters: list[PricingFilter] | None = None


class SimpleArgs(BaseModel):
    query: str


class BadCostReportArgs(BaseModel):
    pricing_data: dict
    service_name: str
    detailed_cost_data: dict | None = None
    recommendations: dict | None = None


def _bad_pricing_tool():
    def _run(service_code: str, filters: list[dict] | None = None) -> str:
        return f"{service_code}:{filters}"

    return StructuredTool.from_function(
        func=_run,
        name="get_pricing",
        description="Pricing lookup",
        args_schema=BadPricingArgs,
    )


def _good_tool(name: str = "aws___search_documentation"):
    @tool(args_schema=SimpleArgs)
    def _run(query: str) -> str:
        """Simple tool."""
        return query

    _run.name = name
    return _run


def _bad_cost_report_tool():
    def _run(
        pricing_data: dict,
        service_name: str,
        detailed_cost_data: dict | None = None,
        recommendations: dict | None = None,
    ) -> str:
        return f"{service_name}:{pricing_data}"

    return StructuredTool.from_function(
        func=_run,
        name="generate_cost_report",
        description="Generate cost report",
        args_schema=BadCostReportArgs,
    )


def _build_settings(tmp_path: Path) -> Settings:
    payload = {
        "model": {"provider": "gemini"},
        "backend": {"workspace_root": str(tmp_path / "workspaces"), "skills_root": None},
        "tools": {},
        "mcp_servers": {
            "aws-pricing": {
                "name": "aws-pricing",
                "transport": "http",
                "url": "https://pricing.example.com/mcp",
            },
            "aws-knowledge": {
                "name": "aws-knowledge",
                "transport": "http",
                "url": "https://knowledge.example.com/mcp",
            },
            "google-workspace": {
                "name": "google-workspace",
                "transport": "http",
                "url": "https://workspace.example.com/mcp",
            },
        },
    }
    try:
        return Settings.model_validate(payload)
    except AttributeError:
        return Settings.parse_obj(payload)


class ToolFactoryStub:
    def build_tools(self, _tool_names, _workspace_state):
        return []


class UncopyableHandle:
    def __deepcopy__(self, memo):
        raise TypeError("cannot pickle '_duckdb.DuckDBPyConnection' object")


def test_preflight_handles_live_like_pricing_union_schema():
    pytest.importorskip("langchain_google_genai")
    _preflight_gemini_tools([_bad_pricing_tool()])


def test_registry_preserves_runtime_context_when_auth_fingerprint_rotates(tmp_path, monkeypatch):
    settings = _build_settings(tmp_path)
    created_tools: list[list[str]] = []

    class DummyAgent:
        def __init__(self, tools):
            self.tools = tools

        def with_config(self, _config):
            return self

    def fake_create_agent(*, model, tools, system_prompt, middleware, checkpointer):
        created_tools.append([getattr(tool, "name", None) for tool in tools])
        return DummyAgent(tools)

    async def fake_initialize(self, *, candidate_server_names=None, preflight_gemini=False):
        self._allowed_servers = {}
        self._tools_by_server = {}
        self._clients_by_server = {}
        self._rejected_servers = {}

    monkeypatch.setattr("helpudoc_agent.graph.create_agent", fake_create_agent)
    monkeypatch.setattr("helpudoc_agent.graph.init_chat_model", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemBackend", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.TodoListMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.SummarizationMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.PatchToolCallsMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.HumanInTheLoopMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.mcp_manager.MCPServerManager.initialize", fake_initialize)

    registry = AgentRegistry(settings, ToolFactoryStub())

    runtime = asyncio.run(
        registry.get_or_create(
            "fast",
            "workspace-rotate",
            initial_context={
                "user_id": "user-1",
                "mcp_policy": {"allowIds": [], "denyIds": [], "isAdmin": False},
                "mcp_auth_fingerprint": "fingerprint-a",
                "active_skill": "frontend-slides",
                "active_skill_scope": {"skill_id": "frontend-slides", "tools": []},
            },
        )
    )
    runtime.workspace_state.context["thread_id"] = "general-assistant:fast:workspace-rotate:user-1:thread"
    runtime.workspace_state.context["custom_resume_marker"] = "keep-me"
    runtime.workspace_state.context["data_agent_manager"] = UncopyableHandle()

    rotated_runtime = asyncio.run(
        registry.get_or_create(
            "fast",
            "workspace-rotate",
            initial_context={
                "user_id": "user-1",
                "mcp_policy": {"allowIds": [], "denyIds": [], "isAdmin": False},
                "mcp_auth_fingerprint": "fingerprint-b",
                "mcp_auth": {"google-workspace": {"Authorization": "Bearer refreshed-token"}},
            },
        )
    )

    assert rotated_runtime is not runtime
    assert rotated_runtime.workspace_state.context["thread_id"] == "general-assistant:fast:workspace-rotate:user-1:thread"
    assert rotated_runtime.workspace_state.context["active_skill"] == "frontend-slides"
    assert rotated_runtime.workspace_state.context["custom_resume_marker"] == "keep-me"
    assert "data_agent_manager" not in rotated_runtime.workspace_state.context
    assert rotated_runtime.workspace_state.context["mcp_auth_fingerprint"] == "fingerprint-b"
    assert rotated_runtime.workspace_state.context["mcp_auth"] == {
        "google-workspace": {"Authorization": "Bearer refreshed-token"}
    }
    assert len(created_tools) == 2


def test_clone_preservable_context_skips_uncopyable_handles():
    cloned = _clone_preservable_context(
        {
            "thread_id": "thread-123",
            "tagged_files": ["spec.docx"],
            "data_agent_manager": UncopyableHandle(),
        }
    )

    assert cloned["thread_id"] == "thread-123"
    assert cloned["tagged_files"] == ["spec.docx"]
    assert "data_agent_manager" not in cloned


def test_aws_pricing_wrapper_sanitizes_schema_and_normalizes_inputs():
    pytest.importorskip("langchain_google_genai")
    captured = {}

    class OriginalTool:
        name = "get_pricing"
        description = "Pricing lookup"
        return_direct = False
        response_format = "content"
        args_schema = _bad_pricing_tool().args_schema

        def invoke(self, payload, config=None, **kwargs):
            captured["payload"] = payload
            return {"ok": True}

    wrapped, _schema = _wrap_tool_for_gemini("aws-pricing", OriginalTool())
    _preflight_gemini_tools([wrapped])

    wrapped.invoke(
        {
            "service_code": "AmazonEC2",
            "region": ["us-east-1"],
            "filters": [
                {"Field": "instanceType", "Type": "EQUALS", "Value": ["m5.large"]},
                {"Field": "memory", "Type": "ANY_OF", "Value": ["8 GiB", "16 GiB"]},
            ],
        }
    )

    assert captured["payload"]["region"] == "us-east-1"
    assert captured["payload"]["filters"][0]["Value"] == "m5.large"
    assert captured["payload"]["filters"][1]["Value"] == ["8 GiB", "16 GiB"]


def test_aws_pricing_wrapper_sanitizes_cost_report_mapping_inputs():
    pytest.importorskip("langchain_google_genai")
    captured = {}

    class OriginalTool:
        name = "generate_cost_report"
        description = "Generate cost report"
        return_direct = False
        response_format = "content"
        args_schema = _bad_cost_report_tool().args_schema

        def invoke(self, payload, config=None, **kwargs):
            captured["payload"] = payload
            return {"ok": True}

    wrapped, _schema = _wrap_tool_for_gemini("aws-pricing", OriginalTool())
    _preflight_gemini_tools([wrapped])

    wrapped.invoke(
        {
            "pricing_data": [{"key": "sku", "value": "ABC123"}],
            "service_name": "AmazonS3",
            "detailed_cost_data": [{"key": "monthly", "value": "12.34"}],
            "recommendations": [{"key": "note", "value": "Use IA where possible"}],
        }
    )

    assert captured["payload"]["pricing_data"] == {"sku": "ABC123"}
    assert captured["payload"]["detailed_cost_data"] == {"monthly": "12.34"}
    assert captured["payload"]["recommendations"] == {"note": "Use IA where possible"}


def test_aws_pricing_wrapper_coerces_content_and_artifact_results():
    pytest.importorskip("langchain_google_genai")

    class OriginalTool:
        name = "get_pricing"
        description = "Pricing lookup"
        return_direct = False
        response_format = "content_and_artifact"
        args_schema = _bad_pricing_tool().args_schema

        def invoke(self, payload, config=None, **kwargs):
            return [{"text": "ok"}, {"sku": "ABC123"}]

    wrapped, _schema = _wrap_tool_for_gemini("aws-pricing", OriginalTool())
    _preflight_gemini_tools([wrapped])

    result = wrapped.invoke(
        {
            "service_code": "AmazonEC2",
            "region": ["us-east-1"],
        }
    )

    assert isinstance(result, str)
    assert "ok" in result
    assert "ABC123" in result


def test_preflight_accepts_simple_gemini_safe_tool():
    pytest.importorskip("langchain_google_genai")

    _preflight_gemini_tools([_good_tool()])


def test_candidate_servers_only_for_general_and_proposal_skills():
    assert get_candidate_mcp_servers(None) == []
    assert get_candidate_mcp_servers(None, preferred_server="google-workspace") == ["google-workspace"]
    assert get_candidate_mcp_servers({"skill_id": "research", "tools": [], "mcp_servers": []}) == []
    assert get_candidate_mcp_servers({"skill_id": "general", "tools": [], "mcp_servers": []}) == [
        "aws-pricing",
        "aws-knowledge",
    ]
    assert get_candidate_mcp_servers(
        {"skill_id": "general", "tools": [], "mcp_servers": []},
        preferred_server="google-workspace",
    ) == [
        "aws-pricing",
        "aws-knowledge",
        "google-workspace",
    ]
    assert get_candidate_mcp_servers({"skill_id": "proposal-writing", "tools": [], "mcp_servers": []}) == [
        "aws-pricing",
        "aws-knowledge",
    ]


def test_activate_skill_context_inherits_preferred_mcp_server():
    context = {"preferred_mcp_server": "google-workspace"}
    skill = SkillMetadata(
        skill_id="research",
        name="research",
        description=None,
        tools=[],
        mcp_servers=[],
        policy=SkillPolicy(),
        path=Path("/tmp/research/SKILL.md"),
    )

    activate_skill_context(context, skill)

    assert context["active_skill_scope"]["mcp_servers"] == ["google-workspace"]


def test_manager_accepts_wrapped_aws_pricing_and_compatible_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    pytest.importorskip("langchain_google_genai")
    settings = _build_settings(tmp_path)
    workspace_state = WorkspaceState(workspace_id="w1", root_path=tmp_path / "workspace")

    class FakeClient:
        def __init__(self, configs):
            self.server_name = next(iter(configs.keys()))

        async def get_tools(self):
            if self.server_name == "aws-pricing":
                return [_bad_pricing_tool()]
            return [_good_tool()]

    client_module = ModuleType("langchain_mcp_adapters.client")
    client_module.MultiServerMCPClient = FakeClient
    package_module = ModuleType("langchain_mcp_adapters")
    package_module.__path__ = []  # type: ignore[attr-defined]
    package_module.client = client_module
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters", package_module)
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters.client", client_module)

    manager = MCPServerManager(settings, workspace_state)
    caplog.set_level(logging.INFO)

    import asyncio

    asyncio.run(
        manager.initialize(
            candidate_server_names=["aws-pricing", "aws-knowledge"],
            preflight_gemini=True,
        )
    )

    assert list(manager.get_tools_by_server().keys()) == ["aws-pricing", "aws-knowledge"]
    assert manager.get_rejected_servers() == {}
    assert "Rejected MCP server during Gemini preflight" not in caplog.text


def test_agent_registry_builds_runtime_with_wrapped_aws_pricing_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pytest.importorskip("langchain_google_genai")
    settings = _build_settings(tmp_path)

    captured = {}

    class DummyAgent:
        def __init__(self, tools):
            self.tools = tools

        def with_config(self, _config):
            return self

    def fake_create_agent(*, model, tools, system_prompt, middleware, checkpointer):
        captured["tool_names"] = [getattr(tool, "name", None) for tool in tools]
        captured["model"] = model
        captured["middleware_count"] = len(middleware)
        return DummyAgent(tools)

    monkeypatch.setattr("helpudoc_agent.graph.create_agent", fake_create_agent)
    monkeypatch.setattr("helpudoc_agent.graph.init_chat_model", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemBackend", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.TodoListMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.SummarizationMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.PatchToolCallsMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.HumanInTheLoopMiddleware", lambda *args, **kwargs: object())

    class FakeClient:
        def __init__(self, configs):
            self.server_name = next(iter(configs.keys()))

        async def get_tools(self):
            if self.server_name == "aws-pricing":
                return [_bad_pricing_tool()]
            return [_good_tool()]

    client_module = ModuleType("langchain_mcp_adapters.client")
    client_module.MultiServerMCPClient = FakeClient
    package_module = ModuleType("langchain_mcp_adapters")
    package_module.__path__ = []  # type: ignore[attr-defined]
    package_module.client = client_module
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters", package_module)
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters.client", client_module)

    registry = AgentRegistry(settings, ToolFactoryStub())

    import asyncio

    runtime = asyncio.run(
        registry.get_or_create(
            "fast",
            "workspace-123",
            initial_context={
                "active_skill_scope": {
                    "skill_id": "general",
                    "tools": [],
                    "mcp_servers": [],
                }
            },
        )
    )

    assert runtime is not None
    assert captured["tool_names"] == ["get_pricing", "aws___search_documentation"]


def test_agent_registry_rebuilds_runtime_when_preferred_mcp_server_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    settings = _build_settings(tmp_path)
    initialize_calls: list[list[str]] = []

    class DummyAgent:
        def __init__(self, tools):
            self.tools = tools

        def with_config(self, _config):
            return self

    def fake_create_agent(*, model, tools, system_prompt, middleware, checkpointer):
        return DummyAgent(tools)

    async def fake_initialize(self, *, candidate_server_names=None, preflight_gemini=False):
        initialize_calls.append(list(candidate_server_names or []))
        self._allowed_servers = {}
        self._tools_by_server = {}
        self._clients_by_server = {}
        self._rejected_servers = {}

    monkeypatch.setattr("helpudoc_agent.graph.create_agent", fake_create_agent)
    monkeypatch.setattr("helpudoc_agent.graph.init_chat_model", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemBackend", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.TodoListMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.FilesystemMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.SummarizationMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.PatchToolCallsMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.graph.HumanInTheLoopMiddleware", lambda *args, **kwargs: object())
    monkeypatch.setattr("helpudoc_agent.mcp_manager.MCPServerManager.initialize", fake_initialize)

    registry = AgentRegistry(settings, ToolFactoryStub())

    runtime = asyncio.run(
        registry.get_or_create(
            "fast",
            "workspace-pref",
            initial_context={},
        )
    )
    rebound_runtime = asyncio.run(
        registry.get_or_create(
            "fast",
            "workspace-pref",
            initial_context={"preferred_mcp_server": "google-workspace"},
        )
    )

    assert runtime is not rebound_runtime
    assert initialize_calls == [[], ["google-workspace"]]
    assert rebound_runtime.workspace_state.context["preferred_mcp_server"] == "google-workspace"
    assert rebound_runtime.workspace_state.context["_bound_mcp_candidates"] == ["google-workspace"]
