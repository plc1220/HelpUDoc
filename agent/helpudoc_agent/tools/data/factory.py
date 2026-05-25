"""Assembles DuckDB-backed data agent tools for LangChain."""
from __future__ import annotations

from typing import Any, List

from langchain_core.tools import Tool

from ...state import WorkspaceState

from .chart_tools import create_chart_tool
from .dashboard_tools import create_dashboard_tools
from .duckdb_manager import DuckDBManager
from .query_tools import create_query_tools


def build_data_agent_tools(workspace_state: WorkspaceState, source_tracker: Any = None) -> List[Tool]:
    db_manager = DuckDBManager(workspace_state)
    workspace_state.context["data_agent_manager"] = db_manager

    query_tools = create_query_tools(db_manager, workspace_state)
    chart_tool = create_chart_tool(db_manager, workspace_state)
    dashboard_tools = create_dashboard_tools(db_manager, workspace_state)

    return [
        query_tools[0],
        query_tools[1],
        query_tools[2],
        query_tools[3],
        chart_tool,
        dashboard_tools[0],
        dashboard_tools[1],
    ]

