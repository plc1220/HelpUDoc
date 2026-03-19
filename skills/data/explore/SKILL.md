---
name: data/explore
description: >
  Profile and explore a dataset — inspect source options, schema, join keys,
  filters, and connector choice — before writing any SQL or analysis.
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

# data/explore — Profile and Explore a Dataset

Generate a comprehensive data profile for a table or file. Understand its shape,
quality, content, and join potential before diving into analysis.

## Connector selection

- **BigQuery (warehouse)**: use when the user references managed datasets or named
  warehouse tables. Use `bq_list_datasets` → `bq_list_tables` → `bq_get_table_info`
  to navigate metadata, then `bq_execute_sql` for profiling queries. If profiling
  turns into deeper iterative analysis, export a scoped slice with
  `materialize_bigquery_to_parquet` and continue locally.
- **Local files (CSV / Parquet)**: use `get_table_schema` first, then `run_sql_query`
  for profiling. DuckDB auto-registers files found in the workspace.

## Workflow

### 1. Identify the source
- Clarify whether the data is in a warehouse or in local workspace files.
- For warehouse: list datasets → list tables → get table info.
- For local files: call `get_table_schema` (marks schema as inspected before SQL is allowed).

### 2. Understand structure
Before any profiling:
- Row count and column count.
- Grain: one row per *what*?
- Primary key — is it unique?
- Date range coverage (min/max of date columns).
- Classify each column: **Identifier | Dimension | Metric | Temporal | Text | Boolean**.

### 3. Generate data profile
Run targeted profiling queries. Collect per column:
- Null count and null rate.
- Distinct count and cardinality ratio.
- Top-5 most common values with frequencies.
- For numerics: min, max, mean, p25, p75, p95.
- For strings: min/max length, empty count, case consistency.
- For dates: min, max, null dates, future dates (if unexpected).

Present the profile as a clean summary table grouped by column type.

### 4. Identify data quality issues
Flag:
- Null rate > 5% (warn) or > 20% (alert).
- Unexpected low/high cardinality.
- Suspicious placeholder values ("N/A", "TBD", "test", "999999").
- Duplicate detection on natural keys.
- Distribution skew for numeric columns.

### 5. Discover relationships
- Foreign key candidates (ID columns that may join to other tables).
- Hierarchies (country > region > city).
- Likely derived columns.
- Redundant columns.

### 6. Suggest dimensions, metrics, and analyses
- Best dimension columns (categorical, 3–50 distinct values).
- Key metric columns.
- Recommended join keys.
- Suggest 3–5 specific follow-up analyses the user could run next using `data/analyze`.

## Guardrails
- Order: schema/metadata → profiling queries → quality assessment → recommendations.
- No speculation — every observation must come from profiling query results.
- Local SQL: always call `get_table_schema` before `run_sql_query`.
