---
name: data-analysis
description: >
  Compatibility entrypoint for legacy "data-analysis" requests. Routes to
  data/analyze for end-to-end analysis, or to the appropriate data/* subskill
  for specialised workflows.
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

# data-analysis — Compatibility Shim

> **This skill is a thin compatibility shim.** For new requests, load the specific
> subskill directly.

## Routing

| Request type | Preferred skill |
|---|---|
| General analysis / "what's happening with…" | `data/analyze` |
| Schema exploration / profiling | `data/explore` |
| Write or refine a SQL query | `data/query` |
| Create a chart or visualization | `data/visualize` |
| QA / validate before sharing | `data/validate` |
| Build a shareable dashboard | `data/dashboard` |

## Legacy behaviour (unchanged)

If the runtime does not resolve a subskill, fall back to the `data/analyze` workflow
in full parity with the prior `data-analysis` behaviour:

1. **Schema**: call `get_table_schema` before any SQL.
2. **Query**: up to 5 focused SQL queries with `LIMIT 1000`.
3. **Chart (optional)**: `generate_chart_config` with Plotly, max 3 charts.
4. **Summary**: call `generate_summary` once to produce the HTML report.

## Standards
- Every insight must cite concrete evidence (counts, averages, %, deltas).
- No `SELECT *`; always name columns explicitly.
- Mandatory order: schema → SQL → chart (optional) → summary.
- No direct file I/O or raw pandas reads of data files.
