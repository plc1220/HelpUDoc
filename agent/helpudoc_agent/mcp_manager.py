"""MCP Server Manager - manages connections and provides RBAC-filtered tools.

This follows the pattern used by ToolFactory.build_tools(): the agent builder
calls MCPServerManager.get_tools() to obtain MCP-provided tools for the request.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from langchain_core.tools import Tool

from .configuration import MCPServerConfig, Settings
from .state import WorkspaceState

logger = logging.getLogger(__name__)

def _format_exception(exc: BaseException) -> str:
    """Flatten ExceptionGroup for readable logs."""
    if isinstance(exc, BaseExceptionGroup):  # py>=3.11
        parts: List[str] = []
        for inner in exc.exceptions:
            parts.append(_format_exception(inner))
        return "; ".join([p for p in parts if p]) or repr(exc)
    return str(exc) or repr(exc)


def describe_mcp_servers(settings: Settings) -> List[Dict[str, Any]]:
    """Return MCP server metadata for UI/debugging (no secrets)."""
    result: List[Dict[str, Any]] = []
    for cfg in (settings.mcp_servers or {}).values():
        endpoint = cfg.url or cfg.endpoint
        result.append(
            {
                "name": cfg.name,
                "transport": cfg.transport,
                "endpoint": endpoint,
                "description": cfg.description,
                "default_access": getattr(cfg, "default_access", "allow"),
            }
        )
    return result


class MCPServerManager:
    """Manages MCP server connections and provides RBAC-filtered tools."""

    def __init__(self, settings: Settings, workspace_state: WorkspaceState):
        self.settings = settings
        self.workspace_state = workspace_state
        self._allowed_servers: Dict[str, MCPServerConfig] = {}
        self._tools_by_server: Dict[str, List[Tool]] = {}
        self._clients_by_server: Dict[str, Any] = {}

    def _filter_by_policy(self) -> Dict[str, MCPServerConfig]:
        """Filter configured servers based on workspace RBAC policy."""
        mcp_policy = self.workspace_state.context.get("mcp_policy", {}) or {}
        deny_ids = set(mcp_policy.get("denyIds", []) or [])
        allow_ids = set(mcp_policy.get("allowIds", []) or [])
        is_admin = bool(mcp_policy.get("isAdmin", False))

        allowed: Dict[str, MCPServerConfig] = {}
        for name, cfg in (self.settings.mcp_servers or {}).items():
            # Admin gets everything.
            if is_admin:
                allowed[name] = cfg
                continue
            # Explicit deny always wins.
            if name in deny_ids:
                continue
            # Default deny requires explicit allow.
            if getattr(cfg, "default_access", "allow") == "deny" and name not in allow_ids:
                continue
            allowed[name] = cfg
        return allowed

    def _build_langchain_mcp_config(self, cfg: MCPServerConfig) -> Dict[str, Any]:
        """Build a single-server config payload for langchain-mcp-adapters."""
        if cfg.transport == "stdio":
            env = dict(cfg.env or {})
            passthrough = cfg.env_passthrough or []
            for key in passthrough:
                if not key:
                    continue
                if key in os.environ and key not in env:
                    env[key] = os.environ[key]
            return {
                "transport": "stdio",
                "command": cfg.command,
                "args": cfg.args or [],
                "env": env,
                "cwd": cfg.cwd,
            }

        headers: Dict[str, str] = dict(cfg.headers or {})
        # Inject headers from environment variables (value = env var name).
        for header_name, env_var in (cfg.headers_from_env or {}).items():
            if not header_name or not env_var:
                continue
            value = os.environ.get(str(env_var), "")
            if value:
                headers[str(header_name)] = value

        if cfg.bearer_token_env_var:
            token = os.environ.get(cfg.bearer_token_env_var, "")
            if token:
                headers.setdefault("Authorization", f"Bearer {token}")

        return {
            "transport": cfg.transport,  # "http" or "sse"
            "url": cfg.url or cfg.endpoint,
            "headers": headers,
        }

    async def initialize(self) -> None:
        """Connect to all allowed MCP servers and cache their tools."""
        self._allowed_servers = self._filter_by_policy()
        self._tools_by_server = {}
        self._clients_by_server = {}

        if not self._allowed_servers:
            return

        try:
            # Optional dependency; if missing, registry remains empty.
            from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore
        except Exception as exc:  # pragma: no cover - optional dependency
            logger.warning("langchain-mcp-adapters not installed; MCP tools disabled (%s)", exc)
            return

        for name, cfg in self._allowed_servers.items():
            try:
                server_config = self._build_langchain_mcp_config(cfg)
                if not server_config.get("url") and cfg.transport in {"http", "sse"}:
                    raise ValueError("Missing url for http/sse MCP server")
                if cfg.transport == "stdio" and not server_config.get("command"):
                    raise ValueError("Missing command for stdio MCP server")

                client = MultiServerMCPClient({name: server_config})
                tools = await client.get_tools()
                self._clients_by_server[name] = client
                self._tools_by_server[name] = list(tools or [])
            except Exception as exc:
                logger.warning(
                    "Failed to connect to MCP server; excluding from available tools (server=%s error=%s)",
                    name,
                    _format_exception(exc),
                )

    async def get_tools(self) -> List[Tool]:
        """Return tools from all connected MCP servers."""
        if not self._tools_by_server:
            return []
        tools: List[Tool] = []
        for items in self._tools_by_server.values():
            tools.extend(items)
        return tools

    def get_tools_by_server(self) -> Dict[str, List[Tool]]:
        return self._tools_by_server

    def get_allowed_server_names(self) -> List[str]:
        return list(self._allowed_servers.keys())

    async def cleanup(self) -> None:
        """Clean up MCP connections (best-effort)."""
        # MultiServerMCPClient should manage its own lifecycle; drop references.
        self._clients_by_server = {}
        self._tools_by_server = {}
        self._allowed_servers = {}
