# Data Platform Hardening Plan

## Context

PR #23 established the snapshot-driven analytics foundation:

- BigQuery as the source of truth
- workspace-local Parquet snapshots as the serving contract
- DuckDB as the local query engine
- stable HTML reports and dashboards generated from refreshed snapshots

This follow-up work focuses on hardening that foundation for reliability, security, and long-term maintainability without changing the core snapshot-based model.

## Goals

1. Make snapshot publication atomic and race-safe.
2. Unify BigQuery auth and runtime context resolution across tools.
3. Add an explicit dataset contract and pre-publish validation layer.
4. Improve observability for refresh runs, freshness, and partial failures.
5. Clarify the security boundary when warehouse data is exported into workspace artifacts.

## In Scope

### 1. Atomic publish

- Write stable Parquet, CSV, manifest, and HTML outputs to temporary paths first.
- Publish with atomic rename where the filesystem supports it.
- Prevent readers from seeing partially written `latest.parquet`, `latest.csv`, or `manifest.json`.
- Ensure dashboards and reports are regenerated only after the corresponding dataset publish succeeds.

Acceptance criteria:

- stable dataset refreshes never expose half-written files
- manifest and dataset paths are updated together
- failed publishes leave the previous stable snapshot intact

### 2. Unified BigQuery context resolution

- Introduce one resolver for project, location, server name, and delegated auth.
- Use the same resolver from BigQuery export and materialization paths.
- Add tests that verify workspace overrides take precedence over toolbox defaults consistently.

Acceptance criteria:

- all BigQuery-backed tools resolve runtime context through one code path
- project/location/auth precedence is documented and tested
- cross-tool behavior stays consistent for the same workspace context

### 3. Dataset contract validation

- Formalize the snapshot manifest as the source of truth for published datasets.
- Validate schema presence, required columns, row counts, and artifact path consistency before publish.
- Add a place for a contract version so downstream skills can evolve safely.

Acceptance criteria:

- every stable dataset publish writes a contract-aware manifest
- invalid or incomplete publishes fail before replacing the stable snapshot
- schema and artifact metadata are validated in tests

### 4. Refresh observability and idempotency

- Track refresh run status, timestamps, and failure mode in a lightweight run log.
- Make repeated refreshes idempotent when inputs are unchanged.
- Surface freshness metadata clearly for downstream dashboards and reports.

Acceptance criteria:

- each refresh run records success or failure with timestamps
- repeated runs with unchanged inputs behave predictably
- freshness metadata is available to artifact-generation steps

### 5. Security boundary and export policy

- Document that exporting warehouse data into Parquet, CSV, and HTML changes the security boundary.
- Add policy hooks for future restrictions such as dataset allowlists, masking, or export gating.
- Capture audit-friendly metadata about source query, project, and refresh actor context where available.

Acceptance criteria:

- exported snapshot manifests clearly record origin metadata
- the codebase has an explicit place to enforce export restrictions later
- documentation reflects the new boundary clearly

## Out of Scope

- live BI dashboards with runtime BigQuery queries
- distributed query execution beyond DuckDB
- full orchestration engine or scheduler rewrite
- semantic modeling layer or metrics catalog

## Recommended Delivery Order

1. Atomic publish
2. Unified BigQuery context resolution
3. Dataset contract validation
4. Refresh observability
5. Security policy hooks and docs

## Why Separate This From PR #23

PR #23 is the foundation. This follow-up keeps the hardening work reviewable and focused while the snapshot-driven workflow can already ship as a coherent first version.
