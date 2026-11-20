import asyncio
from types import SimpleNamespace

from helpudoc_agent.runtime import agent_registry as registry_module


CALENDAR_ACTIONS = {"calendar_read", "calendar_create_event", "calendar_update_event", "calendar_delete_event"}
CALENDAR_TOOLS = CALENDAR_ACTIONS | {"calendar_list_events"}


def _registry(monkeypatch, tmp_path, *, declare_all_tools=False):
    class FixtureMCP:
        def __init__(self, *_args):
            pass

        async def initialize(self, **_kwargs):
            pass

        def get_tools_by_server(self):
            return {}

        def get_allowed_server_names(self):
            return []

        def get_rejected_servers(self):
            return {}

    class FixtureAgent:
        def __init__(self, tools):
            self.tools = {tool.name for tool in tools}

        def with_config(self, _config):
            return self

    for name in ("TodoListMiddleware", "FilesystemMiddleware", "build_summarization_middleware", "PatchToolCallsMiddleware", "MCPDiscoveryMiddleware", "InteractionContractMiddleware", "SlideStylePreviewMiddleware"):
        monkeypatch.setattr(registry_module, name, lambda *_args, **_kwargs: object())
    monkeypatch.setattr(registry_module, "MCPServerManager", FixtureMCP)
    monkeypatch.setattr(registry_module, "get_candidate_mcp_servers", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(registry_module, "collect_tool_names", lambda *_args, **_kwargs: [] if declare_all_tools else ["base"])
    monkeypatch.setattr(registry_module.GuardedTool, "from_tool", lambda tool, **_kwargs: tool)
    monkeypatch.setattr(registry_module, "create_agent", lambda **kwargs: FixtureAgent(kwargs["tools"]))
    model = SimpleNamespace(provider="fixture", resolve_chat_model_name=lambda _mode: "fixture", resolve_thinking_level=lambda _mode: None, resolve_max_output_tokens=lambda _mode: None)
    backend = SimpleNamespace(workspace_root=tmp_path, skills_root=None, plugins_root=None, sync_skills_to_workspace=False, virtual_mode=True, interrupt_on={}, code_interpreter=SimpleNamespace(enabled=False), implicit_input_guard=False, recursion_limit=20)
    factory = SimpleNamespace(build_tools=lambda names, _workspace: [SimpleNamespace(name=name) for name in names])
    registry = registry_module.AgentRegistry(SimpleNamespace(model=model, backend=backend, tools={name: object() for name in {"base"} | CALENDAR_TOOLS}), factory)
    monkeypatch.setattr(registry, "_get_model", lambda *_args, **_kwargs: object())
    return registry


def test_runtime_rebuilds_calendar_bindings_when_signed_capabilities_change(monkeypatch, tmp_path):
    registry = _registry(monkeypatch, tmp_path)

    async def scenario():
        common = {"user_id": "user", "mcp_policy": {"allowIds": [], "denyIds": []}, "mcp_auth_fingerprint": "unchanged"}
        normal = await registry.get_or_create("fast", "workspace", common)
        assert normal.agent.tools == {"base"}
        event_only = await registry.get_or_create("fast", "workspace", {**common, "calendar_event_refs": ["meeting:first"]})
        assert event_only is not normal
        assert event_only.agent.tools == {"base"} | CALENDAR_ACTIONS
        assert "calendar_list_events" not in event_only.agent.tools

        new_selection = await registry.get_or_create("fast", "workspace", {**common, "calendar_event_refs": ["meeting:second"]})
        assert new_selection is event_only
        assert new_selection.workspace_state.context["calendar_event_refs"] == ["meeting:second"]

        source_allowed = await registry.get_or_create("fast", "workspace", {**common, "calendar_event_refs": ["meeting:second"], "calendar_source_ids": ["source:approved"]})
        assert source_allowed is not event_only
        assert source_allowed.agent.tools == {"base"} | CALENDAR_TOOLS

        source_revoked = await registry.get_or_create("fast", "workspace", {**common, "calendar_event_refs": ["meeting:second"]})
        assert source_revoked is not source_allowed
        assert "calendar_list_events" not in source_revoked.agent.tools
        assert source_revoked.workspace_state.context["calendar_source_ids"] == []

        back_to_normal = await registry.get_or_create("fast", "workspace", common)
        assert back_to_normal.agent.tools == {"base"}
        assert back_to_normal.workspace_state.context["calendar_event_refs"] == []

    asyncio.run(scenario())


def test_default_all_tools_cannot_bypass_signed_calendar_capabilities(monkeypatch, tmp_path):
    registry = _registry(monkeypatch, tmp_path, declare_all_tools=True)

    async def scenario():
        normal = await registry.get_or_create("fast", "workspace", {"user_id": "user"})
        assert not (normal.agent.tools & CALENDAR_TOOLS)
        scoped = await registry.get_or_create("fast", "workspace", {"user_id": "user", "calendar_event_refs": ["meeting:selected"]})
        assert scoped.agent.tools & CALENDAR_TOOLS == CALENDAR_ACTIONS
        source_only = await registry.get_or_create("fast", "workspace", {"user_id": "user", "calendar_source_ids": ["source:approved"]})
        assert source_only.agent.tools & CALENDAR_TOOLS == {"calendar_list_events"}
        assert source_only.workspace_state.context["calendar_event_refs"] == []

    asyncio.run(scenario())
