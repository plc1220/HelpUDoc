"""Chart generation tool (matplotlib / seaborn / Plotly in a sandboxed subprocess)."""
from __future__ import annotations

import ast
import json
import logging
import multiprocessing as mp
import re
from pathlib import Path
from queue import Empty
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import tool
from pydantic import Field

from .constants import ALLOWED_ARTIFACT_EXTENSIONS
from .duckdb_manager import DuckDBManager
from .guards import (
    _dashboard_plan_gate_message,
    _is_plan_approved,
    _is_strict_dashboard_mode,
)
from .query_tools import _emit_artifacts
from .utilities import (
    _chart_title_from_path,
    _json_dump,
    _safe_slug,
)
from .workspace_files import (
    _cleanup_new_files,
    _detect_new_files,
    _snapshot_workspace,
    _workspace_rel,
)

from ...state import WorkspaceState

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

def _json_safe_chart_value(value: Any) -> Any:
    if value is None:
        return None
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def _chart_payload(
    chart_title: str,
    *,
    status: str,
    message: str,
    row_count: int,
    chart_config: Any = None,
    plotly_config_path: Optional[str] = None,
    output_files: Optional[List[Dict[str, Any]]] = None,
    error_type: Optional[str] = None,
    available_columns: Optional[List[str]] = None,
) -> str:
    payload: Dict[str, Any] = {
        "status": status,
        "message": message,
        "chart_title": chart_title,
        "chart_config": _json_safe_chart_value(chart_config),
        "plotly_config_path": plotly_config_path,
        "plotly_html_path": None,
        "output_files": output_files or [],
        "row_count": row_count,
    }
    if error_type:
        payload["error_type"] = error_type
    if available_columns is not None:
        payload["available_columns"] = available_columns
    return _json_dump(payload)


def _execute_chart_code_worker(
    result_queue: "mp.Queue[Dict[str, Any]]",
    sanitized_code: str,
    chart_title: str,
    df_context: pd.DataFrame,
) -> None:
    safe_globals: Dict[str, Any] = {
        "__builtins__": _build_safe_builtins(),
        "pd": SafePandasProxy(pd),
        "np": np,
        "json": json,
        "isinstance": isinstance,
        "len": len,
        "range": range,
        "enumerate": enumerate,
        "chart_config": None,
        "chart_title": chart_title,
        "df": df_context,
    }
    if plt is not None:
        safe_globals["plt"] = plt
    if sns is not None:
        safe_globals["sns"] = sns

    exec_namespace: Dict[str, Any] = {}
    try:
        exec(sanitized_code, safe_globals, exec_namespace)
    except KeyError as exc:
        result_queue.put(
            {
                "status": "error",
                "error_type": "missing_column",
                "message": f"Column {str(exc)} not found in query result.",
                "available_columns": list(df_context.columns),
            }
        )
        return
    except Exception as exc:
        result_queue.put(
            {
                "status": "error",
                "error_type": "execution_error",
                "message": f"Failed to execute chart code: {exc}",
            }
        )
        return

    chart_config = exec_namespace.get("chart_config") or safe_globals.get("chart_config")
    plotly_payload = _coerce_plotly_spec(chart_config)
    if plotly_payload is None:
        plotly_payload = _coerce_plotly_spec(
            exec_namespace.get("plotly_fig") or exec_namespace.get("fig")
        )

    result_queue.put(
        {
            "status": "success",
            "chart_config": _json_safe_chart_value(chart_config),
            "plotly_payload": plotly_payload,
        }
    )


def _run_chart_code_in_subprocess(
    sanitized_code: str,
    chart_title: str,
    df_context: pd.DataFrame,
    *,
    timeout_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    from ._shim_targets import get_data_agent_tools_module

    mod = get_data_agent_tools_module()
    if timeout_seconds is not None:
        effective_timeout = timeout_seconds
    else:
        effective_timeout = mod.CHART_EXECUTION_TIMEOUT_SECONDS
    ctx = mp.get_context("spawn")
    result_queue: "mp.Queue[Dict[str, Any]]" = ctx.Queue()
    try:
        process = ctx.Process(
            target=_execute_chart_code_worker,
            args=(result_queue, sanitized_code, chart_title, df_context),
        )
        process.start()
        process.join(effective_timeout)

        if process.is_alive():
            process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join(1)
            return {
                "status": "error",
                "error_type": "timeout",
                "message": f"Chart execution timed out after {effective_timeout:g} seconds.",
            }

        try:
            result = result_queue.get_nowait()
        except Empty:
            result = None
        if result is None:
            return {
                "status": "error",
                "error_type": "execution_error",
                "message": "Chart subprocess exited without returning a result.",
            }
        return result
    finally:
        result_queue.close()
        result_queue.join_thread()
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

def sanitize_python_code(code: str) -> str:
    """Sanitize Python code to prevent malicious execution."""
    code = re.sub(r"#.*$", "", code, flags=re.MULTILINE)
    code = re.sub(r'"""[\s\S]*?"""', "", code)
    code = re.sub(r"'''[\s\S]*?'''", "", code)

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
    except SyntaxError as exc:
        raise ValueError(f"Invalid Python syntax: {exc}")

    return code


def create_chart_tool(db_manager: DuckDBManager, workspace_state: WorkspaceState):
    @tool
    def generate_chart_config(
        chart_title: str = Field(description="The title of the chart"),
        python_code: str = Field(
            description=(
                "Python code to create visualizations from the provided df variable, which contains "
                "the last run_sql_query result. Do not read files directly; use DuckDB via "
                "run_sql_query before calling this tool. Two approaches:\n"
                "1. Matplotlib/Seaborn: Use plt.figure(), plt.plot(), sns.barplot(), etc. "
                "Figures are auto-saved as PNG.\n"
                "2. Plotly (preferred): Build a Plotly figure or a dict with data/layout/config assigned to 'chart_config'. "
                "Plotly specs are saved as .plotly.json for the viewer."
            )
        ),
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Generate visualizations from the last SQL query result."""
        if _is_strict_dashboard_mode(workspace_state) and not _is_plan_approved(workspace_state):
            return _dashboard_plan_gate_message()
        if _is_strict_dashboard_mode(workspace_state):
            return (
                "Dashboard mode uses structured chart specs instead of generated chart code. "
                "Skip generate_chart_config and pass the approved chart bindings directly to generate_dashboard."
            )
        try:
            db_manager.require_query_before_chart()
            db_manager.require_chart_budget()
        except ValueError as exc:
            return str(exc)

        df_context = db_manager.get_limited_result()
        if df_context is None:
            return "No query results available to visualize."

        charts_dir = workspace_state.root_path / "charts"
        safe_title = _safe_slug(chart_title, "chart")
        before_snapshot = _snapshot_workspace(workspace_state.root_path)

        try:
            sanitized_code = sanitize_python_code(python_code)
        except ValueError as exc:
            return _chart_payload(
                chart_title,
                status="error",
                message=str(exc),
                row_count=len(df_context),
                error_type="sanitization_error",
                available_columns=list(df_context.columns),
            )

        execution_result = _run_chart_code_in_subprocess(
            sanitized_code,
            chart_title,
            df_context,
        )
        if execution_result.get("status") != "success":
            after_snapshot = _snapshot_workspace(workspace_state.root_path)
            _cleanup_new_files(workspace_state.root_path, before_snapshot, after_snapshot)
            return _chart_payload(
                chart_title,
                status="error",
                message=execution_result.get("message") or "Chart execution failed.",
                row_count=len(df_context),
                error_type=execution_result.get("error_type") or "execution_error",
                available_columns=execution_result.get("available_columns"),
            )

        chart_config = execution_result.get("chart_config")
        plotly_payload = execution_result.get("plotly_payload")

        after_snapshot = _snapshot_workspace(workspace_state.root_path)
        artifacts = _detect_new_files(
            workspace_state.root_path, before_snapshot, after_snapshot
        )

        plotly_config_path: Optional[Path] = None
        if plotly_payload is not None:
            try:
                charts_dir.mkdir(exist_ok=True)
                plotly_config_path = charts_dir / f"{safe_title}.plotly.json"
                plotly_config_path.write_text(_json_dump(plotly_payload), encoding="utf-8")
                artifacts.append(
                    {
                        "path": _workspace_rel(plotly_config_path, workspace_state.root_path),
                        "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".json"],
                        "size": plotly_config_path.stat().st_size,
                        }
                    )
            except Exception:  # pragma: no cover - best effort persistence
                logger.warning("Failed to persist Plotly config", exc_info=True)

        if chart_config is None and plotly_payload is None and not artifacts:
            return _chart_payload(
                chart_title,
                status="error",
                message="No chart_config variable created and no artifacts produced.",
                row_count=len(df_context),
                error_type="empty_result",
                available_columns=list(df_context.columns),
            )

        artifact_paths = [artifact["path"] for artifact in artifacts]
        db_manager.record_chart(chart_title, artifact_paths)
        for artifact in artifacts:
            db_manager.register_artifact(artifact)
        _emit_artifacts(callbacks, artifacts)

        return _chart_payload(
            chart_title,
            status="success",
            message="Chart generated successfully.",
            row_count=len(df_context),
            chart_config=plotly_payload if plotly_payload is not None else chart_config,
            plotly_config_path=(
                _workspace_rel(plotly_config_path, workspace_state.root_path)
                if plotly_config_path
                else None
            ),
            output_files=artifacts,
        )

    return generate_chart_config
