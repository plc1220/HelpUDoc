from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from helpudoc_agent.data_agent_tools import (
    DuckDBManager,
    _build_dashboard_chart_specs,
    _format_sample_value,
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

    def test_snapshot_workspace_falls_back_to_full_scan_for_off_path_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "reports").mkdir()
            (root / "reports" / "summary.html").write_text("<h1>ok</h1>", encoding="utf-8")
            (root / "README.md").write_text("readme", encoding="utf-8")
            (root / "custom_artifacts").mkdir()
            (root / "custom_artifacts" / "chart.png").write_bytes(b"png")

            snapshot = _snapshot_workspace(root)

            self.assertIn("custom_artifacts/chart.png", snapshot)

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

    def test_format_sample_value_handles_non_scalar_values(self) -> None:
        rendered = _format_sample_value({"segments": ["vip", "trial"]})
        self.assertIn("segments", rendered)
        self.assertIn("vip", rendered)

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

    def test_run_sql_query_caps_window_function_results(self) -> None:
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
            raw = tools["run_sql_query"].invoke(
                {
                    "sql_query": (
                        "SELECT order_id, MAX(revenue) OVER () AS max_revenue "
                        "FROM orders"
                    )
                }
            )

            self.assertIn("Execution was safety-capped at 1000 rows.", raw)
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

    def test_build_dashboard_chart_specs_swaps_horizontal_bar_dimension_and_metric(self) -> None:
        bindings = {
            1: {
                "chart_index": 1,
                "chart_type": "bar",
                "x_field": "cancellation_rate",
                "y_field": "country",
                "orientation": "h",
                "aggregation": "avg",
            }
        }
        dataset_schema = [
            {"name": "country", "type": "object"},
            {"name": "cancellation_rate", "type": "float64"},
        ]

        specs = _build_dashboard_chart_specs(bindings, dataset_schema)

        self.assertEqual(specs[1]["dimensionField"], "country")
        self.assertEqual(specs[1]["metricField"], "cancellation_rate")
        self.assertTrue(specs[1]["liveCapable"])

    def test_build_dashboard_chart_specs_promotes_ratio_binding(self) -> None:
        bindings = {
            1: {
                "chart_index": 1,
                "chart_type": "bar",
                "x_field": "country",
                "aggregation": "avg",
                "numerator_field": "cancelled_orders",
                "denominator_field": "total_orders",
            }
        }
        dataset_schema = [
            {"name": "country", "type": "object"},
            {"name": "cancelled_orders", "type": "int64"},
            {"name": "total_orders", "type": "int64"},
        ]

        specs = _build_dashboard_chart_specs(bindings, dataset_schema)

        self.assertEqual(specs[1]["aggregation"], "ratio")
        self.assertEqual(specs[1]["numeratorField"], "cancelled_orders")
        self.assertEqual(specs[1]["denominatorField"], "total_orders")

    def test_run_sql_query_caps_scalar_subquery_aggregate_results(self) -> None:
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
            raw = tools["run_sql_query"].invoke(
                {
                    "sql_query": (
                        "SELECT order_id, "
                        "(SELECT COUNT(*) FROM orders) AS total_orders "
                        "FROM orders"
                    )
                }
            )

            self.assertIn("Execution was safety-capped at 1000 rows.", raw)
            manager = workspace.context["data_agent_manager"]
            self.assertEqual(len(manager.session.last_query_result), 1000)
            self.assertTrue(manager.session.query_history[-1].truncated)

    def test_generate_dashboard_writes_package_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "datasets").mkdir()
            (root / "datasets" / "orders.csv").write_text(
                "country,cancelled_orders,total_orders,cancellation_rate\n"
                "Spain,5,100,0.05\n"
                "Japan,8,120,0.0667\n"
                "Spain,4,80,0.05\n",
                encoding="utf-8",
            )
            workspace = self._workspace(root)
            tools = self._tool_map(workspace)

            tools["get_table_schema"].invoke({"table_names": ["orders"]})
            tools["run_sql_query"].invoke(
                {
                    "sql_query": (
                        "SELECT country, cancelled_orders, total_orders, cancellation_rate "
                        "FROM orders"
                    )
                }
            )
            tools["generate_chart_config"].invoke(
                {
                    "chart_title": "Cancellation_Rate",
                    "python_code": (
                        "chart_config = {\n"
                        "  'data': [{'x': df['country'].tolist(), 'y': df['cancellation_rate'].tolist(), 'type': 'bar'}],\n"
                        "  'layout': {'title': 'Cancellation rate'}\n"
                        "}\n"
                    ),
                }
            )

            raw = tools["generate_dashboard"].invoke(
                {
                    "title": "Order Cancellations",
                    "description": "Tracks cancellation risk by country.",
                    "output_path": "dashboards/order_cancellations",
                    "dashboard_dataset_path": "datasets/orders.csv",
                    "filter_schema": [{"id": "country", "field": "country", "label": "Country"}],
                    "chart_bindings": [
                        {
                            "chart_index": 1,
                            "chart_type": "bar",
                            "x_field": "country",
                            "y_field": "cancellation_rate",
                            "aggregation": "avg",
                        }
                    ],
                }
            )

            self.assertIn("Dashboard package saved to: dashboards/order_cancellations", raw)

            meta_path = root / "dashboards" / "order_cancellations" / "dashboard.meta.json"
            spec_path = root / "dashboards" / "order_cancellations" / "dashboard.spec.json"
            snapshot_path = root / "dashboards" / "order_cancellations" / "dashboard.snapshot.html"

            self.assertTrue(meta_path.exists())
            self.assertTrue(spec_path.exists())
            self.assertTrue(snapshot_path.exists())

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            spec = json.loads(spec_path.read_text(encoding="utf-8"))

            self.assertEqual(meta["status"], "ready")
            self.assertEqual(meta["runtimeKind"], "native")
            self.assertEqual(meta["snapshotPath"], "dashboards/order_cancellations/dashboard.snapshot.html")
            self.assertEqual(spec["dashboardPath"], "dashboards/order_cancellations")
            self.assertEqual(spec["runtimeKind"], "native")
            self.assertEqual(spec["dataset"]["path"], "datasets/orders.csv")
            self.assertIn("previewPath", spec["dataset"])
            self.assertTrue(spec["dataset"]["previewPath"].endswith("data/dashboard.rows.json"))
            self.assertEqual(spec["fallbackMode"], "read_only_html")

            rows_path = root / "dashboards" / "order_cancellations" / "data" / "dashboard.rows.json"
            self.assertTrue(rows_path.exists())
            rows_payload = json.loads(rows_path.read_text(encoding="utf-8"))
            self.assertIn("rows", rows_payload)
            self.assertGreater(len(rows_payload["rows"]), 0)


if __name__ == "__main__":
    unittest.main()
