# Data Analytics Scripts

These scripts are the Data Analytics plugin's local execution surface. Skills call
`run_skill_python_script` with a JSON request payload; the sandbox runner mounts the
workspace read-only, stages script outputs under `out/`, and copies files written
under `HELPUDOC_WORKSPACE_OUTPUT_ROOT` back into the workspace.

Use `data_workspace.py` for schema inspection, DuckDB queries, profiling, and
CSV/Parquet exports. Use `build_chart_payload.py`, `build_report_payload.py`, and
the `data-artifacts` MCP for bounded chart/table/report payload validation and
rendering. Use `build_native_dashboard_package.py` only for native DashboardCanvas
packages; it must write `dashboard.meta.json`, `dashboard.spec.json`, and
`data/dashboard.rows.json`, and it must not generate `dashboard.snapshot.html`.

Operational rules carried forward from the old data-agent prompt:
- inspect schema or metadata before SQL;
- keep SQL focused, bounded, and source-backed;
- use BigQuery MCP for warehouse discovery/querying, then export scoped local data
  before repeated DuckDB slicing;
- make every insight traceable to concrete rows, aggregates, or source definitions;
- for dashboards, get approval first and build the native package from a canonical
  reusable row dataset.
