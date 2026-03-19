import ast
import base64
import hashlib
import html
import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Set, Tuple

import duckdb
import numpy as np
import pandas as pd
import requests
import yaml
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool
from pydantic import Field

from .state import WorkspaceState

logger = logging.getLogger(__name__)

# Optional plotting libraries (used inside the chart tool)
try:  # pragma: no cover - environment dependent
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:  # pragma: no cover - optional dependency
    plt = None
    logger.warning("matplotlib not available; chart images may fail")

try:  # pragma: no cover - environment dependent
    import seaborn as sns
except Exception:  # pragma: no cover - optional dependency
    sns = None
    logger.warning("seaborn not available; chart images may fail")

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
    ".parquet": "application/octet-stream",
}
MAX_RESULT_ROWS = 20
MAX_SESSION_ROWS = 1000
# Documented guardrail limits enforced in code.
MAX_QUERY_COUNT = 10
MAX_CHART_COUNT = 5
DEFAULT_CACHE_TTL_HOURS = 24
MAX_MATERIALIZED_ROWS = 100000
BIGQUERY_MCP_SERVER = "toolbox-bq-demo"
_WRITE_SQL_PATTERN = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke)\b",
    re.IGNORECASE,
)


@dataclass
class _QueryRecord:
    """One SQL execution captured during a run."""
    sql: str
    row_count: int
    preview: "pd.DataFrame"  # head(MAX_RESULT_ROWS) snapshot


@dataclass
class _ChartRecord:
    """Metadata for one chart produced during a run."""
    title: str
    artifact_paths: List[str]  # workspace-relative paths

@dataclass
class _MaterializationRecord:
    """Metadata for a warehouse export materialized into the workspace."""

    cache_key: str
    sql: str
    parquet_path: str
    metadata_path: str
    row_count: int
    connector: str
    cached: bool
    expires_at: str


class DataAgentSessionState:
    """Holds per-run guardrails and full history for the data agent tools.

    A *run* begins when the session is reset (typically at the start of each
    agent invocation).  All history lists are cleared on reset so that
    reports and dashboards only reflect the current run.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.schema_inspected: bool = False
        self.query_count: int = 0
        self.chart_count: int = 0
        self.summary_generated: bool = False
        self.dashboard_generated: bool = False
        # Full history for the current run
        self.query_history: List[_QueryRecord] = []
        self.chart_history: List[_ChartRecord] = []
        self.materialization_history: List[_MaterializationRecord] = []
        self.run_artifacts: List[Dict[str, Any]] = []
        # Convenience references to the most recent entry
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
        "all": all,
        "any": any,
        "min": min,
        "max": max,
        "sum": sum,
        "len": len,
        "round": round,
        "range": range,
        "enumerate": enumerate,
        "zip": zip,
        "sorted": sorted,
        "bool": bool,
        "int": int,
        "float": float,
        "str": str,
        "list": list,
        "dict": dict,
        "tuple": tuple,
        "set": set,
        "isinstance": isinstance,
        "type": type,
        "__import__": __import__,
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


def _markdown_to_html(markdown_text: str) -> str:
    if not markdown_text:
        return ""

    text = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    text = html.escape(text)

    code_blocks: List[Tuple[str, str]] = []

    def _capture_code_block(match: re.Match) -> str:
        lang = match.group(1) or ""
        code = match.group(2) or ""
        idx = len(code_blocks)
        code_blocks.append((lang, code))
        return f"@@CODEBLOCK{idx}@@"

    text = re.sub(r"```([\w+-]*)\n([\s\S]*?)\n```", _capture_code_block, text)

    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)

    for level in range(6, 0, -1):
        pattern = rf"^{'#' * level}\s+(.*)$"
        text = re.sub(pattern, rf"<h{level}>\1</h{level}>", text, flags=re.M)

    text = re.sub(r"^---+$", "<hr />", text, flags=re.M)

    lines = text.split("\n")
    output: List[str] = []
    in_list = False
    for line in lines:
        match = re.match(r"^\s*[-*]\s+(.*)$", line)
        if match:
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{match.group(1)}</li>")
        else:
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(line)
    if in_list:
        output.append("</ul>")

    text = "\n".join(output)

    for idx, (lang, code) in enumerate(code_blocks):
        class_attr = f" class=\"language-{lang}\"" if lang else ""
        code_html = f"<pre><code{class_attr}>{code}</code></pre>"
        text = text.replace(f"@@CODEBLOCK{idx}@@", code_html)

    blocks = re.split(r"\n{2,}", text.strip())
    wrapped: List[str] = []
    block_start = re.compile(r"^(<h\d|<ul>|<ol>|<pre>|<hr\s*/?>)")
    for block in blocks:
        stripped = block.strip()
        if not stripped:
            continue
        if block_start.match(stripped):
            wrapped.append(stripped)
        else:
            wrapped.append(f"<p>{stripped}</p>")
    return "\n".join(wrapped)


def _chart_title_from_path(path: Path) -> str:
    title = path.stem
    if title.endswith(".plotly"):
        title = title[: -len(".plotly")]
    return title.replace("_", " ")


def _slugify_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-") or "item"


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


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_cache_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", (value or "").strip())
    return cleaned[:64].strip("_") or "warehouse_slice"


def _normalize_sql(sql_query: str) -> str:
    return re.sub(r"\s+", " ", (sql_query or "").strip()).strip().rstrip(";")


def _cache_key_for_query(
    *,
    sql_query: str,
    connector: str,
    workspace_id: str,
    cache_key_hint: str = "",
) -> str:
    normalized = _normalize_sql(sql_query)
    payload = "::".join(
        [
            connector.strip().lower(),
            workspace_id.strip(),
            cache_key_hint.strip().lower(),
            normalized,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _toolbox_defaults() -> Dict[str, str]:
    defaults = {"project": "", "location": "US"}
    toolbox_path = Path(__file__).resolve().parents[2] / "toolbox" / "tools.yaml"
    if not toolbox_path.exists():
        return defaults
    try:
        payload = yaml.safe_load(toolbox_path.read_text(encoding="utf-8")) or {}
    except Exception:  # pragma: no cover - best effort discovery
        return defaults
    source = ((payload.get("sources") or {}).get("bq") or {}) if isinstance(payload, dict) else {}
    project = source.get("project")
    location = source.get("location")
    if isinstance(project, str) and project.strip():
        defaults["project"] = project.strip()
    if isinstance(location, str) and location.strip():
        defaults["location"] = location.strip()
    return defaults


def _bigquery_runtime_defaults(workspace_state: WorkspaceState) -> Dict[str, str]:
    defaults = _toolbox_defaults()
    model_project = workspace_state.context.get("bigquery_project") or workspace_state.context.get("bq_project")
    model_location = workspace_state.context.get("bigquery_location") or workspace_state.context.get("bq_location")
    if isinstance(model_project, str) and model_project.strip():
        defaults["project"] = model_project.strip()
    if isinstance(model_location, str) and model_location.strip():
        defaults["location"] = model_location.strip()
    return defaults


def _extract_bigquery_bearer_token(workspace_state: WorkspaceState) -> str:
    runtime_auth = workspace_state.context.get("mcp_auth", {}) or {}
    if not isinstance(runtime_auth, dict):
        return ""
    candidate = runtime_auth.get(BIGQUERY_MCP_SERVER)
    if not isinstance(candidate, dict):
        return ""
    raw_header = candidate.get("Authorization") or candidate.get("authorization")
    if not isinstance(raw_header, str):
        return ""
    header = raw_header.strip()
    if not header.lower().startswith("bearer "):
        return ""
    return header.split(" ", 1)[1].strip()


def _forbid_write_sql(sql_query: str) -> None:
    if _WRITE_SQL_PATTERN.search(sql_query or ""):
        raise ValueError("Only read-only BigQuery SQL is supported for warehouse materialization.")


def _bigquery_value_from_cell(field_schema: Dict[str, Any], cell: Dict[str, Any]) -> Any:
    mode = str(field_schema.get("mode") or "NULLABLE").upper()
    field_type = str(field_schema.get("type") or "STRING").upper()
    value = cell.get("v") if isinstance(cell, dict) else None
    if value is None:
        return [] if mode == "REPEATED" else None
    if mode == "REPEATED":
        items = value if isinstance(value, list) else []
        return [_bigquery_value_from_cell({**field_schema, "mode": "NULLABLE"}, item) for item in items]
    if field_type == "RECORD":
        nested_fields = field_schema.get("fields") or []
        nested_cells = value.get("f") if isinstance(value, dict) else []
        nested: Dict[str, Any] = {}
        for nested_schema, nested_cell in zip(nested_fields, nested_cells):
            nested[str(nested_schema.get("name") or "")] = _bigquery_value_from_cell(nested_schema, nested_cell)
        return nested
    if field_type in {"INTEGER", "INT64"}:
        return int(value)
    if field_type in {"FLOAT", "FLOAT64"}:
        return float(value)
    if field_type in {"BOOLEAN", "BOOL"}:
        return str(value).lower() == "true"
    if field_type == "TIMESTAMP":
        return pd.to_datetime(float(value), unit="s", utc=True)
    if field_type == "DATE":
        return pd.to_datetime(value).date()
    if field_type == "DATETIME":
        return pd.to_datetime(value)
    if field_type == "TIME":
        return str(value)
    return value


def _rows_to_dataframe(schema: List[Dict[str, Any]], rows: List[Dict[str, Any]]) -> pd.DataFrame:
    columns = [str(field.get("name") or "") for field in schema]
    records: List[Dict[str, Any]] = []
    for row in rows:
        cells = row.get("f") if isinstance(row, dict) else []
        record: Dict[str, Any] = {}
        for field_schema, cell in zip(schema, cells):
            record[str(field_schema.get("name") or "")] = _bigquery_value_from_cell(field_schema, cell)
        records.append(record)
    return pd.DataFrame(records, columns=columns)


def _execute_bigquery_query(
    *,
    workspace_state: WorkspaceState,
    sql_query: str,
    project: str,
    location: str,
    max_rows: int,
) -> Tuple[pd.DataFrame, List[Dict[str, Any]]]:
    bearer_token = _extract_bigquery_bearer_token(workspace_state)
    if not bearer_token:
        raise ValueError(
            "Missing delegated BigQuery credentials. Sign in and ensure MCP auth for toolbox-bq-demo is available."
        )
    if not project:
        raise ValueError("Unable to resolve a BigQuery project for materialization.")

    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bearer {bearer_token}",
            "Content-Type": "application/json",
        }
    )

    response = session.post(
        f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries",
        json={
            "query": sql_query,
            "useLegacySql": False,
            "timeoutMs": 30000,
            "location": location,
            "maxResults": min(max_rows, 10000),
        },
        timeout=90,
    )
    response.raise_for_status()
    payload = response.json()

    job_complete = bool(payload.get("jobComplete"))
    job_ref = payload.get("jobReference") or {}
    job_id = str(job_ref.get("jobId") or "")
    all_rows = list(payload.get("rows") or [])
    schema = list(((payload.get("schema") or {}).get("fields")) or [])
    page_token = payload.get("pageToken")

    while not job_complete:
        if not job_id:
            raise ValueError("BigQuery query did not return a job id.")
        poll = session.get(
            f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries/{job_id}",
            params={"location": location, "maxResults": min(max_rows, 10000)},
            timeout=90,
        )
        poll.raise_for_status()
        payload = poll.json()
        job_complete = bool(payload.get("jobComplete"))
        if not schema:
            schema = list(((payload.get("schema") or {}).get("fields")) or [])
        all_rows.extend(list(payload.get("rows") or []))
        page_token = payload.get("pageToken")
        if len(all_rows) > max_rows:
            raise ValueError(
                f"Materialized result exceeded the v1 safety cap of {max_rows} rows. "
                "Add filters or aggregation before exporting."
            )

    while page_token:
        if not job_id:
            raise ValueError("BigQuery query did not return a job id.")
        page = session.get(
            f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/queries/{job_id}",
            params={
                "location": location,
                "pageToken": page_token,
                "maxResults": min(max_rows, 10000),
            },
            timeout=90,
        )
        page.raise_for_status()
        payload = page.json()
        if not schema:
            schema = list(((payload.get("schema") or {}).get("fields")) or [])
        all_rows.extend(list(payload.get("rows") or []))
        if len(all_rows) > max_rows:
            raise ValueError(
                f"Materialized result exceeded the v1 safety cap of {max_rows} rows. "
                "Add filters or aggregation before exporting."
            )
        page_token = payload.get("pageToken")

    return _rows_to_dataframe(schema, all_rows), schema

def _coerce_plotly_spec(payload: Any) -> Optional[Dict[str, Any]]:
    """Attempt to coerce a payload into a Plotly JSON-serializable dict."""
    if payload is None:
        return None

    try:  # pragma: no cover - optional dependency
        import plotly.io as pio  # type: ignore
    except Exception:  # pragma: no cover - optional dependency
        pio = None

    try:
        if hasattr(payload, "to_plotly_json"):
            if pio is not None:
                return json.loads(pio.to_json(payload, validate=False))
            return payload.to_plotly_json()
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, list):
                return payload
    except Exception:  # pragma: no cover - defensive
        logger.warning("Failed to coerce Plotly spec", exc_info=True)
    return None

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
        if self.session.query_count >= MAX_QUERY_COUNT:
            raise ValueError(
                f"Query budget exhausted: at most {MAX_QUERY_COUNT} queries are allowed per run. "
                "Consolidate your remaining questions into already-run results."
            )
        df = self.con.execute(query).df()
        self.session.query_count += 1
        self.session.last_query_result = df
        self.session.last_query_sql = query
        # Record in full history
        record = _QueryRecord(
            sql=query,
            row_count=len(df),
            preview=df.head(MAX_RESULT_ROWS).copy(),
        )
        self.session.query_history.append(record)
        return df

    def record_chart(self, title: str, artifact_paths: List[str]) -> None:
        """Record chart metadata into session history."""
        self.session.chart_count += 1
        self.session.chart_history.append(_ChartRecord(title=title, artifact_paths=artifact_paths))

    def record_materialization(self, record: _MaterializationRecord) -> None:
        """Record a warehouse materialization event for the current run."""
        self.session.materialization_history.append(record)

    def register_artifact(self, artifact: Dict[str, Any]) -> None:
        """Add an artifact to the run-scoped artifact list."""
        self.session.run_artifacts.append(artifact)

    def refresh_registered_files(self) -> None:
        """Refresh DuckDB table registration for newly materialized files."""
        self._register_files()

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
        r"eval\s*\(", r"exec\s*\(", r"open\s*\(", r"file\s*\(",
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
    allowed_imports = [
        "pandas",
        "pd",
        "numpy",
        "np",
        "json",
        "math",
        "statistics",
        "plotly",
        "plotly.express",
        "plotly.graph_objects",
        "plotly.io",
        "altair",
        "altair.vegalite.v5",
    ]

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
    def materialize_bigquery_to_parquet(
        sql_query: str = Field(description="Read-only BigQuery SQL query to materialize into workspace-local Parquet."),
        cache_key_hint: str = Field(
            default="",
            description="Optional stable label such as dataset purpose or date range to make cache files easier to recognize.",
        ),
        ttl_hours: int = Field(
            default=DEFAULT_CACHE_TTL_HOURS,
            description="Hours before the cached Parquet is considered stale and should be refreshed.",
        ),
        force_refresh: bool = Field(
            default=False,
            description="When true, ignore any cached Parquet and re-run the warehouse query.",
        ),
        max_rows: int = Field(
            default=MAX_MATERIALIZED_ROWS,
            description="Safety cap for exported rows. Keep results scoped for iterative analysis.",
        ),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """
        Execute a scoped BigQuery query and persist the result as workspace-local Parquet.

        The exported Parquet is immediately registered with DuckDB so downstream local
        analysis can continue in the same run without re-hitting BigQuery.
        """
        try:
            normalized_sql = _normalize_sql(sql_query)
            if not normalized_sql:
                return "Provide a non-empty SQL query to materialize."
            _forbid_write_sql(normalized_sql)
        except ValueError as exc:
            return str(exc)

        ttl_hours = max(1, int(ttl_hours or DEFAULT_CACHE_TTL_HOURS))
        max_rows = max(1, min(int(max_rows or MAX_MATERIALIZED_ROWS), MAX_MATERIALIZED_ROWS))

        defaults = _bigquery_runtime_defaults(workspace_state)
        connector = BIGQUERY_MCP_SERVER
        cache_key = _cache_key_for_query(
            sql_query=normalized_sql,
            connector=connector,
            workspace_id=workspace_state.workspace_id,
            cache_key_hint=cache_key_hint,
        )
        slug = _safe_cache_slug(cache_key_hint or f"bq_export_{cache_key}")
        cache_dir = workspace_state.root_path / "data_cache" / "bigquery"
        cache_dir.mkdir(parents=True, exist_ok=True)
        parquet_path = cache_dir / f"{slug}_{cache_key}.parquet"
        metadata_path = cache_dir / f"{slug}_{cache_key}.metadata.json"

        cached = False
        cached_metadata: Dict[str, Any] = {}
        now = _utc_now()
        if not force_refresh and parquet_path.exists() and metadata_path.exists():
            try:
                cached_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                expires_at_raw = str(cached_metadata.get("expiresAt") or "").strip()
                expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00")) if expires_at_raw else None
                if expires_at and expires_at > now:
                    cached = True
            except Exception:  # pragma: no cover - cache corruption falls back to refresh
                cached = False
                cached_metadata = {}

        schema_summary: List[Dict[str, Any]] = []
        row_count = 0
        if cached:
            try:
                row_count = int(cached_metadata.get("rowCount") or 0)
                schema_summary = list(cached_metadata.get("schema") or [])
            except Exception:
                row_count = 0
                schema_summary = []
        else:
            try:
                df, schema = _execute_bigquery_query(
                    workspace_state=workspace_state,
                    sql_query=normalized_sql,
                    project=defaults["project"],
                    location=defaults["location"],
                    max_rows=max_rows,
                )
            except requests.HTTPError as exc:
                body = exc.response.text if exc.response is not None else str(exc)
                return f"BigQuery materialization failed: {body}"
            except Exception as exc:  # pragma: no cover - defensive
                return f"BigQuery materialization failed: {exc}"

            row_count = len(df)
            schema_summary = [
                {
                    "name": str(field.get("name") or ""),
                    "type": str(field.get("type") or "STRING"),
                    "mode": str(field.get("mode") or "NULLABLE"),
                }
                for field in schema
            ]
            try:
                db_manager.con.register("_materialized_bigquery_export", df)
                safe_path = str(parquet_path).replace("'", "''")
                db_manager.con.execute(
                    f"COPY _materialized_bigquery_export TO '{safe_path}' (FORMAT PARQUET)"
                )
                db_manager.con.unregister("_materialized_bigquery_export")
            except Exception as exc:  # pragma: no cover - defensive
                return f"Failed to write Parquet export: {exc}"

            expires_at = now + timedelta(hours=ttl_hours)
            cached_metadata = {
                "cacheKey": cache_key,
                "cacheKeyHint": cache_key_hint or "",
                "connector": connector,
                "project": defaults["project"],
                "location": defaults["location"],
                "sourceSql": normalized_sql,
                "rowCount": row_count,
                "schema": schema_summary,
                "materializedAt": now.isoformat().replace("+00:00", "Z"),
                "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
                "ttlHours": ttl_hours,
                "parquetPath": parquet_path.relative_to(workspace_state.root_path).as_posix(),
                "tableName": parquet_path.stem,
            }
            metadata_path.write_text(_json_dump(cached_metadata), encoding="utf-8")

        db_manager.refresh_registered_files()

        artifacts = []
        for path in (parquet_path, metadata_path):
            ext = path.suffix.lower()
            mime = ALLOWED_ARTIFACT_EXTENSIONS.get(ext)
            if not mime or not path.exists():
                continue
            artifact = {
                "path": path.relative_to(workspace_state.root_path).as_posix(),
                "mimeType": mime,
                "size": path.stat().st_size,
            }
            db_manager.register_artifact(artifact)
            artifacts.append(artifact)

        record = _MaterializationRecord(
            cache_key=cache_key,
            sql=normalized_sql,
            parquet_path=parquet_path.relative_to(workspace_state.root_path).as_posix(),
            metadata_path=metadata_path.relative_to(workspace_state.root_path).as_posix(),
            row_count=row_count,
            connector=connector,
            cached=cached,
            expires_at=str(cached_metadata.get("expiresAt") or ""),
        )
        db_manager.record_materialization(record)

        if callbacks and artifacts:
            try:
                run_id = getattr(callbacks, "run_id", None)
                if run_id is not None:
                    callbacks.on_custom_event("tool_artifacts", {"files": artifacts}, run_id=run_id)
                else:
                    callbacks.on_custom_event("tool_artifacts", {"files": artifacts})
            except Exception:  # pragma: no cover - best effort
                logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)

        payload = {
            "cache_key": cache_key,
            "cached": cached,
            "connector": connector,
            "row_count": row_count,
            "schema": schema_summary,
            "parquet_path": parquet_path.relative_to(workspace_state.root_path).as_posix(),
            "metadata_path": metadata_path.relative_to(workspace_state.root_path).as_posix(),
            "duckdb_table_name": parquet_path.stem,
            "expires_at": cached_metadata.get("expiresAt"),
            "ttl_hours": ttl_hours,
        }
        return _json_dump(payload)

    @tool
    def generate_chart_config(
        chart_title: str = Field(description="The title of the chart"),
        python_code: str = Field(
            description=(
                "Python code to create visualizations. Two approaches:\n"
                "1. Matplotlib/Seaborn: Use plt.figure(), plt.plot(), sns.barplot(), etc. "
                "Figures are auto-saved as PNG.\n"
                "2. Plotly (preferred): Build a Plotly figure or a dict with data/layout/config assigned to 'chart_config'. "
                "Plotly specs are saved as .plotly.json for the viewer."
            )
        ),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """
        Generate visualizations from the last SQL query result.
        
        The Python sandbox has access to:
        - df: pandas DataFrame with the last query result
        - np: numpy for numerical operations
        - json: for creating Plotly configs
        
        Use Plotly for interactive specs:
           chart_config = {
               "data": [{"x": df['category'].tolist(), "y": df['value'].tolist(), "type": "bar"}],
               "layout": {"title": chart_title},
           }
           # Auto-saved as .plotly.json in charts/ directory
           
        Returns JSON with chart metadata and output file paths.
        """
        try:
            db_manager.require_query_before_chart()
        except ValueError as exc:
            return str(exc)
        try:
            db_manager.require_chart_budget()
        except ValueError as exc:
            return str(exc)

        df_context = db_manager.get_limited_result()
        if df_context is None:
            return "No query results available to visualize."

        charts_dir = workspace_state.root_path / "charts"
        safe_title = re.sub(r"[^a-zA-Z0-9_-]+", "_", chart_title.strip() or "chart")
        before_snapshot = _snapshot_workspace(workspace_state.root_path)
        safe_globals: Dict[str, Any] = {
            "__builtins__": _build_safe_builtins(),
            "pd": SafePandasProxy(pd),
            "np": np,
            "json": json,
            # Expose key builtins directly to avoid NameError in some exec contexts
            "isinstance": isinstance,
            "len": len,
            "range": range,
            "enumerate": enumerate,
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
        except KeyError as exc:
            missing_col = str(exc)
            available_cols = list(df_context.columns)
            return (
                f"Column {missing_col} not found in query result. "
                f"Available columns: {available_cols}"
            )
        except Exception as exc:
            logger.exception("Chart config execution failed: %s", exc)
            return f"Failed to execute chart code: {exc}"

        chart_config = (
            exec_namespace.get("chart_config")
            or safe_globals.get("chart_config")
        )
        plotly_payload = _coerce_plotly_spec(chart_config)
        if plotly_payload is None:
            plotly_payload = _coerce_plotly_spec(
                exec_namespace.get("plotly_fig") or exec_namespace.get("fig")
            )

        after_snapshot = _snapshot_workspace(workspace_state.root_path)
        artifacts = _detect_new_files(
            workspace_state.root_path, before_snapshot, after_snapshot
        )

        plotly_config_path: Optional[Path] = None
        plotly_html_path: Optional[Path] = None
        if plotly_payload is not None:
            try:
                charts_dir.mkdir(exist_ok=True)
                plotly_config_path = charts_dir / f"{safe_title}.plotly.json"
                plotly_config_path.write_text(_json_dump(plotly_payload), encoding="utf-8")
                artifacts.append(
                    {
                        "path": plotly_config_path.relative_to(
                            workspace_state.root_path
                        ).as_posix(),
                        "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".json"],
                        "size": plotly_config_path.stat().st_size,
                    }
                )
                try:  # pragma: no cover - optional dependency
                    import plotly.io as pio  # type: ignore

                    fig_for_html = plotly_payload
                    if isinstance(plotly_payload, dict):
                        try:
                            fig_for_html = pio.from_json(_json_dump(plotly_payload))
                        except Exception:
                            fig_for_html = plotly_payload
                    html_content = pio.to_html(
                        fig_for_html,
                        include_plotlyjs="inline",
                        full_html=False,
                    )
                    plotly_html_path = charts_dir / f"{safe_title}.plotly.html"
                    plotly_html_path.write_text(html_content, encoding="utf-8")
                    artifacts.append(
                        {
                            "path": plotly_html_path.relative_to(
                                workspace_state.root_path
                            ).as_posix(),
                            "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".html"],
                            "size": plotly_html_path.stat().st_size,
                        }
                    )
                except Exception:  # pragma: no cover - best effort
                    logger.warning("Failed to persist Plotly HTML", exc_info=True)
            except Exception:  # pragma: no cover - best effort persistence
                logger.warning("Failed to persist Plotly config", exc_info=True)

        if chart_config is None and plotly_payload is None and not artifacts:
            return "No chart_config variable created and no artifacts produced."

        # Record chart metadata into run history
        artifact_paths = [a["path"] for a in artifacts]
        db_manager.record_chart(chart_title, artifact_paths)
        for a in artifacts:
            db_manager.register_artifact(a)

        if callbacks and artifacts:
            try:
                run_id = getattr(callbacks, "run_id", None)
                if run_id is not None:
                    callbacks.on_custom_event(
                        "tool_artifacts",
                        {"files": artifacts},
                        run_id=run_id,
                    )
                else:
                    callbacks.on_custom_event(
                        "tool_artifacts",
                        {"files": artifacts},
                    )
            except Exception:  # pragma: no cover - best effort
                logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)

        payload = {
            "chart_title": chart_title,
            "chart_config": plotly_payload if plotly_payload is not None else chart_config,
            "plotly_config_path": (
                plotly_config_path.relative_to(workspace_state.root_path).as_posix()
                if plotly_config_path
                else None
            ),
            "plotly_html_path": (
                plotly_html_path.relative_to(workspace_state.root_path).as_posix()
                if plotly_html_path
                else None
            ),
            "output_files": artifacts,
            "row_count": len(df_context),
        }
        try:
            return _json_dump(payload)
        except TypeError:  # pragma: no cover - defensive
            payload["chart_config"] = str(chart_config)
            return _json_dump(payload)

    @tool
    def generate_summary(
        summary: str = Field(description="The summary of the actions performed"),
        insights: str = Field(description="The insights from the data"),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """
        Produce a summary of the results retrieved and save it as a self-contained HTML report.
        
        The report embeds:
        - Summary and insights
        - SQL queries executed
        - Sample data
        - Inline PNGs (base64) and Plotly charts (from .plotly.html or .plotly.json)
        """
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before summarizing the findings."
        try:
            db_manager.ensure_single_summary()
        except ValueError as exc:
            return str(exc)
        db_manager.mark_summary_generated()

        # Create HTML report
        from datetime import datetime

        report_lines = [
            "<!doctype html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"utf-8\" />",
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
            "  <title>Data Analysis Report</title>",
            "  <style>",
            "    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f7f7f8; color:#1f2933; margin:0; padding:0; }",
            "    .container { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }",
            "    h1 { margin: 0 0 8px; }",
            "    h2 { margin-top: 28px; margin-bottom: 12px; }",
            "    h3 { margin-top: 20px; margin-bottom: 10px; }",
            "    .card { background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:18px 20px; box-shadow:0 1px 2px rgba(0,0,0,0.04); margin-top:12px; }",
            "    .meta { color:#6b7280; font-size: 0.95rem; margin-bottom: 6px; }",
            "    table { border-collapse: collapse; width: 100%; }",
            "    table thead { background:#f3f4f6; }",
            "    table th, table td { border:1px solid #e5e7eb; padding:8px 10px; text-align:left; font-size: 0.95rem; }",
            "    ul { padding-left: 20px; }",
            "    pre { background:#0f172a; color:#e2e8f0; padding:12px; border-radius:12px; overflow-x:auto; }",
            "    img { max-width: 100%; height: auto; display: block; margin: 12px 0; border-radius:12px; border:1px solid #e5e7eb; }",
            "    .plotly-embed { margin: 16px 0; }",
            "    .list-inline code { background:#f3f4f6; padding:2px 6px; border-radius:6px; }",
            "    .agent-markdown { line-height: 1.7; font-size: 0.98rem; }",
            "    .agent-markdown p { margin: 0 0 1rem; }",
            "    .agent-markdown p:last-child { margin-bottom: 0; }",
            "    .agent-markdown ul, .agent-markdown ol { margin: 0.5rem 0 1rem; padding-left: 1.25rem; }",
            "    .agent-markdown li { margin-bottom: 0.35rem; }",
            "    .agent-markdown code { background:#f3f4f6; padding:2px 6px; border-radius:6px; }",
            "  </style>",
            "  <script src=\"https://cdn.plot.ly/plotly-3.3.0.min.js\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"container\">",
            "    <h1>Data Analysis Report</h1>",
            f"    <div class=\"meta\">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>",
            "    <div class=\"card\">",
            "      <h2>Summary</h2>",
            "      <div class=\"agent-markdown\">",
            _markdown_to_html(summary) or "<p>No summary provided.</p>",
            "      </div>",
            "      <h2>Key Insights</h2>",
            "      <div class=\"agent-markdown\">",
            _markdown_to_html(insights) or "<p>No insights provided.</p>",
            "      </div>",
            "    </div>",
        ]

        if db_manager.session.materialization_history:
            report_lines.extend([
                "    <div class=\"card\">",
                "      <h2>Warehouse Materializations</h2>",
            ])
            for item in db_manager.session.materialization_history:
                report_lines.extend(
                    [
                        f"      <p><strong>Connector:</strong> {html.escape(item.connector)}<br />"
                        f"<strong>Rows:</strong> {item.row_count}<br />"
                        f"<strong>Cached:</strong> {'yes' if item.cached else 'no'}<br />"
                        f"<strong>Parquet:</strong> <code>{html.escape(item.parquet_path)}</code><br />"
                        f"<strong>Metadata:</strong> <code>{html.escape(item.metadata_path)}</code><br />"
                        f"<strong>Expires:</strong> {html.escape(item.expires_at or 'n/a')}</p>",
                        f"      <pre><code>{html.escape(item.sql)}</code></pre>",
                    ]
                )
            report_lines.append("    </div>")

        # Add SQL query history (all queries in the current run)
        if db_manager.session.query_history:
            report_lines.extend([
                "    <div class=\"card\">",
                "      <h2>SQL Queries</h2>",
            ])
            for i, qr in enumerate(db_manager.session.query_history, start=1):
                report_lines.append(f"      <h3>Query {i} <span class=\"meta\">({qr.row_count} rows)</span></h3>")
                report_lines.append(f"      <pre><code>{html.escape(qr.sql)}</code></pre>")
                if not qr.preview.empty:
                    report_lines.append("      <h4>Sample Data</h4>")
                    report_lines.append(qr.preview.to_html(index=False, border=0))
            report_lines.append("    </div>")


        # Visualizations — only include charts produced in this run
        run_chart_paths: List[str] = []
        for cr in db_manager.session.chart_history:
            run_chart_paths.extend(cr.artifact_paths)

        charts_dir = workspace_state.root_path / "charts"
        if run_chart_paths and charts_dir.exists():
            plotly_json_files = sorted(
                p for p in (workspace_state.root_path / rel for rel in run_chart_paths
                             if rel.endswith(".plotly.json"))
                if p.exists()
            )
            plotly_html_files = sorted(
                p for p in (workspace_state.root_path / rel for rel in run_chart_paths
                             if rel.endswith(".plotly.html"))
                if p.exists() and not any(rel.endswith(".plotly.json") for rel in run_chart_paths
                                          if workspace_state.root_path / rel == p)
            )
            png_files = sorted(
                p for p in (workspace_state.root_path / rel for rel in run_chart_paths
                             if rel.endswith(".png"))
                if p.exists()
            )
            if plotly_json_files or plotly_html_files or png_files:
                report_lines.append("    <div class=\"card\">")
                report_lines.append("      <h2>Visualizations</h2>")

                if plotly_json_files:
                    for idx, json_path in enumerate(plotly_json_files, start=1):
                        try:
                            fig_json = json.loads(json_path.read_text(encoding="utf-8"))
                            script_payload = json.dumps(fig_json)
                            div_id = f"plotly-json-{idx}"
                            report_lines.append(f"      <h3>{_chart_title_from_path(json_path)}</h3>")
                            report_lines.append(f"      <div id=\"{div_id}\" class=\"plotly-embed\" style=\"height:420px;\"></div>")
                            report_lines.append(
                                "      <script>"
                                f"const spec{idx} = {script_payload};"
                                f"const data{idx} = spec{idx}.data || []; const layout{idx} = spec{idx}.layout || {{}}; const config{idx} = spec{idx}.config || {{}}; const frames{idx} = spec{idx}.frames || undefined;"
                                f"Plotly.newPlot('{div_id}', data{idx}, layout{idx}, config{idx}).then(() => {{ if (frames{idx} && frames{idx}.length) {{ Plotly.addFrames('{div_id}', frames{idx}); }} }});"
                                "</script>"
                            )
                        except Exception:  # pragma: no cover - best effort
                            logger.warning("Failed to embed Plotly JSON %s", json_path, exc_info=True)
                else:
                    for html_path in plotly_html_files:
                        try:
                            html_fragment = html_path.read_text(encoding="utf-8")
                            report_lines.append(f"      <h3>{_chart_title_from_path(html_path)}</h3>")
                            report_lines.append(f"      <div class=\"plotly-embed\">{html_fragment}</div>")
                        except Exception:  # pragma: no cover - best effort
                            logger.warning("Failed to embed Plotly HTML %s", html_path, exc_info=True)

                for png_path in png_files:
                    try:
                        encoded = base64.b64encode(png_path.read_bytes()).decode("utf-8")
                        report_lines.append(
                            f"      <h3>{_chart_title_from_path(png_path)}</h3><img src=\"data:image/png;base64,{encoded}\" alt=\"{png_path.stem}\" />"
                        )
                    except Exception:  # pragma: no cover - best effort
                        logger.warning("Failed to embed PNG %s", png_path, exc_info=True)

                report_lines.append("    </div>")


        report_lines.extend(
            [
                "  </div>",
                "</body>",
                "</html>",
            ]
        )

        # Save the report
        try:
            reports_dir = workspace_state.root_path / "reports"
            reports_dir.mkdir(exist_ok=True)

            # Create filename with timestamp
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            report_path = reports_dir / f"analysis_report_{timestamp}.html"

            report_content = "\n".join(report_lines)
            report_path.write_text(report_content, encoding="utf-8")

            # Notify about the artifact
            artifact = {
                "path": report_path.relative_to(workspace_state.root_path).as_posix(),
                "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".html"],
                "size": report_path.stat().st_size,
            }

            if callbacks:
                try:
                    run_id = getattr(callbacks, "run_id", None)
                    if run_id is not None:
                        callbacks.on_custom_event(
                            "tool_artifacts",
                            {"files": [artifact]},
                            run_id=run_id,
                        )
                    else:
                        callbacks.on_custom_event(
                            "tool_artifacts",
                            {"files": [artifact]},
                        )
                except Exception:  # pragma: no cover - best effort
                    logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)

            return (
                f"Summary: {summary}\n"
                f"Insights: {insights}\n\n"
                f"📄 Full report saved to: {report_path.relative_to(workspace_state.root_path).as_posix()}"
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("Failed to save HTML report: %s", e)
            return f"Summary: {summary}\nInsights: {insights}\n\n(Note: Failed to save report file: {e})"

    @tool
    def generate_dashboard(
        title: str = Field(description="The dashboard title shown in the HTML header"),
        description: str = Field(
            description="Short paragraph describing what this dashboard shows and who it's for"
        ),
        section_titles: List[str] = Field(
            description=(
                "Ordered list of section headings (one per chart produced in this run). "
                "Must match the number of charts; pass an empty list to use chart titles."
            ),
            default_factory=list,
        ),
        kpis: List[Dict[str, str]] = Field(
            description=(
                "Optional KPI cards for the hero area. Each item should include "
                "'label', 'value', and optional 'note'."
            ),
            default_factory=list,
        ),
        filters: List[Dict[str, Any]] = Field(
            description=(
                "Optional dashboard controls. Supported targets include "
                "'title_search', 'chart_type', 'chart_tag', and 'appendix_visibility'."
            ),
            default_factory=list,
        ),
        sections: List[Dict[str, Any]] = Field(
            description=(
                "Optional chart section groups. Each item may include 'title', "
                "'description', and 'chart_indexes' (1-based chart positions)."
            ),
            default_factory=list,
        ),
        chart_tags: List[List[str]] = Field(
            description=(
                "Optional chart tags aligned to chart order. Each inner list becomes tag chips "
                "and can be used by chart_tag filters."
            ),
            default_factory=list,
        ),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """
        Assemble all charts and queries from the current run into one self-contained
        interactive HTML dashboard artifact.

        Rules:
        - Only charts and queries from the current run are included
            (artifacts from prior runs are excluded).
        - Results in exactly one HTML file written to dashboards/<safe_title>.html.
        - Emits a tool_artifacts event so the frontend can surface the file.
        - Can only be called once per run; subsequent calls return an error.
        """
        try:
            db_manager.ensure_single_dashboard()
        except ValueError as exc:
            return str(exc)
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before building a dashboard."
        if not db_manager.session.chart_history:
            return "Generate at least one chart before building a dashboard."
        db_manager.mark_dashboard_generated()

        from datetime import datetime

        safe_title = re.sub(r"[^a-zA-Z0-9_-]+", "_", title.strip() or "dashboard")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Gather run-scoped chart artifacts
        run_chart_paths: List[str] = []
        for cr in db_manager.session.chart_history:
            run_chart_paths.extend(cr.artifact_paths)

        # Resolve which Plotly JSON / PNG files we have for this run
        ws = workspace_state.root_path
        plotly_json_files = [
            ws / rel for rel in run_chart_paths
            if rel.endswith(".plotly.json") and (ws / rel).exists()
        ]
        png_files = [
            ws / rel for rel in run_chart_paths
            if rel.endswith(".png") and (ws / rel).exists()
        ]

        CSS = """
    :root{
      --bg:#f4f1ea;
      --panel:#fffdf8;
      --panel-strong:#ffffff;
      --ink:#1f2937;
      --muted:#6b7280;
      --line:#e7dfd2;
      --accent:#1f4d3a;
      --accent-soft:#dcece5;
      --accent-warm:#9a3412;
      --shadow:0 16px 40px rgba(68,50,28,0.08);
      --radius-xl:28px;
      --radius-lg:20px;
      --radius-md:14px;
    }
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:
        radial-gradient(circle at top left, rgba(31,77,58,0.09), transparent 28%),
        radial-gradient(circle at top right, rgba(154,52,18,0.08), transparent 24%),
        linear-gradient(180deg,#f7f4ee 0%,#f4f1ea 100%);
      color:var(--ink);
      margin:0;
      padding:0;
    }
    a{color:inherit}
    .shell{max-width:1320px;margin:0 auto;padding:28px 22px 56px}
    .hero{
      background:linear-gradient(135deg,rgba(255,253,248,0.96),rgba(247,242,234,0.96));
      border:1px solid rgba(231,223,210,0.95);
      box-shadow:var(--shadow);
      border-radius:var(--radius-xl);
      padding:34px 36px 28px;
      position:relative;
      overflow:hidden;
    }
    .hero:before{
      content:"";
      position:absolute;
      inset:auto -120px -140px auto;
      width:320px;
      height:320px;
      background:radial-gradient(circle, rgba(31,77,58,0.10), transparent 68%);
      pointer-events:none;
    }
    .eyebrow{
      display:inline-flex;
      align-items:center;
      gap:8px;
      background:var(--accent-soft);
      color:var(--accent);
      border-radius:999px;
      padding:8px 12px;
      font-size:12px;
      font-weight:700;
      letter-spacing:0.08em;
      text-transform:uppercase;
    }
    .hero h1{
      margin:14px 0 10px;
      font-size:clamp(2rem,4vw,3.2rem);
      line-height:1.02;
      letter-spacing:-0.04em;
      max-width:10ch;
    }
    .hero p{
      margin:0;
      max-width:760px;
      color:#4b5563;
      font-size:1rem;
      line-height:1.65;
    }
    .hero-meta{
      margin-top:18px;
      color:var(--muted);
      font-size:0.88rem;
    }
    .kpi-row{
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
      gap:16px;
      margin:22px 0 0;
    }
    .kpi{
      background:rgba(255,255,255,0.82);
      border:1px solid rgba(231,223,210,0.95);
      border-radius:18px;
      padding:18px 18px 16px;
      min-height:104px;
    }
    .kpi-label{
      color:var(--muted);
      text-transform:uppercase;
      letter-spacing:0.08em;
      font-size:0.72rem;
      font-weight:700;
    }
    .kpi-value{
      margin-top:8px;
      font-size:2rem;
      line-height:1;
      letter-spacing:-0.04em;
      color:var(--ink);
      font-weight:800;
    }
    .kpi-note{
      margin-top:10px;
      color:#4b5563;
      font-size:0.86rem;
    }
    .controls{
      margin-top:22px;
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
      gap:12px;
      align-items:end;
    }
    .control{
      display:flex;
      flex-direction:column;
      gap:6px;
    }
    .control label{
      color:var(--muted);
      font-size:0.78rem;
      font-weight:700;
      letter-spacing:0.06em;
      text-transform:uppercase;
    }
    .control input,.control select{
      width:100%;
      border:1px solid var(--line);
      background:#fff;
      color:var(--ink);
      border-radius:12px;
      padding:12px 14px;
      font:inherit;
      outline:none;
    }
    .control input:focus,.control select:focus{
      border-color:#b7cbbf;
      box-shadow:0 0 0 4px rgba(31,77,58,0.10);
    }
    .control-actions{
      display:flex;
      gap:10px;
      align-items:center;
      flex-wrap:wrap;
    }
    .button{
      border:none;
      border-radius:999px;
      padding:12px 16px;
      background:var(--accent);
      color:#fff;
      font:inherit;
      font-weight:700;
      cursor:pointer;
    }
    .button.secondary{
      background:#efe7da;
      color:var(--ink);
    }
    .filter-status{
      color:var(--muted);
      font-size:0.88rem;
    }
    .section{
      margin-top:22px;
      background:rgba(255,253,248,0.92);
      border:1px solid rgba(231,223,210,0.95);
      box-shadow:var(--shadow);
      border-radius:var(--radius-xl);
      padding:26px 28px 30px;
    }
    .section-header{
      display:flex;
      justify-content:space-between;
      align-items:end;
      gap:16px;
      margin-bottom:18px;
    }
    .section h2{
      margin:0;
      font-size:1.35rem;
      letter-spacing:-0.03em;
    }
    .section-intro{
      margin:6px 0 0;
      color:var(--muted);
      font-size:0.95rem;
    }
    .chart-grid{
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(320px,1fr));
      gap:18px;
    }
    .chart-card{
      background:linear-gradient(180deg,#fffefb 0%,#fbf8f2 100%);
      border:1px solid var(--line);
      border-radius:var(--radius-lg);
      padding:18px 18px 10px;
      min-height:408px;
    }
    .chart-card.is-hidden{display:none}
    .chart-card h3{
      margin:0 0 6px;
      font-size:1rem;
      line-height:1.35;
      letter-spacing:-0.02em;
    }
    .chart-meta{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-bottom:10px;
    }
    .tag{
      display:inline-flex;
      align-items:center;
      border-radius:999px;
      padding:5px 9px;
      background:#f2ece1;
      color:#6b5b45;
      font-size:0.74rem;
      font-weight:700;
      letter-spacing:0.03em;
      text-transform:uppercase;
    }
    .chart-subtitle{
      color:var(--muted);
      font-size:0.88rem;
      margin-bottom:12px;
    }
    .plotly-embed{width:100%;height:330px}
    img.chart-img{
      width:100%;
      border-radius:12px;
      margin-top:8px;
      border:1px solid var(--line);
      background:#fff;
    }
    details.appendix{
      border-top:1px solid var(--line);
      padding-top:18px;
    }
    details.appendix summary{
      cursor:pointer;
      list-style:none;
      font-weight:700;
      font-size:1rem;
    }
    details.appendix summary::-webkit-details-marker{display:none}
    .query-list{margin-top:16px;display:grid;gap:14px}
    .query-item{
      background:#faf7f1;
      border:1px solid var(--line);
      border-radius:16px;
      padding:16px;
    }
    .query-meta{
      font-size:0.82rem;
      color:var(--accent-warm);
      font-weight:700;
      letter-spacing:0.03em;
      text-transform:uppercase;
      margin-bottom:8px;
    }
    .query-block{
      margin:0;
      background:#fff;
      border:1px solid var(--line);
      border-radius:12px;
      padding:14px 16px;
      overflow-x:auto;
      white-space:pre-wrap;
      color:#374151;
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;
      font-size:0.84rem;
      line-height:1.55;
    }
    .footer{
      text-align:center;
      color:var(--muted);
      font-size:0.82rem;
      padding:22px 8px 0;
    }
    @media (max-width: 768px){
      .shell{padding:16px 14px 42px}
      .hero,.section{padding:22px 18px}
      .section-header{display:block}
      .chart-grid{grid-template-columns:1fr}
      .plotly-embed{height:300px}
    }
    @media print{
      body{background:#fff}
      .shell{max-width:none;padding:0}
      .hero,.section{box-shadow:none;background:#fff}
    }
    """

        chart_count = len(plotly_json_files) + len(png_files)
        query_count = len(db_manager.session.query_history)

        hero_kpis = kpis or [
            {
                "label": "Charts",
                "value": str(chart_count),
                "note": "Curated visuals embedded in this report",
            },
            {
                "label": "Queries",
                "value": str(query_count),
                "note": "Source queries included in the appendix",
            },
            {
                "label": "Format",
                "value": "HTML",
                "note": "Portable, browser-openable artifact",
            },
        ]

        filter_specs = filters or [
            {
                "id": "chart-search",
                "label": "Search Charts",
                "type": "search",
                "target": "title_search",
                "placeholder": "Search chart titles or subtitles",
                "default": "",
            },
            {
                "id": "chart-type-filter",
                "label": "Chart Type",
                "type": "select",
                "target": "chart_type",
                "default": "all",
                "options": [
                    {"label": "All chart types", "value": "all"},
                    {"label": "Interactive", "value": "interactive"},
                    {"label": "Static", "value": "static"},
                ],
            },
            {
                "id": "appendix-toggle",
                "label": "Appendix",
                "type": "select",
                "target": "appendix_visibility",
                "default": "show",
                "options": [
                    {"label": "Show appendix", "value": "show"},
                    {"label": "Hide appendix", "value": "hide"},
                ],
            },
        ]
        normalized_filter_specs: List[Dict[str, Any]] = []
        for idx, spec in enumerate(filter_specs, start=1):
            normalized = dict(spec)
            normalized["id"] = str(normalized.get("id") or f"dashboard-filter-{idx}")
            normalized["label"] = str(normalized.get("label") or "Filter")
            normalized["type"] = str(normalized.get("type") or "select").lower()
            normalized["target"] = str(normalized.get("target") or normalized["id"])
            normalized["default"] = str(normalized.get("default") or "")
            normalized_filter_specs.append(normalized)
        filter_specs = normalized_filter_specs

        lines: List[str] = [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '  <meta charset="utf-8" />',
            '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
            f"  <title>{html.escape(title)}</title>",
            f"  <style>{CSS}</style>",
            '  <script src="https://cdn.plot.ly/plotly-3.3.0.min.js"></script>',
            "</head>",
            "<body>",
            '  <div class="shell">',
            '    <section class="hero">',
            '      <div class="eyebrow">Interactive dashboard</div>',
            f'      <h1>{html.escape(title)}</h1>',
            f'      <p>{html.escape(description)}</p>',
            f'      <div class="hero-meta">Generated {timestamp}</div>',
            '      <div class="kpi-row">',
        ]

        for item in hero_kpis:
            label = html.escape(str(item.get("label", "")).strip() or "Metric")
            value = html.escape(str(item.get("value", "")).strip() or "-")
            note = html.escape(str(item.get("note", "")).strip() or "")
            lines.append(
                f'        <div class="kpi"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div><div class="kpi-note">{note}</div></div>'
            )

        lines.extend([
            '      </div>',
            '      <div class="controls" aria-label="Dashboard filters">',
        ])

        control_html: List[str] = []
        for idx, spec in enumerate(filter_specs, start=1):
            control_id = html.escape(str(spec.get("id") or f"dashboard-filter-{idx}"))
            label = html.escape(str(spec.get("label") or "Filter"))
            control_type = str(spec.get("type") or "select").lower()
            default_value = str(spec.get("default") or "")
            if control_type == "search":
                placeholder = html.escape(str(spec.get("placeholder") or "Search"))
                control_html.append(
                    f'        <div class="control"><label for="{control_id}">{label}</label>'
                    f'<input id="{control_id}" data-filter-target="{html.escape(str(spec.get("target") or ""))}" '
                    f'type="search" placeholder="{placeholder}" value="{html.escape(default_value)}" /></div>'
                )
            else:
                options = spec.get("options") or []
                option_html: List[str] = []
                for option in options:
                    if isinstance(option, dict):
                        option_label = html.escape(str(option.get("label", option.get("value", ""))))
                        option_value = html.escape(str(option.get("value", "")))
                    else:
                        option_label = html.escape(str(option))
                        option_value = option_label
                    selected = ' selected="selected"' if str(option_value) == default_value else ""
                    option_html.append(f'<option value="{option_value}"{selected}>{option_label}</option>')
                control_html.append(
                    f'        <div class="control"><label for="{control_id}">{label}</label>'
                    f'<select id="{control_id}" data-filter-target="{html.escape(str(spec.get("target") or ""))}">'
                    f'{"".join(option_html)}</select></div>'
                )

        lines.extend(control_html)
        lines.extend([
            '        <div class="control">',
            '          <label>Actions</label>',
            '          <div class="control-actions">',
            '            <button type="button" class="button secondary" id="reset-filters">Reset filters</button>',
            '            <span class="filter-status" id="filter-status"></span>',
            '          </div>',
            '        </div>',
            '      </div>',
            '    </section>',
        ])

        # --- Charts section ---
        chart_entries: List[Dict[str, Any]] = []
        for idx, json_path in enumerate(plotly_json_files, start=1):
            section_title = (
                section_titles[idx - 1]
                if section_titles and idx - 1 < len(section_titles)
                else _chart_title_from_path(json_path)
            )
            try:
                fig_json = json.loads(json_path.read_text(encoding="utf-8"))
                script_payload = json.dumps(fig_json)
                div_id = f"db-chart-{idx}"
                tags = [str(tag).strip() for tag in (chart_tags[idx - 1] if idx - 1 < len(chart_tags) else []) if str(tag).strip()]
                tag_html = ''.join(f'<span class="tag">{html.escape(tag)}</span>' for tag in (["Interactive", "Plotly"] + tags))
                card = (
                    f'<div class="chart-card" data-chart-type="interactive" data-title="{html.escape(section_title.lower())}" '
                    f'data-subtitle="interactive chart with hover detail and responsive resizing" '
                    f'data-tags="{html.escape("|".join(tag.lower() for tag in tags))}">'
                    f'<h3>{html.escape(section_title)}</h3>'
                    f'<div class="chart-meta">{tag_html}</div>'
                    f'<div class="chart-subtitle">Interactive chart with hover detail and responsive resizing.</div>'
                    f'<div id="{div_id}" class="plotly-embed"></div>'
                    f"<script>"
                    f"const dbSpec{idx}={script_payload};"
                    f"const dbData{idx}=dbSpec{idx}.data||[];"
                    f"const dbLayout{idx}=Object.assign({{"
                    f"paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'#fffefb',"
                    f"font:{{family:'Inter, ui-sans-serif, system-ui, sans-serif',color:'#374151',size:12}},"
                    f"margin:{{t:56,r:24,b:56,l:56}},"
                    f"colorway:['#1f4d3a','#b45309','#2563eb','#b91c1c','#7c3aed','#0f766e'],"
                    f"xaxis:{{gridcolor:'#ebe4d8',linecolor:'#d7d0c4',tickcolor:'#d7d0c4',zeroline:false,title:{{standoff:10}}}},"
                    f"yaxis:{{gridcolor:'#ebe4d8',linecolor:'#d7d0c4',tickcolor:'#d7d0c4',zeroline:false,title:{{standoff:10}}}},"
                    f"legend:{{orientation:'h',yanchor:'bottom',y:1.02,xanchor:'left',x:0}},"
                    f"hoverlabel:{{bgcolor:'#1f2937',bordercolor:'#1f2937',font:{{color:'#fff'}}}}"
                    f"}},dbSpec{idx}.layout||{{}});"
                    f"const dbCfg{idx}=Object.assign({{responsive:true,displayModeBar:false}},dbSpec{idx}.config||{{}});"
                    f"Plotly.newPlot('{div_id}',dbData{idx},dbLayout{idx},dbCfg{idx});"
                    f"</script>"
                    "</div>"
                )
                chart_entries.append({"index": idx, "card": card})
            except Exception:  # pragma: no cover - best effort
                logger.warning("Dashboard: failed to embed plotly JSON %s", json_path, exc_info=True)

        for idx, png_path in enumerate(png_files, start=len(plotly_json_files) + 1):
            section_title = (
                section_titles[idx - 1]
                if section_titles and idx - 1 < len(section_titles)
                else _chart_title_from_path(png_path)
            )
            try:
                encoded = base64.b64encode(png_path.read_bytes()).decode("utf-8")
                tags = [str(tag).strip() for tag in (chart_tags[idx - 1] if idx - 1 < len(chart_tags) else []) if str(tag).strip()]
                tag_html = ''.join(f'<span class="tag">{html.escape(tag)}</span>' for tag in (["Static", "Image"] + tags))
                card = (
                    f'<div class="chart-card" data-chart-type="static" data-title="{html.escape(section_title.lower())}" '
                    f'data-subtitle="static image artifact embedded directly in the dashboard" '
                    f'data-tags="{html.escape("|".join(tag.lower() for tag in tags))}">'
                    f'<h3>{html.escape(section_title)}</h3>'
                    f'<div class="chart-meta">{tag_html}</div>'
                    f'<div class="chart-subtitle">Static image artifact embedded directly in the dashboard.</div>'
                    f'<img class="chart-img" src="data:image/png;base64,{encoded}" alt="{html.escape(png_path.stem)}" />'
                    "</div>"
                )
                chart_entries.append({"index": idx, "card": card})
            except Exception:  # pragma: no cover - best effort
                logger.warning("Dashboard: failed to embed PNG %s", png_path, exc_info=True)

        if chart_entries:
            entry_by_index = {entry["index"]: entry["card"] for entry in chart_entries}
            rendered_indexes: Set[int] = set()
            section_specs = sections or [{
                "title": "Analysis Views",
                "description": "A curated set of visuals from this analysis run, arranged for fast review.",
                "chart_indexes": [entry["index"] for entry in chart_entries],
            }]

            for sec_idx, spec in enumerate(section_specs, start=1):
                raw_indexes = spec.get("chart_indexes") or []
                chart_indexes = [
                    int(idx) for idx in raw_indexes
                    if isinstance(idx, (int, str)) and str(idx).isdigit() and int(idx) in entry_by_index
                ]
                if not chart_indexes:
                    continue
                rendered_indexes.update(chart_indexes)
                section_id = html.escape(str(spec.get("id") or f"section-{sec_idx}"))
                section_title = html.escape(str(spec.get("title") or f"Section {sec_idx}"))
                section_desc = html.escape(str(spec.get("description") or ""))
                lines.append(f'  <section class="section" data-section-id="{section_id}">')
                lines.append('    <div class="section-header">')
                lines.append('      <div>')
                lines.append(f'        <h2>{section_title}</h2>')
                if section_desc:
                    lines.append(f'        <p class="section-intro">{section_desc}</p>')
                lines.append('      </div>')
                lines.append('    </div>')
                lines.append('    <div class="chart-grid">')
                lines.extend(f'      {entry_by_index[idx]}' for idx in chart_indexes)
                lines.append("    </div>")
                lines.append("  </section>")

            remaining = [entry["index"] for entry in chart_entries if entry["index"] not in rendered_indexes]
            if remaining:
                lines.append('  <section class="section" data-section-id="remaining-charts">')
                lines.append('    <div class="section-header"><div><h2>Additional Views</h2><p class="section-intro">Charts not assigned to a custom section.</p></div></div>')
                lines.append('    <div class="chart-grid">')
                lines.extend(f'      {entry_by_index[idx]}' for idx in remaining)
                lines.append("    </div>")
                lines.append("  </section>")

        # --- Queries appendix ---
        if db_manager.session.query_history:
            lines.append('  <section class="section">')
            lines.append('    <details class="appendix">')
            lines.append('      <summary>Technical Appendix: Source Queries</summary>')
            lines.append('      <p class="section-intro">SQL used to produce the analysis is included here for auditability and handoff.</p>')
            lines.append('      <div class="query-list">')
            for i, qr in enumerate(db_manager.session.query_history, start=1):
                lines.append('        <div class="query-item">')
                lines.append(f'          <div class="query-meta">Query {i} | {qr.row_count} rows returned</div>')
                lines.append(f'          <pre class="query-block">{html.escape(qr.sql)}</pre>')
                lines.append('        </div>')
            lines.append('      </div>')
            lines.append('    </details>')
            lines.append('  </section>')

        lines.extend([
            f'  <div class="footer">Generated by HelpUDoc data agent | {timestamp}</div>',
            "  </div>",  # /shell
            "  <script>",
            "    (function(){",
            f"      const filterSpecs={json.dumps(filter_specs, default=_json_default)};",
            "      const filterElements=filterSpecs.map((spec)=>({ spec, el: document.getElementById(spec.id) })).filter((item)=>item.el);",
            "      const resetEl=document.getElementById('reset-filters');",
            "      const statusEl=document.getElementById('filter-status');",
            "      const cards=Array.from(document.querySelectorAll('.chart-card'));",
            "      const appendix=document.querySelector('details.appendix');",
            "      function applyFilters(){",
            "        const state={};",
            "        filterElements.forEach(({spec,el})=>{ state[spec.target||spec.id]=(el.value||'').trim().toLowerCase(); });",
            "        let visible=0;",
            "        cards.forEach((card)=>{",
            "          const title=(card.dataset.title||'').toLowerCase();",
            "          const subtitle=(card.dataset.subtitle||'').toLowerCase();",
            "          const chartType=(card.dataset.chartType||'').toLowerCase();",
            "          const tags=(card.dataset.tags||'').toLowerCase().split('|').filter(Boolean);",
            "          const search=state.title_search||'';",
            "          const chartTag=state.chart_tag||'all';",
            "          const type=state.chart_type||'all';",
            "          const matchesSearch=!search || title.includes(search) || subtitle.includes(search) || tags.some((tag)=>tag.includes(search));",
            "          const matchesType=(type==='all') || chartType===type;",
            "          const matchesTag=(chartTag==='all') || tags.includes(chartTag);",
            "          const show=matchesSearch && matchesType && matchesTag;",
            "          card.classList.toggle('is-hidden',!show);",
            "          if(show){visible+=1;}",
            "        });",
            "        if(statusEl){statusEl.textContent=`Showing ${visible} of ${cards.length} charts`;}",
            "        if(appendix){",
            "          const appendixSetting=state.appendix_visibility || 'show';",
            "          appendix.open=appendixSetting==='show';",
            "          appendix.closest('.section').style.display=appendixSetting==='hide' ? 'none' : '';",
            "        }",
            "      }",
            "      filterElements.forEach(({el})=>{ el.addEventListener('input',applyFilters); el.addEventListener('change',applyFilters); });",
            "      if(resetEl){ resetEl.addEventListener('click',()=>{ filterElements.forEach(({spec,el})=>{ el.value=spec.default ?? ''; }); applyFilters(); }); }",
            "      applyFilters();",
            "    })();",
            "  </script>",
            "</body>",
            "</html>",
        ])

        dashboard_content = "\n".join(lines)

        try:
            dashboards_dir = ws / "dashboards"
            dashboards_dir.mkdir(exist_ok=True)
            dashboard_path = dashboards_dir / f"{safe_title}.html"
            dashboard_path.write_text(dashboard_content, encoding="utf-8")

            artifact = {
                "path": dashboard_path.relative_to(ws).as_posix(),
                "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".html"],
                "size": dashboard_path.stat().st_size,
            }
            db_manager.register_artifact(artifact)

            if callbacks:
                try:
                    run_id = getattr(callbacks, "run_id", None)
                    if run_id is not None:
                        callbacks.on_custom_event(
                            "tool_artifacts", {"files": [artifact]}, run_id=run_id
                        )
                    else:
                        callbacks.on_custom_event("tool_artifacts", {"files": [artifact]})
                except Exception:  # pragma: no cover - best effort
                    logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)

            rel_path = dashboard_path.relative_to(ws).as_posix()
            return (
                f"✅ Dashboard saved to: {rel_path}\n"
                f"Charts embedded: {len(chart_entries)} | Queries embedded: {len(db_manager.session.query_history)}"
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("Failed to save dashboard: %s", e)
            return f"(Note: Failed to save dashboard file: {e})"

    return [
        get_table_schema,
        run_sql_query,
        materialize_bigquery_to_parquet,
        generate_chart_config,
        generate_summary,
        generate_dashboard,
    ]
