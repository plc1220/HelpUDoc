---
name: data/dashboard
description: >
  Plan, review, and then assemble a stakeholder-ready dashboard package from the
  current analysis run, with a native interactive canvas experience plus snapshot fallback.
requires_hitl_plan: true
tools:
  - data_agent_tools
  - get_table_schema
  - run_sql_query
  - materialize_bigquery_to_parquet
  - generate_summary
  - generate_dashboard
  - request_plan_approval
  - request_clarification
---

# data/dashboard — Plan and Build a Dashboard Package

This skill is review-first and low-variance. Before any dashboard package is generated, you must:
1. inspect the tagged dataset/report context
2. draft a concrete dashboard plan
3. call `request_plan_approval`
4. wait for approval or edits
5. only then call `generate_dashboard`

Produce one workspace-native dashboard package that can power:
- a native interactive dashboard in the canvas
- a snapshot fallback/export for sharing

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
- Static dashboards require at least one SQL query and at least one chart artifact from this run.
- Native filterable dashboards require `dashboard_dataset_path`, `filter_schema`, and `chart_bindings`.
- `generate_dashboard` can only be called **once per run**.

## Connector scope
The dashboard tool renders from workspace-local data. For BigQuery or other connected
sources, first materialize a scoped, read-only slice into workspace Parquet with
`materialize_bigquery_to_parquet`, then continue through DuckDB and `generate_dashboard`.
The generated dashboard itself does not make live warehouse connections.

## Workflow

### 0. Clarify when true filtering is requested but under-specified
If the user is asking for a genuinely filterable dashboard, do not guess past missing inputs that would change the implementation.

This skill should behave like `frontend-slides`: when key dashboard inputs are missing, call `request_clarification` and pause instead of silently continuing.

Call `request_clarification` when the request implies shared data filters but one or more of these are missing or ambiguous:
- the canonical dataset path to power filtering
- the time/date field for timeframe filters
- the main categorical or numeric fields the user wants exposed as filters
- whether the user wants true cross-filtering or a static dashboard built from existing chart artifacts

Do **not** interrupt for routine dashboard generation when a static/shareable dashboard is sufficient.

Use clarification especially in cases like:
- the user references only a report HTML and asks for timeframe/country/device/range filters
- the user references only a dataset and says "build a dashboard" without saying whether it should be static or truly filterable
- the request says "add filters" but does not specify the dataset that should power them
- multiple plausible date or metric fields exist and choosing the wrong one would change the result

### 0.1 Clarification Form (single interrupt)
Ask all material dashboard questions in a **single** `request_clarification` call so the user can answer in one step, similar to the `frontend-slides` discovery flow.

Preferred questions:
- Header: `Mode`
  Question: `Should this be a static dashboard from existing report/chart artifacts, or a true filterable dashboard backed by a reusable dataset?`
  Options:
  - `Static dashboard`
  - `True filterable dashboard`
- Header: `Dataset`
  Question: `Which dataset should power shared filters? If you already tagged one, confirm that path; otherwise provide the canonical dataset path.`
- Header: `Time field`
  Question: `Which date/time field should drive timeframe filtering?`
- Header: `Filters`
  Question: `Which fields should users filter by? Name the main categorical and numeric filters you want exposed.`

Preferred clarification framing:
- explain the tradeoff briefly
- offer a static-dashboard path and a true-filtered-dashboard path
- ask for the dataset path and intended filter fields if true filtering is desired

Example clarification description:
- `I can build a static dashboard from the existing report/charts, or a truly filterable dashboard if you confirm the canonical dataset and the fields to filter on.`

### 0.2 Tagged HTML hygiene
When the user tags a report HTML for story guidance, do **not** read the full raw HTML into context unless absolutely necessary.

Use these rules:
- treat tagged `.html` report files as reference artifacts, not primary context dumps
- prefer RAG retrieval first; if that fails, use compact outline extraction
- prefer the tagged dataset as the source of truth for filtering and chart bindings
- inspect only targeted parts of the report when needed for narrative cues
- do not repeatedly read large HTML chunks into the model context

If the report is large, extract only the minimum needed story elements:
- headline/theme
- chart titles or section headings
- 2-4 key takeaways

### 1. Keep analysis bounded
For tagged local parquet/csv dashboards, prefer a deterministic prep path over open-ended exploration.

- Before approval:
  - at most **1 schema inspection**
  - at most **1 lightweight preview query**
  - no aggregate analysis
  - no chart generation
- After approval:
  - use a bounded chart-prep bundle for KPI summary, time trend, top country/device/category breakdowns, and optional driver table
  - prefer one reusable aggregate pass over repeated dimension-specific queries
  - produce **3-5 approved chart bindings max**

Do not rediscover upstream tables or rerun exploratory profiling when the tagged local dataset is already sufficient.
Do not use `generate_chart_config` on the happy path for `data/dashboard`; pass structured chart bindings directly to `generate_dashboard`.

Source handling:
- **Local CSV/Parquet**: use `get_table_schema` and `run_sql_query` against the DuckDB
  registered table names. Do not use `pd.read_parquet`, `pd.read_csv`, or direct file reads in
  chart code.
- **BigQuery / MCP datasource**: use the MCP tools to inspect/query the warehouse, then
  materialize the scoped result with `materialize_bigquery_to_parquet`. Treat the resulting
  Parquet as the dashboard dataset.

### 2. Curate before assembling
Before generating the dashboard, review the current run and be selective.

- Prefer 3-6 high-signal visuals over dumping every chart.
- Exclude redundant charts, placeholder charts, and charts with default titles like
  "Top Categories" unless the title is rewritten to state the insight.
- Do not include charts that merely restate the same ranking with a different dimension
  unless the contrast matters.
- If a chart is visually weak, revise the structured binding and labels before package generation.

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

### 3. Draft the dashboard plan before any generation
Decide and write down:
- **Dashboard title**: clear, stakeholder-facing heading.
- **Description**: one paragraph explaining what this dashboard shows and why it matters.
- **Section titles**: one heading per included chart. Write insight-led titles, not file names.
- **Filters**: define what the user should be able to narrow or search.
- **Narrative order**:
  1. Overall pattern or headline risk
  2. Main drivers and breakdowns
  3. Supporting detail or appendix

Your plan must also include:
- **Audience**: who this dashboard is for
- **Business question**: the one question this dashboard must answer
- **Decision questions**: 1-3 concrete decisions the dashboard should support
- **Source of truth**: the tagged dataset path or canonical dataset artifact
- **KPIs**: exact definitions, including weighted-rate logic where applicable
- **Chart list**: 3-6 proposed visuals with purpose and chart type
- **Layout template**: choose a constrained executive layout and freeze the chart lineup
- **Risks / gaps**: anything that could make the dashboard misleading or low-value
- **Fallback note**: whether the dashboard will be truly filter-aware or mostly snapshot/static

The final dashboard should feel like:
- An executive summary at the top
- A curated set of visuals in the middle
- Visible filter controls near the top of the page
- Raw SQL and verbose technical detail demoted to an appendix

### 3.1 Request plan approval (required)
Before calling `generate_dashboard`, call `request_plan_approval`.

Use:
- `plan_title`: the proposed dashboard title
- `plan_summary` or `plan_summary_markdown`: concise dashboard brief with:
  - audience
  - business question
  - dataset source
  - KPI definitions
  - proposed chart set
  - filter strategy
  - narrative order
  - known risks
- `execution_checklist`: the concrete build steps you will take after approval
- `plan_file_path`: `dashboard_plan.md`
- `status_label`: `Review Dashboard Plan`
- `risky_actions`: mention any risk of weak proxy metrics, static-only charts, or missing fields

If the reviewer chooses:
- `approve`: continue to generation
- `edit`: revise the dashboard plan and call `request_plan_approval` again
- `reject`: stop and do not generate the dashboard

Do not call `generate_dashboard` before approval.

### 4. Write titles and copy that explain the insight
Good section titles:
- "Cancellation Risk Is Highest in Belgium and Spain"
- "A Small Group of Apparel Categories Drives Disproportionate Cancellations"
- "Safari and Firefox Show Elevated Cancellation Rates"

Weak section titles to avoid:
- "Geographic Trends"
- "Top Categories"
- "Browser/Device Segmentation"

### 5. Generate the dashboard package
Call `generate_dashboard` with:
- `title`: the dashboard heading.
- `description`: the context paragraph.
- `audience`: the primary audience for the dashboard.
- `business_question`: the core business question.
- `decision_questions`: 1-3 concrete questions/decisions the dashboard supports.
- `layout_template`: the approved executive layout template.
- `headline_takeaway`: optional hero takeaway.
- `insights`: 2-4 concise executive takeaways.
- `known_risks`: key caveats or proxy-metric risks.
- `data_quality_notes`: normalization and data quality notes.
- `section_titles`: ordered list of polished section headings, one per chart. Do not pass
  raw file names or generic placeholders.
- `metric_cards` (optional): 2-3 explicit KPI cards for the hero area.
- `dashboard_dataset_path` (required for native shared data filters): a canonical
  Parquet/CSV/JSON dataset materialized for this run.
- `filter_schema` (optional): structured filter definitions describing field, label, type,
  options, presets, and applicability.
- `chart_bindings` (optional): per-chart bindings that map charts to dataset fields and
  aggregations so both the live runtime and snapshot can render from the same spec.
  Include `question_answered`, `why_it_matters`, and layout metadata on the main path.
- `sections` (optional): named chart groups with `chart_indexes` to control narrative flow.
- `chart_tags` (optional): tags aligned to chart order so controls can filter charts by theme
  or audience.

The tool will:
- Build a dashboard package under `dashboards/<slug>/`.
- Write:
  - `dashboard.meta.json`
  - `dashboard.spec.json`
  - `dashboard.snapshot.html`
  - `data/dashboard.rows.json` when a reusable dataset is embedded
- Emit a `dashboard_artifact` event so the frontend can surface the dashboard folder.
- Emit workspace artifacts so the frontend surfaces the dashboard folder as one object.
- Only include artifacts from the **current run** — prior-run charts are excluded.

### 6. Report to user
After `generate_dashboard` returns:
- Tell the user the dashboard folder path so they know what to open.
- Summarize the story the dashboard tells, not just the file count.
- Mention what was curated in or left out if that affected quality.
- Mention any charts that could not be embedded (logged as warnings).

## Dashboard format
The resulting dashboard package:
- Should feel polished, editorial, and browser-ready.
- Should use a light theme by default unless the user asked for dark mode.
- Should present charts as cards with consistent spacing, hierarchy, and labeling.
- Must include filter controls when the dashboard is truly dataset-backed.
- Should place technical SQL details in a lower-priority appendix, not at the top.
- Should make it clear when the snapshot is read-only versus live/filter-aware.
- Uses native chart bindings plus `dashboard.snapshot.html` fallback from the same `dashboard.spec.json`.

## Filter expectations
Filtering is required for dashboards.

- Minimum acceptable behavior:
  - A visible filter bar
  - At least one working control that changes the visible content immediately
  - A clear reset path
- Preferred behavior:
  - Dimension filters such as region, category, channel, date range, or segment
  - All charts update together from shared filter state
- For true shared data filters:
  - embed a reusable canonical dataset or pre-aggregated table
  - provide `filter_schema` and `chart_bindings`
  - only charts with valid bindings should claim to be filter-aware
- If the run only contains finished chart artifacts and no reusable underlying dataset:
  - the dashboard may still be generated, but those charts should be treated as snapshot/static
    appendix content rather than pretending to support shared data filtering
  - tell the user that richer cross-filtering requires embedding a canonical dataset or
    pre-aggregated tables instead of only chart outputs

## Guardrails
- Do not skip the approval checkpoint for this skill unless the workspace is explicitly in trusted mode.
- Do not call `generate_summary` and `generate_dashboard` in the same run — pick one.
- Do not blindly include every query and chart just because it exists.
- Do not expose raw SQL as the main content of the page.
- Do not accept generic section titles if you can rewrite them.
- Do not pretend a snapshot-only dashboard is live or filter-aware.
- The `dashboards/` directory is separate from `charts/` and `reports/`.
