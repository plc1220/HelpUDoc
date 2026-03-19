---
name: data-analysis
description: End-to-end data analysis with DuckDB queries, optional Plotly charts, dashboard artifacts, and artifact-aware summaries.
tools:
  - export_bigquery_query
  - data_agent_tools
source_skills:
  - data_agent-core
  - data_agent-schema
  - data_agent-sql
  - data_agent-chart
  - data_agent-file
  - data_agent-summary
---

# data-analysis

## Overview
Use this skill to analyze tabular data in the workspace using DuckDB tools, optionally produce Plotly visualizations, build a dashboard artifact, and deliver a concise, evidence-based summary that references generated artifacts.

If the source data lives in BigQuery and there is no relevant local extract yet, either:
- use `export_bigquery_query` to stage a CSV or Parquet file into `data_exports/` for ad hoc analysis, or
- use `materialize_bigquery_to_parquet` to publish a stable Parquet snapshot for recurring refresh workflows.

If the user asks for a scheduled refresh job, a daily snapshot, or a recurring dashboard/report update, switch to `data/refresh`.

## Standards (required)
- **Summary and insights must be valid Markdown**, not raw paragraphs. Use headings (`###`) and bullet lists (`-`) so the report renders cleanly.
- **Every insight must cite concrete evidence** from queries (counts, averages, deltas, correlations, percent shares). No speculation.
- **Name artifacts and charts clearly** using Title_Case_With_Underscores and reference them explicitly in the summary.
- **State limitations** if data is incomplete or if a question cannot be answered from available tables.

## Default analysis pack (use unless user asks for a quick answer)
1. **Dataset snapshot**: row count, key columns, and basic distribution for the main outcome.
2. **Segmentation**: group by primary category (or tiers) and compute core metrics.
3. **Drivers**: quantify top positive/negative relationships (correlation or ranked deltas).
4. **Interactions**: at least one two-factor combination or tiered interaction (e.g., high/low bins).
5. **Outliers/variance**: highlight spread changes across segments (box plot or variance stats).

## Workflow
1. **Stage source data when needed**
   - If the user is asking about BigQuery data and the needed table/extract is not already in the workspace, call `export_bigquery_query` first.
   - Save staged extracts under `data_exports/` with a clear name. Use `.csv` by default; use `.parquet` for larger extracts.
   - Prefer a bounded extract (`row_limit`) unless the user explicitly asks for a full pull.

2. **Scope & schema**
   - Use `get_table_schema` to inspect only the staged/local tables needed for the question.
   - Note relevant tables, key columns, joins, date fields, and metrics before querying.

3. **Query**
   - Use `run_sql_query` to answer the question with focused SQL.
   - Always specify columns (no `SELECT *`) and include `LIMIT 1000`.
   - You may run up to 5 queries total; refine only when needed.
   - Prefer a **segmentation query** and at least one **interaction/combination query** when deeper analysis is requested.
   - After each query, briefly interpret results and decide whether another refinement is required.

4. **Chart (optional)**
   - If a chart helps, use `generate_chart_config` on the latest `df`.
   - Plotly only. Assign a serializable `chart_config` and keep logic deterministic.
   - Plotly outputs will be saved as `.plotly.json` and `.plotly.html` in `charts/`.
   - Use descriptive `chart_title` names (Title_Case_With_Underscores).
   - Do not generate more than 3 charts.

5. **Dashboard (optional)**
   - If the user wants a shareable HTML dashboard, call `generate_dashboard`.
   - Pass a clear `title`, stakeholder-friendly `description`, and optional `section_titles`.
   - Use `output_path` when the user wants the same HTML file refreshed on a schedule.

6. **Artifacts (optional)**
   - If artifacts are useful (CSV extracts, HTML previews, Markdown notes), write them to disk using the provided helpers.
   - Keep artifacts minimal and clearly named; explain why each artifact exists.

7. **Summary**
   - Call `generate_summary` once after queries (and any chart).
   - Include tables used, filters, metrics, and artifacts created.
   - Provide at least two concrete insights (or explain if none exist).
   - Structure output like:
     - `### Summary` with 2-4 bullets
     - `### Key Insights` with 3-6 bullets
   - Mention any artifacts (charts/files) explicitly so the user knows what to open.
   - Note: `generate_summary` will also create a report file in `reports/` with the analysis steps and outputs.
   - Use `output_path` when the user wants the same report HTML refreshed on a schedule.

## Guardrails
- Order is mandatory: export/materialize (when BigQuery is the source) -> schema -> SQL -> chart (optional) -> dashboard or summary -> optional follow-up artifacts.
- No direct file I/O or Python reads of raw data files.
- Use only the listed data tools (`export_bigquery_query` and `data_agent_tools`).
- Explain intent briefly before each tool call; stop after `generate_summary` succeeds.
