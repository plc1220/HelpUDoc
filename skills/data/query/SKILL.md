---
name: data/query
description: >
  Write and refine optimized, connector-specific SQL — BigQuery or DuckDB —
  following best practices for readability, performance, and correctness.
plugin: data-analytics
inherits_plugin_defaults: true
---

# data/query — Write Optimized SQL

Write the best SQL for the specific connector in use. Understand the request,
discover the schema, write the query, and offer to execute it.

## Connector selection

| Condition | Connector |
|---|---|
| Request targets warehouse datasets or large managed tables | BigQuery MCP (`toolbox-bq-demo`) |
| Request targets local CSV / Parquet / JSON files in the workspace | `run_skill_python_script` with `data_workspace` |

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
- **DuckDB (local path)**: standard SQL through the `data_workspace` script; use
  explicit column names for durable queries.

### 3. Discover schema
- **BigQuery**: `bq_list_datasets` → `bq_list_tables` → `bq_get_table_info`
  for the relevant tables. Check partition keys, clustering, and views.
- **DuckDB**: call `run_skill_python_script` with
  `script_name="data_workspace"` and `{"action":"schema"}` before writing local SQL.

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
- The `data_workspace` script applies a bounded `row_limit` when executing local
  query previews.

### 5. Present the query
Provide:
1. The complete query in a SQL code block.
2. Brief explanation of each CTE or section.
3. Performance notes: expected cost, partition usage, potential bottlenecks.
4. How to adjust for common variations (different time range, different grouping).

### 6. Offer to execute
- BigQuery: offer `bq_execute_sql` on the written query.
- If the user will likely iterate on the result, create or use a workspace snapshot
  before continuing locally.
- DuckDB/local: call `data_workspace` with `{"action":"query","sql":"...","row_limit":1000}`
  to execute and return results.
- If results look unexpected, debug and retry (check column names, types, syntax).

## Guardrails
- Schema before SQL: always discover schema before writing and executing.
- No `SELECT *` in any executed query.
- Correct JOIN types; always check for join explosion on many-to-many.
