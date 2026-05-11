"""DuckDB workspace registration and guarded query execution."""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import List, Optional, Set

import duckdb
import pandas as pd

from .constants import (
    DATA_DISCOVERY_DIR_CANDIDATES,
    DATA_FILE_EXTENSIONS,
    MAX_CHART_COUNT,
    MAX_QUERY_COUNT,
    MAX_RESULT_ROWS,
    MAX_SESSION_ROWS,
    STRICT_DASHBOARD_QUERY_COUNT,
    STRICT_DASHBOARD_SCHEMA_COUNT,
)
from .formatting import _format_sample_value
from .guards import (
    _extract_dashboard_dimension_signature,
    _is_strict_dashboard_mode,
)
from .state import DataAgentSessionState, _ChartRecord, _QueryRecord
from .workspace_files import _iter_workspace_files

from ...state import WorkspaceState

logger = logging.getLogger(__name__)

_STRING_LITERAL_PATTERN = re.compile(r"(['\"])([^'\"\\]*)\1")


def _rewrite_virtual_paths(query: str, workspace_root: Path) -> str:
    """Rewrite absolute paths that assume the workspace root is '/' to real filesystem paths."""

    def replacer(match: re.Match[str]) -> str:
        quote, content = match.group(1), match.group(2)
        if content.startswith("/"):
            resolved = (workspace_root / content.lstrip("/")).resolve()
            return f"{quote}{resolved}{quote}"
        return match.group(0)

    return _STRING_LITERAL_PATTERN.sub(replacer, query)
class DuckDBManager:
    """Manages DuckDB connection and file registration."""

    def __init__(self, workspace_state: WorkspaceState):
        self.workspace_state = workspace_state
        self.con = duckdb.connect(database=":memory:")
        # The agent can emit multiple local SQL tool calls in one model step. DuckDB's
        # Python connection is not safe for overlapping use, so serialize all access
        # through a per-manager lock to avoid orphaned/stuck runs.
        self._con_lock = threading.RLock()
        self.session = DataAgentSessionState()
        self._registered_tables: Set[str] = set()
        self._register_files()

    def reset_session(self):
        """Reset per-run guardrails."""
        self.session.reset()
        self._register_files()

    def _register_files(self):
        """Scans workspace for CSV and Parquet files and registers them as tables."""
        with self._con_lock:
            self._registered_tables.clear()
            root = self.workspace_state.root_path
            preferred_dirs = tuple(
                dirname
                for dirname in DATA_DISCOVERY_DIR_CANDIDATES
                if (root / dirname).exists()
            )
            data_files = _iter_workspace_files(
                root,
                allowed_extensions=DATA_FILE_EXTENSIONS,
                preferred_dirs=preferred_dirs,
            )
            used_names: Set[str] = set()
            for file_path in sorted(data_files):
                relative_stem = file_path.relative_to(root).with_suffix("").as_posix()
                base_name = re.sub(r"[^a-zA-Z0-9_]", "_", file_path.stem)
                path_name = re.sub(r"[^a-zA-Z0-9_]", "_", relative_stem)
                ext_name = f"{base_name}_{file_path.suffix.lstrip('.').lower()}"
                table_name = base_name
                if table_name in used_names:
                    table_name = path_name or ext_name
                if table_name in used_names:
                    table_name = ext_name
                safe_path = file_path.as_posix().replace("'", "''")
                try:
                    if file_path.suffix.lower() == ".csv":
                        self.con.execute(
                            f"CREATE OR REPLACE TABLE {table_name} "
                            f"AS SELECT * FROM read_csv_auto('{safe_path}')"
                        )
                    else:
                        self.con.execute(
                            f"CREATE OR REPLACE TABLE {table_name} "
                            f"AS SELECT * FROM read_parquet('{safe_path}')"
                        )
                    used_names.add(table_name)
                    self._registered_tables.add(table_name)
                    logger.info("Registered table %s from %s", table_name, file_path)
                except Exception as exc:
                    logger.error("Failed to register %s: %s", file_path, exc)

    def get_schema(self, table_names: Optional[List[str]] = None) -> str:
        if _is_strict_dashboard_mode(self.workspace_state):
            if self.session.last_schema_result is not None and self.session.schema_read_count >= STRICT_DASHBOARD_SCHEMA_COUNT:
                return (
                    "Dashboard planning mode reuses the existing schema snapshot to avoid duplicated discovery.\n\n"
                    f"{self.session.last_schema_result}"
                )
        with self._con_lock:
            tables = self.con.execute("SHOW TABLES").fetchall()
            if not tables:
                return "No tables found in the workspace."

            schema_lines: List[str] = []
            for table in tables:
                table_name = table[0]
                if table_names and table_name not in table_names:
                    continue

                schema_lines.append(f"Table: {table_name}")
                columns = self.con.execute(f"DESCRIBE {table_name}").fetchall()
                sample_rows = self.con.execute(f"SELECT * FROM {table_name} LIMIT 3").df()
                for col in columns:
                    sample_values: List[str] = []
                    if not sample_rows.empty and col[0] in sample_rows.columns:
                        non_null = sample_rows[col[0]].dropna().tolist()
                        for value in non_null:
                            formatted = _format_sample_value(value)
                            if formatted not in sample_values:
                                sample_values.append(formatted)
                            if len(sample_values) == 2:
                                break
                    sample_suffix = (
                        f" [examples: {', '.join(sample_values)}]" if sample_values else ""
                    )
                    schema_lines.append(f"  - {col[0]} ({col[1]}){sample_suffix}")
                schema_lines.append("")

            rendered = "\n".join(schema_lines).strip()
            self.session.schema_read_count += 1
            self.session.last_schema_result = rendered
            return rendered

    def run_query(
        self,
        query: str,
        *,
        record_sql: Optional[str] = None,
        truncated: bool = False,
    ) -> pd.DataFrame:
        with self._con_lock:
            strict_dashboard_mode = _is_strict_dashboard_mode(self.workspace_state)
            max_query_count = STRICT_DASHBOARD_QUERY_COUNT if strict_dashboard_mode else MAX_QUERY_COUNT
            if self.session.query_count >= max_query_count:
                raise ValueError(
                    f"Query budget exhausted: at most {max_query_count} queries are allowed per run."
                )
            df = self.con.execute(query).df()
            self.session.query_count += 1
            self.session.last_query_result = df
            stored_sql = record_sql or query
            self.session.last_query_sql = stored_sql
            if strict_dashboard_mode:
                signature = _extract_dashboard_dimension_signature(stored_sql)
                if signature:
                    self.session.dashboard_dimension_signatures.add(signature)
            self.session.query_history.append(
                _QueryRecord(
                    sql=stored_sql,
                    row_count=len(df),
                    preview=df.head(MAX_RESULT_ROWS).copy(),
                    truncated=truncated,
                )
            )
            return df

    def record_chart(self, title: str, artifact_paths: List[str]) -> None:
        self.session.chart_count += 1
        self.session.chart_history.append(_ChartRecord(title=title, artifact_paths=artifact_paths))

    def record_materialization(self, record: _MaterializationRecord) -> None:
        self.session.materialization_history.append(record)

    def register_artifact(self, artifact: Dict[str, Any]) -> None:
        self.session.run_artifacts.append(artifact)

    def refresh_registered_files(self) -> None:
        self._register_files()

    def require_schema_check(self) -> None:
        if not self.session.schema_inspected:
            raise ValueError(
                "Call get_table_schema before running SQL queries to verify the data layout."
            )

    def require_query_before_chart(self) -> None:
        if self.session.last_query_result is None:
            raise ValueError("Run at least one SQL query before generating a chart.")

    def require_chart_budget(self) -> None:
        if self.session.chart_count >= MAX_CHART_COUNT:
            raise ValueError(
                f"Chart budget exhausted: at most {MAX_CHART_COUNT} charts are allowed per run."
            )

    def ensure_single_summary(self) -> None:
        if self.session.dashboard_generated:
            raise ValueError("A dashboard has already been generated for this run.")
        if self.session.summary_generated:
            raise ValueError("A summary has already been generated for this run.")

    def ensure_single_dashboard(self) -> None:
        if self.session.summary_generated:
            raise ValueError("A summary has already been generated for this run.")
        if self.session.dashboard_generated:
            raise ValueError("A dashboard has already been generated for this run.")

    def mark_summary_generated(self) -> None:
        self.session.summary_generated = True

    def mark_dashboard_generated(self) -> None:
        self.session.dashboard_generated = True

    def get_limited_result(self) -> Optional[pd.DataFrame]:
        result = self.session.last_query_result
        if result is None:
            return None
        if len(result) > MAX_SESSION_ROWS:
            return result.head(MAX_SESSION_ROWS).copy()
        return result.copy()


