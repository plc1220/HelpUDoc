# Data Skill Migration

This document records the current migration from the legacy `data-analysis` skill
to the newer `data/*` skill family, along with the remaining work required before
`data-analysis` can be safely removed.

## Summary

The data skill surface has been expanded from a single end-to-end skill into a
multi-skill family:

- `data`
- `data/explore`
- `data/query`
- `data/analyze`
- `data/visualize`
- `data/validate`
- `data/dashboard`

The new structure is intended to support a more complete workflow for:

- schema and dataset discovery
- SQL authoring and execution
- analysis and insight generation
- chart creation
- validation before sharing
- dashboard assembly

`data-analysis` remains in the repo as a compatibility shim for older prompts and
older user habits.

## What Changed

### Skills

- Added a new nested `skills/data/` skill family with subskills for specialized
  analysis tasks.
- Updated `skills/data-analysis/SKILL.md` to act as a thin compatibility layer
  that routes users toward the new `data/*` skills.
- Added BigQuery MCP awareness to the data skill frontmatter via `mcp_servers`.

### Skill discovery

- `agent/helpudoc_agent/skills_registry.py` now supports recursive discovery of
  nested `SKILL.md` files.
- Nested skills are identified by relative POSIX path, for example
  `data/analyze`.

### Data tools

- `agent/helpudoc_agent/data_agent_tools.py` now tracks run-scoped query and
  chart history.
- Added code-enforced budgets for query count and chart count.
- Added `generate_dashboard` to produce a single HTML dashboard artifact.
- Added `materialize_bigquery_to_parquet` so warehouse-backed analysis can move
  into workspace-local Parquet and continue cheaply in DuckDB.
- Reports and dashboards are now designed to include only artifacts from the
  current run.

### Tests

- Added `tests/test_data_skill_family.py` to cover nested skill discovery,
  frontmatter parsing, tool-scope logic, dashboard generation, and compatibility
  behavior.

## Intended Usage Model

The expected user experience is:

- broad data questions route to `data/analyze`
- SQL-writing requests route to `data/query`
- schema exploration requests route to `data/explore`
- charting requests route to `data/visualize`
- review or QA requests route to `data/validate`
- dashboard assembly requests route to `data/dashboard`

Connector choice is expected to be:

- BigQuery MCP for warehouse datasets
- DuckDB-backed `data_agent_tools` for local CSV and Parquet files
- For iterative warehouse analysis: BigQuery first, then
  `materialize_bigquery_to_parquet`, then DuckDB over the exported Parquet

## BigQuery To DuckDB Materialization Model

The intended serving model is:

- BigQuery remains the warehouse and system of record
- a scoped warehouse query can be materialized into `data_cache/` as Parquet
- DuckDB then handles iterative slicing, visualization, validation, and
  dashboard/report generation

The first version uses:

- workspace-first Parquet export
- metadata JSON written alongside the Parquet file
- manual refresh plus TTL cache reuse

The metadata is expected to capture:

- source SQL
- connector/server id
- row count
- export time
- cache expiry
- target Parquet path

## Known Gaps

The migration is not yet complete. The main gaps are:

### Runtime tool enforcement is not wired through yet

The repo now contains active-skill scope metadata and guarded invocation wrappers.
This area should still be treated as newly introduced and verified carefully,
especially for MCP tools and grouped tool factories.

### Tool names do not yet match enforcement assumptions

The new skills currently declare `tools: [data_agent_tools]`, but the actual
callable tools exposed by that factory are:

- `get_table_schema`
- `run_sql_query`
- `generate_chart_config`
- `generate_summary`
- `generate_dashboard`

If runtime enforcement is enabled without reconciling this mismatch, local data
skills will deny their own tool calls.

### Summary/dashboard exclusivity is documented but not enforced

The skill docs describe a run as producing one summary or one dashboard. This now
needs to remain enforced as the feature evolves.

### Verification environment is incomplete

The new test file has been added, but test execution was not verified in the
current shell environment because `pytest` is not installed there.

## Why `data-analysis` Should Stay For Now

`data-analysis` still provides useful compatibility during the transition:

- older prompts may still refer to `data-analysis` directly
- the new `data/*` routing is more capable, but also more specific
- runtime enforcement is not complete yet, so the shim reduces migration risk

In other words, the new family is the preferred interface, but `data-analysis`
still acts as a safe bridge.

## Future Work Before Removing `data-analysis`

### 1. Finish runtime enforcement

- persist active skill scope in runtime context, not only policy metadata
- enforce builtin tool access based on declared skill tool scope
- enforce MCP access based on declared `mcp_servers`
- always allow core routing and clarification tools

### 2. Fix the tool-scope model

Choose one consistent model and apply it everywhere:

- either declare concrete callable tool names in skill frontmatter
- or treat tool factories as logical groups and map them to callable tools before
  enforcement

This must be reflected in both runtime logic and tests.

### 3. Enforce run-finalization rules

- prevent calling `generate_dashboard` after `generate_summary`
- prevent calling `generate_summary` after `generate_dashboard`
- decide whether `data/dashboard` is a separate follow-up run or a mutually
  exclusive finalization path

### 4. Validate end-to-end behavior

- install test dependencies and run `tests/test_data_skill_family.py`
- add or update integration coverage for `load_skill`, nested skill ids, and MCP
  tool access
- manually validate common prompts against both local DuckDB and BigQuery MCP
- manually validate BigQuery materialization, TTL reuse, and forced refresh flows

### 5. Update user-facing guidance

- prefer `data/analyze` in examples and UI copy
- prefer `data/query`, `data/explore`, and `data/dashboard` in documentation
- mark `data-analysis` as deprecated in docs and possibly in the skill text itself

## Discontinuation Checklist

`data-analysis` can be removed only after all of the following are true:

- runtime skill-to-tool enforcement is implemented and verified
- skill frontmatter and callable tool names are aligned
- summary/dashboard finalization rules are enforced
- the new data skill family passes automated tests
- common user prompts succeed with `data/*` skills alone
- no frontend, backend, prompt, or operator workflow still depends on the
  `data-analysis` id

## Recommended End State

Once the migration is complete:

- `data` remains the main hub skill
- `data/analyze` becomes the default end-to-end entrypoint
- other `data/*` skills handle specialist workflows
- `data-analysis` is removed from the repo entirely

Until then, keep `data-analysis` as a deprecated compatibility alias.
