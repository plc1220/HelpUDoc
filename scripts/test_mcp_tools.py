#!/usr/bin/env python3
"""Smoke test: connect to configured MCP server(s) and list tool names.

Usage:
  .venv/bin/python scripts/test_mcp_tools.py
  .venv/bin/python scripts/test_mcp_tools.py --server toolbox-bq-demo
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Ensure local ./agent package is importable when run from repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = REPO_ROOT / "agent"
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(AGENT_DIR))

from helpudoc_agent.configuration import load_settings
from helpudoc_agent.mcp_manager import MCPServerManager
from helpudoc_agent.state import WorkspaceState


async def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Only show tools for this server name", default="")
    parser.add_argument("--invoke", help="Invoke a tool by name (after loading tools)", default="")
    parser.add_argument("--input", help="JSON input for --invoke (default: {})", default="{}")
    args = parser.parse_args()

    settings = load_settings()
    workspace_state = WorkspaceState(
        workspace_id="mcp-smoke-test",
        root_path=Path("/tmp/helpudoc-mcp-smoke-test"),
    )
    # Simulate an admin request so all servers are eligible.
    workspace_state.context["mcp_policy"] = {"allowIds": [], "denyIds": [], "isAdmin": True}

    mgr = MCPServerManager(settings, workspace_state)
    await mgr.initialize()

    if not mgr.get_allowed_server_names():
        print("No MCP servers allowed by policy (or none configured).")
        return 0

    print("Allowed MCP servers:")
    for name in mgr.get_allowed_server_names():
        print(f"- {name}")

    tools_by_server = mgr.get_tools_by_server()
    if args.server:
        tools_by_server = {args.server: tools_by_server.get(args.server, [])}

    print("\nTools:")
    for server, tools in tools_by_server.items():
        print(f"- {server}: {len(tools)} tool(s)")
        for tool in tools:
            tool_name = getattr(tool, "name", None) or str(tool)
            print(f"  - {tool_name}")

    if args.invoke:
        import json

        def _flatten_exc(exc: BaseException) -> str:
            if isinstance(exc, BaseExceptionGroup):
                return "; ".join([_flatten_exc(e) for e in exc.exceptions])
            return str(exc) or repr(exc)

        target = None
        for tools in tools_by_server.values():
            for tool in tools:
                if getattr(tool, "name", None) == args.invoke:
                    target = tool
                    break
            if target:
                break
        if not target:
            print(f"\nInvoke failed: tool '{args.invoke}' not found in loaded tools.")
            return 2
        try:
            payload = json.loads(args.input or "{}")
            if payload is None:
                payload = {}
            if not isinstance(payload, dict):
                raise ValueError("--input must be a JSON object")
        except Exception as exc:
            print(f"\nInvoke failed: invalid --input JSON ({exc})")
            return 2

        print(f"\nInvoking: {args.invoke}")
        try:
            if hasattr(target, "ainvoke"):
                result = await target.ainvoke(payload)  # type: ignore[attr-defined]
            else:
                result = target.invoke(payload)  # type: ignore[attr-defined]
            print(result)
        except Exception as exc:
            print(f"Invoke error: {_flatten_exc(exc)}")
            print("Hint: this server likely requires a bearer token. Ensure env var 'BQ_ACCESS_TOKEN' is set.")
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
