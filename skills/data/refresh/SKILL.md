---
name: data/refresh
description: Refresh a stable BigQuery-backed Parquet snapshot in the workspace and regenerate recurring dashboard or report artifacts from DuckDB.
plugin: data-analytics
inherits_plugin_defaults: true
tools:
  - export_bigquery_query
---

# data/refresh

Use this skill when the user wants a repeatable snapshot job rather than a one-off answer.

## Workflow

1. Refresh or create the warehouse slice.
   - Prefer `datasets/<slug>/latest.parquet` as the stable target path.
   - Use CSV mirrors only when compatibility requires them.
   - Treat BigQuery as the source of truth and DuckDB as the local serving layer.
   - Use the declared BigQuery export path for warehouse snapshots, then use
     `data_workspace` for local checks.

2. Validate the refreshed snapshot locally.
   - Call `data_workspace` schema for the refreshed table/file.
   - Run one or two focused `data_workspace` query checks for freshness and row sanity.

3. Regenerate the recurring artifact.
   - Use `build_native_dashboard_package` for the native DashboardCanvas package.
   - Use `build_report_payload` plus `data-artifacts` for report payloads.
   - Always pass a stable output path so scheduled refreshes overwrite the same package.

4. Close with the refresh contract.
   - Tell the user which snapshot path was updated.
   - Tell the user which dashboard/report path was regenerated.
   - If appropriate, suggest automating the exact prompt on a daily schedule in the user’s timezone.

## Defaults

- Scheduled snapshots, not live warehouse HTML
- Canonical data artifact: Parquet + manifest
- CSV mirror is optional compatibility output, not the primary serving layer
