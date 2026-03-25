import ast
import base64
import hashlib
import html
import json
import logging
import multiprocessing as mp
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from queue import Empty
from typing import Annotated, Any, Dict, List, Optional, Set, Tuple

import duckdb
import numpy as np
import pandas as pd
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import Tool, tool
from pydantic import Field

from .bigquery_export_tools import (
    extract_bearer_header,
    load_bigquery_toolbox_config,
    resolve_output_path,
    run_bigquery_query,
    validate_read_only_sql,
    write_export_dataframe,
)
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
MAX_QUERY_COUNT = 10
MAX_CHART_COUNT = 5
DEFAULT_CACHE_TTL_HOURS = 24
MAX_MATERIALIZED_ROWS = 100000
MAX_QUERY_RESULT_ROWS = MAX_SESSION_ROWS + 1
CHART_EXECUTION_TIMEOUT_SECONDS = 5.0
WORKSPACE_SCAN_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".idea",
    ".vscode",
}
DATA_FILE_EXTENSIONS = {".csv", ".parquet"}
DATA_DISCOVERY_DIR_CANDIDATES = (
    "data",
    "datasets",
    "exports",
    "data_exports",
)


@dataclass
class _QueryRecord:
    sql: str
    row_count: int
    preview: "pd.DataFrame"
    truncated: bool = False


@dataclass
class _ChartRecord:
    title: str
    artifact_paths: List[str]


@dataclass
class _MaterializationRecord:
    cache_key: str
    sql: str
    parquet_path: str
    metadata_path: str
    row_count: int
    connector: str
    cached: bool
    expires_at: str


class DataAgentSessionState:
    """Holds per-run guardrails and history for the data agent tools."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.schema_inspected = False
        self.query_count = 0
        self.chart_count = 0
        self.summary_generated = False
        self.dashboard_generated = False
        self.last_query_result: Optional[pd.DataFrame] = None
        self.last_query_sql: Optional[str] = None
        self.query_history: List[_QueryRecord] = []
        self.chart_history: List[_ChartRecord] = []
        self.materialization_history: List[_MaterializationRecord] = []
        self.run_artifacts: List[Dict[str, Any]] = []


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


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _workspace_rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _safe_slug(value: str, default: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", (value or "").strip()).strip("_")
    return slug or default


def _should_skip_directory(name: str) -> bool:
    if name in WORKSPACE_SCAN_EXCLUDED_DIRS:
        return True
    return name.startswith(".")


def _iter_workspace_files(
    root: Path,
    *,
    allowed_extensions: Optional[Set[str]] = None,
    preferred_dirs: Tuple[str, ...] = (),
) -> List[Path]:
    seen: Set[Path] = set()
    files: List[Path] = []

    def _append_file(path: Path) -> None:
        if allowed_extensions and path.suffix.lower() not in allowed_extensions:
            return
        resolved = path.resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        files.append(path)

    for child in root.iterdir():
        if child.is_file():
            _append_file(child)

    preferred_roots: List[Path] = []
    for dirname in preferred_dirs:
        candidate = root / dirname
        if candidate.exists() and candidate.is_dir():
            preferred_roots.append(candidate)

    def _scan_recursive(base: Path) -> None:
        for current_root, dirnames, filenames in os.walk(base):
            current_path = Path(current_root)
            if current_path != base and _should_skip_directory(current_path.name):
                dirnames[:] = []
                continue
            dirnames[:] = [
                dirname for dirname in dirnames if not _should_skip_directory(dirname)
            ]
            for filename in filenames:
                _append_file(current_path / filename)

    for base in preferred_roots:
        _scan_recursive(base)
    if not preferred_roots or len(files) == 0:
        _scan_recursive(root)
    return files


def _snapshot_workspace(root: Path) -> Dict[str, Tuple[int, int]]:
    snapshot: Dict[str, Tuple[int, int]] = {}
    for path in _iter_workspace_files(
        root,
        allowed_extensions=set(ALLOWED_ARTIFACT_EXTENSIONS.keys()),
        preferred_dirs=("charts", "reports", "dashboards", "exports", "data_exports"),
    ):
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


def _cleanup_new_files(
    root: Path,
    before: Dict[str, Tuple[int, int]],
    after: Dict[str, Tuple[int, int]],
) -> None:
    for rel in after:
        if rel in before:
            continue
        path = root / rel
        try:
            if path.exists():
                path.unlink()
        except OSError:
            logger.warning("Failed to clean up artifact %s", path, exc_info=True)


def _format_dataframe_markdown(df: pd.DataFrame, *, truncated: bool = False) -> str:
    if df.empty:
        return "Query executed successfully but returned no data."

    display_df = df.head(MAX_RESULT_ROWS)
    message_lines = [f"Result shape: {len(df)} rows x {len(df.columns)} columns."]
    if truncated:
        message_lines.append(
            f"Execution was safety-capped at {MAX_SESSION_ROWS} rows. Refine the query for the full result."
        )
    if len(df.columns):
        columns = ", ".join(f"`{column}`" for column in df.columns[:10])
        if len(df.columns) > 10:
            columns += ", ..."
        message_lines.append(f"Columns: {columns}")
    numeric_summary = _format_numeric_summary(df)
    if numeric_summary:
        message_lines.append(f"Numeric summary: {numeric_summary}")
    if len(df) > MAX_RESULT_ROWS:
        message_lines.append(f"Showing the first {MAX_RESULT_ROWS} rows below.")
    message_lines.append(display_df.to_markdown())
    rendered = "\n".join(message_lines)
    if len(rendered) > 4000:
        return rendered[:4000] + "\n... (Output truncated due to length)"
    return rendered


def _format_sample_value(value: Any) -> str:
    if pd.isna(value):
        return "null"
    if isinstance(value, str):
        compact = value if len(value) <= 32 else value[:29] + "..."
        return repr(compact)
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    return str(value)


def _format_numeric_summary(df: pd.DataFrame) -> str:
    numeric_df = df.select_dtypes(include=["number"])
    if numeric_df.empty:
        return ""

    summaries: List[str] = []
    for column in numeric_df.columns[:3]:
        series = numeric_df[column].dropna()
        if series.empty:
            continue
        summaries.append(
            f"`{column}` min={series.min():.3g}, median={series.median():.3g}, max={series.max():.3g}"
        )
    return "; ".join(summaries)


def _query_looks_aggregated(query: str) -> bool:
    aggregate_markers = [
        r"\bgroup\s+by\b",
        r"\bdistinct\b",
        r"\bhaving\b",
        r"\bcount\s*\(",
        r"\bsum\s*\(",
        r"\bavg\s*\(",
        r"\bmean\s*\(",
        r"\bmin\s*\(",
        r"\bmax\s*\(",
    ]
    return any(re.search(pattern, query, re.IGNORECASE) for pattern in aggregate_markers)


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
    effective_timeout = timeout_seconds or CHART_EXECUTION_TIMEOUT_SECONDS
    ctx = mp.get_context("spawn")
    result_queue: "mp.Queue[Dict[str, Any]]" = ctx.Queue()
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
    finally:
        result_queue.close()
        result_queue.join_thread()

    if result is None:
        return {
            "status": "error",
            "error_type": "execution_error",
            "message": "Chart subprocess exited without returning a result.",
        }
    return result


def _markdown_to_html(markdown_text: str) -> str:
    if not markdown_text:
        return ""

    text = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    text = html.escape(text)

    code_blocks: List[Tuple[str, str]] = []

    def _capture_code_block(match: re.Match[str]) -> str:
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
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, datetime):
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


def _coerce_text_arg(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def _coerce_int_arg(
    value: Any,
    default: int,
    *,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> int:
    try:
        coerced = int(value if value is not None else default)
    except (TypeError, ValueError):
        coerced = int(default)
    if minimum is not None:
        coerced = max(minimum, coerced)
    if maximum is not None:
        coerced = min(maximum, coerced)
    return coerced


def _coerce_bool_arg(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return bool(default if value is None else value)


def _resolve_workspace_html_path(
    workspace_root: Path,
    output_path: str,
    *,
    default_dir: str,
    default_stem: str,
) -> Path:
    raw = (output_path or "").strip()
    if not raw:
        raw = f"{default_dir}/{default_stem}.html"
    elif raw.endswith("/"):
        raw = f"{raw}{default_stem}.html"
    elif Path(raw).suffix.lower() not in {".html", ".htm"}:
        raw = f"{raw}.html"

    candidate = Path(raw)
    if candidate.is_absolute():
        candidate = Path(str(candidate).lstrip("/"))
    resolved = (workspace_root / candidate).resolve()
    root_resolved = workspace_root.resolve()
    if root_resolved not in resolved.parents and resolved != root_resolved:
        raise ValueError("output_path must remain inside the workspace.")
    return resolved


def _resolve_workspace_data_path(workspace_root: Path, raw_path: str) -> Path:
    candidate = Path((raw_path or "").strip())
    if not str(candidate):
        raise ValueError("dashboard_dataset_path is required for data-backed filtering.")
    if candidate.is_absolute():
        candidate = Path(str(candidate).lstrip("/"))
    resolved = (workspace_root / candidate).resolve()
    root_resolved = workspace_root.resolve()
    if root_resolved not in resolved.parents and resolved != root_resolved:
        raise ValueError("dashboard_dataset_path must remain inside the workspace.")
    return resolved


def _normalize_record_value(value: Any) -> Any:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, np.generic):
        return value.item()
    return value


def _load_dashboard_dataset(workspace_root: Path, dataset_path: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], str]:
    resolved = _resolve_workspace_data_path(workspace_root, dataset_path)
    if not resolved.exists():
        raise ValueError(f"Dashboard dataset not found: {dataset_path}")

    suffix = resolved.suffix.lower()
    if suffix == ".parquet":
        df = pd.read_parquet(resolved)
        format_name = "parquet"
    elif suffix == ".csv":
        df = pd.read_csv(resolved)
        format_name = "csv"
    elif suffix in {".json", ".jsonl", ".ndjson"}:
        format_name = "json"
        if suffix == ".json":
            payload = json.loads(resolved.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                if isinstance(payload.get("rows"), list):
                    rows = payload.get("rows") or []
                elif isinstance(payload.get("data"), list):
                    rows = payload.get("data") or []
                else:
                    rows = [payload]
            elif isinstance(payload, list):
                rows = payload
            else:
                raise ValueError("JSON dashboard datasets must contain an object or list.")
        else:
            rows = [
                json.loads(line)
                for line in resolved.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        df = pd.DataFrame(rows)
    else:
        raise ValueError(
            "dashboard_dataset_path must point to a .parquet, .csv, .json, .jsonl, or .ndjson file."
        )

    records = [
        {str(key): _normalize_record_value(value) for key, value in row.items()}
        for row in df.replace({np.nan: None}).to_dict(orient="records")
    ]
    schema = [
        {
            "name": str(column),
            "type": str(dtype),
        }
        for column, dtype in df.dtypes.items()
    ]
    return records, schema, format_name


def _normalize_filter_schema(raw_filters: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for idx, raw in enumerate(raw_filters or [], start=1):
        if not isinstance(raw, dict):
            continue
        field_name = _coerce_text_arg(raw.get("field")).strip()
        filter_type = _coerce_text_arg(raw.get("type"), "categorical").strip().lower()
        if not field_name:
            continue
        normalized.append(
            {
                "id": _coerce_text_arg(raw.get("id"), f"filter_{idx}").strip() or f"filter_{idx}",
                "field": field_name,
                "label": _coerce_text_arg(raw.get("label"), field_name.replace("_", " ").title()).strip()
                or field_name.replace("_", " ").title(),
                "type": filter_type if filter_type in {"categorical", "date", "datetime", "numeric"} else "categorical",
                "operators": list(raw.get("operators") or []),
                "multi": _coerce_bool_arg(raw.get("multi"), True),
                "options": list(raw.get("options") or []),
                "applies_to": list(raw.get("applies_to") or []),
                "default": raw.get("default"),
                "presets": list(raw.get("presets") or []),
                "step": raw.get("step"),
            }
        )
    return normalized


def _normalize_chart_bindings(raw_bindings: Optional[List[Dict[str, Any]]]) -> Dict[int, Dict[str, Any]]:
    normalized: Dict[int, Dict[str, Any]] = {}
    for idx, raw in enumerate(raw_bindings or [], start=1):
        if not isinstance(raw, dict):
            continue
        chart_index = _coerce_int_arg(raw.get("chart_index"), idx, minimum=1)
        normalized[chart_index] = {
            "chart_index": chart_index,
            "chart_type": _coerce_text_arg(raw.get("chart_type"), "bar").strip().lower() or "bar",
            "x_field": _coerce_text_arg(raw.get("x_field")).strip(),
            "y_field": _coerce_text_arg(raw.get("y_field")).strip(),
            "aggregation": _coerce_text_arg(raw.get("aggregation"), "count").strip().lower() or "count",
            "series_field": _coerce_text_arg(raw.get("series_field")).strip(),
            "orientation": _coerce_text_arg(raw.get("orientation")).strip().lower(),
            "sort_by": _coerce_text_arg(raw.get("sort_by"), "y").strip().lower() or "y",
            "sort_direction": _coerce_text_arg(raw.get("sort_direction"), "desc").strip().lower() or "desc",
            "limit": _coerce_int_arg(raw.get("limit"), 0, minimum=0),
            "mode": _coerce_text_arg(raw.get("mode"), "lines+markers").strip(),
            "title": _coerce_text_arg(raw.get("title")).strip(),
            "x_title": _coerce_text_arg(raw.get("x_title")).strip(),
            "y_title": _coerce_text_arg(raw.get("y_title")).strip(),
            "static_reason": _coerce_text_arg(raw.get("static_reason")).strip(),
        }
    return normalized


def _cache_key_for_query(sql_query: str, workspace_id: str, cache_key_hint: str) -> str:
    digest = hashlib.sha256(
        f"{workspace_id}\n{cache_key_hint}\n{sql_query}".encode("utf-8")
    ).hexdigest()
    return digest[:12]


def _schema_summary_from_dataframe(df: pd.DataFrame) -> List[Dict[str, Any]]:
    return [
        {
            "name": str(column),
            "type": str(dtype),
            "mode": "NULLABLE",
        }
        for column, dtype in df.dtypes.items()
    ]


def _load_dataframe_from_parquet(connection: duckdb.DuckDBPyConnection, parquet_path: Path) -> pd.DataFrame:
    safe_path = parquet_path.as_posix().replace("'", "''")
    return connection.execute(f"SELECT * FROM read_parquet('{safe_path}')").df()


def _emit_artifacts(
    callbacks: Optional[CallbackManagerForToolRun],
    artifacts: List[Dict[str, Any]],
) -> None:
    if not callbacks or not artifacts:
        return
    try:
        run_id = getattr(callbacks, "run_id", None)
        payload = {"files": artifacts}
        if run_id is not None:
            callbacks.on_custom_event("tool_artifacts", payload, run_id=run_id)
        else:
            callbacks.on_custom_event("tool_artifacts", payload)
    except Exception:  # pragma: no cover - best effort
        logger.warning("Failed to dispatch tool_artifacts event", exc_info=True)


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
        self._register_files()

    def _register_files(self):
        """Scans workspace for CSV and Parquet files and registers them as tables."""
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

        return "\n".join(schema_lines).strip()

    def run_query(
        self,
        query: str,
        *,
        record_sql: Optional[str] = None,
        truncated: bool = False,
    ) -> pd.DataFrame:
        if self.session.query_count >= MAX_QUERY_COUNT:
            raise ValueError(
                f"Query budget exhausted: at most {MAX_QUERY_COUNT} queries are allowed per run."
            )
        df = self.con.execute(query).df()
        self.session.query_count += 1
        self.session.last_query_result = df
        stored_sql = record_sql or query
        self.session.last_query_sql = stored_sql
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
        sql_query: str = Field(description="The SQL query to run."),
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
            truncated = False
            executed_query = cleaned_query
            safety_capped = not _query_looks_aggregated(cleaned_query)
            if safety_capped:
                executed_query = (
                    f"SELECT * FROM ({cleaned_query}) AS helpudoc_query_preview "
                    f"LIMIT {MAX_QUERY_RESULT_ROWS}"
                )

            df = db_manager.run_query(executed_query, record_sql=cleaned_query)
            if safety_capped and len(df) > MAX_SESSION_ROWS:
                truncated = True
                df = df.head(MAX_SESSION_ROWS).copy()
                db_manager.session.last_query_result = df
                if db_manager.session.query_history:
                    db_manager.session.query_history[-1].row_count = len(df)
                    db_manager.session.query_history[-1].preview = df.head(MAX_RESULT_ROWS).copy()
                    db_manager.session.query_history[-1].truncated = True
            return _format_dataframe_markdown(df, truncated=truncated)
        except Exception as exc:  # pragma: no cover - defensive
            return f"Error executing query: {str(exc)}"

    @tool
    def materialize_bigquery_to_parquet(
        sql_query: Annotated[
            str,
            Field(description="Read-only BigQuery SQL query to materialize into workspace-local Parquet."),
        ],
        cache_key_hint: Annotated[
            str,
            Field(description="Optional stable label to make cache files easier to recognize."),
        ] = "",
        ttl_hours: Annotated[
            int,
            Field(description="Hours before the cached Parquet is considered stale and should be refreshed."),
        ] = DEFAULT_CACHE_TTL_HOURS,
        force_refresh: Annotated[
            bool,
            Field(description="When true, ignore any cached Parquet and re-run the warehouse query."),
        ] = False,
        max_rows: Annotated[
            int,
            Field(description="Safety cap for exported rows. Keep results scoped for iterative analysis."),
        ] = MAX_MATERIALIZED_ROWS,
        target_path: Annotated[
            str,
            Field(description="Optional stable parquet path such as datasets/orders/latest.parquet."),
        ] = "",
        emit_csv: Annotated[
            bool,
            Field(description="When true, also publish a CSV mirror of the refreshed dataset."),
        ] = False,
        csv_path: Annotated[
            str,
            Field(description="Optional stable CSV path such as datasets/orders/latest.csv."),
        ] = "",
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Materialize a read-only BigQuery query into cached and optionally stable workspace Parquet."""
        if workspace_state.context.get("tagged_files_only"):
            return "Tool disabled: tagged files were provided, use rag_query only."

        normalized_sql = _coerce_text_arg(sql_query).strip().rstrip(";")
        if not normalized_sql:
            return "SQL query is required."

        try:
            validate_read_only_sql(normalized_sql)
        except ValueError as exc:
            return str(exc)

        hint = _coerce_text_arg(cache_key_hint).strip()
        ttl_value = _coerce_int_arg(ttl_hours, DEFAULT_CACHE_TTL_HOURS, minimum=1)
        row_cap = _coerce_int_arg(
            max_rows,
            MAX_MATERIALIZED_ROWS,
            minimum=1,
            maximum=MAX_MATERIALIZED_ROWS,
        )
        refresh = _coerce_bool_arg(force_refresh, False)
        publish_csv = _coerce_bool_arg(emit_csv, False)
        toolbox_defaults = load_bigquery_toolbox_config()
        preferred_server = str(toolbox_defaults.get("server_name") or "toolbox-bq-demo")
        project = _coerce_text_arg(
            workspace_state.context.get("bigquery_project")
            or workspace_state.context.get("bq_project")
            or toolbox_defaults.get("project")
        ).strip()
        location = _coerce_text_arg(
            workspace_state.context.get("bigquery_location")
            or workspace_state.context.get("bq_location")
            or toolbox_defaults.get("location")
        ).strip()

        auth_header = extract_bearer_header(workspace_state, preferred_server)
        if not auth_header:
            return (
                "BigQuery materialization is unavailable because no delegated BigQuery access token was found. "
                f"Expected MCP auth for server '{preferred_server}' or BQ_ACCESS_TOKEN."
            )

        cache_key = _cache_key_for_query(
            normalized_sql,
            _coerce_text_arg(getattr(workspace_state, "workspace_id", "")),
            hint,
        )
        cache_slug = _safe_slug(hint or "bq_export", "bq_export")
        cache_dir = workspace_state.root_path / "data_cache" / "bigquery"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_parquet_path = cache_dir / f"{cache_slug}_{cache_key}.parquet"
        cache_metadata_path = cache_dir / f"{cache_slug}_{cache_key}.metadata.json"

        now = _utc_now()
        cached = False
        metadata_payload: Dict[str, Any] = {}
        df: Optional[pd.DataFrame] = None

        if not refresh and cache_parquet_path.exists() and cache_metadata_path.exists():
            try:
                metadata_payload = json.loads(cache_metadata_path.read_text(encoding="utf-8"))
                expires_at_raw = _coerce_text_arg(metadata_payload.get("expiresAt")).strip()
                expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00")) if expires_at_raw else None
                if expires_at and expires_at > now:
                    cached = True
            except Exception:
                cached = False
                metadata_payload = {}

        if not cached:
            try:
                df = run_bigquery_query(
                    sql=normalized_sql,
                    project=project,
                    location=location,
                    auth_header=auth_header,
                    row_limit=row_cap,
                )
                write_export_dataframe(df, cache_parquet_path, "parquet")
            except Exception as exc:  # pragma: no cover - network/filesystem guard
                logger.exception("BigQuery materialization failed")
                return f"BigQuery materialization failed: {exc}"

            expires_at = now + timedelta(hours=ttl_value)
            metadata_payload = {
                "cacheKey": cache_key,
                "cacheKeyHint": hint,
                "connector": preferred_server,
                "project": project,
                "location": location,
                "sourceSql": normalized_sql,
                "rowCount": len(df),
                "schema": _schema_summary_from_dataframe(df),
                "refreshedAt": now.isoformat().replace("+00:00", "Z"),
                "materializedAt": now.isoformat().replace("+00:00", "Z"),
                "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
                "ttlHours": ttl_value,
                "parquetPath": _workspace_rel(cache_parquet_path, workspace_state.root_path),
                "csvPath": "",
                "artifactTargets": {"dashboard": "", "report": ""},
            }
            cache_metadata_path.write_text(_json_dump(metadata_payload), encoding="utf-8")

        stable_parquet_path: Optional[Path] = None
        stable_csv_path: Optional[Path] = None
        manifest_path = cache_metadata_path
        artifact_paths: List[Path] = [cache_parquet_path, cache_metadata_path]

        if target_path.strip():
            try:
                stable_parquet_path = resolve_output_path(
                    workspace_state.root_path,
                    target_path,
                    "parquet",
                )
            except ValueError as exc:
                return str(exc)
            stable_parquet_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_parquet_path, stable_parquet_path)
            manifest_path = stable_parquet_path.parent / "manifest.json"
            artifact_paths.append(stable_parquet_path)

        if publish_csv:
            if df is None:
                df = _load_dataframe_from_parquet(db_manager.con, cache_parquet_path)
            raw_csv_path = csv_path.strip()
            if not raw_csv_path and stable_parquet_path is not None:
                raw_csv_path = (stable_parquet_path.parent / "latest.csv").relative_to(
                    workspace_state.root_path
                ).as_posix()
            try:
                stable_csv_path = resolve_output_path(
                    workspace_state.root_path,
                    raw_csv_path,
                    "csv",
                )
            except ValueError as exc:
                return str(exc)
            write_export_dataframe(df, stable_csv_path, "csv")
            artifact_paths.append(stable_csv_path)

        if stable_parquet_path is not None:
            stable_metadata = dict(metadata_payload)
            stable_metadata["parquetPath"] = _workspace_rel(stable_parquet_path, workspace_state.root_path)
            stable_metadata["csvPath"] = (
                _workspace_rel(stable_csv_path, workspace_state.root_path)
                if stable_csv_path is not None
                else ""
            )
            stable_metadata["artifactTargets"] = {
                "dashboard": "",
                "report": "",
            }
            manifest_path.write_text(_json_dump(stable_metadata), encoding="utf-8")
            artifact_paths.append(manifest_path)
        else:
            if stable_csv_path is not None:
                metadata_payload["csvPath"] = _workspace_rel(stable_csv_path, workspace_state.root_path)
                cache_metadata_path.write_text(_json_dump(metadata_payload), encoding="utf-8")

        db_manager.refresh_registered_files()

        registered_artifacts: List[Dict[str, Any]] = []
        for artifact_path in artifact_paths:
            if not artifact_path.exists():
                continue
            mime_type = ALLOWED_ARTIFACT_EXTENSIONS.get(artifact_path.suffix.lower())
            if not mime_type:
                continue
            artifact_payload = {
                "path": _workspace_rel(artifact_path, workspace_state.root_path),
                "mimeType": mime_type,
                "size": artifact_path.stat().st_size,
            }
            db_manager.register_artifact(artifact_payload)
            registered_artifacts.append(artifact_payload)

        published_parquet = stable_parquet_path or cache_parquet_path
        published_metadata = manifest_path
        db_manager.record_materialization(
            _MaterializationRecord(
                cache_key=cache_key,
                sql=normalized_sql,
                parquet_path=_workspace_rel(published_parquet, workspace_state.root_path),
                metadata_path=_workspace_rel(published_metadata, workspace_state.root_path),
                row_count=_coerce_int_arg(metadata_payload.get("rowCount"), 0, minimum=0),
                connector=preferred_server,
                cached=cached,
                expires_at=_coerce_text_arg(metadata_payload.get("expiresAt")),
            )
        )
        _emit_artifacts(callbacks, registered_artifacts)

        payload = {
            "cache_key": cache_key,
            "cached": cached,
            "connector": preferred_server,
            "row_count": _coerce_int_arg(metadata_payload.get("rowCount"), 0, minimum=0),
            "schema": list(metadata_payload.get("schema") or []),
            "parquet_path": _workspace_rel(published_parquet, workspace_state.root_path),
            "metadata_path": _workspace_rel(published_metadata, workspace_state.root_path),
            "csv_path": (
                _workspace_rel(stable_csv_path, workspace_state.root_path)
                if stable_csv_path is not None
                else _coerce_text_arg(metadata_payload.get("csvPath"))
            ),
            "duckdb_table_name": published_parquet.stem,
            "expires_at": metadata_payload.get("expiresAt"),
            "ttl_hours": ttl_value,
            "cache_parquet_path": _workspace_rel(cache_parquet_path, workspace_state.root_path),
            "cache_metadata_path": _workspace_rel(cache_metadata_path, workspace_state.root_path),
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
        """Generate visualizations from the last SQL query result."""
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

    @tool
    def generate_summary(
        summary: Annotated[str, Field(description="The summary of the actions performed")],
        insights: Annotated[str, Field(description="The insights from the data")],
        output_path: Annotated[
            str,
            Field(description="Optional stable HTML output path such as reports/orders_daily.html."),
        ] = "",
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Produce a summary of the results and save it as a self-contained HTML report."""
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before summarizing the findings."
        try:
            db_manager.ensure_single_summary()
        except ValueError as exc:
            return str(exc)
        db_manager.mark_summary_generated()

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
            "    pre { background:#0f172a; color:#e2e8f0; padding:12px; border-radius:12px; overflow-x:auto; white-space:pre-wrap; }",
            "    img { max-width: 100%; height: auto; display: block; margin: 12px 0; border-radius:12px; border:1px solid #e5e7eb; }",
            "    .plotly-embed { margin: 16px 0; }",
            "    .agent-markdown { line-height: 1.7; font-size: 0.98rem; }",
            "  </style>",
            "  <script src=\"https://cdn.plot.ly/plotly-3.3.0.min.js\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"container\">",
            "    <h1>Data Analysis Report</h1>",
            f"    <div class=\"meta\">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>",
            "    <div class=\"card\">",
            "      <h2>Summary</h2>",
            f"      <div class=\"agent-markdown\">{_markdown_to_html(summary) or '<p>No summary provided.</p>'}</div>",
            "      <h2>Key Insights</h2>",
            f"      <div class=\"agent-markdown\">{_markdown_to_html(insights) or '<p>No insights provided.</p>'}</div>",
            "    </div>",
        ]

        if db_manager.session.materialization_history:
            report_lines.extend(
                [
                    "    <div class=\"card\">",
                    "      <h2>Warehouse Materializations</h2>",
                ]
            )
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

        if db_manager.session.query_history:
            report_lines.extend(
                [
                    "    <div class=\"card\">",
                    "      <h2>SQL Queries</h2>",
                ]
            )
            for idx, query_record in enumerate(db_manager.session.query_history, start=1):
                row_label = (
                    f"{query_record.row_count}+ rows previewed"
                    if query_record.truncated
                    else f"{query_record.row_count} rows"
                )
                report_lines.append(
                    f"      <h3>Query {idx} <span class=\"meta\">({row_label})</span></h3>"
                )
                report_lines.append(f"      <pre><code>{html.escape(query_record.sql)}</code></pre>")
                if not query_record.preview.empty:
                    report_lines.append("      <h4>Sample Data</h4>")
                    report_lines.append(query_record.preview.to_html(index=False, border=0))
            report_lines.append("    </div>")

        run_chart_paths: List[str] = []
        for chart_record in db_manager.session.chart_history:
            run_chart_paths.extend(chart_record.artifact_paths)

        plotly_json_files = sorted(
            p for p in (workspace_state.root_path / rel for rel in run_chart_paths if rel.endswith(".plotly.json"))
            if p.exists()
        )
        plotly_html_files = sorted(
            p for p in (workspace_state.root_path / rel for rel in run_chart_paths if rel.endswith(".plotly.html"))
            if p.exists()
        )
        png_files = sorted(
            p for p in (workspace_state.root_path / rel for rel in run_chart_paths if rel.endswith(".png"))
            if p.exists()
        )
        if plotly_json_files or plotly_html_files or png_files:
            report_lines.append("    <div class=\"card\">")
            report_lines.append("      <h2>Visualizations</h2>")

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
                except Exception:
                    logger.warning("Failed to embed Plotly JSON %s", json_path, exc_info=True)

            for html_path in plotly_html_files:
                try:
                    html_fragment = html_path.read_text(encoding="utf-8")
                    report_lines.append(f"      <h3>{_chart_title_from_path(html_path)}</h3>")
                    report_lines.append(f"      <div class=\"plotly-embed\">{html_fragment}</div>")
                except Exception:
                    logger.warning("Failed to embed Plotly HTML %s", html_path, exc_info=True)

            for png_path in png_files:
                try:
                    encoded = base64.b64encode(png_path.read_bytes()).decode("utf-8")
                    report_lines.append(
                        f"      <h3>{_chart_title_from_path(png_path)}</h3><img src=\"data:image/png;base64,{encoded}\" alt=\"{png_path.stem}\" />"
                    )
                except Exception:
                    logger.warning("Failed to embed PNG %s", png_path, exc_info=True)

            report_lines.append("    </div>")

        report_lines.extend(["  </div>", "</body>", "</html>"])

        try:
            reports_dir = workspace_state.root_path / "reports"
            reports_dir.mkdir(exist_ok=True)
            if output_path.strip():
                report_path = _resolve_workspace_html_path(
                    workspace_state.root_path,
                    output_path,
                    default_dir="reports",
                    default_stem="analysis_report",
                )
            else:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                report_path = reports_dir / f"analysis_report_{timestamp}.html"
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text("\n".join(report_lines), encoding="utf-8")

            artifact = {
                "path": _workspace_rel(report_path, workspace_state.root_path),
                "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".html"],
                "size": report_path.stat().st_size,
            }
            db_manager.register_artifact(artifact)
            _emit_artifacts(callbacks, [artifact])
            return (
                f"Summary: {summary}\n"
                f"Insights: {insights}\n\n"
                f"📄 Full report saved to: {_workspace_rel(report_path, workspace_state.root_path)}"
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to save HTML report: %s", exc)
            return f"Summary: {summary}\nInsights: {insights}\n\n(Note: Failed to save report file: {exc})"

    @tool
    def generate_dashboard(
        title: Annotated[str, Field(description="The dashboard title shown in the HTML header")],
        description: Annotated[
            str,
            Field(description="Short paragraph describing what this dashboard shows and who it's for"),
        ],
        section_titles: Annotated[
            Optional[List[str]],
            Field(description="Optional ordered list of section headings, one per chart produced in this run."),
        ] = None,
        output_path: Annotated[
            str,
            Field(description="Optional stable HTML output path such as dashboards/orders_overview.html."),
        ] = "",
        dashboard_dataset_path: Annotated[
            str,
            Field(
                description=(
                    "Optional workspace-relative path to a canonical Parquet/CSV/JSON dataset used for "
                    "data-backed cross-filtering."
                )
            ),
        ] = "",
        filter_schema: Annotated[
            Optional[List[Dict[str, Any]]],
            Field(
                description=(
                    "Optional filter definitions. Each item may include id, field, label, type "
                    "(categorical/date/datetime/numeric), multi, options, presets, and applies_to."
                )
            ),
        ] = None,
        chart_bindings: Annotated[
            Optional[List[Dict[str, Any]]],
            Field(
                description=(
                    "Optional per-chart bindings aligned by chart order or chart_index. Each binding may include "
                    "chart_type, x_field, y_field, aggregation, series_field, orientation, sort settings, and titles."
                )
            ),
        ] = None,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Assemble all charts and query history from the current run into one HTML dashboard."""
        try:
            db_manager.ensure_single_dashboard()
        except ValueError as exc:
            return str(exc)
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before building a dashboard."
        if not db_manager.session.chart_history:
            return "Generate at least one chart before building a dashboard."
        db_manager.mark_dashboard_generated()

        stable_title = _safe_slug(title, "dashboard")
        dashboard_path = _resolve_workspace_html_path(
            workspace_state.root_path,
            output_path,
            default_dir="dashboards",
            default_stem=stable_title,
        )

        chart_entries: List[Dict[str, Any]] = []
        chosen_titles = list(section_titles or [])
        normalized_bindings = _normalize_chart_bindings(chart_bindings)

        for chart_index, chart_record in enumerate(db_manager.session.chart_history, start=1):
            preferred_path: Optional[Path] = None
            preferred_kind = ""
            for suffix, kind in (
                (".plotly.json", "plotly_json"),
                (".plotly.html", "plotly_html"),
                (".png", "png"),
            ):
                for rel_path in chart_record.artifact_paths:
                    if not rel_path.endswith(suffix):
                        continue
                    candidate = workspace_state.root_path / rel_path
                    if candidate.exists():
                        preferred_path = candidate
                        preferred_kind = kind
                        break
                if preferred_path is not None:
                    break
            if preferred_path is None:
                continue
            section_title = (
                chosen_titles[chart_index - 1]
                if chart_index - 1 < len(chosen_titles)
                else chart_record.title
                or _chart_title_from_path(preferred_path)
            )
            chart_entries.append(
                {
                    "chart_index": chart_index,
                    "title": section_title,
                    "path": preferred_path,
                    "kind": preferred_kind,
                    "binding": normalized_bindings.get(chart_index),
                }
            )

        filter_config = _normalize_filter_schema(filter_schema)
        dataset_records: List[Dict[str, Any]] = []
        dataset_schema: List[Dict[str, Any]] = []
        dataset_format = ""
        data_filtering_enabled = False
        if dashboard_dataset_path.strip():
            dataset_records, dataset_schema, dataset_format = _load_dashboard_dataset(
                workspace_state.root_path,
                dashboard_dataset_path,
            )
            data_filtering_enabled = bool(dataset_records and filter_config)

        bound_cards: List[str] = []
        static_cards: List[str] = []
        chart_runtime_defs: List[Dict[str, Any]] = []

        for entry in chart_entries:
            chart_index = entry["chart_index"]
            section_title = entry["title"]
            chart_path = entry["path"]
            chart_kind = entry["kind"]
            binding = entry.get("binding") or {}
            binding_is_compatible = bool(
                data_filtering_enabled
                and binding
                and binding.get("x_field")
                and (binding.get("aggregation") == "count" or binding.get("y_field"))
            )

            if binding_is_compatible:
                div_id = f"dashboard-chart-{chart_index}"
                chart_runtime_defs.append(
                    {
                        "chartIndex": chart_index,
                        "divId": div_id,
                        "title": section_title,
                        "chartType": binding.get("chart_type") or "bar",
                        "xField": binding.get("x_field"),
                        "yField": binding.get("y_field"),
                        "aggregation": binding.get("aggregation") or "count",
                        "seriesField": binding.get("series_field") or "",
                        "orientation": binding.get("orientation") or "",
                        "sortBy": binding.get("sort_by") or "y",
                        "sortDirection": binding.get("sort_direction") or "desc",
                        "limit": binding.get("limit") or 0,
                        "mode": binding.get("mode") or "lines+markers",
                        "xTitle": binding.get("x_title") or "",
                        "yTitle": binding.get("y_title") or "",
                    }
                )
                bound_cards.append(
                    f"<article class=\"chart-card filter-aware\" data-chart-index=\"{chart_index}\">"
                    f"<h3>{html.escape(section_title)}</h3>"
                    f"<p class=\"chart-meta\">Filter-aware chart bound to the canonical dashboard dataset</p>"
                    f"<div id=\"{div_id}\" class=\"plotly-embed\"></div>"
                    f"<p class=\"chart-note\" id=\"{div_id}-status\"></p>"
                    f"</article>"
                )
                continue

            static_reason = (
                _coerce_text_arg(binding.get("static_reason"))
                or "Static appendix artifact because this chart is not bound to the dashboard dataset."
            )
            try:
                if chart_kind == "plotly_json":
                    fig_json = json.loads(chart_path.read_text(encoding="utf-8"))
                    script_payload = json.dumps(fig_json)
                    div_id = f"dashboard-static-chart-{chart_index}"
                    static_cards.append(
                        f"<article class=\"chart-card static-card\">"
                        f"<h3>{html.escape(section_title)}</h3>"
                        f"<p class=\"chart-meta\">Static appendix chart</p>"
                        f"<p class=\"chart-note\">{html.escape(static_reason)}</p>"
                        f"<div id=\"{div_id}\" class=\"plotly-embed\"></div>"
                        f"<script>"
                        f"const dashboardStaticSpec{chart_index} = {script_payload};"
                        f"Plotly.newPlot('{div_id}', dashboardStaticSpec{chart_index}.data || [], dashboardStaticSpec{chart_index}.layout || {{}}, Object.assign({{responsive:true,displayModeBar:false}}, dashboardStaticSpec{chart_index}.config || {{}}));"
                        f"</script>"
                        f"</article>"
                    )
                elif chart_kind == "plotly_html":
                    static_cards.append(
                        f"<article class=\"chart-card static-card\">"
                        f"<h3>{html.escape(section_title)}</h3>"
                        f"<p class=\"chart-meta\">Static appendix chart</p>"
                        f"<p class=\"chart-note\">{html.escape(static_reason)}</p>"
                        f"{chart_path.read_text(encoding='utf-8')}"
                        f"</article>"
                    )
                elif chart_kind == "png":
                    encoded = base64.b64encode(chart_path.read_bytes()).decode("utf-8")
                    static_cards.append(
                        f"<article class=\"chart-card static-card\">"
                        f"<h3>{html.escape(section_title)}</h3>"
                        f"<p class=\"chart-meta\">Static image artifact</p>"
                        f"<p class=\"chart-note\">{html.escape(static_reason)}</p>"
                        f"<img class=\"chart-img\" src=\"data:image/png;base64,{encoded}\" alt=\"{html.escape(chart_path.stem)}\" />"
                        f"</article>"
                    )
            except Exception:
                logger.warning("Failed to embed dashboard artifact %s", chart_path, exc_info=True)

        query_items = []
        for idx, query_record in enumerate(db_manager.session.query_history, start=1):
            row_label = (
                f"{query_record.row_count}+ rows previewed"
                if query_record.truncated
                else f"{query_record.row_count} rows"
            )
            query_items.append(
                "<div class=\"query-item\">"
                f"<div class=\"query-meta\">Query {idx} • {row_label}</div>"
                f"<pre class=\"query-block\">{html.escape(query_record.sql)}</pre>"
                "</div>"
            )

        html_lines = [
            "<!doctype html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"utf-8\" />",
            "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
            f"  <title>{html.escape(title)}</title>",
            "  <style>",
            "    :root{--bg:#f4f1ea;--panel:#fffdf8;--ink:#1f2937;--muted:#6b7280;--line:#e7dfd2;--accent:#1f4d3a;--shadow:0 16px 40px rgba(68,50,28,0.08);}",
            "    *{box-sizing:border-box}",
            "    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#f7f4ee 0%,#f4f1ea 100%);color:var(--ink);}",
            "    .shell{max-width:1320px;margin:0 auto;padding:28px 22px 56px}",
            "    .hero,.section{background:rgba(255,253,248,0.96);border:1px solid rgba(231,223,210,0.95);box-shadow:var(--shadow);border-radius:28px;padding:28px 30px;}",
            "    .hero h1{margin:0 0 10px;font-size:clamp(2rem,4vw,3.2rem);line-height:1.02;letter-spacing:-0.04em;}",
            "    .hero p{margin:0;color:#4b5563;line-height:1.65;max-width:760px}",
            "    .hero-meta{margin-top:16px;color:var(--muted);font-size:0.9rem}",
            "    .section{margin-top:22px}",
            "    .chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}",
            "    .chart-card{background:linear-gradient(180deg,#fffefb 0%,#fbf8f2 100%);border:1px solid var(--line);border-radius:20px;padding:18px}",
            "    .chart-card h3{margin:0 0 8px;font-size:1.05rem}",
            "    .chart-meta{margin:0 0 12px;color:var(--muted);font-size:0.88rem}",
            "    .chart-note{margin:10px 0 0;color:#4b5563;font-size:0.9rem;line-height:1.4}",
            "    .plotly-embed{width:100%;height:340px}",
            "    img.chart-img{width:100%;border-radius:12px;border:1px solid var(--line)}",
            "    .filter-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:22px}",
            "    .filter-card{background:rgba(255,253,248,0.96);border:1px solid rgba(231,223,210,0.95);box-shadow:var(--shadow);border-radius:20px;padding:18px}",
            "    .filter-card h2{margin:0 0 6px;font-size:1rem}",
            "    .filter-card p{margin:0 0 12px;color:var(--muted);font-size:0.9rem;line-height:1.5}",
            "    .filter-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}",
            "    .filter-control{display:flex;flex-direction:column;gap:6px}",
            "    .filter-control label{font-size:0.88rem;font-weight:600;color:#374151}",
            "    .filter-control select,.filter-control input,.filter-actions button{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:#fff;color:var(--ink)}",
            "    .filter-actions{display:flex;gap:10px;align-items:end}",
            "    .filter-actions button{cursor:pointer;background:var(--accent);color:#fff;font-weight:600}",
            "    .filter-actions button.secondary{background:#fff;color:var(--ink)}",
            "    .dataset-meta{margin-top:14px;color:var(--muted);font-size:0.85rem}",
            "    details.appendix{margin-top:18px}",
            "    .query-item{background:#faf7f1;border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:12px}",
            "    .query-meta{font-size:0.82rem;color:#9a3412;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;margin-bottom:8px}",
            "    .query-block{margin:0;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow-x:auto;white-space:pre-wrap;color:#374151}",
            "    @media (max-width: 768px){.shell{padding:16px 14px 42px}.hero,.section,.filter-card{padding:22px 18px}.chart-grid{grid-template-columns:1fr}.plotly-embed{height:300px}}",
            "  </style>",
            "  <script src=\"https://cdn.plot.ly/plotly-3.3.0.min.js\"></script>",
            "</head>",
            "<body>",
            "  <div class=\"shell\">",
            "    <section class=\"hero\">",
            "      <div>Interactive dashboard</div>",
            f"      <h1>{html.escape(title)}</h1>",
            f"      <p>{html.escape(description)}</p>",
            f"      <div class=\"hero-meta\">Generated {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} • Charts embedded: {len(bound_cards) + len(static_cards)} • Queries embedded: {len(db_manager.session.query_history)}</div>",
            "    </section>",
        ]

        if data_filtering_enabled:
            html_lines.extend(
                [
                    "    <section class=\"filter-bar\">",
                    "      <div class=\"filter-card\">",
                    "        <h2>Shared data filters</h2>",
                    "        <p>These controls update all compatible charts from the embedded dashboard dataset.</p>",
                    "        <div id=\"dashboard-filter-controls\" class=\"filter-controls\"></div>",
                    "        <div class=\"filter-actions\">",
                    "          <button type=\"button\" id=\"dashboard-apply-filters\" class=\"secondary\">Apply filters</button>",
                    "          <button type=\"button\" id=\"dashboard-reset-filters\">Reset filters</button>",
                    "        </div>",
                    f"        <div class=\"dataset-meta\">Dataset: {html.escape(dashboard_dataset_path)} • Rows embedded: {len(dataset_records)} • Format: {html.escape(dataset_format)}</div>",
                    "      </div>",
                    "    </section>",
                ]
            )

        html_lines.extend(
            [
            "    <section class=\"section\">",
            "      <h2>Highlights</h2>" if bound_cards else "      <h2>Charts</h2>",
            "      <div class=\"chart-grid\">",
            *(bound_cards or static_cards),
            "      </div>",
        ]
        )

        if bound_cards and static_cards:
            html_lines.extend(
                [
                    "      <details class=\"appendix\">",
                    "        <summary>Static appendix charts</summary>",
                    "        <div class=\"chart-grid\">",
                    *static_cards,
                    "        </div>",
                    "      </details>",
                ]
            )

        html_lines.extend(
            [
            "      <details class=\"appendix\">",
            "        <summary>Technical appendix</summary>",
            *query_items,
            "      </details>",
            "    </section>",
            "  </div>",
            "  <script>",
            f"    const DASHBOARD_DATASET = {_json_dump(dataset_records)};",
            f"    const DASHBOARD_FILTER_SCHEMA = {_json_dump(filter_config)};",
            f"    const DASHBOARD_CHART_DEFS = {_json_dump(chart_runtime_defs)};",
            f"    const DASHBOARD_DATASET_SCHEMA = {_json_dump(dataset_schema)};",
            """
    (function() {
      if (!DASHBOARD_DATASET.length || !DASHBOARD_FILTER_SCHEMA.length || !DASHBOARD_CHART_DEFS.length) {
        return;
      }

      const controlHost = document.getElementById('dashboard-filter-controls');
      const applyButton = document.getElementById('dashboard-apply-filters');
      const resetButton = document.getElementById('dashboard-reset-filters');
      const fieldTypes = Object.fromEntries((DASHBOARD_DATASET_SCHEMA || []).map((item) => [item.name, String(item.type || '').toLowerCase()]));

      function inferFieldType(filterDef) {
        if (filterDef.type === 'numeric' || filterDef.type === 'date' || filterDef.type === 'datetime') {
          return filterDef.type;
        }
        const raw = fieldTypes[filterDef.field] || '';
        if (raw.includes('date') || raw.includes('time')) return 'date';
        if (raw.includes('int') || raw.includes('float') || raw.includes('double') || raw.includes('decimal')) return 'numeric';
        return 'categorical';
      }

      function parseDateValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }

      function parseNumericValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }

      function normalizeComparable(value, type) {
        if (type === 'date' || type === 'datetime') {
          const parsed = parseDateValue(value);
          return parsed ? parsed.getTime() : null;
        }
        if (type === 'numeric') {
          return parseNumericValue(value);
        }
        return value;
      }

      function distinctValues(field) {
        const values = [];
        const seen = new Set();
        DASHBOARD_DATASET.forEach((row) => {
          const value = row[field];
          const key = value === null || value === undefined ? '__null__' : String(value);
          if (!seen.has(key) && value !== null && value !== undefined && value !== '') {
            seen.add(key);
            values.push(value);
          }
        });
        return values.sort((a, b) => String(a).localeCompare(String(b)));
      }

      function fieldExtent(field, type) {
        let min = null;
        let max = null;
        DASHBOARD_DATASET.forEach((row) => {
          const value = normalizeComparable(row[field], type);
          if (value === null) return;
          if (min === null || value < min) min = value;
          if (max === null || value > max) max = value;
        });
        return { min, max };
      }

      function createControl(filterDef) {
        const wrapper = document.createElement('div');
        wrapper.className = 'filter-control';
        const label = document.createElement('label');
        label.textContent = filterDef.label;
        wrapper.appendChild(label);
        const fieldType = inferFieldType(filterDef);
        filterDef.resolvedType = fieldType;

        if (fieldType === 'categorical') {
          const select = document.createElement('select');
          select.id = filterDef.id;
          if (filterDef.multi) select.multiple = true;
          const values = (filterDef.options && filterDef.options.length ? filterDef.options : distinctValues(filterDef.field));
          values.forEach((value) => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            select.appendChild(option);
          });
          wrapper.appendChild(select);
          return wrapper;
        }

        if (fieldType === 'date' || fieldType === 'datetime') {
          const extent = fieldExtent(filterDef.field, 'date');
          const preset = document.createElement('select');
          preset.id = filterDef.id + '__preset';
          ['', 'last_30_days', 'last_90_days', 'last_180_days'].forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value ? value.replaceAll('_', ' ') : 'Custom range';
            preset.appendChild(option);
          });
          wrapper.appendChild(preset);
          const startInput = document.createElement('input');
          startInput.type = 'date';
          startInput.id = filterDef.id + '__start';
          const endInput = document.createElement('input');
          endInput.type = 'date';
          endInput.id = filterDef.id + '__end';
          if (extent.min !== null) startInput.value = new Date(extent.min).toISOString().slice(0, 10);
          if (extent.max !== null) endInput.value = new Date(extent.max).toISOString().slice(0, 10);
          preset.addEventListener('change', () => {
            if (!preset.value || extent.max === null) return;
            const end = new Date(extent.max);
            const start = new Date(end);
            const days = preset.value === 'last_30_days' ? 30 : preset.value === 'last_90_days' ? 90 : 180;
            start.setDate(start.getDate() - days);
            startInput.value = start.toISOString().slice(0, 10);
            endInput.value = end.toISOString().slice(0, 10);
          });
          wrapper.appendChild(startInput);
          wrapper.appendChild(endInput);
          return wrapper;
        }

        const extent = fieldExtent(filterDef.field, 'numeric');
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.id = filterDef.id + '__min';
        minInput.placeholder = extent.min === null ? 'Min' : String(extent.min);
        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.id = filterDef.id + '__max';
        maxInput.placeholder = extent.max === null ? 'Max' : String(extent.max);
        wrapper.appendChild(minInput);
        wrapper.appendChild(maxInput);
        return wrapper;
      }

      function readFilterValue(filterDef) {
        const type = filterDef.resolvedType || inferFieldType(filterDef);
        if (type === 'categorical') {
          const select = document.getElementById(filterDef.id);
          return Array.from(select ? select.selectedOptions : []).map((option) => option.value);
        }
        if (type === 'date' || type === 'datetime') {
          return {
            start: document.getElementById(filterDef.id + '__start')?.value || '',
            end: document.getElementById(filterDef.id + '__end')?.value || '',
          };
        }
        return {
          min: document.getElementById(filterDef.id + '__min')?.value || '',
          max: document.getElementById(filterDef.id + '__max')?.value || '',
        };
      }

      function rowMatchesFilter(row, filterDef, value) {
        const type = filterDef.resolvedType || inferFieldType(filterDef);
        const rowValue = row[filterDef.field];
        if (type === 'categorical') {
          if (!value || !value.length) return true;
          return value.includes(String(rowValue));
        }
        if (type === 'date' || type === 'datetime') {
          const rowTime = normalizeComparable(rowValue, 'date');
          if (rowTime === null) return false;
          const start = value.start ? parseDateValue(value.start) : null;
          const end = value.end ? parseDateValue(value.end) : null;
          if (start && rowTime < start.getTime()) return false;
          if (end) {
            const inclusiveEnd = new Date(end);
            inclusiveEnd.setHours(23, 59, 59, 999);
            if (rowTime > inclusiveEnd.getTime()) return false;
          }
          return true;
        }
        const numericValue = normalizeComparable(rowValue, 'numeric');
        if (numericValue === null) return false;
        const minValue = parseNumericValue(value.min);
        const maxValue = parseNumericValue(value.max);
        if (minValue !== null && numericValue < minValue) return false;
        if (maxValue !== null && numericValue > maxValue) return false;
        return true;
      }

      function aggregateRows(rows, chartDef) {
        const map = new Map();
        rows.forEach((row) => {
          const xValue = row[chartDef.xField];
          const seriesValue = chartDef.seriesField ? row[chartDef.seriesField] : '__single__';
          const key = JSON.stringify([xValue, seriesValue]);
          if (!map.has(key)) {
            map.set(key, { x: xValue, series: seriesValue, count: 0, sum: 0, min: null, max: null, values: [] });
          }
          const bucket = map.get(key);
          bucket.count += 1;
          const yRaw = chartDef.yField ? parseNumericValue(row[chartDef.yField]) : null;
          if (yRaw !== null) {
            bucket.sum += yRaw;
            bucket.min = bucket.min === null ? yRaw : Math.min(bucket.min, yRaw);
            bucket.max = bucket.max === null ? yRaw : Math.max(bucket.max, yRaw);
            bucket.values.push(yRaw);
          }
        });

        const points = Array.from(map.values()).map((bucket) => {
          let yValue = bucket.count;
          switch (chartDef.aggregation) {
            case 'sum':
              yValue = bucket.sum;
              break;
            case 'avg':
            case 'mean':
              yValue = bucket.values.length ? bucket.sum / bucket.values.length : 0;
              break;
            case 'min':
              yValue = bucket.min === null ? 0 : bucket.min;
              break;
            case 'max':
              yValue = bucket.max === null ? 0 : bucket.max;
              break;
            case 'nunique':
            case 'count_distinct':
              yValue = new Set(bucket.values).size;
              break;
            case 'count':
            default:
              yValue = bucket.count;
              break;
          }
          return { x: bucket.x, y: yValue, series: bucket.series };
        });

        points.sort((left, right) => {
          const direction = chartDef.sortDirection === 'asc' ? 1 : -1;
          const leftValue = chartDef.sortBy === 'x' ? String(left.x ?? '') : Number(left.y ?? 0);
          const rightValue = chartDef.sortBy === 'x' ? String(right.x ?? '') : Number(right.y ?? 0);
          if (leftValue < rightValue) return -1 * direction;
          if (leftValue > rightValue) return 1 * direction;
          return 0;
        });

        return chartDef.limit > 0 ? points.slice(0, chartDef.limit) : points;
      }

      function buildPlotlyPayload(rows, chartDef) {
        const grouped = aggregateRows(rows, chartDef);
        const seriesValues = chartDef.seriesField
          ? [...new Set(grouped.map((item) => item.series))]
          : ['__single__'];
        const traces = seriesValues.map((seriesKey) => {
          const points = grouped.filter((item) => item.series === seriesKey);
          const trace = {
            type: chartDef.chartType === 'area' ? 'scatter' : chartDef.chartType,
            name: seriesKey === '__single__' ? chartDef.title : String(seriesKey),
            x: points.map((item) => item.x),
            y: points.map((item) => item.y),
          };
          if (chartDef.chartType === 'line' || chartDef.chartType === 'area') {
            trace.type = 'scatter';
            trace.mode = chartDef.mode || 'lines+markers';
            if (chartDef.chartType === 'area') trace.fill = 'tozeroy';
          }
          if (chartDef.chartType === 'scatter') {
            trace.mode = chartDef.mode || 'markers';
          }
          if (chartDef.chartType === 'bar' && chartDef.orientation === 'h') {
            trace.orientation = 'h';
            trace.x = points.map((item) => item.y);
            trace.y = points.map((item) => item.x);
          }
          if (chartDef.chartType === 'pie') {
            trace.type = 'pie';
            trace.labels = points.map((item) => item.x);
            trace.values = points.map((item) => item.y);
            delete trace.x;
            delete trace.y;
          }
          return trace;
        });
        return {
          data: traces,
          layout: {
            title: chartDef.title,
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { t: 56, r: 24, b: 56, l: 56 },
            xaxis: chartDef.chartType === 'pie' ? undefined : { title: chartDef.xTitle || chartDef.xField },
            yaxis: chartDef.chartType === 'pie' ? undefined : { title: chartDef.yTitle || chartDef.yField || chartDef.aggregation },
            legend: { orientation: 'h' },
          },
          config: { responsive: true, displayModeBar: false },
        };
      }

      function renderCharts() {
        const filterState = Object.fromEntries(DASHBOARD_FILTER_SCHEMA.map((filterDef) => [filterDef.id, readFilterValue(filterDef)]));
        const filteredRows = DASHBOARD_DATASET.filter((row) =>
          DASHBOARD_FILTER_SCHEMA.every((filterDef) => rowMatchesFilter(row, filterDef, filterState[filterDef.id]))
        );

        DASHBOARD_CHART_DEFS.forEach((chartDef) => {
          const statusNode = document.getElementById(chartDef.divId + '-status');
          const plotNode = document.getElementById(chartDef.divId);
          if (!plotNode) return;
          const payload = buildPlotlyPayload(filteredRows, chartDef);
          if (!payload.data.length || !payload.data.some((trace) => (trace.x && trace.x.length) || (trace.labels && trace.labels.length))) {
            Plotly.purge(plotNode);
            if (statusNode) statusNode.textContent = 'No data matches the current filters for this chart.';
            return;
          }
          Plotly.newPlot(plotNode, payload.data, payload.layout, payload.config);
          if (statusNode) statusNode.textContent = filteredRows.length + ' rows match the current filters.';
        });
      }

      DASHBOARD_FILTER_SCHEMA.forEach((filterDef) => {
        controlHost.appendChild(createControl(filterDef));
      });
      if (applyButton) applyButton.addEventListener('click', renderCharts);
      if (resetButton) {
        resetButton.addEventListener('click', () => {
          DASHBOARD_FILTER_SCHEMA.forEach((filterDef) => {
            const type = filterDef.resolvedType || inferFieldType(filterDef);
            if (type === 'categorical') {
              const select = document.getElementById(filterDef.id);
              if (select) Array.from(select.options).forEach((option) => { option.selected = false; });
            } else if (type === 'date' || type === 'datetime') {
              const preset = document.getElementById(filterDef.id + '__preset');
              const start = document.getElementById(filterDef.id + '__start');
              const end = document.getElementById(filterDef.id + '__end');
              if (preset) preset.value = '';
              if (start) start.value = '';
              if (end) end.value = '';
            } else {
              const minInput = document.getElementById(filterDef.id + '__min');
              const maxInput = document.getElementById(filterDef.id + '__max');
              if (minInput) minInput.value = '';
              if (maxInput) maxInput.value = '';
            }
          });
          renderCharts();
        });
      }
      renderCharts();
    })();
            """,
            "  </script>",
            "</body>",
            "</html>",
        ]
        )

        try:
            dashboard_path.parent.mkdir(parents=True, exist_ok=True)
            dashboard_path.write_text("\n".join(html_lines), encoding="utf-8")
            artifact = {
                "path": _workspace_rel(dashboard_path, workspace_state.root_path),
                "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".html"],
                "size": dashboard_path.stat().st_size,
            }
            db_manager.register_artifact(artifact)
            _emit_artifacts(callbacks, [artifact])
            return f"Dashboard saved to: {_workspace_rel(dashboard_path, workspace_state.root_path)}"
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to save dashboard HTML: %s", exc)
            return f"Failed to save dashboard file: {exc}"

    return [
        get_table_schema,
        run_sql_query,
        materialize_bigquery_to_parquet,
        generate_chart_config,
        generate_summary,
        generate_dashboard,
    ]
