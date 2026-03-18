---
name: data/dashboard
description: >
  Assemble all charts and query results from the current analysis run into a single
  self-contained interactive HTML dashboard artifact.
tools:
  - data_agent_tools
  - get_table_schema
  - run_sql_query
  - materialize_bigquery_to_parquet
  - generate_chart_config
  - generate_summary
  - generate_dashboard
---

# data/dashboard — Build an Interactive HTML Dashboard

Produce one portable, self-contained HTML file that embeds all charts and queries
from the current run. No external dependencies — everything inlined.

## When to use this skill
Use `data/dashboard` after completing a `data/analyze` or `data/visualize` run when
the user asks for a shareable dashboard, interactive report, or wants to bundle all
charts into a single file.

## Prerequisites (enforced in code)
- At least one SQL query must have been executed in this run.
- At least one chart must have been generated in this run.
- `generate_dashboard` can only be called **once per run**.

## Connector scope
The dashboard tool only uses `data_agent_tools` (local data). BigQuery queries are
surfaced as embedded SQL + row-count metadata — the dashboard itself does not make
live warehouse connections.

## Workflow

### 1. Ensure analysis is complete
- All SQL queries for the dashboard should already be done.
- All charts (`generate_chart_config`) should already be generated.
- Do not start fresh analysis here — this skill only assembles an already-collected run.

### 2. Plan the layout
Decide:
- **Dashboard title**: clear, stakeholder-facing heading.
- **Description**: one paragraph explaining what this dashboard shows and who it's for.
- **Section titles**: one heading per chart (optional — defaults to chart file names).

### 3. Generate the dashboard
Call `generate_dashboard` with:
- `title`: the dashboard heading.
- `description`: the context paragraph.
- `section_titles`: list of section headings, one per chart (optional).

The tool will:
- Embed all charts produced in this run (Plotly JSON → interactive, PNG → static).
- Embed all queries with their row counts in a "Queries" section.
- Write a single self-contained HTML file to `dashboards/<title>.html`.
- Emit a `tool_artifacts` event so the frontend surfaces the file.
- Only include artifacts from the **current run** — prior-run charts are excluded.

### 4. Report to user
After `generate_dashboard` returns:
- Tell the user the dashboard path so they know where to open it.
- Summarize what is embedded (N charts, N queries).
- Mention any charts that could not be embedded (logged as warnings).

## Dashboard format
The HTML output:
- Dark-mode, responsive layout (works on any screen size).
- Plotly charts rendered interactively (pan, zoom, hover).
- PNG charts embedded as base64 (no external file dependencies).
- SQL queries displayed in a monospace code block with row-count metadata.
- No CDN dependency except `cdn.plot.ly` for Plotly runtime (inlined in the script tag).

## Guardrails
- Do not call `generate_summary` and `generate_dashboard` in the same run — pick one.
- Do not generate new charts inside this skill — only assemble what was already created.
- The `dashboards/` directory is separate from `charts/` and `reports/`.
