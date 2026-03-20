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

This skill is not a generic file bundler. Treat it as a presentation step:
- Curate the strongest visuals from the current run.
- Present a stakeholder-ready narrative, not an analyst scratchpad.
- Optimize for clarity, hierarchy, and quick scanning.
- Include dashboard controls and filters. A dashboard without filtering is not complete.

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
- Do not start fresh analysis here unless a clearly missing visualization prevents a usable
  dashboard. If the run only contains weak or redundant charts, first generate better charts
  before calling `generate_dashboard`.

### 2. Curate before assembling
Before generating the dashboard, review the current run and be selective.

- Prefer 3-6 high-signal visuals over dumping every chart.
- Exclude redundant charts, placeholder charts, and charts with default titles like
  "Top Categories" unless the title is rewritten to state the insight.
- Do not include charts that merely restate the same ranking with a different dimension
  unless the contrast matters.
- If a chart is visually weak, re-generate it first with better encoding and labeling.

Use these chart-quality rules:
- Match chart type to question:
  - Time trend: line or area.
  - Ranked comparison: sorted horizontal bar.
  - Share/composition: stacked bar or doughnut only for a few categories.
  - Relationship: scatter.
- Avoid:
  - Unsorted bars for ranked data.
  - Doughnuts with too many slices.
  - Generic default Plotly styling.
  - Long category labels without horizontal orientation or truncation.
  - Chart titles that describe the dimension but not the takeaway.

### 3. Plan the dashboard like an executive artifact
Decide:
- **Dashboard title**: clear, stakeholder-facing heading.
- **Description**: one paragraph explaining what this dashboard shows and why it matters.
- **Section titles**: one heading per included chart. Write insight-led titles, not file names.
- **Filters**: define what the user should be able to narrow or search.
- **Narrative order**:
  1. Overall pattern or headline risk
  2. Main drivers and breakdowns
  3. Supporting detail or appendix

The final dashboard should feel like:
- An executive summary at the top
- A curated set of visuals in the middle
- Visible filter controls near the top of the page
- Raw SQL and verbose technical detail demoted to an appendix

### 4. Write titles and copy that explain the insight
Good section titles:
- "Cancellation Risk Is Highest in Belgium and Spain"
- "A Small Group of Apparel Categories Drives Disproportionate Cancellations"
- "Safari and Firefox Show Elevated Cancellation Rates"

Weak section titles to avoid:
- "Geographic Trends"
- "Top Categories"
- "Browser/Device Segmentation"

### 5. Generate the dashboard
Call `generate_dashboard` with:
- `title`: the dashboard heading.
- `description`: the context paragraph.
- `section_titles`: ordered list of polished section headings, one per chart. Do not pass
  raw file names or generic placeholders.
- `kpis` (optional): explicit KPI cards for the hero area.
- `filters` (optional): structured dashboard controls such as title search, chart type,
  chart tag, or appendix visibility.
- `sections` (optional): named chart groups with `chart_indexes` to control narrative flow.
- `chart_tags` (optional): tags aligned to chart order so controls can filter charts by theme
  or audience.

The tool will:
- Embed all charts produced in this run (Plotly JSON → interactive, PNG → static).
- Embed all queries with their row counts in a technical appendix.
- Write a single self-contained HTML file to `dashboards/<title>.html`.
- Emit a `tool_artifacts` event so the frontend surfaces the file.
- Only include artifacts from the **current run** — prior-run charts are excluded.

### 6. Report to user
After `generate_dashboard` returns:
- Tell the user the dashboard path so they know where to open it.
- Summarize the story the dashboard tells, not just the file count.
- Mention what was curated in or left out if that affected quality.
- Mention any charts that could not be embedded (logged as warnings).

## Dashboard format
The HTML output:
- Should feel polished, editorial, and browser-ready.
- Should use a light theme by default unless the user asked for dark mode.
- Should present charts as cards with consistent spacing, hierarchy, and labeling.
- Must include filter controls that update the view without reloading the page.
- Should place technical SQL details in a lower-priority appendix, not at the top.
- Plotly charts render interactively (pan, zoom, hover).
- PNG charts are embedded as base64 (no external file dependencies).
- No CDN dependency except `cdn.plot.ly` for Plotly runtime.

## Filter expectations
Filtering is required for dashboards.

- Minimum acceptable behavior:
  - A visible filter bar
  - At least one working control that changes the visible content immediately
  - A clear reset path
- Preferred behavior:
  - Dimension filters such as region, category, channel, date range, or segment
  - All charts update together from shared filter state
- If the run only contains finished chart artifacts and no reusable underlying dataset:
  - Still provide dashboard-level controls such as chart search, section filtering, chart-type
    filtering, or visibility toggles
  - Tell the user that richer cross-filtering requires embedding a canonical dataset or
    pre-aggregated tables instead of only chart outputs

## Quality bar
The generated dashboard is not acceptable if it looks like:
- a raw notebook export
- a query log with charts attached
- generic default Plotly output with no visual system
- a wall of similarly styled bar charts without narrative progression

It is acceptable when:
- the first screen communicates the main story quickly
- the charts are visually distinct, readable, and ordered with intent
- titles and descriptive copy explain why each visual matters
- filters are obvious, responsive, and useful
- technical details are available but visually de-emphasized

## Guardrails
- Do not call `generate_summary` and `generate_dashboard` in the same run — pick one.
- Do not blindly include every query and chart just because it exists.
- Do not expose raw SQL as the main content of the page.
- Do not accept generic section titles if you can rewrite them.
- The `dashboards/` directory is separate from `charts/` and `reports/`.
