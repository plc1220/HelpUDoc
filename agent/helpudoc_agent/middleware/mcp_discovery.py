"""Model-driven MCP discovery and same-run dynamic tool registration.

Only server IDs are checkpointed. Clients/credentials live in the existing
user/policy/auth-scoped manager. Both model exposure and execution recheck access.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Annotated

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from pydantic.json_schema import SkipJsonSchema
from typing_extensions import NotRequired

from ..mcp_manager import MCPServerManager
from ..skills_registry import (
    get_candidate_mcp_servers,
    is_skill_allowed,
    is_tool_allowed,
)
from ..tool_guard import GuardedTool


def _merge_server_ids(left: list[str], right: list[str]) -> list[str]:
    return sorted(set(left) | set(right))


class MCPDiscoveryState(AgentState):
    mcp_loaded_servers: NotRequired[Annotated[list[str], _merge_server_ids]]


def _tool_alias(server: str, name: str) -> str:
    # Stable across resumes, valid for Gemini, and distinct even when sanitized
    # names collide or two servers expose the same operation name.
    digest = hashlib.sha256(f"{server}\0{name}".encode()).hexdigest()[:12]
    label = re.sub(r"[^a-zA-Z0-9_]", "_", f"{server}_{name}")[:46]
    return f"mcp_{label}_{digest}"


class MCPDiscoveryMiddleware(AgentMiddleware):
    state_schema = MCPDiscoveryState

    def __init__(self, manager: MCPServerManager):
        super().__init__()
        self.manager = manager
        self.workspace = manager.workspace_state
        self.preflight = manager.settings.model.provider == "gemini"

        @tool
        def list_mcp_servers() -> dict:
            """Discover configured external services and MCP servers available to you.

            List server IDs, capabilities and loading status before choosing an
            integration for a task. This reads the authorized catalog without
            connecting to external services. Use load_mcp_tools to get operations.
            """
            return {"servers": self._catalog()}

        @tool
        async def load_mcp_tools(
            server_name: str, runtime: SkipJsonSchema[ToolRuntime]
        ) -> Command:
            """Load an external service's tools for use immediately in this conversation.

            Choose server_name from list_mcp_servers based on the user's task.
            Discovers actual operation schemas; does not execute an external
            operation. Newly loaded tools become callable on the next model step.
            """
            # SkipJsonSchema keeps the injected runtime out of Gemini's raw
            # args_schema conversion while ToolNode still injects it at execution.
            if not self._can_use_server(server_name):
                return self._load_result(
                    runtime,
                    server_name,
                    error="Server unavailable under current permissions or skill scope.",
                )
            await self.manager.ensure_server(
                server_name, preflight_gemini=self.preflight, retry=True
            )
            if server_name in self.manager.get_rejected_servers():
                # Transport exceptions may contain credentials/URLs. Keep details
                # in server logs, never in a model-facing discovery response.
                return self._load_result(
                    runtime,
                    server_name,
                    error="Server tool discovery failed. Check its connection, authentication and schema compatibility.",
                )
            if not self._can_use_server(server_name):
                return self._load_result(
                    runtime,
                    server_name,
                    error="Server access changed during discovery.",
                )
            return self._load_result(runtime, server_name)

        self.tools = [list_mcp_servers, load_mcp_tools]

    def _can_use_server(self, name: str) -> bool:
        context = self.workspace.context
        if (
            context.get("skill_builder")
            or name not in self.manager.get_permitted_servers()
        ):
            return False
        active = context.get("active_skill")
        if active and not is_skill_allowed(active, context):
            return False
        if any(
            Path(marker).exists()
            for marker in context.get("active_skill_block_paths", [])
        ):
            return False
        return is_tool_allowed(
            "", context.get("active_skill_scope"), tool_mcp_server=name
        )

    def _catalog(self) -> list[dict]:
        loaded = self.manager.get_tools_by_server()
        rejected = self.manager.get_rejected_servers()
        return [
            {
                "name": name,
                "description": cfg.description or name,
                "transport": cfg.transport,
                "available_in_current_skill": self._can_use_server(name),
                "status": "load_failed"
                if name in rejected
                else "loaded"
                if name in loaded
                else "not_loaded",
            }
            for name, cfg in sorted(self.manager.get_permitted_servers().items())
        ]

    def _load_result(
        self, runtime: ToolRuntime, server: str, error: str | None = None
    ) -> Command:
        payload = {"server": server}
        update = {}
        if error:
            payload["error"] = error
        else:
            payload["tools"] = [
                {
                    "name": _tool_alias(server, item.name),
                    "description": item.description,
                }
                for item in self.manager.get_tools_by_server().get(server, [])
            ]
            update["mcp_loaded_servers"] = [server]
        update["messages"] = [
            ToolMessage(
                content=json.dumps(payload),
                tool_call_id=runtime.tool_call_id,
                name="load_mcp_tools",
                status="error" if error else "success",
            )
        ]
        return Command(update=update)

    def _selected_servers(self, state) -> set[str]:
        context = self.workspace.context
        selected = set(state.get("mcp_loaded_servers", []))
        selected.update(
            get_candidate_mcp_servers(
                context.get("active_skill_scope"),
                context.get("preferred_mcp_server"),
            )
        )
        return {name for name in selected if self._can_use_server(name)}

    async def _ensure_selected(self, state) -> None:
        await asyncio.gather(
            *(
                self.manager.ensure_server(name, preflight_gemini=self.preflight)
                for name in sorted(self._selected_servers(state))
            )
        )

    def _dynamic_tools(self, state) -> dict[str, GuardedTool]:
        result = {}
        for server in sorted(self._selected_servers(state)):
            for item in self.manager.get_tools_by_server().get(server, []):
                wrapped = GuardedTool.from_tool(
                    item, workspace_state=self.workspace, tool_mcp_server=server
                )
                wrapped.name = _tool_alias(server, item.name)
                result[wrapped.name] = wrapped
        return result

    def _model_request(self, request):
        # Replace prebound MCP tools with the same namespaced tools used for lazy
        # loads. Leave builtins/provider-native tools and other middleware intact.
        static = [
            item for item in request.tools if not getattr(item, "tool_mcp_server", None)
        ]
        dynamic = self._dynamic_tools(request.state)
        return request.override(tools=[*static, *dynamic.values()])

    async def awrap_model_call(self, request, handler):
        await self._ensure_selected(request.state)
        return await handler(self._model_request(request))

    def wrap_model_call(self, request, handler):
        asyncio.run(self._ensure_selected(request.state))
        return handler(self._model_request(request))

    def _execution_request(self, request):
        name = request.tool_call["name"]
        dynamic = self._dynamic_tools(request.state)
        if name in dynamic:
            return request.override(tool=dynamic[name])
        if name.startswith("mcp_") or getattr(request.tool, "tool_mcp_server", None):
            return ToolMessage(
                content="MCP tool unavailable under current permissions, skill scope or loading state.",
                name=name,
                tool_call_id=request.tool_call["id"],
                status="error",
            )
        return request

    async def awrap_tool_call(self, request, handler):
        # Rehydrate on resume/restart even if the pending tool call precedes a
        # model step in this process. Only authorized selected servers are loaded.
        if request.tool_call["name"].startswith("mcp_"):
            await self._ensure_selected(request.state)
        updated = self._execution_request(request)
        return updated if isinstance(updated, ToolMessage) else await handler(updated)

    def wrap_tool_call(self, request, handler):
        if request.tool_call["name"].startswith("mcp_"):
            asyncio.run(self._ensure_selected(request.state))
        updated = self._execution_request(request)
        return updated if isinstance(updated, ToolMessage) else handler(updated)
