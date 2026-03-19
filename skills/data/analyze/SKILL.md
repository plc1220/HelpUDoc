---
name: data/analyze
description: >
  End-to-end data analysis — from a quick metric lookup to a formal stakeholder
  report. Combines schema discovery, SQL execution, optional visualization, and
  an evidence-based summary. Use for general "analyze / what's happening with…"
  requests.
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

# data/analyze — Answer Data Questions

Answer any data question, from a quick lookup to a full segmented analysis with
charts and a structured report.

## Complexity levels

| Level | Signals | Output |
|---|---|---|
| **Quick answer** | Single metric, simple filter, factual lookup | Direct answer + query used |
| **Full analysis** | Multi-dimensional trend / comparison | Insights + tables + optional chart + summary |
| **Formal report** | "Prepare a report / review" | Executive summary + methodology + findings + caveats |

## Required completions

- If the user asks for a **shareable report**, **formal report**, **summary report**, or
  anything that implies a deliverable artifact, you **must** call `generate_summary`
  exactly once before the final chat response.
- If the user asks for an **interactive dashboard**, load `data/dashboard` and call
  `generate_dashboard` exactly once.
- Do **not** use general web-search tools for warehouse questions that can be answered
  from the declared BigQuery MCP server and local DuckDB tools.

## Connector selection

- **BigQuery (warehouse)**: target = named warehouse tables or large managed datasets.
  Use `bq_list_datasets` → `bq_list_tables` → `bq_get_table_info` → `bq_execute_sql`.
  If the answer will require iterative follow-up, materialize the scoped result to
  workspace-local Parquet with `materialize_bigquery_to_parquet` and continue in DuckDB.
- **Local files (CSV / Parquet in workspace)**: use `get_table_schema` →
  `run_sql_query` → optional `generate_chart_config` → `generate_summary`.
- **Do not attempt cross-source SQL joins.** Orchestrate at workflow level.

## Standards

- **Every insight must cite concrete evidence** (counts, averages, %, deltas, 
  correlations). No speculation.
- **Name charts and artifacts clearly** (Title_Case_With_Underscores).
- **State limitations** if data is incomplete or a question cannot be answered.

## Default analysis pack (use for full analyses unless user asks for a quick answer)

1. **Dataset snapshot**: row count, key columns, basic distribution for main outcome.
2. **Segmentation**: group by primary category, compute core metrics.
3. **Drivers**: quantify top positive/negative relationships.
4. **Interactions**: at least one two-factor combination or tiered interaction.
5. **Outliers/variance**: highlight spread changes across segments.

## Workflow

### 1. Understand the question
Parse complexity level, data requirements (tables, metrics, time range), and
desired output format (number, table, chart, narrative).

### 2. Schema / metadata discovery
- **Warehouse**: navigate metadata tools to find relevant tables and columns.
- **Local**: call `get_table_schema` (required before any `run_sql_query`).
- Note relevant tables, columns, joins, date fields, and metrics.

### 3. Query
- Write focused SQL (no `SELECT *`), always with `LIMIT 1000`.
- When joining tables, always use short table aliases and qualify every selected,
  grouped, filtered, and ordered column (`o.status`, `u.country`, etc.). Never
  rely on unqualified column names in multi-table queries.
- Run at most **5 queries** for a full analysis; up to **10** are allowed in code.
- Refine only when results are unexpected; briefly interpret between queries.
- Prefer a **segmentation query** + at least one **interaction query** for deeper
  analysis.
- If the work begins on BigQuery and you expect repeated slicing, comparisons,
  charts, or validation passes, materialize the scoped warehouse result to Parquet
  before continuing. Prefer DuckDB for the iterative loop after export.
- After each query: interpret results and decide whether refinement is needed.

### 4. Validate before presenting
Before surfacing results, run sanity checks:
- Row count — does it make sense?
- Nulls — unexpected nulls that could skew results?
- Magnitude — numbers in a reasonable range?
- Trend continuity — gaps in time series?
- Aggregation logic — subtotals sum to totals?

### 5. Visualize (optional)
When a chart communicates results more effectively than a table:
- Use `generate_chart_config` with Plotly (preferred for interactivity).
- Use descriptive `chart_title` names (Title_Case).
- Do not generate more than **3 charts** in a standard analysis.
- Plotly specs saved as `.plotly.json` and `.plotly.html` in `charts/`.

### 6. Summary
Call `generate_summary` once after queries (and any chart):
- Include tables used, filters, metrics, and artifacts created.
- Provide at least two concrete insights (or explain if none exist).
- Structure:
  - `### Summary` — 2–4 bullets
  - `### Key Insights` — 3–6 evidence-backed bullets
- Mention any charts/files explicitly so the user knows what to open.
- Note: `generate_summary` saves an HTML report to `reports/` with all queries and charts from this run.
- For report-style requests, do not stop after analysis notes alone; the run is incomplete
  until `generate_summary` succeeds and you tell the user where the report was written.

## Guardrails
- Mandatory order: schema → SQL → chart (optional) → summary.
- No direct file I/O or raw `pandas` reads of data files.
- Use only tools from `data_agent_tools` or the declared MCP server.
- Stop after `generate_summary` succeeds.
