---
name: data
description: Hub skill for data analysis workflows, including ad hoc DuckDB analysis and recurring snapshot refresh jobs.
tools:
  - export_bigquery_query
  - data_agent_tools
---

# data

Use this hub when the user is asking about tabular analysis work and you need to choose the right workflow.

- Use `data-analysis` for ad hoc analysis, charts, dashboards, and reports against workspace data.
- Use `data/refresh` when the user wants a recurring refresh job that republishes Parquet snapshots and regenerates stable HTML artifacts.

Prefer BigQuery as the system of record and DuckDB as the local query layer over workspace snapshots.
