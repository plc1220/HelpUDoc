---
name: data-analysis
description: End-to-end data analysis with DuckDB queries, optional Plotly charts, and artifact-aware summaries.
tools:
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
Use this skill to analyze tabular data in the workspace using DuckDB tools, optionally produce a Plotly visualization, and deliver a concise, evidence-based summary that references any generated artifacts.

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
1. **Scope & schema**
   - Use `get_table_schema` to inspect only the tables needed for the question.
   - Note relevant tables, key columns, joins, date fields, and metrics before querying.

2. **Query**
   - Use `run_sql_query` to answer the question with focused SQL.
   - Always specify columns (no `SELECT *`) and include `LIMIT 1000`.
   - You may run up to 5 queries total; refine only when needed.
   - Prefer a **segmentation query** and at least one **interaction/combination query** when deeper analysis is requested.
   - After each query, briefly interpret results and decide whether another refinement is required.

3. **Chart (optional)**
   - If a chart helps, use `generate_chart_config` on the latest `df`.
   - Plotly only. Assign a serializable `chart_config` and keep logic deterministic.
   - Plotly outputs will be saved as `.plotly.json` and `.plotly.html` in `charts/`.
   - Use descriptive `chart_title` names (Title_Case_With_Underscores).
   - Do not generate more than 3 charts.

4. **Artifacts (optional)**
   - If artifacts are useful (CSV extracts, HTML previews, Markdown notes), write them to disk using the provided helpers.
   - Keep artifacts minimal and clearly named; explain why each artifact exists.

5. **Summary**
   - Call `generate_summary` once after queries (and any chart).
   - Include tables used, filters, metrics, and artifacts created.
   - Provide at least two concrete insights (or explain if none exist).
   - Structure output like:
     - `### Summary` with 2-4 bullets
     - `### Key Insights` with 3-6 bullets
   - Mention any artifacts (charts/files) explicitly so the user knows what to open.
   - Note: `generate_summary` will also create a report file in `reports/` with the analysis steps and outputs.

## Guardrails
- Order is mandatory: schema -> SQL -> chart (optional) -> artifacts (optional) -> summary.
- No direct file I/O or Python reads of raw data files.
- Use only the data tools provided (via `data_agent_tools`).
- Explain intent briefly before each tool call; stop after `generate_summary` succeeds.
