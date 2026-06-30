---
name: data/analyze
description: >
  End-to-end data analysis — from a quick metric lookup to a formal stakeholder
  report. Combines schema discovery, SQL execution, optional visualization, and
  an evidence-based summary. Use for general "analyze / what's happening with…"
  requests.
plugin: data-analytics
inherits_plugin_defaults: true
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
  anything that implies a deliverable artifact, prepare the report payload with
  `build_report_payload`, validate it with `data-artifacts`, and mention the result
  before the final chat response.
- If the user asks for an **interactive dashboard**, load `data/dashboard` and build
  one native dashboard package after approval.
- Do **not** use general web-search tools for warehouse questions that can be answered
  from the declared BigQuery MCP server and local data scripts.

## Connector selection

- **BigQuery (warehouse)**: target = named warehouse tables or large managed datasets.
  Use `bq_list_datasets` → `bq_list_tables` → `bq_get_table_info` → `bq_execute_sql`.
  If the answer will require iterative follow-up, create or use a workspace snapshot
  and continue with the local `data_workspace` script.
- **Local files (CSV / Parquet / JSON in workspace)**: use `data_workspace` for schema,
  query, profile, and export actions; use `build_chart_payload` or
  `build_report_payload` for shareable payloads.
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
- **Local**: call `data_workspace` with `{"action":"schema"}` before local SQL.
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
  charts, or validation passes, use a workspace snapshot before continuing. Prefer
  DuckDB through `data_workspace` for the iterative loop after export.
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
- Use `build_chart_payload` for chart/table payload preparation, then `render_chart`
  or `render_table` from `data-artifacts` after validation.
- Use descriptive `chart_title` names (Title_Case).
- Do not generate more than **3 charts** in a standard analysis.
- Keep chart payloads bounded and source-backed.

### 6. Summary / report payload
For report-style work, call `build_report_payload` after queries and any chart/table payloads:
- Include tables used, filters, metrics, and artifacts created.
- Provide at least two concrete insights (or explain if none exist).
- Structure:
  - `### Summary` — 2–4 bullets
  - `### Key Insights` — 3–6 evidence-backed bullets
- Mention any charts/files explicitly so the user knows what to open.
- Validate report/dashboard artifact payloads with `validate_data_artifact` before
  `render_artifact`.
- For report-style requests, do not stop after analysis notes alone; produce the
  validated payload or explain exactly what blocked it.

## Guardrails
- Mandatory order: schema → SQL/script query → chart/table payload (optional) → summary/report payload.
- No direct file I/O or raw `pandas` reads by the agent; use declared scripts for local files.
- Use only inherited plugin scripts, declared tools, or declared MCP servers.
