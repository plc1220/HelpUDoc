"""DuckDB-backed data tools — compatibility shim for ``helpudoc_agent.data_agent_tools``.

Implementations live under ``helpudoc_agent.tools.data``. This module re-exports
symbols so existing imports, skill entrypoints, and test monkeypatch paths keep
working (for example ``run_bigquery_query`` and ``CHART_EXECUTION_TIMEOUT_SECONDS``).
"""
from __future__ import annotations

from helpudoc_agent.bigquery_export_tools import run_bigquery_query
from helpudoc_agent.tools.data.constants import (
    CHART_EXECUTION_TIMEOUT_SECONDS,
    MAX_CHART_COUNT,
    MAX_QUERY_COUNT,
)
from helpudoc_agent.tools.data.dashboard_tools import _build_dashboard_chart_specs
from helpudoc_agent.tools.data.duckdb_manager import DuckDBManager
from helpudoc_agent.tools.data.factory import build_data_agent_tools
from helpudoc_agent.tools.data.formatting import _format_sample_value
from helpudoc_agent.tools.data.renderers.html_summary import render_summary_html
from helpudoc_agent.tools.data.workspace_files import _snapshot_workspace

__all__ = [
    "build_data_agent_tools",
    "DuckDBManager",
    "CHART_EXECUTION_TIMEOUT_SECONDS",
    "MAX_CHART_COUNT",
    "MAX_QUERY_COUNT",
    "_build_dashboard_chart_specs",
    "_format_sample_value",
    "_snapshot_workspace",
    "render_summary_html",
    "run_bigquery_query",
]
