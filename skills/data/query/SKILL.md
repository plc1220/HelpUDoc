---
name: data-query
description: "Writes and refines optimized, connector-specific SQL — BigQuery or DuckDB — following best practices for readability, performance, and correctness. Use when the user asks to write SQL, build a query, optimize a query, or needs help with BigQuery or DuckDB syntax for data extraction and transformation."
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

# data/query — Write Optimized SQL

Write the best SQL for the specific connector in use. Understand the request,
discover the schema, write the query, and offer to execute it.

## Connector selection

| Condition | Connector |
|---|---|
| Request targets warehouse datasets or large managed tables | BigQuery MCP (`bq_execute_sql`) followed by `materialize_bigquery_to_parquet` when iterative follow-up is likely |
| Request targets local CSV / Parquet files in the workspace | DuckDB (`run_sql_query`) |

Default to DuckDB for workspace files unless the user names a warehouse table.

## Workflow

### 1. Parse the request
Identify from the user's description:
- **Output columns**: What fields should appear in results?
- **Filters**: Time ranges, segments, statuses, etc.
- **Aggregations**: GROUP BY, counts, sums, averages?
- **Joins**: Multiple tables required?
- **Ordering**: Sort key and direction.
- **Limit**: Top-N or sample?

### 2. Determine dialect
- **BigQuery (warehouse path)**: standard SQL with backtick identifiers,
  `DATE_TRUNC`, `SAFE_DIVIDE`, partitioned tables.
- **DuckDB (local path)**: standard SQL; call `get_table_schema` first;
  use always explicit column names (no `SELECT *`).

### 3. Discover schema
- **BigQuery**: `bq_list_datasets` → `bq_list_tables` → `bq_get_table_info`
  for the relevant tables. Check partition keys, clustering, and views.
- **DuckDB**: call `get_table_schema` for the tables involved.

### 4. Write the query
Follow these practices:

**Structure:**
- Use CTEs (`WITH`) for multi-step queries — one CTE per logical transformation.
- Name CTEs descriptively (`daily_signups`, `active_users`, `revenue_by_product`).

**Performance:**
- Never `SELECT *` in production queries — name only needed columns.
- Filter early (push WHERE close to base tables).
- Use partition filters for BigQuery date partitions.
- Prefer `EXISTS` over `IN` for large subqueries.
- Use the correct JOIN type (don't use LEFT JOIN when INNER is correct).
- Avoid correlated subqueries when a JOIN or window function works.

**Readability:**
- Comment on non-obvious logic.
- Consistent indentation; each major clause on its own line.
- Alias tables with meaningful short names.

**DuckDB-specific:**
- Always include `LIMIT 1000` unless aggregating to a small result.
- `run_sql_query` will automatically append `LIMIT 1000` if omitted.

### 5. Present the query
Provide:
1. The complete query in a SQL code block.
2. Brief explanation of each CTE or section.
3. Performance notes: expected cost, partition usage, potential bottlenecks.
4. How to adjust for common variations (different time range, different grouping).

### 6. Offer to execute
- BigQuery: offer `bq_execute_sql` on the written query.
- If the user will likely iterate on the result, materialize the scoped result
  with `materialize_bigquery_to_parquet` so DuckDB can handle follow-up slicing.
- DuckDB: call `run_sql_query` to execute and return results.
- If results look unexpected, debug and retry (check column names, types, syntax).

## Guardrails
- Schema before SQL: always discover schema before writing and executing.
- No `SELECT *` in any executed query.
- Correct JOIN types; always check for join explosion on many-to-many.
