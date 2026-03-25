from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from helpudoc_agent.data_agent_tools import (
    DuckDBManager,
    _snapshot_workspace,
    build_data_agent_tools,
)
from helpudoc_agent.state import WorkspaceState


class DataAgentToolsTest(unittest.TestCase):
    def _workspace(self, root: Path) -> WorkspaceState:
        return WorkspaceState(workspace_id="ws-data-tools", root_path=root)

    def _tool_map(self, workspace: WorkspaceState):
        return {tool.name: tool for tool in build_data_agent_tools(workspace)}

    def test_snapshot_workspace_skips_ignored_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reports").mkdir()
            (root / "charts").mkdir()
            (root / "node_modules" / "pkg").mkdir(parents=True)
            (root / "reports" / "summary.html").write_text("<h1>ok</h1>", encoding="utf-8")
            (root / "charts" / "plot.png").write_bytes(b"png")
            (root / "node_modules" / "pkg" / "ignored.png").write_bytes(b"ignored")

            snapshot = _snapshot_workspace(root)

            self.assertIn("reports/summary.html", snapshot)
            self.assertIn("charts/plot.png", snapshot)
            self.assertNotIn("node_modules/pkg/ignored.png", snapshot)

    def test_register_files_prefers_data_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "datasets").mkdir()
            (root / "node_modules").mkdir()
            (root / "datasets" / "orders.csv").write_text(
                "status,revenue\nactive,10\npending,20\n",
                encoding="utf-8",
            )
            (root / "node_modules" / "ignored.csv").write_text(
                "status,revenue\nbad,0\n",
                encoding="utf-8",
            )

            manager = DuckDBManager(self._workspace(root))
            tables = {row[0] for row in manager.con.execute("SHOW TABLES").fetchall()}

            self.assertIn("orders", tables)
            self.assertNotIn("ignored", tables)

    def test_get_table_schema_includes_example_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "datasets").mkdir()
            (root / "datasets" / "orders.csv").write_text(
                "status,revenue\nactive,10\npending,20\nactive,30\n",
                encoding="utf-8",
            )
            tools = self._tool_map(self._workspace(root))

            raw = tools["get_table_schema"].invoke({"table_names": ["orders"]})

            self.assertIn("Table: orders", raw)
            self.assertIn("status (VARCHAR)", raw)
            self.assertIn("[examples: 'active', 'pending']", raw)
            self.assertIn("revenue (BIGINT)", raw)

    def test_run_sql_query_keeps_aggregate_results_intact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "datasets").mkdir()
            rows = ["category,value"]
            rows.extend(f"c{i},1" for i in range(1005))
            (root / "datasets" / "orders.csv").write_text(
                "\n".join(rows) + "\n",
                encoding="utf-8",
            )
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": ["orders"]})
            raw = tools["run_sql_query"].invoke(
                {
                    "sql_query": (
                        "SELECT category, SUM(value) AS total "
                        "FROM orders GROUP BY category ORDER BY category"
                    )
                }
            )

            self.assertIn("Result shape: 1005 rows x 2 columns.", raw)
            self.assertNotIn("Execution was safety-capped", raw)
            manager = workspace.context["data_agent_manager"]
            self.assertEqual(len(manager.session.last_query_result), 1005)
            self.assertFalse(manager.session.query_history[-1].truncated)

    def test_run_sql_query_caps_non_aggregated_previews(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "datasets").mkdir()
            rows = ["order_id,revenue"]
            rows.extend(f"{i},{i * 10}" for i in range(1105))
            (root / "datasets" / "orders.csv").write_text(
                "\n".join(rows) + "\n",
                encoding="utf-8",
            )
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": ["orders"]})
            raw = tools["run_sql_query"].invoke({"sql_query": "SELECT * FROM orders"})

            self.assertIn("Result shape: 1000 rows x 2 columns.", raw)
            self.assertIn("Execution was safety-capped at 1000 rows.", raw)
            self.assertIn("Numeric summary:", raw)
            manager = workspace.context["data_agent_manager"]
            self.assertEqual(len(manager.session.last_query_result), 1000)
            self.assertTrue(manager.session.query_history[-1].truncated)

    def test_generate_chart_config_returns_success_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": []})
            tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS x, 2 AS y"})
            raw = tools["generate_chart_config"].invoke(
                {
                    "chart_title": "Revenue_Chart",
                    "python_code": (
                        "chart_config = {\n"
                        "  'data': [{'x': df['x'].tolist(), 'y': df['y'].tolist(), 'type': 'bar'}],\n"
                        "  'layout': {'title': 'Revenue'}\n"
                        "}\n"
                    ),
                }
            )

            payload = json.loads(raw)
            self.assertEqual(payload["status"], "success")
            self.assertEqual(payload["message"], "Chart generated successfully.")
            self.assertEqual(payload["chart_title"], "Revenue_Chart")
            self.assertTrue(payload["plotly_config_path"].endswith(".plotly.json"))
            self.assertTrue(payload["output_files"])

    def test_generate_chart_config_returns_missing_column_error_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": []})
            tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS x, 2 AS y"})
            raw = tools["generate_chart_config"].invoke(
                {
                    "chart_title": "Broken_Chart",
                    "python_code": (
                        "chart_config = {\n"
                        "  'data': [{'x': df['missing'].tolist(), 'y': df['y'].tolist(), 'type': 'bar'}],\n"
                        "  'layout': {'title': 'Broken'}\n"
                        "}\n"
                    ),
                }
            )

            payload = json.loads(raw)
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["error_type"], "missing_column")
            self.assertIn("available_columns", payload)
            self.assertEqual(payload["output_files"], [])
            manager = workspace.context["data_agent_manager"]
            self.assertFalse(manager.session.chart_history)

    @patch("helpudoc_agent.data_agent_tools.CHART_EXECUTION_TIMEOUT_SECONDS", 0.2)
    def test_generate_chart_config_times_out_in_subprocess(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": []})
            tools["run_sql_query"].invoke({"sql_query": "SELECT 1 AS x"})
            raw = tools["generate_chart_config"].invoke(
                {
                    "chart_title": "Slow_Chart",
                    "python_code": "while 1:\n    pass\n",
                }
            )

            payload = json.loads(raw)
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["error_type"], "timeout")
            self.assertEqual(payload["output_files"], [])
            manager = workspace.context["data_agent_manager"]
            self.assertFalse(manager.session.chart_history)


if __name__ == "__main__":
    unittest.main()
