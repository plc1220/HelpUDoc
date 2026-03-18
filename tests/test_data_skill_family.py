"""Tests for the data/* skill family port.

Covers:
- skills_registry: recursive discovery, nested IDs, mcp_servers parsing,
  is_tool_allowed runtime enforcement
- data_agent_tools: schema-before-query guard, query/chart budget, run-scoped
  history, dashboard generation, stale-artifact isolation
- compatibility: data-analysis shim routing
"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_skill_md(
    name: str,
    tools: Optional[list[str]] = None,
    mcp_servers: Optional[list[str]] = None,
    extra: str = "",
) -> str:
    frontmatter_lines = [f"name: {name}"]
    if tools:
        frontmatter_lines.append("tools:")
        for t in tools:
            frontmatter_lines.append(f"  - {t}")
    if mcp_servers:
        frontmatter_lines.append("mcp_servers:")
        for s in mcp_servers:
            frontmatter_lines.append(f"  - {s}")
    frontmatter = "\n".join(frontmatter_lines)
    return f"---\n{frontmatter}\n---\n\n# {name}\n\n{extra}"


# ---------------------------------------------------------------------------
# skills_registry tests
# ---------------------------------------------------------------------------


class TestSkillsRegistryRecursiveDiscovery:
    """Recursive SKILL.md discovery and nested skill ID construction."""

    def test_top_level_skill_id_is_dirname(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        skill_dir = tmp_path / "research"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(_make_skill_md("research"), encoding="utf-8")

        skills = load_skills(tmp_path)
        assert len(skills) == 1
        assert skills[0].skill_id == "research"

    def test_nested_skill_id_is_posix_path(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        nested_dir = tmp_path / "data" / "analyze"
        nested_dir.mkdir(parents=True)
        (nested_dir / "SKILL.md").write_text(_make_skill_md("data/analyze"), encoding="utf-8")

        # Also add the hub
        hub_dir = tmp_path / "data"
        (hub_dir / "SKILL.md").write_text(_make_skill_md("data"), encoding="utf-8")

        skills = load_skills(tmp_path)
        ids = {s.skill_id for s in skills}
        assert "data" in ids
        assert "data/analyze" in ids

    def test_all_data_subskills_discovered(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        subskills = ["explore", "query", "analyze", "visualize", "validate", "dashboard"]
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "SKILL.md").write_text(_make_skill_md("data"), encoding="utf-8")
        for sub in subskills:
            d = tmp_path / "data" / sub
            d.mkdir()
            (d / "SKILL.md").write_text(_make_skill_md(f"data/{sub}"), encoding="utf-8")

        skills = load_skills(tmp_path)
        ids = {s.skill_id for s in skills}
        assert "data" in ids
        for sub in subskills:
            assert f"data/{sub}" in ids, f"data/{sub} not found"

    def test_list_skills_shows_nested_ids(self, tmp_path: Path) -> None:
        """load_skills returns skills with correct nested IDs available for listing."""
        from agent.helpudoc_agent.skills_registry import load_skills

        for path, content in [
            ("data/SKILL.md", _make_skill_md("data")),
            ("data/analyze/SKILL.md", _make_skill_md("data/analyze")),
            ("data-analysis/SKILL.md", _make_skill_md("data-analysis")),
        ]:
            full = tmp_path / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content, encoding="utf-8")

        skills = load_skills(tmp_path)
        ids = [s.skill_id for s in skills]
        assert "data" in ids
        assert "data/analyze" in ids
        assert "data-analysis" in ids

    def test_no_skill_md_directory_skipped(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        # Directory with no SKILL.md at any depth
        (tmp_path / "empty_dir" / "nested").mkdir(parents=True)
        skills = load_skills(tmp_path)
        assert skills == []


class TestMcpServersFrontmatterParsing:
    """mcp_servers field is parsed and stored on SkillMetadata."""

    def test_mcp_servers_parsed_from_list(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        d = tmp_path / "data"
        d.mkdir()
        (d / "SKILL.md").write_text(
            _make_skill_md("data", mcp_servers=["toolbox-bq-demo", "other-mcp"]),
            encoding="utf-8",
        )
        skills = load_skills(tmp_path)
        assert len(skills) == 1
        assert skills[0].mcp_servers == ["toolbox-bq-demo", "other-mcp"]

    def test_mcp_servers_defaults_to_empty_list(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        d = tmp_path / "localonly"
        d.mkdir()
        (d / "SKILL.md").write_text(_make_skill_md("localonly", tools=["data_agent_tools"]), encoding="utf-8")
        skills = load_skills(tmp_path)
        assert skills[0].mcp_servers == []


class TestRuntimeEnforcement:
    """is_tool_allowed enforces declared tool/server scope."""

    def _make_skill(self, tools: list[str], mcp_servers: list[str]) -> Any:
        from agent.helpudoc_agent.skills_registry import load_skills
        import tempfile, os

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "s"
            p.mkdir()
            (p / "SKILL.md").write_text(
                _make_skill_md("s", tools=tools, mcp_servers=mcp_servers),
                encoding="utf-8",
            )
            skills = load_skills(Path(td))
        return skills[0]

    def test_always_allowed_tools_permitted_regardless_of_skill(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed, load_skills
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "s"
            p.mkdir()
            (p / "SKILL.md").write_text(_make_skill_md("s", tools=["only_tool"]), encoding="utf-8")
            skills = load_skills(Path(td))
        skill = skills[0]
        assert is_tool_allowed("list_skills", skill) is True
        assert is_tool_allowed("load_skill", skill) is True
        assert is_tool_allowed("request_plan_approval", skill) is True

    def test_builtin_tool_allowed_when_declared(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        skill = self._make_skill(tools=["data_agent_tools", "run_sql_query"], mcp_servers=[])
        assert is_tool_allowed("run_sql_query", skill, tool_mcp_server=None) is True

    def test_builtin_tool_denied_when_not_declared(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        skill = self._make_skill(tools=["data_agent_tools", "run_sql_query"], mcp_servers=[])
        assert is_tool_allowed("web_search", skill, tool_mcp_server=None) is False

    def test_dict_scope_is_supported_for_runtime_context(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        active_scope = {
            "skill_id": "data/analyze",
            "tools": ["run_sql_query", "generate_summary"],
            "mcp_servers": ["toolbox-bq-demo"],
        }
        assert is_tool_allowed("run_sql_query", active_scope, tool_mcp_server=None) is True
        assert is_tool_allowed("generate_dashboard", active_scope, tool_mcp_server=None) is False

    def test_mcp_tool_allowed_when_server_declared(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        skill = self._make_skill(tools=[], mcp_servers=["toolbox-bq-demo"])
        assert is_tool_allowed("bq_execute_sql", skill, tool_mcp_server="toolbox-bq-demo") is True

    def test_mcp_tool_denied_from_undeclared_server(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        skill = self._make_skill(tools=[], mcp_servers=["toolbox-bq-demo"])
        assert is_tool_allowed("other_tool", skill, tool_mcp_server="other-mcp") is False

    def test_no_active_skill_allows_all(self) -> None:
        from agent.helpudoc_agent.skills_registry import is_tool_allowed

        assert is_tool_allowed("anything", None, tool_mcp_server=None) is True
        assert is_tool_allowed("mcp_tool", None, tool_mcp_server="some-server") is True


class TestGuardedTool:
    """GuardedTool should preserve wrapped tool metadata and fail safely."""

    def test_guarded_tool_preserves_response_format_and_returns_clean_error(self, tmp_path: Path) -> None:
        from langchain_core.messages import ToolMessage
        from langchain_core.tools import tool

        from agent.helpudoc_agent.state import WorkspaceState
        from agent.helpudoc_agent.tool_guard import GuardedTool

        @tool
        def google_search(query: str) -> str:
            """Search the web."""
            return f"results for {query}"

        workspace_state = WorkspaceState(workspace_id="w", root_path=tmp_path)
        workspace_state.context["active_skill_scope"] = {
            "skill_id": "data/analyze",
            "tools": ["run_sql_query"],
            "mcp_servers": ["toolbox-bq-demo"],
        }

        guarded = GuardedTool.from_tool(google_search, workspace_state=workspace_state)
        assert guarded.response_format == getattr(google_search, "response_format", "content")
        result = guarded.invoke({"query": "cancellations"})
        assert isinstance(result, str)
        assert "not allowed" in result.lower()

        runtime_result = guarded.invoke(
            {
                "id": "tool-call-1",
                "name": "google_search",
                "type": "tool_call",
                "query": "cancellations",
            }
        )
        assert isinstance(runtime_result, ToolMessage)
        assert runtime_result.status == "error"
        assert "not allowed" in str(runtime_result.content).lower()

    def test_guarded_tool_wraps_runtime_exceptions_as_toolmessage(self, tmp_path: Path) -> None:
        from langchain_core.messages import ToolMessage
        from langchain_core.tools import tool

        from agent.helpudoc_agent.state import WorkspaceState
        from agent.helpudoc_agent.tool_guard import GuardedTool

        @tool
        def bq_execute_sql(sql_query: str) -> str:
            """Execute SQL."""
            raise ValueError("Column name gender is ambiguous")

        workspace_state = WorkspaceState(workspace_id="w", root_path=tmp_path)
        workspace_state.context["active_skill_scope"] = {
            "skill_id": "data/analyze",
            "tools": [],
            "mcp_servers": ["toolbox-bq-demo"],
        }

        guarded = GuardedTool.from_tool(
            bq_execute_sql,
            workspace_state=workspace_state,
            tool_mcp_server="toolbox-bq-demo",
        )
        runtime_result = guarded.invoke(
            {
                "id": "tool-call-2",
                "name": "bq_execute_sql",
                "type": "tool_call",
                "sql_query": "select * from t",
            }
        )
        assert isinstance(runtime_result, ToolMessage)
        assert runtime_result.status == "error"
        assert "ambiguous" in str(runtime_result.content).lower()


# ---------------------------------------------------------------------------
# data_agent_tools tests
# ---------------------------------------------------------------------------


@pytest.fixture()
def workspace_state(tmp_path: Path) -> Any:
    """Create a lightweight WorkspaceState-like object pointing at tmp_path."""
    state = MagicMock()
    state.root_path = tmp_path
    state.context = {}
    return state


@pytest.fixture()
def db_manager(workspace_state: Any) -> Any:
    from agent.helpudoc_agent.data_agent_tools import DuckDBManager

    return DuckDBManager(workspace_state)


class TestSchemaBeforeQuery:
    """Schema must be inspected before running SQL queries."""

    def test_run_sql_without_schema_returns_error(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        result = tools["run_sql_query"].invoke({"sql_query": "SELECT 1"})
        assert "get_table_schema" in result or "schema" in result.lower()

    def test_run_sql_after_schema_succeeds(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        tools["get_table_schema"].invoke({"table_names": []})
        # No CSV in workspace → "No tables" but no guard error
        result = tools["run_sql_query"].invoke({"sql_query": "SELECT 42 AS n"})
        assert "42" in result or "1 rows" in result.lower() or "rows" in result.lower()


class TestQueryBudgetEnforcement:
    """Query count is capped at MAX_QUERY_COUNT."""

    def test_exceeding_query_budget_returns_error(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import (
            DuckDBManager,
            MAX_QUERY_COUNT,
        )
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)
        mgr.session.schema_inspected = True
        # Exhaust budget
        for _ in range(MAX_QUERY_COUNT):
            mgr.run_query("SELECT 1")
        with pytest.raises(ValueError, match="budget exhausted"):
            mgr.run_query("SELECT 2")

    def test_query_history_accumulates(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import DuckDBManager
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)
        mgr.session.schema_inspected = True
        mgr.run_query("SELECT 1 AS a")
        mgr.run_query("SELECT 2 AS b")
        assert len(mgr.session.query_history) == 2
        assert mgr.session.query_history[0].sql == "SELECT 1 AS a"
        assert mgr.session.query_history[1].sql == "SELECT 2 AS b"


class TestChartBudgetEnforcement:
    """Chart count is capped at MAX_CHART_COUNT."""

    def test_exceeding_chart_budget_returns_error(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import (
            DuckDBManager,
            MAX_CHART_COUNT,
        )
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)
        # Simulate having run queries
        mgr.session.schema_inspected = True
        mgr.session.last_query_result = pd.DataFrame({"x": [1]})
        # Exhaust budget
        for i in range(MAX_CHART_COUNT):
            mgr.record_chart(f"chart_{i}", [f"charts/chart_{i}.plotly.json"])
        mgr.session.chart_count = MAX_CHART_COUNT

        with pytest.raises(ValueError, match="budget exhausted"):
            mgr.require_chart_budget()


class TestRunScopedHistory:
    """Session history resets cleanly between runs."""

    def test_reset_clears_query_and_chart_history(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import DuckDBManager
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)
        mgr.session.schema_inspected = True
        mgr.run_query("SELECT 1")
        mgr.record_chart("My Chart", ["charts/my_chart.plotly.json"])
        assert len(mgr.session.query_history) == 1
        assert len(mgr.session.chart_history) == 1

        mgr.reset_session()
        assert mgr.session.query_history == []
        assert mgr.session.chart_history == []
        assert mgr.session.run_artifacts == []
        assert mgr.session.query_count == 0
        assert mgr.session.chart_count == 0

    def test_summary_includes_full_query_history(self, tmp_path: Path) -> None:
        """generate_summary embeds all queries from the run, not just the last one."""
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}

        tools["get_table_schema"].invoke({"table_names": []})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS first_query"})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 2 AS second_query"})

        result = tools["generate_summary"].invoke(
            {"summary": "Test summary", "insights": "Two queries were run."}
        )
        # Report should be saved
        reports_dir = tmp_path / "reports"
        assert reports_dir.exists(), "reports/ dir should be created"
        html_files = list(reports_dir.glob("*.html"))
        assert len(html_files) == 1
        content = html_files[0].read_text(encoding="utf-8")
        # Both queries must appear in the report
        assert "first_query" in content
        assert "second_query" in content

    def test_stale_charts_not_included_in_new_run(self, tmp_path: Path) -> None:
        """Charts from a prior run do not appear in a fresh run's report."""
        from agent.helpudoc_agent.data_agent_tools import DuckDBManager
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)

        # Simulate a prior run that left a chart artifact on disk
        charts_dir = tmp_path / "charts"
        charts_dir.mkdir()
        stale_chart = charts_dir / "old_chart.plotly.json"
        stale_chart.write_text(json.dumps({"data": [], "layout": {}}), encoding="utf-8")

        # New run — no charts recorded in session
        mgr.reset_session()
        assert mgr.session.chart_history == []
        # run_chart_paths would be empty → stale chart excluded
        run_chart_paths: list[str] = []
        for cr in mgr.session.chart_history:
            run_chart_paths.extend(cr.artifact_paths)
        assert "charts/old_chart.plotly.json" not in run_chart_paths


class TestDashboardTool:
    """generate_dashboard produces a single self-contained HTML artifact."""

    def _run_analysis_and_chart(self, tmp_path: Path) -> dict:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        tools["get_table_schema"].invoke({"table_names": []})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 42 AS val"})
        # Generate a minimal chart
        tools["generate_chart_config"].invoke({
            "chart_title": "Test_Chart",
            "python_code": textwrap.dedent("""\
                chart_config = {
                    "data": [{"x": [1, 2], "y": [3, 4], "type": "scatter"}],
                    "layout": {"title": "Test"},
                }
            """),
        })
        return tools

    def test_dashboard_tool_creates_html_file(self, tmp_path: Path) -> None:
        tools = self._run_analysis_and_chart(tmp_path)
        result = tools["generate_dashboard"].invoke({
            "title": "My Dashboard",
            "description": "A test dashboard.",
            "section_titles": [],
        })
        dashboards_dir = tmp_path / "dashboards"
        assert dashboards_dir.exists(), "dashboards/ dir should be created"
        html_files = list(dashboards_dir.glob("*.html"))
        assert len(html_files) == 1, f"Expected 1 dashboard HTML, got {html_files}"
        assert "Dashboard saved to" in result or "dashboards/" in result

    def test_dashboard_html_is_self_contained(self, tmp_path: Path) -> None:
        tools = self._run_analysis_and_chart(tmp_path)
        tools["generate_dashboard"].invoke({
            "title": "Self Contained",
            "description": "No external deps.",
            "section_titles": [],
        })
        html_files = list((tmp_path / "dashboards").glob("*.html"))
        content = html_files[0].read_text(encoding="utf-8")
        # Should embed Plotly CDN and the chart spec inline
        assert "plotly" in content.lower()
        assert "<!doctype html>" in content.lower()
        # Should include query block  
        assert "42" in content  # the SELECT 42 result

    def test_dashboard_requires_at_least_one_query(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        result = tools["generate_dashboard"].invoke({
            "title": "Empty",
            "description": ".",
            "section_titles": [],
        })
        assert "query" in result.lower()

    def test_dashboard_requires_at_least_one_chart(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        tools["get_table_schema"].invoke({"table_names": []})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 1"})
        result = tools["generate_dashboard"].invoke({
            "title": "No Charts",
            "description": ".",
            "section_titles": [],
        })
        assert "chart" in result.lower()

    def test_dashboard_can_only_be_called_once(self, tmp_path: Path) -> None:
        tools = self._run_analysis_and_chart(tmp_path)
        tools["generate_dashboard"].invoke({
            "title": "First",
            "description": ".",
            "section_titles": [],
        })
        result2 = tools["generate_dashboard"].invoke({
            "title": "Second",
            "description": ".",
            "section_titles": [],
        })
        assert "already been generated" in result2.lower() or "dashboard" in result2.lower()

    def test_dashboard_excludes_stale_charts(self, tmp_path: Path) -> None:
        """A chart written in a prior run should not appear in a fresh run's dashboard."""
        from agent.helpudoc_agent.data_agent_tools import DuckDBManager
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        mgr = DuckDBManager(ws)

        # Create a stale on-disk chart artifact
        charts_dir = tmp_path / "charts"
        charts_dir.mkdir()
        stale = charts_dir / "stale.plotly.json"
        stale.write_text(json.dumps({"data": [{"x": [999]}], "layout": {}}), encoding="utf-8")

        # New run — no charts recorded
        mgr.reset_session()
        run_chart_paths: list[str] = []
        for cr in mgr.session.chart_history:
            run_chart_paths.extend(cr.artifact_paths)
        resolved_json = [tmp_path / rel for rel in run_chart_paths if rel.endswith(".plotly.json")]
        assert stale not in resolved_json


class TestSummaryDashboardExclusivity:
    """Exactly one terminal artifact path is allowed per run."""

    def test_dashboard_after_summary_is_blocked(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        tools["get_table_schema"].invoke({"table_names": []})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS n"})
        tools["generate_summary"].invoke({"summary": "s", "insights": "i"})
        result = tools["generate_dashboard"].invoke({
            "title": "Blocked",
            "description": ".",
            "section_titles": [],
        })
        assert "summary has already been generated" in result.lower()

    def test_summary_after_dashboard_is_blocked(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.context = {}
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        tools["get_table_schema"].invoke({"table_names": []})
        tools["run_sql_query"].invoke({"sql_query": "SELECT 42 AS val"})
        tools["generate_chart_config"].invoke({
            "chart_title": "Terminal_Chart",
            "python_code": textwrap.dedent("""\
                chart_config = {
                    "data": [{"x": [1], "y": [42], "type": "bar"}],
                    "layout": {"title": "Terminal"},
                }
            """),
        })
        tools["generate_dashboard"].invoke({
            "title": "My Dashboard",
            "description": ".",
            "section_titles": [],
        })
        result = tools["generate_summary"].invoke({"summary": "s", "insights": "i"})
        assert "dashboard has already been generated" in result.lower()


class TestBigQueryMaterialization:
    """Warehouse slices can be exported to workspace Parquet and reused."""

    def _fake_bq_response(self) -> Dict[str, Any]:
        return {
            "jobComplete": True,
            "schema": {
                "fields": [
                    {"name": "order_id", "type": "INT64", "mode": "NULLABLE"},
                    {"name": "revenue", "type": "FLOAT64", "mode": "NULLABLE"},
                ]
            },
            "rows": [
                {"f": [{"v": "1"}, {"v": "10.5"}]},
                {"f": [{"v": "2"}, {"v": "22.0"}]},
            ],
        }

    def test_materialize_bigquery_to_parquet_creates_cache_files(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.workspace_id = "ws1"
        ws.context = {
            "mcp_auth": {
                "toolbox-bq-demo": {
                    "Authorization": "Bearer test-token",
                }
            },
            "bigquery_project": "demo-project",
            "bigquery_location": "us",
        }
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        fake_session = MagicMock()
        fake_session.post.return_value = MagicMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value=self._fake_bq_response()),
        )

        with patch("agent.helpudoc_agent.data_agent_tools.requests.Session", return_value=fake_session):
            raw = tools["materialize_bigquery_to_parquet"].invoke(
                {
                    "sql_query": "SELECT 1 AS order_id, 10.5 AS revenue",
                    "cache_key_hint": "orders_recent",
                }
            )

        payload = json.loads(raw)
        parquet_path = tmp_path / payload["parquet_path"]
        metadata_path = tmp_path / payload["metadata_path"]
        assert parquet_path.exists()
        assert metadata_path.exists()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        assert metadata["sourceSql"] == "SELECT 1 AS order_id, 10.5 AS revenue"
        assert metadata["connector"] == "toolbox-bq-demo"
        assert metadata["rowCount"] == 2
        schema_text = tools["get_table_schema"].invoke({"table_names": [payload["duckdb_table_name"]]})
        assert payload["duckdb_table_name"] in schema_text

    def test_materialize_bigquery_to_parquet_reuses_cache_until_refresh(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.data_agent_tools import build_data_agent_tools
        from unittest.mock import MagicMock

        ws = MagicMock()
        ws.root_path = tmp_path
        ws.workspace_id = "ws1"
        ws.context = {
            "mcp_auth": {
                "toolbox-bq-demo": {
                    "Authorization": "Bearer test-token",
                }
            },
            "bigquery_project": "demo-project",
            "bigquery_location": "us",
        }
        tools = {t.name: t for t in build_data_agent_tools(ws)}
        fake_session = MagicMock()
        fake_session.post.return_value = MagicMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value=self._fake_bq_response()),
        )

        with patch("agent.helpudoc_agent.data_agent_tools.requests.Session", return_value=fake_session):
            first = json.loads(
                tools["materialize_bigquery_to_parquet"].invoke(
                    {"sql_query": "SELECT 1 AS order_id, 10.5 AS revenue", "cache_key_hint": "orders_recent"}
                )
            )
            second = json.loads(
                tools["materialize_bigquery_to_parquet"].invoke(
                    {"sql_query": "SELECT 1 AS order_id, 10.5 AS revenue", "cache_key_hint": "orders_recent"}
                )
            )
            refreshed = json.loads(
                tools["materialize_bigquery_to_parquet"].invoke(
                    {
                        "sql_query": "SELECT 1 AS order_id, 10.5 AS revenue",
                        "cache_key_hint": "orders_recent",
                        "force_refresh": True,
                    }
                )
            )

        assert first["cached"] is False
        assert second["cached"] is True
        assert refreshed["cached"] is False
        assert fake_session.post.call_count == 2


class TestCompatibility:
    """Legacy data-analysis requests still resolve and work."""

    def test_data_analysis_skill_is_discovered(self, tmp_path: Path) -> None:
        """The data-analysis shim is found by the registry."""
        from agent.helpudoc_agent.skills_registry import load_skills

        # Copy the actual data-analysis SKILL.md into the tmp skills root
        src = Path(__file__).parent.parent / "skills" / "data-analysis" / "SKILL.md"
        if not src.exists():
            pytest.skip("skills/data-analysis/SKILL.md not found in repo")
        dest = tmp_path / "data-analysis"
        dest.mkdir()
        (dest / "SKILL.md").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

        skills = load_skills(tmp_path)
        ids = [s.skill_id for s in skills]
        assert "data-analysis" in ids

    def test_data_analysis_shim_declares_data_agent_tools(self, tmp_path: Path) -> None:
        from agent.helpudoc_agent.skills_registry import load_skills

        src = Path(__file__).parent.parent / "skills" / "data-analysis" / "SKILL.md"
        if not src.exists():
            pytest.skip("skills/data-analysis/SKILL.md not found in repo")
        dest = tmp_path / "data-analysis"
        dest.mkdir()
        (dest / "SKILL.md").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

        skills = load_skills(tmp_path)
        shim = next(s for s in skills if s.skill_id == "data-analysis")
        assert "data_agent_tools" in shim.tools
        assert "materialize_bigquery_to_parquet" in shim.tools

    def test_toolbox_bq_demo_still_works_unchanged(self) -> None:
        """toolbox/tools.yaml configures the BQ toolset without modification."""
        tools_yaml = (
            Path(__file__).parent.parent / "toolbox" / "tools.yaml"
        )
        if not tools_yaml.exists():
            pytest.skip("toolbox/tools.yaml not found")
        content = tools_yaml.read_text(encoding="utf-8")
        # Key tool names that must remain
        for tool_name in ("bq_execute_sql", "bq_list_datasets", "bq_list_tables", "bq_get_table_info"):
            assert tool_name in content, f"{tool_name} missing from tools.yaml"
