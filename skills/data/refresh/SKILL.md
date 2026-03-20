---
name: data/refresh
description: Refresh a stable BigQuery-backed Parquet snapshot in the workspace and regenerate recurring dashboard or report artifacts from DuckDB.
tools:
  - export_bigquery_query
  - data_agent_tools
---

# data/refresh

Use this skill when the user wants a repeatable snapshot job rather than a one-off answer.

## Workflow

1. Materialize the warehouse slice with `materialize_bigquery_to_parquet`.
   - Prefer `datasets/<slug>/latest.parquet` as the stable target path.
   - Use `emit_csv=true` only when a CSV mirror is explicitly useful.
   - Treat BigQuery as the source of truth and DuckDB as the local serving layer.

2. Validate the refreshed snapshot locally.
   - Call `get_table_schema` for the refreshed table.
   - Run one or two focused `run_sql_query` checks for freshness and row sanity.

3. Regenerate the recurring artifact.
   - Use `generate_dashboard` for an interactive HTML dashboard.
   - Use `generate_summary` for a canned HTML report.
   - Always pass a stable `output_path` so scheduled refreshes overwrite the same file.

4. Close with the refresh contract.
   - Tell the user which snapshot path was updated.
   - Tell the user which HTML path was regenerated.
   - If appropriate, suggest automating the exact prompt on a daily schedule in the user’s timezone.

## Defaults

- Scheduled snapshots, not live warehouse HTML
- Canonical data artifact: Parquet + manifest
- CSV mirror is optional compatibility output, not the primary serving layer
