from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

AGENT_DIR = CURRENT_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


def _build_workspace(tmp_path: Path):
    workspace = MagicMock()
    workspace.root_path = tmp_path
    workspace.workspace_id = "ws-1"
    workspace.context = {
        "mcp_auth": {
            "toolbox-bq-demo": {
                "Authorization": "Bearer test-token",
            }
        },
        "bigquery_project": "demo-project",
        "bigquery_location": "us",
    }
    return workspace


def _tools_for_workspace(tmp_path: Path):
    from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools

    workspace = _build_workspace(tmp_path)
    return workspace, {tool.name: tool for tool in build_data_agent_tools(workspace)}


def test_nested_skill_discovery_supports_data_refresh(tmp_path: Path) -> None:
    from agent.helpudoc_agent.skills_registry import load_skills

    (tmp_path / "data" / "refresh").mkdir(parents=True)
    (tmp_path / "data" / "refresh" / "SKILL.md").write_text(
        "---\nname: data/refresh\ndescription: refresh data\n---\n",
        encoding="utf-8",
    )

    skills = load_skills(tmp_path)
    assert {skill.skill_id for skill in skills} == {"data/refresh"}


def test_materialize_bigquery_raw_func_defaults_do_not_crash(tmp_path: Path) -> None:
    _, tools = _tools_for_workspace(tmp_path)
    materialize = tools["materialize_bigquery_to_parquet"]
    with patch(
        "agent.helpudoc_agent.data_agent_tools.run_bigquery_query",
        return_value=pd.DataFrame({"order_id": [1], "revenue": [10.5]}),
    ):
        raw = materialize.func("SELECT 1 AS order_id, 10.5 AS revenue")

    payload = json.loads(raw)
    assert payload["cached"] is False
    assert payload["row_count"] == 1
    assert payload["parquet_path"].endswith(".parquet")


def test_materialize_bigquery_to_stable_targets_publishes_manifest_and_csv(tmp_path: Path) -> None:
    _, tools = _tools_for_workspace(tmp_path)
    with patch(
        "agent.helpudoc_agent.data_agent_tools.run_bigquery_query",
        return_value=pd.DataFrame({"order_id": [1, 2], "revenue": [10.5, 22.0]}),
    ):
        raw = tools["materialize_bigquery_to_parquet"].invoke(
            {
                "sql_query": "SELECT order_id, revenue FROM demo.orders",
                "cache_key_hint": "orders_daily",
                "target_path": "datasets/orders/latest.parquet",
                "emit_csv": True,
            }
        )

    payload = json.loads(raw)
    parquet_path = tmp_path / payload["parquet_path"]
    manifest_path = tmp_path / payload["metadata_path"]
    csv_path = tmp_path / payload["csv_path"]
    assert parquet_path.exists()
    assert manifest_path.exists()
    assert csv_path.exists()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["sourceSql"] == "SELECT order_id, revenue FROM demo.orders"
    assert manifest["parquetPath"] == "datasets/orders/latest.parquet"
    assert manifest["csvPath"] == "datasets/orders/latest.csv"
    assert manifest["artifactTargets"] == {"dashboard": "", "report": ""}

    schema_text = tools["get_table_schema"].invoke({"table_names": ["latest"]})
    assert "Table: latest" in schema_text


def test_materialize_bigquery_invoke_reuses_cache(tmp_path: Path) -> None:
    _, tools = _tools_for_workspace(tmp_path)
    with patch(
        "agent.helpudoc_agent.data_agent_tools.run_bigquery_query",
        return_value=pd.DataFrame({"order_id": [1], "revenue": [10.5]}),
    ) as mock_query:
        first = json.loads(
            tools["materialize_bigquery_to_parquet"].invoke(
                {
                    "sql_query": "SELECT 1 AS order_id, 10.5 AS revenue",
                    "cache_key_hint": "orders_recent",
                }
            )
        )
        second = json.loads(
            tools["materialize_bigquery_to_parquet"].invoke(
                {
                    "sql_query": "SELECT 1 AS order_id, 10.5 AS revenue",
                    "cache_key_hint": "orders_recent",
                }
            )
        )

    assert first["cached"] is False
    assert second["cached"] is True
    assert mock_query.call_count == 1


def test_generate_summary_with_output_path_overwrites_stable_file(tmp_path: Path) -> None:
    _, tools = _tools_for_workspace(tmp_path)
    tools["get_table_schema"].invoke({"table_names": []})
    tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS value"})
    tools["generate_summary"].invoke(
        {
            "summary": "### Summary\n- First version",
            "insights": "### Key Insights\n- First insight",
            "output_path": "reports/daily.html",
        }
    )

    _, tools = _tools_for_workspace(tmp_path)
    tools["get_table_schema"].invoke({"table_names": []})
    tools["run_sql_query"].invoke({"sql_query": "SELECT 2 AS value"})
    tools["generate_summary"].invoke(
        {
            "summary": "### Summary\n- Second version",
            "insights": "### Key Insights\n- Second insight",
            "output_path": "reports/daily.html",
        }
    )

    report_path = tmp_path / "reports" / "daily.html"
    content = report_path.read_text(encoding="utf-8")
    assert report_path.exists()
    assert "Second version" in content
    assert "Second insight" in content


def test_generate_dashboard_with_output_path_overwrites_stable_file(tmp_path: Path) -> None:
    _, tools = _tools_for_workspace(tmp_path)
    tools["get_table_schema"].invoke({"table_names": []})
    tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS x, 10 AS y"})
    tools["generate_chart_config"].invoke(
        {
            "chart_title": "First_Chart",
            "python_code": (
                "chart_config = {\n"
                "  'data': [{'x': df['x'].tolist(), 'y': df['y'].tolist(), 'type': 'bar'}],\n"
                "  'layout': {'title': 'First'}\n"
                "}\n"
            ),
        }
    )
    tools["generate_dashboard"].invoke(
        {
            "title": "Orders Dashboard",
            "description": "First description",
            "output_path": "dashboards/orders.html",
        }
    )

    _, tools = _tools_for_workspace(tmp_path)
    tools["get_table_schema"].invoke({"table_names": []})
    tools["run_sql_query"].invoke({"sql_query": "SELECT 2 AS x, 20 AS y"})
    tools["generate_chart_config"].invoke(
        {
            "chart_title": "Second_Chart",
            "python_code": (
                "chart_config = {\n"
                "  'data': [{'x': df['x'].tolist(), 'y': df['y'].tolist(), 'type': 'scatter'}],\n"
                "  'layout': {'title': 'Second'}\n"
                "}\n"
            ),
        }
    )
    tools["generate_dashboard"].invoke(
        {
            "title": "Orders Dashboard",
            "description": "Second description",
            "output_path": "dashboards/orders.html",
        }
    )

    dashboard_path = tmp_path / "dashboards" / "orders.html"
    content = dashboard_path.read_text(encoding="utf-8")
    assert dashboard_path.exists()
    assert "Second description" in content
    assert "Second_Chart".replace("_", " ") in content or "Second_Chart" in content


def test_repo_data_refresh_skill_contract_mentions_snapshot_workflow() -> None:
    skill_path = CURRENT_DIR / "skills" / "data" / "refresh" / "SKILL.md"
    content = skill_path.read_text(encoding="utf-8")
    assert "materialize_bigquery_to_parquet" in content
    assert "generate_dashboard" in content
    assert "latest.parquet" in content
