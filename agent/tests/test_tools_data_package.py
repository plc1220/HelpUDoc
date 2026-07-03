"""Guard imports for the split ``helpudoc_agent.tools.data`` package."""
from __future__ import annotations

from pathlib import Path

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.data.duckdb_manager import DuckDBManager
from helpudoc_agent.tools.data.factory import build_data_agent_tools


def test_factory_matches_shim_tool_order(tmp_path: Path) -> None:
    ws = WorkspaceState(workspace_id="pkg-test", root_path=tmp_path)
    direct = [t.name for t in build_data_agent_tools(ws)]
    from helpudoc_agent.data_agent_tools import build_data_agent_tools as shim_build

    ws2 = WorkspaceState(workspace_id="pkg-test-2", root_path=tmp_path)
    via_shim = [t.name for t in shim_build(ws2)]
    assert direct == via_shim == [
        "get_table_schema",
        "run_sql_query",
        "materialize_bigquery_to_parquet",
        "export_sql_query",
        "generate_chart_config",
        "generate_summary",
        "generate_dashboard",
    ]


def test_duckdb_manager_importable_from_package(tmp_path: Path) -> None:
    ws = WorkspaceState(workspace_id="ddb", root_path=tmp_path)
    mgr = DuckDBManager(ws)
    assert mgr.session.query_count == 0
