---
name: data/visualize
description: >
  Turn validated SQL query output into publication-quality Plotly charts. Select
  the right chart type, apply design best practices, and produce chart artifacts.
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
  If the charting task will involve multiple refinements, export the scoped result
  first with `materialize_bigquery_to_parquet` and then chart from DuckDB.
- **If local workspace files**: call `get_table_schema` then `run_sql_query`.
- **If data already queried earlier in this run**: `generate_chart_config` uses the
  last query result automatically — no need to re-query.

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

### 4. Generate the visualization
Use `generate_chart_config` with Plotly (preferred):

```python
chart_config = {
    "data": [{
        "x": df["category"].tolist(),
        "y": df["value"].tolist(),
        "type": "bar",
        "marker": {"color": "#3b82f6"},
    }],
    "layout": {
        "title": {"text": chart_title, "font": {"size": 18}},
        "xaxis": {"title": "Category"},
        "yaxis": {"title": "Value"},
        "plot_bgcolor": "#f8fafc",
        "paper_bgcolor": "#ffffff",
        "font": {"family": "Inter, system-ui, sans-serif"},
    },
}
```

- Always assign a serializable `chart_config` — no lambdas or special objects.
- Keep logic deterministic; avoid random seeds or shuffling.
- Do not generate more than **5 charts** per run (enforced in code).

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
- Plotly specs saved as `.plotly.json` and `.plotly.html` in `charts/`.
- Use descriptive `chart_title` names (Title_Case_With_Underscores).
- Provide the code used so the user can modify it.
- Suggest 1–2 variations (different grouping, zoomed range, different chart type).

## Guardrails
- Must query data before charting (enforced in code).
- Plotly only — do not use matplotlib unless the user explicitly requests it.
- Max **5 charts** per run.
