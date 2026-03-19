---
name: data/validate
description: >
  QA an analysis before sharing — check methodology, assumptions, SQL logic,
  calculations, visualizations, narrative, and statistical pitfalls.
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

# data/validate — Validate Analysis Before Sharing

Systematically audit an analysis for errors, biases, and presentation issues before
sharing with stakeholders. Produce a confidence assessment with a clear pass/caveat/revise verdict.

## Workflow

### 1. Review methodology and assumptions
Examine:
- **Question framing**: Is the analysis answering the right question? Could it be
  interpreted differently?
- **Data selection**: Are the right tables / time ranges used?
- **Population definition**: Are intended inclusions/exclusions correctly applied?
- **Metric definitions**: Are metrics defined clearly and consistently?
- **Baseline and comparison**: Are time periods, cohort sizes, and contexts comparable?

### 2. Pre-delivery QA checklist

**Data quality:**
- [ ] Row counts match expectations.
- [ ] Null rates are understood and handled.
- [ ] No unexpected future dates in historical data.
- [ ] Categorical values are consistent (case, whitespace, encoding).

**Calculation checks:**
- [ ] Subtotals sum to totals.
- [ ] Percentages sum to 100% where expected.
- [ ] YoY/MoM comparisons use the correct base periods.
- [ ] Filters applied consistently across all metrics.

**Reasonableness checks:**
- [ ] Numbers are in a plausible range.
- [ ] Trends are directionally consistent with known context.
- [ ] Segment counts sum to total population.

**Presentation checks:**
- [ ] Chart axes start at appropriate values (zero for bar charts).
- [ ] Chart scales are consistent across comparison panels.
- [ ] Titles accurately describe what's shown.
- [ ] No truncated axes or 3D effects that distort perception.

### 3. Check for common analytical pitfalls

| Pitfall | Description |
|---|---|
| **Join explosion** | Many-to-many joins that multiply rows unintentionally |
| **Survivorship bias** | Analyzing only entities that "survived" a filter or time window |
| **Incomplete period comparison** | Comparing a full period to a partial one (e.g., last month vs. this month mid-month) |
| **Denominator shifting** | Rates where the denominator changes over time, making the numerator trend misleading |
| **Average of averages** | Averaging rates or ratios across groups instead of computing correctly weighted rates |
| **Timezone mismatches** | Dates/timestamps interpreted in different timezones across tables |
| **Selection bias** | Segmentation that over- or under-represents certain groups |

### 4. Verify calculations
- Spot-check 2–3 key numbers independently (re-compute from first principles or a
  different query path).
- Validate subtotals sum correctly.
- Confirm filters are applied consistently.
- For warehouse queries: run a sanity-check `bq_execute_sql`; for local queries:
  cross-check with `run_sql_query`. When validation will require several follow-up
  checks against warehouse data, materialize the scoped slice first and validate in DuckDB.

### 5. Assess visualizations
- Do axes start at zero for bar charts?
- Are scales consistent across comparison charts?
- Do chart titles accurately describe what's shown?
- Could the visualization mislead a quick reader?

### 6. Evaluate narrative and conclusions
- Are conclusions supported by the data shown?
- Are alternative explanations acknowledged?
- Is uncertainty communicated appropriately?
- Do recommendations follow logically from findings?

### 7. Suggest improvements
Provide specific, actionable suggestions:
- Additional analyses that would strengthen conclusions.
- Caveats or limitations that must be noted.
- Better visualizations or framings for key points.
- Missing context stakeholders would want.

### 8. Confidence assessment
Rate the analysis on a 3-level scale:

**Ready to share** — Methodologically sound, calculations verified, caveats noted.
Minor suggestions for improvement but nothing blocking.

**Share with noted caveats** — Largely correct but has specific limitations or
assumptions that must be communicated. List required caveats explicitly.

**Needs revision** — Found specific errors, methodological issues, or missing
analyses that must be addressed before sharing. List required changes in priority order.

## Guardrails
- Do not modify the original analysis — only report on it.
- Surface all issues found; do not suppress borderline concerns.
- When re-running checks, use the same connector as the original analysis.
