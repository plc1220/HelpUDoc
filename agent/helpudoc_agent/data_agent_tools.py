
import ast
import json
import base64
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
            "  </style>",
            "  <script src=\"https://cdn.plot.ly/plotly-2.35.2.min.js\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"container\">",
            "    <h1>Data Analysis Report</h1>",
            f"    <div class=\"meta\">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>",
            "    <div class=\"card\">",
            "      <h2>Summary</h2>",
            f"      <p>{summary}</p>",
            "      <h2>Key Insights</h2>",
            f"      <p>{insights}</p>",
            "    </div>",
        ]

        # Add SQL query information
        if db_manager.session.last_query_sql:
            sql = db_manager.session.last_query_sql
            report_lines.extend(
                [
                    "    <div class=\"card\">",
                    "      <h2>SQL Query</h2>",
                    "      <pre><code>",
                    sql,
                    "      </code></pre>",
                    "    </div>",
                ]
            )

        # Add query results info
        if db_manager.session.last_query_result is not None:
            df = db_manager.session.last_query_result
            report_lines.extend(
                [
                    "    <div class=\"card\">",
                    "      <h2>Query Results</h2>",
                    f"      <p><strong>Rows returned:</strong> {len(df)}<br /><strong>Columns:</strong> {', '.join(df.columns.tolist())}</p>",
                ]
            )
            if not df.empty:
                report_lines.append("      <h3>Sample Data</h3>")
                report_lines.append(df.head(10).to_html(index=False, border=0))
            report_lines.append("    </div>")

        # Visualizations
        charts_dir = workspace_state.root_path / "charts"
        if charts_dir.exists():
            png_files = sorted(charts_dir.glob("*.png"))
            plotly_html_files = sorted(charts_dir.glob("*.plotly.html"))
            plotly_json_files = sorted(charts_dir.glob("*.plotly.json"))
            if png_files or plotly_html_files or plotly_json_files:
                report_lines.append("    <div class=\"card\">")
                report_lines.append("      <h2>Visualizations</h2>")

                # Inline Plotly HTML
                for html_path in plotly_html_files:
                    try:
                        html_fragment = html_path.read_text(encoding="utf-8")
                        report_lines.append(f"      <div class=\"plotly-embed\">{html_fragment}</div>")
                    except Exception:  # pragma: no cover - best effort
                        logger.warning("Failed to embed Plotly HTML %s", html_path, exc_info=True)

                # Render Plotly JSON directly (only if no HTML counterpart)
                if not plotly_html_files:
                    for idx, json_path in enumerate(plotly_json_files, start=1):
                        try:
                            fig_json = json.loads(json_path.read_text(encoding="utf-8"))
                            script_payload = json.dumps(fig_json)
                            div_id = f"plotly-json-{idx}"
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

                # Embed PNGs as base64 after Plotly embeds
                for png_path in png_files:
                    try:
                        encoded = base64.b64encode(png_path.read_bytes()).decode("utf-8")
                        report_lines.append(
                            f"      <h3>{png_path.stem}</h3><img src=\"data:image/png;base64,{encoded}\" alt=\"{png_path.stem}\" />"
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

    return [get_table_schema, run_sql_query, generate_chart_config, generate_summary]
