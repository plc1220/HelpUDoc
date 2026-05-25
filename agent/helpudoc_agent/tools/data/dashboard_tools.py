"""HTML summary reports and native dashboard package generation."""
from __future__ import annotations

import base64
import html
import json
import logging
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional
from uuid import uuid4

import numpy as np
import pandas as pd
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import tool
from pydantic import Field

from ...state import WorkspaceState

from .constants import (
    ALLOWED_ARTIFACT_EXTENSIONS,
    MAX_CHART_COUNT,
    NATIVE_DASHBOARD_AGGREGATIONS,
    NATIVE_DASHBOARD_CHART_TYPES,
    NATIVE_DASHBOARD_ORIENTATIONS,
    NATIVE_DASHBOARD_SORT_DIRECTIONS,
    NATIVE_DASHBOARD_SORT_FIELDS,
    STRICT_DASHBOARD_MIN_CHART_COUNT,
)
from .duckdb_manager import DuckDBManager
from .formatting import _markdown_to_html
from .guards import (
    _dashboard_plan_gate_message,
    _is_plan_approved,
    _is_strict_dashboard_mode,
)
from .query_tools import _emit_artifacts
from .utilities import (
    _coerce_bool_arg,
    _coerce_int_arg,
    _coerce_text_arg,
    _json_dump,
    _safe_slug,
    _utc_now,
)
from .workspace_files import _workspace_rel

logger = logging.getLogger(__name__)


def _compat_render_summary_html(**kwargs):
    """Resolve via data_agent_tools so tests can monkeypatch render_summary_html."""
    from ._shim_targets import get_data_agent_tools_module

    mod = get_data_agent_tools_module()
    return mod.render_summary_html(**kwargs)


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


def _resolve_workspace_dashboard_dir(
    workspace_root: Path,
    output_path: str,
    *,
    default_dir: str,
    default_stem: str,
) -> Path:
    raw = (output_path or "").strip()
    if not raw:
        raw = f"{default_dir}/{default_stem}"
    elif raw.endswith("/"):
        raw = raw.rstrip("/")
    else:
        candidate = Path(raw)
        suffix = candidate.suffix.lower()
        if suffix in {".html", ".htm"}:
            raw = str(candidate.with_suffix(""))

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
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return value.isoformat()
    if isinstance(value, np.datetime64):
        return pd.Timestamp(value).isoformat()
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


def _coerce_dataframe_dashboard_rows(df: pd.DataFrame) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
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
    return records, schema


def _build_dataset_reference(workspace_root: Path, dataset_path: str) -> Dict[str, Any]:
    cleaned = _coerce_text_arg(dataset_path).strip()
    if not cleaned:
        return {}
    resolved = _resolve_workspace_data_path(workspace_root, cleaned)
    if not resolved.exists():
        return {"path": cleaned}
    stat = resolved.stat()
    return {
        "path": _workspace_rel(resolved, workspace_root),
        "format": resolved.suffix.lower().lstrip("."),
        "size": stat.st_size,
        "updatedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "version": f"{int(stat.st_mtime)}-{stat.st_size}",
    }


def _build_dashboard_dataset_block(
    workspace_root: Path,
    dashboard_dataset_path: str,
    dataset_records: List[Dict[str, Any]],
    preview_rel_path: str,
) -> Dict[str, Any]:
    """Canonical dataset path plus browser-friendly preview rows (v1 JSON)."""
    base = _build_dataset_reference(workspace_root, dashboard_dataset_path)
    if not dataset_records:
        return base
    block = dict(base)
    block["previewPath"] = preview_rel_path
    block["rowCount"] = len(dataset_records)
    return block


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
            "dimension_field": _coerce_text_arg(raw.get("dimension_field")).strip(),
            "metric_field": _coerce_text_arg(raw.get("metric_field")).strip(),
            "aggregation": _coerce_text_arg(raw.get("aggregation"), "count").strip().lower() or "count",
            "numerator_field": _coerce_text_arg(raw.get("numerator_field")).strip(),
            "denominator_field": _coerce_text_arg(raw.get("denominator_field")).strip(),
            "series_field": _coerce_text_arg(raw.get("series_field")).strip(),
            "orientation": _coerce_text_arg(raw.get("orientation")).strip().lower(),
            "sort_by": _coerce_text_arg(raw.get("sort_by"), "y").strip().lower() or "y",
            "sort_direction": _coerce_text_arg(raw.get("sort_direction"), "desc").strip().lower() or "desc",
            "limit": _coerce_int_arg(raw.get("limit"), 0, minimum=0),
            "mode": _coerce_text_arg(raw.get("mode"), "lines+markers").strip(),
            "title": _coerce_text_arg(raw.get("title")).strip(),
            "x_title": _coerce_text_arg(raw.get("x_title")).strip(),
            "y_title": _coerce_text_arg(raw.get("y_title")).strip(),
            "question_answered": _coerce_text_arg(raw.get("question_answered")).strip(),
            "why_it_matters": _coerce_text_arg(raw.get("why_it_matters")).strip(),
            "highlight_rule": _coerce_text_arg(raw.get("highlight_rule")).strip(),
            "format": _coerce_text_arg(raw.get("format")).strip(),
            "interactive": _coerce_bool_arg(raw.get("interactive"), True),
            "layout_span": _coerce_text_arg(raw.get("layout_span"), "half").strip().lower() or "half",
            "layout_section": _coerce_text_arg(raw.get("layout_section"), "drivers").strip().lower() or "drivers",
            "static_reason": _coerce_text_arg(raw.get("static_reason")).strip(),
        }
    return normalized


def _schema_type_map(dataset_schema: List[Dict[str, Any]]) -> Dict[str, str]:
    return {
        _coerce_text_arg(item.get("name")).strip(): _coerce_text_arg(item.get("type")).strip().lower()
        for item in dataset_schema
        if isinstance(item, dict) and _coerce_text_arg(item.get("name")).strip()
    }


def _is_numeric_schema_type(type_name: str) -> bool:
    normalized = str(type_name or "").strip().lower()
    return any(
        token in normalized
        for token in ("int", "float", "double", "decimal", "numeric", "real", "bigint", "smallint")
    )


def _is_datetime_schema_type(dtype: str) -> bool:
    normalized = dtype.lower()
    return "date" in normalized or "time" in normalized


def _build_dashboard_chart_specs(
    normalized_bindings: Dict[int, Dict[str, Any]],
    dataset_schema: List[Dict[str, Any]],
) -> Dict[int, Dict[str, Any]]:
    schema_types = _schema_type_map(dataset_schema)
    normalized_specs: Dict[int, Dict[str, Any]] = {}
    for chart_index, binding in normalized_bindings.items():
        x_field = _coerce_text_arg(binding.get("x_field")).strip()
        y_field = _coerce_text_arg(binding.get("y_field")).strip()
        dimension_field = _coerce_text_arg(binding.get("dimension_field")).strip() or x_field
        metric_field = _coerce_text_arg(binding.get("metric_field")).strip() or y_field
        orientation = _coerce_text_arg(binding.get("orientation")).strip().lower()
        numerator_field = _coerce_text_arg(binding.get("numerator_field")).strip()
        denominator_field = _coerce_text_arg(binding.get("denominator_field")).strip()

        if orientation == "h" and x_field and y_field:
            x_is_numeric = _is_numeric_schema_type(schema_types.get(x_field, ""))
            y_is_numeric = _is_numeric_schema_type(schema_types.get(y_field, ""))
            if x_is_numeric and not y_is_numeric:
                dimension_field = y_field
                metric_field = x_field

        aggregation = _coerce_text_arg(binding.get("aggregation"), "count").strip().lower() or "count"
        if numerator_field and denominator_field and aggregation in {"avg", "mean"}:
            aggregation = "ratio"

        live_capable = bool(
            dimension_field
            and (
                aggregation == "count"
                or metric_field
                or (numerator_field and denominator_field)
            )
        )
        chart_id = _coerce_text_arg(binding.get("chart_id"), f"chart_{chart_index}").strip() or f"chart_{chart_index}"
        normalized_specs[chart_index] = {
            "chartId": chart_id,
            "chartIndex": chart_index,
            "chartType": _coerce_text_arg(binding.get("chart_type"), "bar").strip().lower() or "bar",
            "dimensionField": dimension_field,
            "metricField": metric_field,
            "numeratorField": numerator_field,
            "denominatorField": denominator_field,
            "aggregation": aggregation,
            "orientation": orientation,
            "seriesField": _coerce_text_arg(binding.get("series_field")).strip(),
            "sort": {
                "by": _coerce_text_arg(binding.get("sort_by"), "y").strip().lower() or "y",
                "direction": _coerce_text_arg(binding.get("sort_direction"), "desc").strip().lower() or "desc",
            },
            "limit": _coerce_int_arg(binding.get("limit"), 0, minimum=0),
            "mode": _coerce_text_arg(binding.get("mode"), "lines+markers").strip(),
            "labels": {
                "title": _coerce_text_arg(binding.get("title")).strip(),
                "x": _coerce_text_arg(binding.get("x_title")).strip(),
                "y": _coerce_text_arg(binding.get("y_title")).strip(),
            },
            "questionAnswered": _coerce_text_arg(binding.get("question_answered")).strip(),
            "whyItMatters": _coerce_text_arg(binding.get("why_it_matters")).strip(),
            "highlightRule": _coerce_text_arg(binding.get("highlight_rule")).strip(),
            "format": _coerce_text_arg(binding.get("format")).strip(),
            "interactive": _coerce_bool_arg(binding.get("interactive"), True),
            "layoutSpan": _coerce_text_arg(binding.get("layout_span"), "half").strip().lower() or "half",
            "layoutSection": _coerce_text_arg(binding.get("layout_section"), "drivers").strip().lower() or "drivers",
            "filters": list(binding.get("filters") or []),
            "liveCapable": live_capable,
            "staticOnly": not live_capable,
            "staticReason": _coerce_text_arg(binding.get("static_reason")).strip(),
        }
    return normalized_specs


def _validate_dashboard_runtime_config(
    *,
    filter_config: List[Dict[str, Any]],
    chart_bindings: Dict[int, Dict[str, Any]],
    dataset_schema: List[Dict[str, Any]],
) -> List[str]:
    errors: List[str] = []
    fields = _schema_type_map(dataset_schema)
    field_names = set(fields)

    for filter_def in filter_config:
        field = _coerce_text_arg(filter_def.get("field")).strip()
        if field and field not in field_names:
            errors.append(f"Filter field '{field}' is not present in the dashboard dataset.")

    for chart_index, binding in sorted(chart_bindings.items()):
        prefix = f"Chart {chart_index}"
        chart_type = _coerce_text_arg(binding.get("chart_type")).strip().lower()
        aggregation = _coerce_text_arg(binding.get("aggregation")).strip().lower()
        x_field = _coerce_text_arg(binding.get("x_field")).strip()
        y_field = _coerce_text_arg(binding.get("y_field")).strip()
        dimension_field = _coerce_text_arg(binding.get("dimension_field")).strip() or x_field
        metric_field = _coerce_text_arg(binding.get("metric_field")).strip() or y_field
        numerator_field = _coerce_text_arg(binding.get("numerator_field")).strip()
        denominator_field = _coerce_text_arg(binding.get("denominator_field")).strip()
        series_field = _coerce_text_arg(binding.get("series_field")).strip()
        sort_by = _coerce_text_arg(binding.get("sort_by")).strip().lower()
        sort_direction = _coerce_text_arg(binding.get("sort_direction")).strip().lower()
        orientation = _coerce_text_arg(binding.get("orientation")).strip().lower()

        if chart_type not in NATIVE_DASHBOARD_CHART_TYPES:
            errors.append(
                f"{prefix} uses unsupported chart_type '{chart_type}'. "
                f"Use one of: {', '.join(sorted(NATIVE_DASHBOARD_CHART_TYPES))}."
            )
        if aggregation not in NATIVE_DASHBOARD_AGGREGATIONS and not (numerator_field and denominator_field):
            errors.append(
                f"{prefix} uses unsupported aggregation '{aggregation}'. "
                f"Use one of: {', '.join(sorted(NATIVE_DASHBOARD_AGGREGATIONS))}."
            )
        if sort_by not in NATIVE_DASHBOARD_SORT_FIELDS:
            errors.append(f"{prefix} sort_by must be 'x' or 'y'.")
        if sort_direction not in NATIVE_DASHBOARD_SORT_DIRECTIONS:
            errors.append(f"{prefix} sort_direction must be 'asc' or 'desc'.")
        if orientation not in NATIVE_DASHBOARD_ORIENTATIONS:
            errors.append(f"{prefix} orientation must be '', 'h', or 'v'.")
        if not dimension_field:
            errors.append(f"{prefix} is missing x_field or dimension_field.")
        elif dimension_field not in field_names:
            errors.append(f"{prefix} dimension field '{dimension_field}' is not present in the dashboard dataset.")
        if aggregation != "count" and not numerator_field and not denominator_field:
            if not metric_field:
                errors.append(f"{prefix} is missing y_field or metric_field for aggregation '{aggregation}'.")
            elif metric_field not in field_names:
                errors.append(f"{prefix} metric field '{metric_field}' is not present in the dashboard dataset.")
        for role, field in (
            ("numerator_field", numerator_field),
            ("denominator_field", denominator_field),
            ("series_field", series_field),
        ):
            if field and field not in field_names:
                errors.append(f"{prefix} {role} '{field}' is not present in the dashboard dataset.")
        if series_field and series_field == dimension_field:
            errors.append(f"{prefix} uses the same field for dimension and series; choose a different grouping.")
        if chart_type in {"line", "area", "scatter"} and dimension_field and _is_datetime_schema_type(fields.get(dimension_field, "")):
            if sort_by != "x" or sort_direction != "asc":
                errors.append(f"{prefix} is time-based and must use sort_by='x' with sort_direction='asc'.")

    return errors


_GENERIC_DASHBOARD_TITLE_TOKENS = {
    "chart",
    "overview",
    "analysis",
    "trends",
    "breakdown",
    "geographic trends",
    "top categories",
    "browser/device segmentation",
    "country comparison",
}


def _looks_schema_like_title(value: str) -> bool:
    normalized = re.sub(r"\s+", " ", _coerce_text_arg(value).strip().lower())
    if not normalized:
        return True
    if normalized in _GENERIC_DASHBOARD_TITLE_TOKENS:
        return True
    return bool(re.fullmatch(r"[a-z0-9_ /-]+", normalized) and "_" in normalized)


def _validate_dashboard_spec_inputs(
    *,
    strict_dashboard_mode: bool,
    dashboard_dataset_path: str,
    audience: str,
    business_question: str,
    decision_questions: List[str],
    layout_template: str,
    metric_cards: List[Dict[str, str]],
    chart_specs: Dict[int, Dict[str, Any]],
) -> Optional[str]:
    if not strict_dashboard_mode:
        return None
    if not chart_specs:
        return (
            "Dashboard package incomplete: no structured charts were provided. "
            "Pass approved chart bindings so the live runtime has charts to render."
        )
    if not _coerce_text_arg(dashboard_dataset_path).strip():
        return (
            "Dashboard package incomplete: dashboard_dataset_path is required so the native runtime "
            "can persist dashboard.rows.json for the canvas."
        )
    if not audience.strip():
        return "Dashboard spec incomplete: audience is required for executive dashboard mode."
    if not business_question.strip():
        return "Dashboard spec incomplete: business_question is required for executive dashboard mode."
    if not decision_questions:
        return "Dashboard spec incomplete: provide at least one decision question for executive dashboard mode."
    if not layout_template.strip():
        return "Dashboard spec incomplete: layout_template is required for executive dashboard mode."
    if not metric_cards or len(metric_cards) > 3:
        return "Dashboard spec incomplete: provide 2 to 3 KPI cards for the executive hero."
    if len(chart_specs) < STRICT_DASHBOARD_MIN_CHART_COUNT or len(chart_specs) > MAX_CHART_COUNT:
        return (
            f"Dashboard spec incomplete: provide {STRICT_DASHBOARD_MIN_CHART_COUNT} to {MAX_CHART_COUNT} "
            "structured charts for executive dashboard mode."
        )
    for chart_spec in chart_specs.values():
        title = _coerce_text_arg((chart_spec.get("labels") or {}).get("title"))
        if _looks_schema_like_title(title):
            return (
                "Dashboard spec validation failed: chart titles must be business-readable and insight-led, "
                f"not generic placeholders ('{title or 'untitled'}')."
            )
        if not _coerce_text_arg(chart_spec.get("questionAnswered")).strip():
            return f"Dashboard spec validation failed: {title} is missing questionAnswered."
        if not _coerce_text_arg(chart_spec.get("whyItMatters")).strip():
            return f"Dashboard spec validation failed: {title} is missing whyItMatters."
    return None


def _emit_dashboard_artifact(
    callbacks: Optional[CallbackManagerForToolRun],
    payload: Dict[str, Any],
) -> None:
    if not callbacks or not payload:
        return
    try:
        run_id = getattr(callbacks, "run_id", None)
        if run_id is not None:
            callbacks.on_custom_event("dashboard_artifact", payload, run_id=run_id)
        else:
            callbacks.on_custom_event("dashboard_artifact", payload)
    except Exception:  # pragma: no cover - best effort
        logger.warning("Failed to dispatch dashboard_artifact event", exc_info=True)


def create_dashboard_tools(db_manager: DuckDBManager, workspace_state: WorkspaceState):
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
        if str(workspace_state.context.get("active_skill") or "").strip() == "data/dashboard":
            return (
                "The active skill is data/dashboard. Stay on the dashboard path: request plan approval, "
                "generate the approved charts, then call generate_dashboard."
            )
        if db_manager.session.query_count == 0:
            return "Run at least one SQL query before summarizing the findings."
        try:
            db_manager.ensure_single_summary()
        except ValueError as exc:
            return str(exc)
        db_manager.mark_summary_generated()
        generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        materialization_items: List[str] = []
        query_items: List[str] = []
        visualization_items: List[str] = []

        if db_manager.session.materialization_history:
            for item in db_manager.session.materialization_history:
                materialization_items.append(
                    "<article class=\"stack-item\">"
                    f"<div class=\"stack-meta\">Connector {html.escape(item.connector)} • Rows {item.row_count} • Cached {'yes' if item.cached else 'no'}</div>"
                    f"<p><strong>Parquet:</strong> <code>{html.escape(item.parquet_path)}</code><br />"
                    f"<strong>Metadata:</strong> <code>{html.escape(item.metadata_path)}</code><br />"
                    f"<strong>Expires:</strong> {html.escape(item.expires_at or 'n/a')}</p>"
                    f"<pre><code>{html.escape(item.sql)}</code></pre>"
                    "</article>"
                )

        if db_manager.session.query_history:
            for idx, query_record in enumerate(db_manager.session.query_history, start=1):
                row_label = (
                    f"{query_record.row_count}+ rows previewed"
                    if query_record.truncated
                    else f"{query_record.row_count} rows"
                )
                query_block = [
                    "<article class=\"stack-item\">",
                    f"<div class=\"stack-meta\">Query {idx} • {row_label}</div>",
                    f"<pre><code>{html.escape(query_record.sql)}</code></pre>",
                ]
                if not query_record.preview.empty:
                    query_block.append("<h4>Sample Data</h4>")
                    query_block.append(query_record.preview.to_html(index=False, border=0))
                query_block.append("</article>")
                query_items.append("".join(query_block))

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
            for idx, json_path in enumerate(plotly_json_files, start=1):
                try:
                    fig_json = json.loads(json_path.read_text(encoding="utf-8"))
                    script_payload = json.dumps(fig_json)
                    div_id = f"plotly-json-{idx}"
                    visualization_items.append(
                        "<article class=\"stack-item\">"
                        f"<h3>{_chart_title_from_path(json_path)}</h3>"
                        f"<div id=\"{div_id}\" class=\"plotly-embed\"></div>"
                        "<script>"
                        f"const spec{idx} = {script_payload};"
                        f"const data{idx} = spec{idx}.data || []; const layout{idx} = spec{idx}.layout || {{}}; const config{idx} = spec{idx}.config || {{}}; const frames{idx} = spec{idx}.frames || undefined;"
                        f"Plotly.newPlot('{div_id}', data{idx}, layout{idx}, config{idx}).then(() => {{ if (frames{idx} && frames{idx}.length) {{ Plotly.addFrames('{div_id}', frames{idx}); }} }});"
                        "</script>"
                        "</article>"
                    )
                except Exception:
                    logger.warning("Failed to embed Plotly JSON %s", json_path, exc_info=True)

            for html_path in plotly_html_files:
                try:
                    html_fragment = html_path.read_text(encoding="utf-8")
                    visualization_items.append(
                        "<article class=\"stack-item\">"
                        f"<h3>{_chart_title_from_path(html_path)}</h3>"
                        f"<div class=\"plotly-embed\">{html_fragment}</div>"
                        "</article>"
                    )
                except Exception:
                    logger.warning("Failed to embed Plotly HTML %s", html_path, exc_info=True)

            for png_path in png_files:
                try:
                    encoded = base64.b64encode(png_path.read_bytes()).decode("utf-8")
                    visualization_items.append(
                        "<article class=\"stack-item\">"
                        f"<h3>{_chart_title_from_path(png_path)}</h3>"
                        f"<img src=\"data:image/png;base64,{encoded}\" alt=\"{png_path.stem}\" />"
                        "</article>"
                    )
                except Exception:
                    logger.warning("Failed to embed PNG %s", png_path, exc_info=True)
        summary_metric_cards = [
            {
                "label": "Queries Run",
                "value": str(len(db_manager.session.query_history)),
                "meta": "SQL steps captured in this report",
            },
            {
                "label": "Charts Embedded",
                "value": str(len(visualization_items)),
                "meta": "Visual artifacts included below",
            },
            {
                "label": "Warehouse Pulls",
                "value": str(len(db_manager.session.materialization_history)),
                "meta": "Materializations cached or refreshed",
            },
        ]
        if db_manager.session.query_history:
            latest_query = db_manager.session.query_history[-1]
            summary_metric_cards.append(
                {
                    "label": "Latest Result",
                    "value": str(latest_query.row_count),
                    "meta": "Rows in the final SQL step",
                }
            )

        report_html = _compat_render_summary_html(
            title="Data Analysis Report",
            generated_at=generated_at,
            summary_html=_markdown_to_html(summary),
            insights_html=_markdown_to_html(insights),
            metric_cards=summary_metric_cards,
            materialization_items=materialization_items,
            query_items=query_items,
            visualization_items=visualization_items,
        )

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
            report_path.write_text(report_html, encoding="utf-8")

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
        audience: Annotated[
            str,
            Field(description="Primary audience for this dashboard, such as Ops leadership or the Board."),
        ] = "",
        business_question: Annotated[
            str,
            Field(description="The core business question this dashboard answers."),
        ] = "",
        decision_questions: Annotated[
            Optional[List[str]],
            Field(description="Ordered list of the decisions or questions the dashboard should help answer."),
        ] = None,
        layout_template: Annotated[
            str,
            Field(description="Named layout template to use for the dashboard, such as executive_driver_dashboard."),
        ] = "executive_driver_dashboard",
        hero_eyebrow: Annotated[
            str,
            Field(description="Optional short eyebrow label displayed above the dashboard title."),
        ] = "Interactive Dashboard",
        headline_takeaway: Annotated[
            str,
            Field(description="Optional one-line headline takeaway shown in the hero section."),
        ] = "",
        insights: Annotated[
            Optional[List[str]],
            Field(description="Optional list of executive takeaways rendered near the top of the dashboard."),
        ] = None,
        known_risks: Annotated[
            Optional[List[str]],
            Field(description="Optional list of known dashboard caveats or risks."),
        ] = None,
        data_quality_notes: Annotated[
            Optional[List[str]],
            Field(description="Optional list of data quality or normalization notes."),
        ] = None,
        section_titles: Annotated[
            Optional[List[str]],
            Field(description="Optional ordered list of section headings, one per chart produced in this run."),
        ] = None,
        output_path: Annotated[
            str,
            Field(description="Optional stable dashboard package path such as dashboards/orders_overview or dashboards/orders_overview/."),
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
        metric_cards: Annotated[
            Optional[List[Dict[str, Any]]],
            Field(
                description=(
                    "Optional KPI cards for the hero section. Each item may include label, value, and meta."
                )
            ),
        ] = None,
        callbacks: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Assemble chart bindings and rows into one native dashboard package."""
        if _is_strict_dashboard_mode(workspace_state) and not _is_plan_approved(workspace_state):
            return _dashboard_plan_gate_message()
        try:
            db_manager.ensure_single_dashboard()
        except ValueError as exc:
            return str(exc)
        normalized_bindings = _normalize_chart_bindings(chart_bindings)
        filter_config = _normalize_filter_schema(filter_schema)
        has_native_dataset_dashboard = bool(
            dashboard_dataset_path.strip()
            and normalized_bindings
        )

        if db_manager.session.query_count == 0 and not has_native_dataset_dashboard:
            return "Run at least one SQL query before building a dashboard."
        strict_dashboard_mode = _is_strict_dashboard_mode(workspace_state)
        if strict_dashboard_mode and len(normalized_bindings) < STRICT_DASHBOARD_MIN_CHART_COUNT:
            return (
                "Dashboard plan incomplete: pass 3 to 5 approved chart bindings to generate_dashboard "
                "before building the dashboard package."
            )
        if strict_dashboard_mode and not _coerce_text_arg(dashboard_dataset_path).strip():
            return "Dashboard mode requires dashboard_dataset_path so the native renderer can persist dashboard.rows.json."
        if not db_manager.session.chart_history and not has_native_dataset_dashboard:
            return (
                "Provide dashboard_dataset_path, filter_schema, and chart_bindings so the native dashboard "
                "package can include data/dashboard.rows.json."
            )
        if strict_dashboard_mode and len(normalized_bindings) > MAX_CHART_COUNT:
            return (
                f"Dashboard plan too large: at most {MAX_CHART_COUNT} approved charts are allowed per dashboard package."
            )

        stable_title = _safe_slug(title, "dashboard")
        dashboard_dir = _resolve_workspace_dashboard_dir(
            workspace_state.root_path,
            output_path,
            default_dir="dashboards",
            default_stem=stable_title,
        )
        dashboard_rel_path = _workspace_rel(dashboard_dir, workspace_state.root_path)
        dashboard_meta_path = dashboard_dir / "dashboard.meta.json"
        dashboard_spec_path = dashboard_dir / "dashboard.spec.json"
        dashboard_meta_rel_path = _workspace_rel(dashboard_meta_path, workspace_state.root_path)
        dashboard_spec_rel_path = _workspace_rel(dashboard_spec_path, workspace_state.root_path)
        dashboard_data_dir = dashboard_dir / "data"
        dashboard_rows_path = dashboard_data_dir / "dashboard.rows.json"
        dashboard_rows_rel_path = _workspace_rel(dashboard_rows_path, workspace_state.root_path)

        chart_entries: List[Dict[str, Any]] = []
        chart_entries_by_index: Dict[int, Dict[str, Any]] = {}
        chosen_titles = list(section_titles or [])

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
            chart_entry = (
                {
                    "chart_index": chart_index,
                    "title": section_title,
                    "path": preferred_path,
                    "kind": preferred_kind,
                    "binding": normalized_bindings.get(chart_index),
                }
            )
            chart_entries.append(chart_entry)
            chart_entries_by_index[chart_index] = chart_entry

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
        elif db_manager.session.query_history:
            dataset_records, dataset_schema = _coerce_dataframe_dashboard_rows(
                db_manager.session.query_history[-1].preview
            )
            dataset_format = "query_preview"
        if strict_dashboard_mode and not dataset_records:
            return (
                "Dashboard mode could not load the canonical dataset. "
                "Confirm dashboard_dataset_path points to a valid workspace CSV, Parquet, or JSON artifact."
            )
        if dataset_records and normalized_bindings:
            validation_errors = _validate_dashboard_runtime_config(
                filter_config=filter_config,
                chart_bindings=normalized_bindings,
                dataset_schema=dataset_schema,
            )
            if validation_errors:
                return "Dashboard chart binding validation failed:\n- " + "\n- ".join(validation_errors)

        normalized_chart_specs = _build_dashboard_chart_specs(normalized_bindings, dataset_schema)
        normalized_decision_questions = [
            _coerce_text_arg(item).strip() for item in (decision_questions or []) if _coerce_text_arg(item).strip()
        ]
        normalized_insights = [
            _coerce_text_arg(item).strip() for item in (insights or []) if _coerce_text_arg(item).strip()
        ]
        normalized_known_risks = [
            _coerce_text_arg(item).strip() for item in (known_risks or []) if _coerce_text_arg(item).strip()
        ]
        normalized_data_quality_notes = [
            _coerce_text_arg(item).strip() for item in (data_quality_notes or []) if _coerce_text_arg(item).strip()
        ]
        workspace_id = _coerce_text_arg(getattr(workspace_state, "workspace_id", "")).strip() or "workspace"
        dashboard_id = uuid4().hex
        dashboard_meta: Dict[str, Any] = {
            "dashboardId": dashboard_id,
            "slug": stable_title,
            "title": title,
            "specVersion": 2,
            "runtimeKind": "native",
            "createdAt": _utc_now().isoformat(),
            "updatedAt": _utc_now().isoformat(),
            "status": "generating",
            "specPath": dashboard_spec_rel_path,
            "metaPath": dashboard_meta_rel_path,
            "datasetRef": _build_dataset_reference(workspace_state.root_path, dashboard_dataset_path),
        }
        dashboard_dir.mkdir(parents=True, exist_ok=True)
        dashboard_meta_path.write_text(_json_dump(dashboard_meta), encoding="utf-8")
        _emit_dashboard_artifact(
            callbacks,
            {
                "dashboardPath": dashboard_rel_path,
                "workspaceId": workspace_id,
                "dashboardId": dashboard_id,
                "title": title,
                "status": "generating",
            },
        )

        bound_cards: List[str] = []
        static_cards: List[str] = []
        chart_runtime_defs: List[Dict[str, Any]] = []
        normalized_dashboard_charts: List[Dict[str, Any]] = []
        dataset_backed_charts_enabled = bool(dataset_records)
        approved_chart_count = max(len(normalized_chart_specs), len(chart_entries))

        for chart_index in range(1, approved_chart_count + 1):
            entry = chart_entries_by_index.get(chart_index)
            chart_spec = normalized_chart_specs.get(chart_index) or {}
            binding = normalized_bindings.get(chart_index) or {}
            section_title = (
                _coerce_text_arg((chart_spec.get("labels") or {}).get("title"))
                or _coerce_text_arg(binding.get("title"))
                or (entry or {}).get("title")
                or (chosen_titles[chart_index - 1] if chart_index - 1 < len(chosen_titles) else "")
                or f"Chart {chart_index}"
            )

            if chart_spec:
                normalized_dashboard_charts.append(
                    {
                        **chart_spec,
                        "title": section_title,
                    }
                )

            binding_is_compatible = bool(
                dataset_backed_charts_enabled
                and chart_spec
                and chart_spec.get("liveCapable")
            )
            if binding_is_compatible:
                div_id = f"dashboard-chart-{chart_index}"
                chart_runtime_defs.append(
                    {
                        "chartId": chart_spec.get("chartId") or f"chart_{chart_index}",
                        "chartIndex": chart_index,
                        "divId": div_id,
                        "title": section_title,
                        "chartType": chart_spec.get("chartType") or "bar",
                        "dimensionField": chart_spec.get("dimensionField") or "",
                        "metricField": chart_spec.get("metricField") or "",
                        "numeratorField": chart_spec.get("numeratorField") or "",
                        "denominatorField": chart_spec.get("denominatorField") or "",
                        "xField": chart_spec.get("dimensionField") or "",
                        "yField": chart_spec.get("metricField") or "",
                        "aggregation": chart_spec.get("aggregation") or "count",
                        "seriesField": chart_spec.get("seriesField") or "",
                        "orientation": chart_spec.get("orientation") or "",
                        "sortBy": ((chart_spec.get("sort") or {}).get("by")) or "y",
                        "sortDirection": ((chart_spec.get("sort") or {}).get("direction")) or "desc",
                        "limit": chart_spec.get("limit") or 0,
                        "mode": chart_spec.get("mode") or "lines+markers",
                        "xTitle": ((chart_spec.get("labels") or {}).get("x")) or "",
                        "yTitle": ((chart_spec.get("labels") or {}).get("y")) or "",
                    }
                )
                chart_descriptor = "Filter-aware chart bound to the canonical dashboard dataset" if data_filtering_enabled else "Interactive chart bound to the canonical dashboard dataset"
                bound_cards.append(
                    f"<article class=\"chart-card filter-aware\" data-chart-index=\"{chart_index}\">"
                    f"<h3>{html.escape(section_title)}</h3>"
                    f"<p class=\"chart-meta\">{html.escape(chart_descriptor)}</p>"
                    f"<div id=\"{div_id}\" class=\"plotly-embed\"></div>"
                    f"<p class=\"chart-note\" id=\"{div_id}-status\"></p>"
                    f"</article>"
                )
                continue

            if not entry:
                continue

            chart_path = entry["path"]
            chart_kind = entry["kind"]
            static_reason = (
                _coerce_text_arg(chart_spec.get("staticReason") or binding.get("static_reason"))
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
        generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        hero_meta = (
            f"Charts embedded: {len(bound_cards) + len(static_cards)} • "
            f"Queries embedded: {len(db_manager.session.query_history)}"
        )
        normalized_metric_cards: List[Dict[str, str]] = []
        for raw_card in metric_cards or []:
            if not isinstance(raw_card, dict):
                continue
            label = _coerce_text_arg(raw_card.get("label")).strip()
            value = _coerce_text_arg(raw_card.get("value")).strip()
            meta = _coerce_text_arg(raw_card.get("meta")).strip()
            if not label or not value:
                continue
            normalized_metric_cards.append({"label": label, "value": value, "meta": meta})
        dashboard_metric_cards = normalized_metric_cards[:3] if normalized_metric_cards else [
            {
                "label": "Charts",
                "value": str(len(chart_runtime_defs) or len(normalized_dashboard_charts)),
                "meta": "Approved visuals in the dashboard package",
            },
            {
                "label": "Shared Filters",
                "value": str(len(filter_config)),
                "meta": "Controls applied across the dashboard dataset",
            },
            {
                "label": "Dataset Rows",
                "value": str(len(dataset_records)) if dataset_records else "n/a",
                "meta": "Canonical dataset rows available to the native renderer",
            },
        ]
        validation_error = _validate_dashboard_spec_inputs(
            strict_dashboard_mode=strict_dashboard_mode,
            dashboard_dataset_path=dashboard_dataset_path,
            audience=audience,
            business_question=business_question,
            decision_questions=normalized_decision_questions,
            layout_template=layout_template,
            metric_cards=dashboard_metric_cards,
            chart_specs=normalized_chart_specs,
        )
        if validation_error:
            dashboard_meta.update(
                {
                    "updatedAt": _utc_now().isoformat(),
                    "status": "error",
                }
            )
            dashboard_meta_path.write_text(_json_dump(dashboard_meta), encoding="utf-8")
            _emit_dashboard_artifact(
                callbacks,
                {
                    "dashboardPath": dashboard_rel_path,
                    "workspaceId": workspace_id,
                    "dashboardId": dashboard_id,
                    "title": title,
                    "status": "error",
                },
            )
            return validation_error
        preview_rel_written = ""
        if dataset_records:
            dashboard_data_dir.mkdir(parents=True, exist_ok=True)
            dashboard_rows_path.write_text(_json_dump({"rows": dataset_records}), encoding="utf-8")
            preview_rel_written = dashboard_rows_rel_path
        if normalized_chart_specs and not preview_rel_written:
            dashboard_meta.update(
                {
                    "updatedAt": _utc_now().isoformat(),
                    "status": "error",
                }
            )
            try:
                dashboard_meta_path.write_text(_json_dump(dashboard_meta), encoding="utf-8")
            except Exception:
                logger.warning("Failed to persist dashboard error manifest", exc_info=True)
            _emit_dashboard_artifact(
                callbacks,
                {
                    "dashboardPath": dashboard_rel_path,
                    "workspaceId": workspace_id,
                    "dashboardId": dashboard_id,
                    "title": title,
                    "status": "error",
                },
            )
            return (
                "Dashboard package incomplete: data/dashboard.rows.json was not written. "
                "Provide a valid dashboard_dataset_path so the native canvas can load the dashboard."
            )
        dataset_block = _build_dashboard_dataset_block(
            workspace_state.root_path,
            dashboard_dataset_path,
            dataset_records,
            preview_rel_written,
        )
        dashboard_spec = {
            "version": 2,
            "dashboardId": dashboard_id,
            "runtimeKind": "native",
            "slug": stable_title,
            "title": title,
            "audience": audience,
            "businessQuestion": business_question,
            "decisionQuestions": normalized_decision_questions,
            "description": description,
            "generatedAt": generated_at,
            "dashboardPath": dashboard_rel_path,
            "specPath": dashboard_spec_rel_path,
            "metaPath": dashboard_meta_rel_path,
            "heroMeta": hero_meta,
            "highlightsHeading": "Decision Drivers" if bound_cards else "Charts",
            "hero": {
                "eyebrow": hero_eyebrow,
                "description": description,
                "headlineTakeaway": headline_takeaway,
                "kpis": dashboard_metric_cards,
            },
            "filters": filter_config,
            "charts": normalized_dashboard_charts,
            "chartRuntimeDefs": chart_runtime_defs,
            "metricCards": dashboard_metric_cards,
            "layout": {
                "template": layout_template,
                "gridColumns": 2,
                "maxFirstScreenVisuals": 5,
            },
            "insights": normalized_insights,
            "knownRisks": normalized_known_risks,
            "dataQualityNotes": normalized_data_quality_notes,
            "dataset": dataset_block,
            "datasetRef": dataset_block,
            "datasetSchema": dataset_schema,
            "fallbackMode": "native_only",
        }

        try:
            dashboard_dir.mkdir(parents=True, exist_ok=True)
            dashboard_spec_path.write_text(_json_dump(dashboard_spec), encoding="utf-8")
            stale_snapshot_path = dashboard_dir / "dashboard.snapshot.html"
            if stale_snapshot_path.exists():
                stale_snapshot_path.unlink()
            dashboard_meta.update(
                {
                    "updatedAt": _utc_now().isoformat(),
                    "status": "ready",
                    "runtimeKind": "native",
                    "specVersion": 2,
                    "datasetRef": dashboard_spec.get("dataset") or {},
                }
            )
            dashboard_meta_path.write_text(_json_dump(dashboard_meta), encoding="utf-8")
            db_manager.mark_dashboard_generated()
            artifacts_out: List[Dict[str, Any]] = [
                {
                    "path": dashboard_meta_rel_path,
                    "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".json"],
                    "size": dashboard_meta_path.stat().st_size,
                },
                {
                    "path": dashboard_spec_rel_path,
                    "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".json"],
                    "size": dashboard_spec_path.stat().st_size,
                },
            ]
            if preview_rel_written:
                artifacts_out.append(
                    {
                        "path": preview_rel_written,
                        "mimeType": ALLOWED_ARTIFACT_EXTENSIONS[".json"],
                        "size": dashboard_rows_path.stat().st_size,
                    }
                )
            for art in artifacts_out:
                db_manager.register_artifact(art)
            _emit_artifacts(callbacks, artifacts_out)
            _emit_dashboard_artifact(
                callbacks,
                {
                    "dashboardPath": dashboard_rel_path,
                    "workspaceId": workspace_id,
                    "dashboardId": dashboard_id,
                    "title": title,
                    "status": "ready",
                },
            )
            return f"Dashboard package saved to: {dashboard_rel_path}"
        except Exception as exc:  # pragma: no cover - defensive
            dashboard_meta.update(
                {
                    "updatedAt": _utc_now().isoformat(),
                    "status": "error",
                }
            )
            try:
                dashboard_dir.mkdir(parents=True, exist_ok=True)
                dashboard_meta_path.write_text(_json_dump(dashboard_meta), encoding="utf-8")
            except Exception:
                logger.warning("Failed to persist dashboard error manifest", exc_info=True)
            _emit_dashboard_artifact(
                callbacks,
                {
                    "dashboardPath": dashboard_rel_path,
                    "workspaceId": workspace_id,
                    "dashboardId": dashboard_id,
                    "title": title,
                    "status": "error",
                },
            )
            logger.warning("Failed to save dashboard package: %s", exc)
            return f"Failed to save dashboard package: {exc}"

    return [generate_summary, generate_dashboard]
