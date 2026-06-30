# Data Skill Migration

This document records the current migration from the legacy `data-analysis` skill
to the newer `data/*` skill family, along with the remaining work required before
`data-analysis` can be safely removed.

For the current `data/dashboard` runtime status and native DashboardCanvas package
work, also see `docs/dashboard-runtime-status.md`.

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
- `data/refresh`

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

### Data plugin runtime

- `plugins/data-analytics/plugin.yaml` groups the `data/*` skills as a plugin
  while preserving canonical skill ids.
- `run_skill_python_script` is the Data plugin's only inherited LangChain tool.
- Local data work runs through declared plugin scripts such as `data_workspace`
  and `build_native_dashboard_package`.
- BigQuery remains MCP-backed through `toolbox-bq-demo`.
- Chart/table/report payload validation and rendering are additive MCP features
  exposed by `data-artifacts`.
- Native dashboards remain DashboardCanvas packages with
  `dashboard.meta.json`, `dashboard.spec.json`, and
  `data/dashboard.rows.json`; no `dashboard.snapshot.html` is generated.

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
- `data_workspace` for local CSV, Parquet, and JSON files
- For iterative warehouse analysis: BigQuery first, then a scoped workspace
  snapshot, then DuckDB through `data_workspace`

## BigQuery To Local Snapshot Model

The intended serving model is:

- BigQuery remains the warehouse and system of record
- a scoped warehouse query can be exported into a stable workspace dataset
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

### Dedicated data subagent is not implemented

The V2 plugin is a scope bundle: skills, scripts, and MCP servers are grouped
under `data-analytics`, but execution still happens in the main agent runtime.

### Legacy data tools still exist as compatibility code

The old data tool package remains in the repo for historical tests and
compatibility imports, but it is no longer exposed by Data plugin defaults or
runtime configuration.

### Further prompt/doc cleanup may remain

Some historical docs and compatibility tests can still mention the old tool
package as legacy implementation detail.

## Why `data-analysis` Should Stay For Now

`data-analysis` still provides useful compatibility during the transition:

- older prompts may still refer to `data-analysis` directly
- the new `data/*` routing is more capable, but also more specific
- the shim reduces migration risk while existing prompts and tests finish moving
  to the plugin-script runtime

In other words, the new family is the preferred interface, but `data-analysis`
still acts as a safe bridge.

## Future Work Before Removing `data-analysis`

### 1. Decide whether Data Analytics should become a dedicated subagent

- keep `execution.mode: scope_bundle` for now
- evaluate a future dedicated DeepAgents subagent only after the script/MCP path
  has stabilized

### 2. Complete prompt and doc migration

- prefer `data/analyze` in examples and UI copy
- prefer `data/query`, `data/explore`, and `data/dashboard` in documentation
- mark `data-analysis` as deprecated in docs and possibly in the skill text itself

## Discontinuation Checklist

`data-analysis` can be removed only after all of the following are true:

- the new Data plugin scope is verified in automated tests
- native dashboard package generation is fully script-backed
- report/chart/table payloads flow through `data-artifacts`
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
