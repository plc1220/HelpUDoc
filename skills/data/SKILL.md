---
name: data
description: >
  Data analysis skill hub. Routes to the right specialist subskill depending on the
  request — exploration, query writing, end-to-end analysis, visualization, validation,
  dashboard planning plus assembly, or recurring snapshot refresh.
plugin: data-analytics
inherits_plugin_defaults: true
---

# data — Skill Hub

This hub describes when to use each subskill in the `data/` family. Load the most
specific subskill that matches the request; fall back to `data/analyze` for general
analysis tasks.

## Subskill routing

| Request type | Load skill |
|---|---|
| "What tables / columns / data do I have?" | `data/explore` |
| "Write me a SQL query to…" | `data/query` |
| "Analyze / what's happening with…" (general) | `data/analyze` |
| "Chart / visualize this…" | `data/visualize` |
| "Check / validate this analysis before I share it" | `data/validate` |
| "Build me a dashboard" | `data/dashboard` |
| "Refresh this every day / keep this report in sync" | `data/refresh` |

## Connector selection (apply in every subskill)

Choose the right data connector for the source:

- **Warehouse (managed datasets, large tables)** — use the BigQuery MCP server
  (`toolbox-bq-demo`) for discovery and scoped SQL. Treat BigQuery as the source of
  truth. When repeated local slicing is needed, create or use a workspace snapshot
  first, then continue through plugin scripts.
- **Local files (CSV / Parquet / JSON in the workspace)** — use
  `run_skill_python_script` with `data_workspace` for schema inspection, DuckDB
  queries, profiling, and exports.
- **Charts / tables / reports** — prepare payloads with plugin scripts, then validate
  and render bounded payloads through the `data-artifacts` MCP.
- **Recurring dashboards / canned reports** — use `data/refresh` to publish stable
  snapshots such as `datasets/<slug>/latest.parquet`, then regenerate stable native
  dashboard or report artifacts from those snapshots.
- **Dashboard creation** — `data/dashboard` is review-first. It should inspect the tagged
  dataset/report context, propose a dashboard plan, wait for approval, then generate the
  native DashboardCanvas package with `build_native_dashboard_package`.
- **Do not attempt cross-source SQL joins in v1.** Orchestrate at the workflow level
  (query each source separately; combine in Python / summary prose).

## Guardrails that apply to every subskill

- Inspect schema / metadata before executing SQL.
- Always cite concrete numbers (counts, averages, %, deltas). No speculation.
- Keep query and script runs bounded; prefer 5 focused queries for a normal analysis
  and stop by 10 unless the user explicitly asks for deeper investigation.
- Maximum **5 charts** per run.
- One shareable deliverable path per run: report artifact or native dashboard package.
- Reports and dashboards only include artifacts from the **current run** — never
  from prior runs.
- Dashboard requests should prefer a tagged dataset artifact as the source of truth and
  avoid fresh warehouse rediscovery unless the tagged inputs are unusable.
- In `data/dashboard`, pass structured chart bindings to
  `build_native_dashboard_package`; do not generate `dashboard.snapshot.html`.
