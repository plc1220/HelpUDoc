---
name: data/visualize
description: >
  Turn validated SQL query output into publication-quality Plotly charts. Select
  the right chart type, apply design best practices, and produce chart artifacts.
plugin: data-analytics
inherits_plugin_defaults: true
---

# data/visualize — Create Visualizations

Create the right chart for the data and audience. Run the query if data isn't yet
available, select the chart type, generate the visualization, and save it as an
artifact.

## Workflow

### 1. Understand the request
Determine:
- **Data source**: already queried (use last result) vs. needs to be queried first.
- **Chart type**: explicitly requested or needs a recommendation.
- **Purpose**: exploration, presentation, report, or dashboard component.
- **Audience**: technical team, executives, external stakeholders.

### 2. Get the data
- **If data warehouse is connected and data needs querying**: use `bq_execute_sql`.
  If the charting task will involve multiple refinements, use a scoped workspace
  dataset and chart from local rows.
- **If local workspace files**: call `data_workspace` schema, then a bounded
  `data_workspace` query.
- **If data already exists in reviewed rows**: pass those rows into
  `build_chart_payload` or `render_chart`.

### 3. Select chart type

| Data relationship | Recommended chart |
|---|---|
| Trend over time | Line chart |
| Comparison across categories | Bar chart (horizontal if many categories) |
| Part-to-whole | Stacked bar or area chart |
| Distribution | Histogram or box plot |
| Correlation between two variables | Scatter plot |
| Ranking | Horizontal bar chart |
| Two-variable comparison over time | Dual-axis line or grouped bar |
| Matrix of relationships | Heatmap |

Explain the recommendation briefly if the user didn't specify.

### 4. Generate the visualization payload
Use `build_chart_payload` for script-side preparation when you need a durable payload,
then call `render_chart` from `data-artifacts` for reviewed chart payloads.

- Prefer tidy long rows and explicit field bindings.
- Keep logic deterministic; avoid random seeds or shuffling.
- Do not generate more than **5 charts** per run.

### 5. Apply design best practices

**Color:**
- Use a consistent, colorblind-friendly palette. Avoid default rainbow.
- Highlight key data points with a contrasting accent color.
- Grey out reference/comparison data.

**Typography:**
- Descriptive title that states the *insight*, not just the metric
  (e.g., "Revenue grew 23% YoY" not "Revenue by Month").
- Readable axis labels (avoid 90-degree rotation where possible).
- Data labels on key points when they add clarity.

**Accuracy:**
- Y-axis starts at zero for bar charts.
- No misleading axis breaks without clear notation.
- Consistent scales when comparing panels.
- Appropriate precision (don't show 10 decimal places).

### 6. Save and present
- Use descriptive `chart_title` names (Title_Case_With_Underscores).
- Mention source rows, metric definitions, and caveats.
- Suggest 1–2 variations (different grouping, zoomed range, different chart type).

## Guardrails
- Must query or provide reviewed rows before charting.
- Use `data-artifacts` chart/table payloads unless the user explicitly requests a file-based chart.
- Max **5 charts** per run.
