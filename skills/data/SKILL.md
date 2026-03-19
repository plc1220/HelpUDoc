---
name: data
description: >
  Data analysis skill hub. Routes to the right specialist subskill depending on the
  request — exploration, query writing, end-to-end analysis, visualization, validation,
  or interactive dashboard assembly.
tools:
  - data_agent_tools
  - get_table_schema
  - run_sql_query
  - materialize_bigquery_to_parquet
  - generate_chart_config
  - generate_summary
  - generate_dashboard
mcp_servers:
  - toolbox-bq-demo
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

## Connector selection (apply in every subskill)

Choose the right data connector for the source:

- **Warehouse (managed datasets, large tables)** — use the BigQuery MCP server
  (`toolbox-bq-demo`) for discovery and the initial scoped query. If the task will
  require iterative follow-up analysis, materialize the scoped result with
  `materialize_bigquery_to_parquet` and continue in DuckDB.
- **Local files (CSV / Parquet in the workspace)** — use `data_agent_tools`.
  Available tools: `get_table_schema`, `run_sql_query`,
  `materialize_bigquery_to_parquet`, `generate_chart_config`, `generate_summary`,
  `generate_dashboard`.
- **Do not attempt cross-source SQL joins in v1.** Orchestrate at the workflow level
  (query each source separately; combine in Python / summary prose).

## Guardrails that apply to every subskill

- Inspect schema / metadata before executing SQL.
- Always cite concrete numbers (counts, averages, %, deltas). No speculation.
- Maximum **10 SQL queries** per run (enforced in code).
- Maximum **5 charts** per run (enforced in code).
- One `generate_summary` OR one `generate_dashboard` per run.
- Reports and dashboards only include artifacts from the **current run** — never
  from prior runs.
