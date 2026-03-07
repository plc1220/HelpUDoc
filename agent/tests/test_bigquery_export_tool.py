from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import duckdb
import pandas as pd

from helpudoc_agent.bigquery_export_tools import (
    build_export_bigquery_query_tool,
    resolve_output_path,
    run_bigquery_query,
    validate_read_only_sql,
    write_export_dataframe,
)
from helpudoc_agent.state import WorkspaceState


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(self.text)


class BigQueryExportToolTest(unittest.TestCase):
    def test_validate_read_only_sql_rejects_write(self) -> None:
        validate_read_only_sql("WITH base AS (SELECT 1) SELECT * FROM base")
        with self.assertRaises(ValueError):
            validate_read_only_sql("DELETE FROM demo.table WHERE id = 1")

    def test_resolve_output_path_blocks_workspace_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            resolved = resolve_output_path(root, "data_exports/orders", "csv")
            self.assertEqual(resolved, root / "data_exports" / "orders.csv")
            with self.assertRaises(ValueError):
                resolve_output_path(root, "../outside.csv", "csv")

    @patch("helpudoc_agent.bigquery_export_tools.time.sleep", return_value=None)
    @patch("helpudoc_agent.bigquery_export_tools.requests.get")
    @patch("helpudoc_agent.bigquery_export_tools.requests.post")
    def test_run_bigquery_query_handles_paging(self, mock_post, mock_get, _mock_sleep) -> None:
        schema = {
            "fields": [
                {"name": "order_id", "type": "INT64"},
                {"name": "is_repeat", "type": "BOOL"},
                {"name": "meta", "type": "RECORD", "fields": [{"name": "channel", "type": "STRING"}]},
            ]
        }
        mock_post.return_value = _FakeResponse(
            {
                "jobComplete": True,
                "jobReference": {"jobId": "job-123", "location": "us"},
                "schema": schema,
                "rows": [
                    {"f": [{"v": "1"}, {"v": "true"}, {"v": {"f": [{"v": "email"}]}}]},
                ],
                "pageToken": "next-page",
            }
        )
        mock_get.return_value = _FakeResponse(
            {
                "schema": schema,
                "rows": [
                    {"f": [{"v": "2"}, {"v": "false"}, {"v": {"f": [{"v": "ads"}]}}]},
                ],
            }
        )

        df = run_bigquery_query(
            sql="SELECT order_id, is_repeat, meta FROM sample.orders",
            project="demo-project",
            location="us",
            auth_header="Bearer token",
            row_limit=100,
        )

        self.assertEqual(df["order_id"].tolist(), [1, 2])
        self.assertEqual(df["is_repeat"].tolist(), [True, False])
        self.assertEqual(df["meta"].tolist(), ['{"channel": "email"}', '{"channel": "ads"}'])

    def test_write_export_dataframe_supports_csv_and_parquet(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            df = pd.DataFrame({"category": ["A", "B"], "value": [10, 20]})

            csv_meta = write_export_dataframe(df, root / "data_exports" / "sample.csv", "csv")
            self.assertEqual(csv_meta["rowCount"], 2)
            self.assertTrue((root / "data_exports" / "sample.csv").exists())

            parquet_path = root / "data_exports" / "sample.parquet"
            parquet_meta = write_export_dataframe(df, parquet_path, "parquet")
            self.assertEqual(parquet_meta["rowCount"], 2)
            self.assertTrue(parquet_path.exists())
            count = duckdb.connect(database=":memory:").execute(
                f"SELECT COUNT(*) FROM read_parquet('{parquet_path.as_posix()}')"
            ).fetchone()[0]
            self.assertEqual(count, 2)

    @patch("helpudoc_agent.bigquery_export_tools.run_bigquery_query")
    def test_export_tool_writes_workspace_csv(self, mock_query) -> None:
        mock_query.return_value = pd.DataFrame({"order_id": [101, 102], "revenue": [12.5, 8.0]})
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = WorkspaceState(
                workspace_id="ws-1",
                root_path=Path(tmpdir),
                context={"mcp_auth": {"toolbox-bq-demo": {"Authorization": "Bearer token"}}},
            )
            tool = build_export_bigquery_query_tool(workspace)
            raw = tool.invoke(
                {
                    "sql": "SELECT order_id, revenue FROM dataset.orders",
                    "output_path": "data_exports/orders_extract",
                    "format": "csv",
                    "row_limit": 500,
                }
            )
            payload = json.loads(raw)
            output_file = workspace.root_path / payload["path"]

            self.assertEqual(payload["format"], "csv")
            self.assertEqual(payload["rowCount"], 2)
            self.assertTrue(output_file.exists())
            self.assertIn("order_id", output_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
