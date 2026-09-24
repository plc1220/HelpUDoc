"""Exercise dynamic registration through real LangChain model/tool graph steps."""

from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import ToolCallRequest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from pydantic import Field

from helpudoc_agent.configuration import Settings
from helpudoc_agent.mcp_manager import MCPServerManager, _preflight_gemini_tools
from helpudoc_agent.middleware.mcp_discovery import MCPDiscoveryMiddleware, _tool_alias
from helpudoc_agent.state import WorkspaceState


class ScriptedModel(BaseChatModel):
    replies: list[AIMessage]
    seen_tools: list[list[str]] = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "scripted-mcp-harness-test"

    def bind_tools(self, tools, **kwargs):
        self.seen_tools.append([item.name for item in tools])
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        index = sum(isinstance(message, AIMessage) for message in messages)
        return ChatResult(generations=[ChatGeneration(message=self.replies[index])])


def call(name, args=None, id="call"):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args or {}, "id": id}]
    )


@pytest.fixture
def harness(tmp_path, monkeypatch):
    settings = Settings.model_validate(
        {
            "model": {"provider": "gemini"},
            "backend": {"workspace_root": str(tmp_path)},
            "tools": {},
            "mcp_servers": {
                name: {
                    "name": name,
                    "transport": "http",
                    "url": f"https://{name}.example/mcp",
                    "description": description,
                    "default_access": access,
                }
                for name, description, access in [
                    (
                        "google-workspace",
                        "Google Drive uploads, Gmail, Calendar",
                        "allow",
                    ),
                    ("aws-knowledge", "AWS documentation", "allow"),
                    ("restricted", "Private service", "deny"),
                ]
            },
        }
    )
    workspace = WorkspaceState(workspace_id="w1", root_path=tmp_path)
    connections, operations = [], []

    class FakeClient:
        def __init__(self, configs):
            self.server = next(iter(configs))
            connections.append(configs)

        async def get_tools(self):
            @tool
            async def upload_file(filename: str) -> str:
                """Upload a workspace file to this external service."""
                operations.append((self.server, filename))
                return f"uploaded {filename}"

            return [upload_file]

    monkeypatch.setattr(
        "langchain_mcp_adapters.client.MultiServerMCPClient", FakeClient
    )
    manager = MCPServerManager(settings, workspace)
    middleware = MCPDiscoveryMiddleware(manager)
    return SimpleNamespace(
        settings=settings,
        workspace=workspace,
        manager=manager,
        middleware=middleware,
        connections=connections,
        operations=operations,
    )


def test_untagged_discover_load_execute_same_graph_run(harness):
    alias = _tool_alias("google-workspace", "upload_file")
    model = ScriptedModel(
        replies=[
            call("list_mcp_servers", id="catalog"),
            call("load_mcp_tools", {"server_name": "google-workspace"}, id="load"),
            call(alias, {"filename": "report.pdf"}, id="upload"),
            AIMessage(content="Uploaded."),
        ]
    )
    _preflight_gemini_tools(harness.middleware.tools)
    agent = create_agent(model, middleware=[harness.middleware])
    result = asyncio.run(
        agent.ainvoke({"messages": [("user", "Upload report.pdf to Google Drive")]})
    )
    results = [
        message for message in result["messages"] if isinstance(message, ToolMessage)
    ]
    catalog = json.loads(results[0].content)["servers"]
    assert {entry["name"] for entry in catalog} == {"google-workspace", "aws-knowledge"}
    assert all(entry["status"] == "not_loaded" for entry in catalog)
    assert alias not in model.seen_tools[0] and alias not in model.seen_tools[1]
    assert alias in model.seen_tools[2]
    assert (
        results[-1].tool_call_id == "upload"
        and "uploaded report.pdf" in results[-1].content
    )
    assert harness.operations == [("google-workspace", "report.pdf")]
    assert len(harness.connections) == 1
    assert result["mcp_loaded_servers"] == ["google-workspace"]


def test_parallel_loads_merge_and_namespace_identical_operations(harness):
    calls = [
        {"name": "load_mcp_tools", "args": {"server_name": server}, "id": server}
        for server in ("google-workspace", "aws-knowledge")
    ]
    model = ScriptedModel(
        replies=[AIMessage(content="", tool_calls=calls), AIMessage(content="Ready")]
    )
    agent = create_agent(model, middleware=[harness.middleware])
    result = asyncio.run(agent.ainvoke({"messages": [("user", "Use both services")]}))
    assert set(result["mcp_loaded_servers"]) == {"google-workspace", "aws-knowledge"}
    aliases = {
        _tool_alias(server, "upload_file") for server in result["mcp_loaded_servers"]
    }
    assert len(aliases) == 2 and aliases.issubset(model.seen_tools[-1])
    assert harness.operations == []


def test_deny_and_skill_scope_block_discovery_loading_and_execution(harness):
    harness.workspace.context.update(
        {
            "mcp_policy": {"allowIds": ["restricted"], "denyIds": ["restricted"]},
            "active_skill_scope": {
                "skill_id": "cloud",
                "mcp_servers": ["aws-knowledge"],
            },
        }
    )
    model = ScriptedModel(
        replies=[
            call("load_mcp_tools", {"server_name": "google-workspace"}),
            AIMessage(content="Blocked"),
        ]
    )
    result = asyncio.run(
        create_agent(model, middleware=[harness.middleware]).ainvoke(
            {"messages": [("user", "Upload")]}
        )
    )
    assert any(
        isinstance(item, ToolMessage) and item.status == "error"
        for item in result["messages"]
    )
    assert all("google-workspace" not in config for config in harness.connections)
    assert "restricted" not in {
        entry["name"] for entry in harness.middleware._catalog()
    }
    # A forged invocation cannot bypass registration or a changed policy.
    harness.workspace.context["mcp_policy"]["denyIds"].append("aws-knowledge")
    request = ToolCallRequest(
        tool_call={
            "name": _tool_alias("aws-knowledge", "upload_file"),
            "id": "forged",
            "args": {"filename": "x"},
        },
        tool=None,
        state={"mcp_loaded_servers": ["aws-knowledge"]},
        runtime=None,
    )

    async def should_not_execute(request):
        pytest.fail("Denied tool reached execution")

    blocked = asyncio.run(
        harness.middleware.awrap_tool_call(request, should_not_execute)
    )
    assert blocked.status == "error" and harness.operations == []


def test_failure_is_sanitized_and_explicit_load_can_retry(harness, monkeypatch):
    original = MCPServerManager.initialize

    async def failed(self, **kwargs):
        self._rejected_servers = {
            "google-workspace": "401 Bearer secret https://private.example"
        }

    monkeypatch.setattr(MCPServerManager, "initialize", failed)
    model = ScriptedModel(
        replies=[
            call("load_mcp_tools", {"server_name": "google-workspace"}),
            AIMessage(content="Unavailable"),
        ]
    )
    result = asyncio.run(
        create_agent(model, middleware=[harness.middleware]).ainvoke(
            {"messages": [("user", "Upload")]}
        )
    )
    failure = next(item for item in result["messages"] if isinstance(item, ToolMessage))
    assert (
        failure.status == "error"
        and "secret" not in failure.content
        and "private.example" not in failure.content
    )
    assert not result.get("mcp_loaded_servers")
    monkeypatch.setattr(MCPServerManager, "initialize", original)
    assert asyncio.run(harness.manager.ensure_server("google-workspace")) == []
    assert (
        len(asyncio.run(harness.manager.ensure_server("google-workspace", retry=True)))
        == 1
    )
    assert harness.manager.get_rejected_servers() == {}


def test_checkpoint_rehydrates_with_new_credentials_and_other_threads_stay_clean(
    harness,
):
    alias = _tool_alias("google-workspace", "upload_file")
    checkpoint = MemorySaver()
    config = {"configurable": {"thread_id": "conversation-a"}}
    first = ScriptedModel(
        replies=[
            call("load_mcp_tools", {"server_name": "google-workspace"}),
            AIMessage(content="Ready"),
        ]
    )
    asyncio.run(
        create_agent(
            first, middleware=[harness.middleware], checkpointer=checkpoint
        ).ainvoke({"messages": [("user", "Prepare Google Drive")]}, config)
    )
    harness.workspace.context["mcp_auth"] = {
        "google-workspace": {"Authorization": "Bearer fresh-token"}
    }
    fresh_middleware = MCPDiscoveryMiddleware(
        MCPServerManager(harness.settings, harness.workspace)
    )
    second = ScriptedModel(
        replies=[
            AIMessage(content="unused"),
            AIMessage(content="unused"),
            call(alias, {"filename": "report.pdf"}),
            AIMessage(content="Done"),
        ]
    )
    asyncio.run(
        create_agent(
            second, middleware=[fresh_middleware], checkpointer=checkpoint
        ).ainvoke({"messages": [("user", "Now upload report.pdf")]}, config)
    )
    assert (
        harness.connections[-1]["google-workspace"]["headers"]["Authorization"]
        == "Bearer fresh-token"
    )
    assert harness.operations == [("google-workspace", "report.pdf")]
    other = ScriptedModel(replies=[AIMessage(content="Hello")])
    asyncio.run(
        create_agent(
            other, middleware=[fresh_middleware], checkpointer=checkpoint
        ).ainvoke(
            {"messages": [("user", "Hello")]},
            {"configurable": {"thread_id": "conversation-b"}},
        )
    )
    assert alias not in other.seen_tools[0]


def test_skill_selected_mid_run_loads_declared_mcp_without_rebuilding(harness):
    @tool
    def select_skill() -> str:
        """Activate the user's skill."""
        harness.workspace.context["active_skill_scope"] = {
            "skill_id": "drive",
            "mcp_servers": ["google-workspace"],
        }
        return "Active"

    alias = _tool_alias("google-workspace", "upload_file")
    model = ScriptedModel(
        replies=[
            call("select_skill"),
            call(alias, {"filename": "x"}),
            AIMessage(content="Done"),
        ]
    )
    asyncio.run(
        create_agent(
            model, tools=[select_skill], middleware=[harness.middleware]
        ).ainvoke({"messages": [("user", "Use my Drive skill")]})
    )
    assert alias not in model.seen_tools[0] and alias in model.seen_tools[1]
    assert harness.operations == [("google-workspace", "x")]


def test_duplicate_concurrent_loads_connect_once(harness):
    async def load_both():
        return await asyncio.gather(
            *[harness.manager.ensure_server("google-workspace") for _ in range(2)]
        )

    loaded = asyncio.run(load_both())
    assert all(loaded) and len(harness.connections) == 1


def test_preferred_server_and_builtin_name_collision(harness):
    harness.workspace.context["preferred_mcp_server"] = "google-workspace"

    @tool
    def upload_file(filename: str) -> str:
        """Upload locally."""
        return "local"

    alias = _tool_alias("google-workspace", "upload_file")
    model = ScriptedModel(
        replies=[call(alias, {"filename": "x"}), AIMessage(content="Done")]
    )
    asyncio.run(
        create_agent(
            model, tools=[upload_file], middleware=[harness.middleware]
        ).ainvoke({"messages": [("user", "Upload x")]})
    )
    assert {"upload_file", alias}.issubset(model.seen_tools[0])
    assert harness.operations == [("google-workspace", "x")]


def test_full_runtime_streams_discovery_with_filesystem_and_code_interpreter(
    harness, monkeypatch, tmp_path
):
    from helpudoc_agent.runtime.agent_registry import AgentRegistry

    alias = _tool_alias("google-workspace", "upload_file")
    model = ScriptedModel(
        replies=[
            call("list_mcp_servers", id="catalog"),
            call("load_mcp_tools", {"server_name": "google-workspace"}, id="load"),
            call(alias, {"filename": "report.pdf"}, id="upload"),
            AIMessage(content="Done"),
        ]
    )
    harness.settings.backend.skills_root = tmp_path / "skills"
    harness.settings.backend.code_interpreter.enabled = True
    monkeypatch.setattr(AgentRegistry, "_get_model", lambda *args, **kwargs: model)
    registry = AgentRegistry(
        harness.settings, SimpleNamespace(build_tools=lambda *args: [])
    )

    async def stream():
        runtime = await registry.get_or_create("fast", "stream-test")
        snapshots = []
        async for value in runtime.agent.astream(
            {"messages": [("user", "Upload report.pdf to Google Drive")]},
            {"configurable": {"thread_id": "stream-test"}},
            context=runtime.workspace_state.context,
            stream_mode="values",
        ):
            snapshots.append(value)
        return snapshots

    snapshots = asyncio.run(stream())
    assert {"eval", "read_file", "list_mcp_servers", "load_mcp_tools"}.issubset(
        model.seen_tools[0]
    )
    assert snapshots[-1]["mcp_loaded_servers"] == ["google-workspace"]
    assert harness.operations == [("google-workspace", "report.pdf")]


@pytest.mark.skipif(
    os.getenv("HELPUDOC_LIVE_MCP_MODEL_TEST") != "1",
    reason="Opt-in live Gemini evaluation",
)
@pytest.mark.parametrize("request_kind", ["list", "upload"])
def test_live_fast_model_discovers_mcp_without_tag(harness, request_kind):
    from helpudoc_agent.gemini_chat import create_chat_google_generative_ai
    from helpudoc_agent.runtime.agent_registry import GENERAL_SYSTEM_PROMPT

    model = create_chat_google_generative_ai(
        harness.settings.model,
        harness.settings.model.name,
        thinking_level="low",
        max_output_tokens=2048,
        request_timeout=30,
    )
    agent = create_agent(
        model, middleware=[harness.middleware], system_prompt=GENERAL_SYSTEM_PROMPT
    )
    result = asyncio.run(
        agent.ainvoke(
            {
                "messages": [
                    (
                        "user",
                        "list the mcp server"
                        if request_kind == "list"
                        else "Upload report.pdf to my Google Drive.",
                    )
                ]
            },
            {"recursion_limit": 12},
        )
    )
    calls = [
        call["name"]
        for message in result["messages"]
        if isinstance(message, AIMessage)
        for call in message.tool_calls
    ]
    print("Live Fast MCP calls:", calls)
    assert "list_mcp_servers" in calls
    if request_kind == "list":
        answer = str(result["messages"][-1].content)
        assert "google-workspace" in answer and "aws-knowledge" in answer
        assert "restricted" not in answer
        assert harness.operations == [] and harness.connections == []
    else:
        assert "load_mcp_tools" in calls
        assert harness.operations == [("google-workspace", "report.pdf")]
