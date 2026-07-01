from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd

from _data_common import (
    infer_schema,
    json_dump,
    normalize_rel_path,
    read_request,
    resolve_output_path,
    safe_slug,
    utc_now,
    workspace_root,
    write_out_json,
)


def load_rows(dataset_path: str, request: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    raw_rows = request.get("rows")
    if isinstance(raw_rows, list):
        rows = [row for row in raw_rows if isinstance(row, dict)]
        return rows, infer_schema(rows)
    if not dataset_path:
        return [], []
    path = workspace_root() / normalize_rel_path(dataset_path)
    if not path.is_file():
        raise SystemExit(f"dashboard dataset not found: {dataset_path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(path)
    elif suffix == ".parquet":
        df = pd.read_parquet(path)
    elif suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
            df = pd.DataFrame(payload["rows"])
        elif isinstance(payload, list):
            df = pd.DataFrame(payload)
        else:
            raise SystemExit("dashboard JSON dataset must be an array or {rows: [...]}")
    else:
        raise SystemExit("dashboard dataset must be CSV, Parquet, or JSON")
    rows = json.loads(df.to_json(orient="records", date_format="iso"))
    return rows, [{"name": str(name), "type": str(dtype)} for name, dtype in df.dtypes.items()]


def normalize_filters(raw: Any) -> list[dict[str, Any]]:
    filters = raw if isinstance(raw, list) else []
    normalized: list[dict[str, Any]] = []
    for item in filters:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field") or "").strip()
        if not field:
            continue
        normalized.append({
            "id": str(item.get("id") or field).strip(),
            "field": field,
            "type": str(item.get("type") or "categorical").strip(),
            "label": str(item.get("label") or field).strip(),
            "multi": bool(item.get("multi", True)),
        })
    return normalized


def normalize_chart_defs(raw: Any) -> list[dict[str, Any]]:
    bindings = raw if isinstance(raw, list) else []
    defs: list[dict[str, Any]] = []
    for idx, item in enumerate(bindings, start=1):
        if not isinstance(item, dict):
            continue
        chart_index = int(item.get("chart_index") or item.get("chartIndex") or idx)
        x_field = str(item.get("x_field") or item.get("xField") or item.get("dimension_field") or item.get("dimensionField") or "").strip()
        y_field = str(item.get("y_field") or item.get("yField") or item.get("metric_field") or item.get("metricField") or "").strip()
        defs.append({
            "chartId": str(item.get("chart_id") or item.get("chartId") or f"chart_{chart_index}"),
            "chartIndex": chart_index,
            "divId": f"dashboard-chart-{chart_index}",
            "title": str(item.get("title") or f"Chart {chart_index}"),
            "chartType": str(item.get("chart_type") or item.get("chartType") or "bar"),
            "dimensionField": x_field,
            "metricField": y_field,
            "numeratorField": str(item.get("numerator_field") or item.get("numeratorField") or ""),
            "denominatorField": str(item.get("denominator_field") or item.get("denominatorField") or ""),
            "xField": x_field,
            "yField": y_field,
            "seriesField": str(item.get("series_field") or item.get("seriesField") or ""),
            "aggregation": str(item.get("aggregation") or "sum"),
            "orientation": str(item.get("orientation") or ""),
            "sortBy": str(item.get("sort_by") or item.get("sortBy") or "y"),
            "sortDirection": str(item.get("sort_direction") or item.get("sortDirection") or "desc"),
            "timeGrain": str(item.get("time_grain") or item.get("timeGrain") or ""),
            "limit": int(item.get("limit") or 0),
            "mode": str(item.get("mode") or "lines+markers"),
            "xTitle": str(item.get("x_title") or item.get("xTitle") or x_field),
            "yTitle": str(item.get("y_title") or item.get("yTitle") or y_field),
        })
    return defs


def dashboard_rel_path(request: dict[str, Any]) -> str:
    title = str(request.get("title") or "Dashboard")
    raw = str(request.get("output_path") or "").strip()
    if not raw:
        return f"dashboards/{safe_slug(title, 'dashboard')}"
    normalized = normalize_rel_path(raw)
    if normalized.endswith(".html") or normalized.endswith(".htm"):
        normalized = str(Path(normalized).with_suffix(""))
    return normalized.rstrip("/") or f"dashboards/{safe_slug(title, 'dashboard')}"


def main() -> None:
    request = read_request()
    title = str(request.get("title") or "Dashboard")
    description = str(request.get("description") or "")
    dataset_path = str(request.get("dashboard_dataset_path") or request.get("dataset_path") or "")
    rows, schema = load_rows(dataset_path, request)
    filters = normalize_filters(request.get("filter_schema") or request.get("filters"))
    chart_defs = normalize_chart_defs(request.get("chart_bindings") or request.get("chartRuntimeDefs"))
    rel = dashboard_rel_path(request)
    dashboard_id = uuid4().hex
    package_dir = resolve_output_path(f"{rel}/dashboard.meta.json").parent
    data_dir = package_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    rows_path = data_dir / "dashboard.rows.json"
    meta_path = package_dir / "dashboard.meta.json"
    spec_path = package_dir / "dashboard.spec.json"
    rows_rel = f"{rel}/data/dashboard.rows.json"
    meta_rel = f"{rel}/dashboard.meta.json"
    spec_rel = f"{rel}/dashboard.spec.json"

    rows_path.write_text(json_dump({"rows": rows}), encoding="utf-8")
    spec = {
        "version": 2,
        "dashboardId": dashboard_id,
        "runtimeKind": "native",
        "slug": package_dir.name,
        "title": title,
        "audience": str(request.get("audience") or ""),
        "businessQuestion": str(request.get("business_question") or request.get("businessQuestion") or ""),
        "decisionQuestions": request.get("decision_questions") or request.get("decisionQuestions") or [],
        "description": description,
        "generatedAt": utc_now(),
        "dashboardPath": rel,
        "specPath": spec_rel,
        "metaPath": meta_rel,
        "hero": {
            "eyebrow": str(request.get("hero_eyebrow") or "Interactive Dashboard"),
            "description": description,
            "headlineTakeaway": str(request.get("headline_takeaway") or ""),
            "kpis": request.get("metric_cards") or [],
        },
        "filters": filters,
        "charts": [],
        "chartRuntimeDefs": chart_defs,
        "metricCards": request.get("metric_cards") or [],
        "layout": {"template": str(request.get("layout_template") or "executive_driver_dashboard"), "gridColumns": 2},
        "insights": request.get("insights") or [],
        "knownRisks": request.get("known_risks") or [],
        "dataQualityNotes": request.get("data_quality_notes") or [],
        "dataset": {"path": dataset_path, "previewPath": rows_rel, "rowCount": len(rows), "format": Path(dataset_path).suffix.lstrip(".")},
        "datasetRef": {"path": dataset_path, "previewPath": rows_rel, "rowCount": len(rows), "format": Path(dataset_path).suffix.lstrip(".")},
        "datasetSchema": schema,
        "fallbackMode": "native_only",
    }
    spec_path.write_text(json_dump(spec), encoding="utf-8")
    meta = {
        "dashboardId": dashboard_id,
        "slug": package_dir.name,
        "title": title,
        "specVersion": 2,
        "runtimeKind": "native",
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "status": "ready",
        "dashboardPath": rel,
        "specPath": spec_rel,
        "metaPath": meta_rel,
        "datasetRef": spec["dataset"],
    }
    meta_path.write_text(json_dump(meta), encoding="utf-8")

    files = [
        {"path": meta_rel, "mimeType": "application/json", "size": meta_path.stat().st_size},
        {"path": spec_rel, "mimeType": "application/json", "size": spec_path.stat().st_size},
        {"path": rows_rel, "mimeType": "application/json", "size": rows_path.stat().st_size},
    ]
    dashboard_events = [
        {"dashboardPath": rel, "workspaceId": str(__import__("os").environ.get("HELPUDOC_WORKSPACE_ID") or ""), "dashboardId": dashboard_id, "title": title, "status": "ready"}
    ]
    write_out_json("tool_artifacts.json", {"files": files})
    write_out_json("dashboard_artifacts.json", {"dashboardArtifacts": dashboard_events})
    write_out_json("result.json", {"ok": True, "dashboardPath": rel, "files": files})
    print(json_dump({"ok": True, "dashboardPath": rel}))


if __name__ == "__main__":
    main()
