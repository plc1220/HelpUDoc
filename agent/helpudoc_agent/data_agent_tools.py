
import ast
import json
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Set, Tuple

import duckdb
import numpy as np
import pandas as pd
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool
from pydantic import BaseModel, Field

from .state import WorkspaceState

logger = logging.getLogger(__name__)

ALLOWED_ARTIFACT_EXTENSIONS = {
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
}
MAX_RESULT_ROWS = 20
MAX_SESSION_ROWS = 1000


class DataAgentSessionState:
    """Holds per-run guardrails for the data agent tools."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.schema_inspected = False
        self.query_count = 0
        self.summary_generated = False
        self.last_query_result: Optional[pd.DataFrame] = None
        self.last_query_sql: Optional[str] = None


class SafePandasProxy:
    """Restricts pandas entry points that could be used to read raw files."""

    _blocked = {"read_csv", "read_parquet", "read_json", "read_excel"}

    def __init__(self, module: Any):
        self._module = module

    def __getattr__(self, name: str) -> Any:
        if name in self._blocked:
            raise ValueError(
                "Direct file reads are disabled in this environment. "
                "Use DuckDB queries to load data."
            )
        return getattr(self._module, name)


def _build_safe_builtins() -> Dict[str, Any]:
    return {
        "abs": abs,
        "min": min,
        "max": max,
        "sum": sum,
        "len": len,
        "round": round,
        "range": range,
        "enumerate": enumerate,
        "zip": zip,
        "sorted": sorted,
    }


def _snapshot_workspace(root: Path) -> Dict[str, Tuple[int, int]]:
    snapshot: Dict[str, Tuple[int, int]] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        try:
            stat = path.stat()
        except OSError:
            continue
        snapshot[rel] = (int(stat.st_mtime * 1e9), stat.st_size)
    return snapshot


def _detect_new_files(
    root: Path, before: Dict[str, Tuple[int, int]], after: Dict[str, Tuple[int, int]]
) -> List[Dict[str, Any]]:
    artifacts: List[Dict[str, Any]] = []
    for rel, meta in after.items():
        if rel in before:
            continue
        path = root / rel
        ext = path.suffix.lower()
        if ext not in ALLOWED_ARTIFACT_EXTENSIONS:
            continue
        mime = ALLOWED_ARTIFACT_EXTENSIONS[ext]
        artifacts.append(
            {
                "path": rel,
                "mimeType": mime,
                "size": meta[1],
            }
        )
    return artifacts


def _format_dataframe_markdown(df: pd.DataFrame) -> str:
    if df.empty:
        return "Query executed successfully but returned no data."

    display_df = df.head(MAX_RESULT_ROWS)
    message_lines = [
        f"The query returned {len(df)} rows.",
    ]
    if len(df) > MAX_RESULT_ROWS:
        message_lines.append(f"Showing the first {MAX_RESULT_ROWS} rows below.")
    message_lines.append(display_df.to_markdown())
    rendered = "\n".join(message_lines)
    if len(rendered) > 4000:
        return rendered[:4000] + "\n... (Output truncated due to length)"
    return rendered


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.ndarray,)):
        return value.tolist()
    if isinstance(value, (pd.Series, pd.Index)):
        return value.tolist()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value)} is not JSON serializable")


def _json_dump(payload: Any) -> str:
    return json.dumps(payload, default=_json_default, ensure_ascii=False)

class DuckDBManager:
    """Manages DuckDB connection and file registration."""
    
    def __init__(self, workspace_state: WorkspaceState):
        self.workspace_state = workspace_state
        self.con = duckdb.connect(database=":memory:")
        self.session = DataAgentSessionState()
        self._registered_tables: Set[str] = set()
        self._register_files()

    def reset_session(self):
        """Reset per-run guardrails."""
        self.session.reset()
        # Refresh tables so new workspace files become available to DuckDB.
        self._register_files()

    def _register_files(self):
        """Scans workspace for CSV and Parquet files and registers them as tables."""
        self._registered_tables.clear()
        root = self.workspace_state.root_path
        csv_files = list(root.rglob("*.csv"))
        parquet_files = list(root.rglob("*.parquet"))
        for file_path in csv_files + parquet_files:
            table_name = file_path.stem
            table_name = re.sub(r'[^a-zA-Z0-9_]', '_', table_name)
            try:
                if file_path.suffix.lower() == ".csv":
                    self.con.execute(
                        f"CREATE OR REPLACE TABLE {table_name} "
                        f"AS SELECT * FROM read_csv_auto('{file_path}')"
                    )
                else:
                    self.con.execute(
                        f"CREATE OR REPLACE TABLE {table_name} "
                        f"AS SELECT * FROM read_parquet('{file_path}')"
                    )
                self._registered_tables.add(table_name)
                logger.info("Registered table %s from %s", table_name, file_path)
            except Exception as e:
                logger.error("Failed to register %s: %s", file_path, e)

    def get_schema(self, table_names: Optional[List[str]] = None) -> str:
        """Returns the schema of registered tables."""
        tables = self.con.execute("SHOW TABLES").fetchall()
        if not tables:
            return "No tables found in the workspace."

        schema_str = ""
        for table in tables:
            table_name = table[0]
            if table_names and table_name not in table_names:
                continue
            
            schema_str += f"Table: {table_name}\n"
            columns = self.con.execute(f"DESCRIBE {table_name}").fetchall()
            for col in columns:
                # column_name, column_type, null, key, default, extra
                schema_str += f"  - {col[0]} ({col[1]})\n"
            schema_str += "\n"
        
        return schema_str

    def run_query(self, query: str) -> pd.DataFrame:
        """Executes a SQL query and returns the result as a DataFrame."""
        df = self.con.execute(query).df()
        self.session.query_count += 1
        self.session.last_query_result = df
        self.session.last_query_sql = query
        return df

    def require_schema_check(self) -> None:
        if not self.session.schema_inspected:
            raise ValueError(
                "Call get_table_schema before running SQL queries to verify the data layout."
            )

    def require_query_before_chart(self) -> None:
        if self.session.last_query_result is None:
            raise ValueError(
                "Run at least one SQL query before generating a chart."
            )

    def ensure_single_summary(self) -> None:
        if self.session.summary_generated:
            raise ValueError("A summary has already been generated for this run.")

    def mark_summary_generated(self) -> None:
        self.session.summary_generated = True

    def get_limited_result(self) -> Optional[pd.DataFrame]:
        result = self.session.last_query_result
        if result is None:
            return None
        if len(result) > MAX_SESSION_ROWS:
            return result.head(MAX_SESSION_ROWS).copy()
        return result.copy()


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

def sanitize_python_code(code: str) -> str:
    """Sanitize Python code to prevent malicious execution."""
    # Remove comments and normalize whitespace
    code = re.sub(r"#.*$", "", code, flags=re.MULTILINE)
    code = re.sub(r'"""[\s\S]*?"""', "", code)
    code = re.sub(r"'''[\s\S]*?'''", "", code)

    # Forbidden patterns
    forbidden_patterns = [
        r"import\s+os", r"import\s+sys", r"import\s+subprocess", r"import\s+__builtins__",
        r"__import__", r"eval\s*\(", r"exec\s*\(", r"open\s*\(", r"file\s*\(",
        r"input\s*\(", r"raw_input\s*\(", r"compile\s*\(", r"globals\s*\(",
        r"locals\s*\(", r"vars\s*\(", r"dir\s*\(", r"help\s*\(", r"breakpoint\s*\(",
        r"quit\s*\(", r"exit\s*\(", r"while\s+True:",
        r"async\s+", r"await\s+",
        r"pd\.read_csv", r"pd\.read_parquet", r"pd\.read_json", r"pd\.read_excel",
        r"read_csv_auto", r"read_parquet",
    ]

    for pattern in forbidden_patterns:
        if re.search(pattern, code, re.IGNORECASE):
            raise ValueError(f"Forbidden pattern detected: {pattern}")

    # Only allow basic pandas operations and chart config generation
    allowed_imports = ["pandas", "pd", "numpy", "np", "json", "math", "statistics"]

    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name not in allowed_imports:
                        raise ValueError(f"Forbidden import: {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                if node.module not in allowed_imports:
                    raise ValueError(f"Forbidden import from: {node.module}")
    except SyntaxError as e:
        raise ValueError(f"Invalid Python syntax: {e}")

    return code

def build_data_agent_tools(workspace_state: WorkspaceState, source_tracker: Any = None) -> List[Tool]:
    db_manager = DuckDBManager(workspace_state)
    workspace_state.context["data_agent_manager"] = db_manager

    @tool
    def get_table_schema(
        table_names: List[str] = Field(description="List of table names to get schema for. If empty, returns all tables."),
    ) -> str:
        """Get the schema of tables relevant to the user question."""
        result = db_manager.get_schema(table_names if table_names else None)
        db_manager.session.schema_inspected = True
        return result

    @tool
    def run_sql_query(
        sql_query: str = Field(description="The SQL query to run. Always limit rows to 1000."),
    ) -> str:
        """Run a SQL query against the database and return the results."""
        try:
            db_manager.require_schema_check()
        except ValueError as exc:
            return str(exc)

        try:
            cleaned_query = sql_query.strip()
            if cleaned_query.endswith(";"):
                cleaned_query = cleaned_query[:-1].rstrip()
            cleaned_query = _rewrite_virtual_paths(
                cleaned_query, db_manager.workspace_state.root_path
            )
            if not re.search(r"\blimit\s+\d+\b", cleaned_query, re.IGNORECASE):
                cleaned_query = f"{cleaned_query} LIMIT 1000"

            df = db_manager.run_query(cleaned_query)
            return _format_dataframe_markdown(df)
        except Exception as e:  # pragma: no cover - defensive
            return f"Error executing query: {str(e)}"

    @tool
    def generate_chart_config(
        chart_title: str = Field(description="The title of the chart"),
        python_code: str = Field(description="The Python code to generate the chart config"),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute Python code to generate a chart.js config."""
        try:
            db_manager.require_query_before_chart()
        except ValueError as exc:
            return str(exc)

        df_context = db_manager.get_limited_result()
        if df_context is None:
            return "No query results available to visualize."

        before_snapshot = _snapshot_workspace(workspace_state.root_path)
        safe_globals: Dict[str, Any] = {
            "__builtins__": _build_safe_builtins(),
            "pd": SafePandasProxy(pd),
            "np": np,
            "json": json,
            "chart_config": None,
            "chart_title": chart_title,
            "df": df_context,
        }

        try:
            sanitized_code = sanitize_python_code(python_code)
        except ValueError as exc:
            return str(exc)

        exec_namespace: Dict[str, Any] = {}
        try:
            exec(sanitized_code, safe_globals, exec_namespace)
        except Exception as exc:
            logger.exception("Chart config execution failed: %s", exc)
            return f"Failed to execute chart code: {exc}"

        chart_config = (
            exec_namespace.get("chart_config")
            or safe_globals.get("chart_config")
        )
        if chart_config is None:
            return "No chart_config variable created."

        after_snapshot = _snapshot_workspace(workspace_state.root_path)
        artifacts = _detect_new_files(
            workspace_state.root_path, before_snapshot, after_snapshot
        )
        if callbacks and artifacts:
            try:
                callbacks.on_custom_event(
                    "tool_artifacts",
                    {"files": artifacts},
                    run_id=callbacks.run_id,
                )
            except Exception:  # pragma: no cover - best effort
                logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)

        payload = {
            "chart_title": chart_title,
            "chart_config": chart_config,
            "output_files": artifacts,
            "row_count": len(df_context),
        }
        return _json_dump(payload)

    @tool
    def generate_summary(
        summary: str = Field(description="The summary of the actions performed"),
        insights: str = Field(description="The insights from the data"),
    ) -> str:
        """Produce a summary of the results retrieved."""
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before summarizing the findings."
        try:
            db_manager.ensure_single_summary()
        except ValueError as exc:
            return str(exc)
        db_manager.mark_summary_generated()
        return f"Summary: {summary}\nInsights: {insights}"

    return [get_table_schema, run_sql_query, generate_chart_config, generate_summary]
