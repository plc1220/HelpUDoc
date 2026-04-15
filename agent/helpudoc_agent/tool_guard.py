"""Tool wrappers that enforce active-skill scope at invocation time."""
from __future__ import annotations

import json
from typing import Any, Optional

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from pydantic import ConfigDict, Field

from .skills_registry import is_tool_allowed
from .state import WorkspaceState

_PREFERRED_MCP_ONLY_BUILTINS = {
    "google_search",
    "google_grounded_search",
    "rag_query",
}


def _tool_scope_error(tool_name: str, skill_id: Optional[str], tool_mcp_server: Optional[str]) -> str:
    if skill_id:
        if tool_mcp_server:
            return (
                f"Tool '{tool_name}' is not allowed while skill '{skill_id}' is active. "
                f"This skill does not permit MCP server '{tool_mcp_server}'."
            )
        return (
            f"Tool '{tool_name}' is not allowed while skill '{skill_id}' is active. "
            "Load a skill that declares this tool or switch to a different workflow."
        )
    return f"Tool '{tool_name}' is not allowed in the current context."


class GuardedTool(BaseTool):
    """Delegate to a wrapped tool only when the active skill scope allows it."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    wrapped_tool: BaseTool = Field(exclude=True)
    workspace_state: WorkspaceState = Field(exclude=True)
    tool_mcp_server: Optional[str] = None
    args_schema: Any = None
    return_direct: bool = False
    response_format: str = "content"

    @classmethod
    def from_tool(
        cls,
        tool: BaseTool,
        *,
        workspace_state: WorkspaceState,
        tool_mcp_server: Optional[str] = None,
    ) -> "GuardedTool":
        return cls(
            name=tool.name,
            description=tool.description,
            args_schema=getattr(tool, "args_schema", None),
            return_direct=bool(getattr(tool, "return_direct", False)),
            response_format=str(getattr(tool, "response_format", "content") or "content"),
            wrapped_tool=tool,
            workspace_state=workspace_state,
            tool_mcp_server=tool_mcp_server,
        )

    def _guard(self) -> Optional[str]:
        context = self.workspace_state.context if isinstance(self.workspace_state.context, dict) else {}
        preferred_server = context.get("preferred_mcp_server")
        preferred_bound = bool(context.get("preferred_mcp_server_bound"))
        if (
            isinstance(preferred_server, str)
            and preferred_server.strip()
            and preferred_bound
            and self.tool_mcp_server is None
            and self.name in _PREFERRED_MCP_ONLY_BUILTINS
        ):
            return (
                f"Tool '{self.name}' is blocked for this turn because '/mcp {preferred_server.strip()}' "
                "is active and bound. Use tools from the preferred MCP server first."
            )
        active_scope = context.get("active_skill_scope")
        if is_tool_allowed(self.name, active_scope, tool_mcp_server=self.tool_mcp_server):
            return None
        skill_id = None
        if isinstance(active_scope, dict):
            raw_skill_id = active_scope.get("skill_id")
            if isinstance(raw_skill_id, str) and raw_skill_id.strip():
                skill_id = raw_skill_id.strip()
        return _tool_scope_error(self.name, skill_id, self.tool_mcp_server)

    def _blocked_result(self, input: Any, error: str) -> Any:
        """Return an agent-runtime-safe blocked result.

        ToolNode expects async tool execution to yield a ``ToolMessage`` (or ``Command``),
        not a bare string. For direct local invocations in tests/utilities, we keep the
        simpler string response.
        """
        if isinstance(input, dict):
            tool_call_id = input.get("id")
            if isinstance(tool_call_id, str) and tool_call_id.strip():
                return ToolMessage(
                    content=error,
                    name=self.name,
                    tool_call_id=tool_call_id,
                    status="error",
                )
        return error

    def _exception_result(self, input: Any, exc: Exception) -> Any:
        message = str(exc) or repr(exc)
        if isinstance(input, dict):
            tool_call_id = input.get("id")
            if isinstance(tool_call_id, str) and tool_call_id.strip():
                return ToolMessage(
                    content=message,
                    name=self.name,
                    tool_call_id=tool_call_id,
                    status="error",
                )
        raise exc

    def _tool_call_id(self, input: Any) -> str | None:
        if not isinstance(input, dict):
            return None
        tool_call_id = input.get("id")
        if isinstance(tool_call_id, str) and tool_call_id.strip():
            return tool_call_id.strip()
        return None

    def _stringify_result(self, result: Any) -> str:
        if result is None:
            return ""
        if isinstance(result, str):
            return result
        if isinstance(result, dict):
            if isinstance(result.get("text"), str):
                return result["text"]
            if isinstance(result.get("content"), str):
                return result["content"]
            return json.dumps(result, ensure_ascii=False, default=str)
        if isinstance(result, list):
            parts: list[str] = []
            for item in result:
                if item is None:
                    continue
                if isinstance(item, str):
                    parts.append(item)
                    continue
                if isinstance(item, dict):
                    if isinstance(item.get("text"), str):
                        parts.append(item["text"])
                        continue
                    if isinstance(item.get("content"), str):
                        parts.append(item["content"])
                        continue
                parts.append(json.dumps(item, ensure_ascii=False, default=str) if isinstance(item, (dict, list)) else str(item))
            return "\n".join(part for part in parts if part).strip()
        return str(result)

    def _success_result(self, input: Any, result: Any) -> Any:
        tool_call_id = self._tool_call_id(input)
        if tool_call_id is None:
            return result
        if isinstance(result, ToolMessage):
            return result
        return ToolMessage(
            content=self._stringify_result(result),
            name=self.name,
            tool_call_id=tool_call_id,
        )

    def _unwrap_runtime_input(self, input: Any) -> Any:
        if not isinstance(input, dict):
            return input
        if input.get("type") != "tool_call":
            return input
        raw_args = input.get("args")
        if isinstance(raw_args, dict):
            return raw_args
        return {
            key: value
            for key, value in input.items()
            if key not in {"id", "name", "type"}
        }

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        error = self._guard()
        if error:
            return self._blocked_result(input, error)
        try:
            result = self.wrapped_tool.invoke(self._unwrap_runtime_input(input), config=config, **kwargs)
            return self._success_result(input, result)
        except Exception as exc:
            return self._exception_result(input, exc)

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        error = self._guard()
        if error:
            return self._blocked_result(input, error)
        try:
            wrapped_input = self._unwrap_runtime_input(input)
            if hasattr(self.wrapped_tool, "ainvoke"):
                result = await self.wrapped_tool.ainvoke(wrapped_input, config=config, **kwargs)
            else:
                result = self.wrapped_tool.invoke(wrapped_input, config=config, **kwargs)
            return self._success_result(input, result)
        except Exception as exc:
            return self._exception_result(input, exc)

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        error = self._guard()
        if error:
            payload = kwargs if kwargs else (args[0] if len(args) == 1 else list(args) if args else {})
            return self._blocked_result(payload, error)
        if kwargs:
            payload: Any = kwargs
        elif len(args) == 1:
            payload = args[0]
        elif args:
            payload = list(args)
        else:
            payload = {}
        try:
            return self.wrapped_tool.invoke(payload)
        except Exception as exc:
            return self._exception_result(payload, exc)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        error = self._guard()
        if error:
            payload = kwargs if kwargs else (args[0] if len(args) == 1 else list(args) if args else {})
            return self._blocked_result(payload, error)
        if kwargs:
            payload: Any = kwargs
        elif len(args) == 1:
            payload = args[0]
        elif args:
            payload = list(args)
        else:
            payload = {}
        try:
            if hasattr(self.wrapped_tool, "ainvoke"):
                return await self.wrapped_tool.ainvoke(payload)
            return self.wrapped_tool.invoke(payload)
        except Exception as exc:
            return self._exception_result(payload, exc)
