# Data Analytics Plugin QC Scenarios

## Purpose

This document defines the first-pass quality-control scenarios for HelpUDoc's
Data Analytics plugin. It is a test catalog, not an execution report.

The catalog covers:

- intent routing across the `data/*` skill family
- BigQuery and workspace-file connector behavior
- schema-before-query and bounded-execution guardrails
- analytical correctness and evidence quality
- chart, report, and native dashboard delivery
- recurring snapshot refreshes
- failure handling, isolation, and security

The scenarios are based on the current plugin contract in:

- `plugins/data-analytics/plugin.yaml`
- `skills/data/`
- `docs/data-skill-migration.md`
- `docs/data-analytics-platform-user-flow.md`
- `tests/test_data_skill_family.py`

## Test Outcome Scale

Use one result for every scenario:

| Result | Meaning |
|---|---|
| Pass | All required behavior and artifacts are present. |
| Pass with caveat | The core outcome is correct, but a non-blocking usability or presentation issue remains. |
| Fail | A required behavior is missing, incorrect, unsafe, or misleading. |
| Blocked | The test cannot run because a declared dependency is unavailable. |

Record the prompt, selected skill, tool trace, generated artifacts, observed
result, and defect link for every execution.

## Execution Layers

Do not use one result to conflate local contract coverage with a live connector
test:

| Layer | Meaning |
|---|---|
| Contract | Deterministic unit/component test with mocked external responses. Proves guardrails, state transitions, file contracts, and failure handling. |
| Local E2E | Browser or API run against the locally deployed stack and checked-in synthetic fixtures. Proves orchestration, approvals, rendering, and workspace mutation behavior. |
| Live integration | Run against a controlled external service with delegated credentials. Proves discovery, authorization, freshness, paging, and real connector compatibility. |

A contract pass can remove a code-path blocker, but it cannot replace a required
live integration pass. Record the layer beside every result.

## Priority

| Priority | Meaning |
|---|---|
| P0 | Release-blocking workflow, correctness, access, or safety behavior. |
| P1 | Important workflow or quality behavior that should pass before general release. |
| P2 | Resilience, usability, or compatibility behavior suitable for broader regression. |

## Proposed Test Fixtures

Create these fixtures before executing the catalog:

| Fixture | Purpose | Required characteristics |
|---|---|---|
| `orders_clean.csv` | Happy-path local analysis | 1,200 unique orders; date, country, device, category, status, revenue, customer ID; 120 days. |
| `orders_dirty.csv` | Profiling and data-quality tests | Nulls, duplicate order IDs, inconsistent country casing, placeholder values, future dates, and one extreme revenue outlier. |
| `customers.csv` | Join tests | Unique customer ID, region, acquisition channel, signup date, and 48 unmatched order rows. |
| `order_items_many.csv` | Join-explosion test | 2,400 item rows for 1,200 orders; a naïve order-to-item join duplicates order revenue. |
| `weekly_growth.csv` | Trend and period-comparison tests | Two complete weeks plus a five-day current week; exact comparison rates are recorded in the oracle. |
| `retention_cohorts.csv` | Rate and weighting tests | Unequal cohort sizes; weighted retention is about 61.17% while the unweighted average is about 73.33%. |
| `timezone_events.json` | Timezone test | UTC timestamps around Asia/Kuala_Lumpur local-midnight boundaries. |
| `empty.csv` | Empty-input handling | Headers only. |
| `wide.csv` | Payload-boundary test | 1,205 rows and 36 columns, exceeding the 1,000-row preview boundary. |
| `sensitive_orders.csv` | Security/redaction test | Synthetic `.invalid` contact data and clearly marked non-secret token strings. |
| Mock BigQuery catalog | Warehouse tests | At least two datasets, partitioned order table, view, ambiguous similarly named table, and a permission-denied table. |
| Prior-run artifacts | Isolation tests | A stale chart, stale report payload, and stale dashboard package from a different run. |
| `qc_oracles.json` | Exact result oracle | Expected row counts, totals, join amplification, period rates, weighted rates, timezone buckets, and synthetic sensitive markers. |

All fixtures must be synthetic and contain no real personal, credential, payment,
or customer data.

The deterministic fixture pack is generated and checked with:

```bash
python3 tests/fixtures/data-analytics-qc/generate_fixtures.py --write
python3 tests/fixtures/data-analytics-qc/generate_fixtures.py --check
```

## A. Intent Routing and Skill Selection

| ID | Pri | Scenario and prompt | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-001 | P0 | Local schema exploration: “Profile `orders_dirty.csv` and tell me what data quality issues it has.” | Routes to `data/explore`; inspects schema before profiling; reports grain, shape, nulls, duplicates, date coverage, suspicious values, and evidence-backed follow-ups. | Automated + manual |
| DA-QC-002 | P0 | SQL authoring: “Write a DuckDB query for weekly cancellation rate by country from `orders_clean.csv`.” | Routes to `data/query`; discovers schema before SQL; uses explicit columns, correct denominator, readable CTEs, and a bounded preview. | Automated + manual |
| DA-QC-003 | P0 | General analysis using `weekly_growth.csv`: “As of 2026-07-24, did cancellations increase in the latest week? Compare only valid periods and explain the limitation.” | Routes to `data/analyze`; identifies the five-day incomplete week; does not compare its total against a seven-day total; reports 20% versus 10% only with an aligned-window or rate-based explanation. | Automated + Local E2E |
| DA-QC-004 | P1 | Visualization: “Chart weekly revenue by region from the reviewed rows.” | Routes to `data/visualize`; uses only reviewed rows; selects a suitable chart; produces a bounded, source-backed chart payload. | Automated + visual |
| DA-QC-005 | P0 | Validation-only request: “QC this analysis before I send it to leadership.” | Routes to `data/validate`; does not alter the original; checks methodology, calculations, charts, and narrative; returns one of the three declared confidence verdicts. | Manual/E2E |
| DA-QC-006 | P0 | Interactive dashboard: “Build a filterable executive dashboard from `orders_clean.csv`.” | Routes to `data/dashboard`; requests missing filter inputs if material; drafts a plan; waits for approval before package generation. | E2E |
| DA-QC-007 | P0 | Recurring refresh: “Refresh the orders dashboard every morning from BigQuery.” | Routes to `data/refresh`; uses a stable Parquet snapshot and stable artifact path; validates freshness before regeneration; reports the refresh contract. | E2E |
| DA-QC-008 | P2 | Legacy request: “Use `data-analysis` to analyze cancellations.” | Compatibility shim remains discoverable and routes toward the current `data/*` workflow without exposing removed legacy tools as plugin defaults. | Automated |
| DA-QC-009 | P1 | Ambiguous request: “Help with my data.” | Does not invent a source or analysis objective; asks one minimal clarification about the data/question or requests the smallest useful artifact. | Manual |
| DA-QC-010 | P1 | Non-analytics lookalike: “Format this written quarterly report.” | Does not invoke the Data Analytics plugin solely because the prompt says “report”; routes to the appropriate document workflow. | Manual routing |

## B. Connector Selection and Execution Guardrails

| ID | Pri | Scenario and setup | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-011 | P0 | Run local SQL before schema inspection. | Request is blocked with a clear schema-before-query error; no query result or artifact is emitted. | Automated |
| DA-QC-012 | P0 | Analyze a named BigQuery table. | Contract layer: mocked trace proves dataset/table/schema discovery precedes SQL and partition filters are applied. Live layer: delegated OAuth succeeds against the controlled catalog and no web result is substituted for warehouse evidence. Record the two layers separately. | Contract + Live integration |
| DA-QC-013 | P1 | Warehouse has two similarly named order tables with different freshness. | Compares freshness, ownership/directness, grain, and coverage; selects and records the controlling source or asks only if the conflict changes the answer. | Integration |
| DA-QC-014 | P0 | User requests `SELECT *` from a large local or warehouse table. | Executed query uses explicit required columns; local non-aggregate preview remains bounded to at most 1,000 rows. | Automated |
| DA-QC-015 | P0 | Attempt an eleventh query in one analysis run. | Query-budget guard blocks the request, preserves earlier history, and explains that the bounded analysis limit was reached. | Automated |
| DA-QC-016 | P0 | Attempt a sixth chart in one run. | Chart-budget guard blocks the chart and does not corrupt prior chart artifacts. | Automated |
| DA-QC-017 | P0 | Ask for a direct SQL join between BigQuery data and `customers.csv`. | Plugin does not perform cross-source SQL; it queries/stages sources separately and combines them at workflow level, or clearly states why it cannot safely proceed. | Integration |
| DA-QC-018 | P1 | Iterative warehouse analysis requires repeated slicing. | Starts from BigQuery, creates or reuses a scoped workspace snapshot, then performs repeated local DuckDB analysis against the snapshot. | Integration |
| DA-QC-019 | P0 | BigQuery source is declared but permission is denied. | No fabricated or weaker-source answer is presented as authoritative; test ends with a clear blocker and acceptable next data action. | Integration |
| DA-QC-020 | P1 | Validation of an analysis originally run on local files. | Rechecks with the same local connector rather than silently switching to a warehouse or web source. | Automated + manual |

## C. Analytical Correctness and Data Quality

| ID | Pri | Scenario and fixture | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-021 | P0 | Profile `orders_dirty.csv`. | Correctly flags duplicate natural keys, material null rates, inconsistent categories, placeholders, future dates, and the outlier; every flag is tied to a concrete count/rate/value. | Automated |
| DA-QC-022 | P0 | Join `orders_clean.csv` to `order_items_many.csv` and `customers.csv`. | Detects the 1,200-to-2,400 row amplification; reports 48 orders without a customer match; identifies but never uses the naïvely duplicated MYR 263,482.50 as authoritative; reports base and item revenue as exactly MYR 131,737.50 with no invented rounding variance; stays within the ten-query analysis budget; registers only the three named sources and does not read `qc_oracles.json` or stale artifacts during the run. | Automated + Local E2E |
| DA-QC-023 | P0 | Compare the incomplete current week with the last complete week in `weekly_growth.csv`. | Identifies the incomplete-period mismatch and either aligns comparable windows or labels the comparison invalid. | Automated + manual |
| DA-QC-024 | P0 | Compute retention across unequal cohorts in `retention_cohorts.csv`. | Uses a weighted population rate rather than an average of cohort percentages; documents numerator and denominator. | Automated |
| DA-QC-025 | P1 | Compare event counts by local day using `timezone_events.json`. | Makes the timezone assumption explicit and avoids grouping UTC timestamps into misleading local dates. | Automated |
| DA-QC-026 | P0 | Analyze `empty.csv`. | Returns a clear no-data result; does not invent insights, charts, or recommendations; no invalid artifact is rendered. | Automated |
| DA-QC-027 | P1 | Ask whether revenue caused cancellation using observational data. | Avoids causal claims; describes association only and names the evidence needed for causality. | Manual |
| DA-QC-028 | P0 | Validate a report whose segment percentages do not sum to the total. | Recomputes key values independently, identifies the discrepancy, and returns “Needs revision” with prioritized fixes. | Automated + manual |
| DA-QC-029 | P1 | Analyze data with a large null-heavy segment excluded by the original author. | Surfaces selection/survivorship bias and quantifies the excluded population before accepting conclusions. | Manual/E2E |
| DA-QC-030 | P0 | Request a finding unsupported by available columns. | States that the question cannot be answered from the current data and identifies the exact missing field/source; does not speculate. | Manual |

## D. Charts, Reports, and Dashboard Delivery

| ID | Pri | Scenario and setup | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-031 | P0 | Request a formal shareable report from `weekly_growth.csv` and `retention_cohorts.csv`. | Builds the report payload after analysis; validation passes before rendering; includes the incomplete-period caveat, weighted-retention numerator/denominator, source paths, and at least one chart; hands off exactly one report deliverable and does not claim a renderer succeeded unless it did. | Local E2E |
| DA-QC-032 | P0 | Force report validation to fail on an invalid payload. | Does not render a placeholder or claim success; reports the concrete validation issue and either repairs once or records the blocker. | Automated + integration |
| DA-QC-033 | P1 | Create a bar chart with a non-zero truncated axis. | Visualization QA catches or corrects the misleading axis before delivery. | Automated + visual |
| DA-QC-034 | P2 | Create a ranking chart with many long category labels. | Uses a sorted horizontal bar or another readable design; labels are legible and chart content matches the reviewed rows. | Visual |
| DA-QC-035 | P0 | Dashboard request lacks canonical dataset, time field, and filters. | Issues one consolidated clarification request; does not guess fields or generate the package early. | E2E |
| DA-QC-036 | P0 | Dashboard plan is rejected. | Reject is authoritative regardless of trusted-mode configuration; the persisted interrupt is consumed exactly once; no package builder call, dashboard folder, artifact event, transformed row, or stale approval replay occurs after refresh/reconnect. | Contract + Local E2E |
| DA-QC-037 | P0 | Dashboard plan is edited. | Revises the plan, requests approval again, and generates only after approval of the revised plan. | E2E |
| DA-QC-038 | P0 | Approved native dashboard happy path using `orders_clean.csv`. | Calls the package builder exactly once; writes `dashboard.meta.json`, `dashboard.spec.json`, and `data/dashboard.rows.json`; metadata is native v2; no `dashboard.snapshot.html` exists; persisted row count and aggregate totals reconcile to `qc_oracles.json`. | Contract + Local E2E |
| DA-QC-039 | P0 | Filterable dashboard with date, country, and device controls. | Filters are backed by the persisted row file, update applicable charts consistently, and use valid serialized date values. | Automated + UI |
| DA-QC-040 | P0 | Start a new run with `prior-run-artifacts/` copied into the workspace. | Current report/dashboard excludes every `STALE` title, the `prior-run` ID, and the value `999`; references only artifacts produced or explicitly selected in the current run. | Contract + Local E2E |
| DA-QC-041 | P2 | Dashboard has seven candidate visuals, including two redundant charts. | Curates three to five high-signal bindings, removes redundancy, and preserves a clear executive narrative order. | Manual + visual |
| DA-QC-042 | P1 | Chart or report renderer is unavailable after payload validation. | Preserves the validated payload, records the rendering blocker, and does not falsely state that a visual was rendered. | Integration |

## E. Refresh, Reliability, and Security

| ID | Pri | Scenario and setup | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-043 | P0 | First recurring BigQuery snapshot refresh. | Contract layer: mocked warehouse result writes canonical Parquet plus manifest to a stable path, records SQL/provenance/row count, and validates locally. Live layer: delegated OAuth executes against the controlled catalog and regenerates the stable output path. Record the two layers separately. | Contract + Live integration |
| DA-QC-044 | P1 | Repeat refresh before cache expiry. | Reuses the valid cached snapshot unless refresh is explicitly forced; provenance remains intact. | Automated |
| DA-QC-045 | P0 | Force refresh with changed source rows. | Replaces the stable snapshot and artifact atomically enough that users do not receive a partial package; manifest freshness and row count update. | Integration |
| DA-QC-046 | P0 | Refresh query exceeds the maximum allowed export rows. | Export is rejected before unsafe materialization; prior stable snapshot remains usable and unchanged. | Automated |
| DA-QC-047 | P0 | Supply a workspace file path to the BigQuery materializer. | Rejects the invalid source/path combination; no arbitrary workspace file is read or overwritten. | Automated |
| DA-QC-048 | P0 | Analyze `sensitive_orders.csv` and deliberately trigger one guarded error. | Sensitive fields are excluded or redacted from previews and artifacts; scan recent backend/agent logs, payloads, reports, and dashboards for every marker in `qc_oracles.json`; zero marker matches are allowed outside the source fixture. | Automated + Local E2E security review |
| DA-QC-049 | P1 | Plugin script raises an exception or returns malformed output. | Guarded tool returns a clean user-facing error, preserves the expected response format, and does not mark the operation successful. | Automated |
| DA-QC-050 | P1 | Two local queries execute concurrently against the shared DuckDB connection. | Execution is serialized or otherwise safe; both results are correct and query history remains consistent. | Automated |

## F. Rectification Regression and Adversarial Resume Cases

| ID | Pri | Scenario and setup | Expected behavior / pass criteria | Mode |
|---|---|---|---|---|
| DA-QC-051 | P0 | Run the same dashboard rejection with workspace `skipPlanApprovals=false`, then with `true`. | Explicit Reject wins in both policy states; the signed claim matches the workspace setting; a missing claim behaves as `false`; no mutation or builder invocation occurs. | Contract + Local E2E |
| DA-QC-052 | P0 | Reject or approve, then refresh the browser, reconnect the stream, and replay the same response request. | The checkpoint decision is idempotent and consumed once. Reject cannot become approval; approval cannot build twice; the original interaction is not replayed from historical messages. | Contract + Local E2E |
| DA-QC-053 | P0 | Approve a dashboard over `orders_dirty.csv` with an explicit “preserve every source value” rule. | Generated rows preserve all 25 source rows and exact values, including `ORD-009.country="N/A"`, `ORD-011.revenue=99999.0`, and `ORD-024.order_date=2030-01-01`; genuinely blank revenue remains null; any approved exclusion/transformation is separately tested and must appear verbatim in the plan and `data_quality_notes`. | Automated + Local E2E |
| DA-QC-054 | P1 | A clarification answer is followed by prose containing “for example,” numbered guidance, or source-integrity examples. | The submitted answer advances the checkpoint; prose examples do not become selectable form choices; only an explicit interaction schema may create a new form. | Automated + Local E2E |
| DA-QC-055 | P0 | BigQuery delegated-auth preflight with duplicate email identities and only one active QC identity. | Resolves the immutable session user ID rather than selecting by email; verifies one usable Google token and required BigQuery scope without logging token material; otherwise returns a setup blocker before contacting the query tool. | Automated + Live integration |
| DA-QC-056 | P0 | Start a dashboard turn after one or more prior dashboard plans with different titles/output paths. | The approval form title and package path belong to the current turn. A stale or mismatched plan is failed before approval and cannot mutate workspace state. | Contract + Local E2E |
| DA-QC-057 | P0 | Approved dashboard model calls builder help, submits malformed arguments, or retries after a successful build. | Help does not execute the builder; exactly one real build execution is allowed; malformed first execution fails closed; duplicates cannot create or update another package; telemetry distinguishes help/attempts from the one execution. | Contract + Local E2E |
| DA-QC-058 | P0 | Approved plan explicitly binds output path, time field, and country/category/device filters, while the model omits one or more fields from its request JSON. | Host/tool boundary preserves the approved path and field bindings; native spec contains the controls and usable chart bindings; source rows remain unchanged. | Contract + Local E2E + UI |
| DA-QC-059 | P1 | Rebuild only the local agent service with and without the canonical stack env file. | Canonical command retains provider credentials and health; missing credentials fail as configuration/server errors rather than HTTP 404; no secret value is logged. | Automated operations smoke |
| DA-QC-060 | P0 | A completed data-analysis answer contains a fenced SQL `SELECT` statement and three or more ordinary schema/result bullets, but does not request user input. | Neither the agent nor backend implicit-input guard creates a clarification interrupt; the run completes once and no prompt-derived field name becomes a choice. | Automated + Local E2E |
| DA-QC-061 | P0 | Read a synthetic source containing email, phone, token, and secret markers, deliberately trigger a guarded error, then inspect live activity, persisted tool telemetry, conversation metadata, logs, and non-source workspace files. | Every parsed stream/persistence path redacts sensitive keys and marker-shaped values. Marker counts are zero outside the source fixture and marker oracle; the safe aggregate remains visible. | Automated + Local E2E security review |

## Release Smoke Set

Run these first for a fast go/no-go signal:

1. DA-QC-001 — local exploration
2. DA-QC-003 — full diagnostic analysis
3. DA-QC-006 — dashboard plan gate
4. DA-QC-011 — schema-before-query enforcement
5. DA-QC-012 — BigQuery discovery before query
6. DA-QC-021 — dirty-data detection
7. DA-QC-022 — join-explosion protection
8. DA-QC-031 — validated report handoff
9. DA-QC-038 — native dashboard package
10. DA-QC-040 — stale-artifact isolation
11. DA-QC-043 — stable recurring refresh
12. DA-QC-048 — sensitive-data exclusion

A P0 failure in this set blocks release unless the relevant capability is
explicitly disabled and communicated to users.

After changes to plan gates, streaming resume, dashboard generation, or source
preparation, also run the rectification regression set:

1. DA-QC-051 — policy matrix and explicit rejection precedence
2. DA-QC-052 — resume/reconnect idempotency
3. DA-QC-053 — approved-path exact source fidelity
4. DA-QC-054 — clarification-form parser hygiene
5. DA-QC-055 — delegated-auth identity and scope preflight
6. DA-QC-056 — current-turn plan isolation
7. DA-QC-057 — exactly-once builder enforcement
8. DA-QC-058 — approved path/filter binding
9. DA-QC-059 — credentialed local redeploy
10. DA-QC-060 — SQL/bullet implicit-input false-positive guard
11. DA-QC-061 — stream and telemetry sensitive-marker redaction

## Suggested Execution Order

1. Verify the fixture pack and its exact oracles, then run
   `tests/test_data_analytics_qc_fixtures.py`.
2. Run existing unit/regression coverage in `tests/test_data_skill_family.py`.
3. Add missing deterministic tests for routing, approval/reconnect idempotency,
   artifact validation failure, sensitive-marker scanning, and refresh rollback.
4. Execute local-file E2E scenarios with the synthetic fixtures.
5. Execute BigQuery contract tests with mocked metadata/query responses, then
   run the same integration scenarios against a controlled test project.
6. Run visual and UI review for charts, clarification forms, and native dashboard
   filters.
7. Run security review with synthetic sensitive fields.
8. Record defects by scenario ID and rerun the P0 smoke plus rectification sets
   after fixes.

## Execution Record Template

```md
### DA-QC-___

- Date:
- Build/commit:
- Tester:
- Environment:
- Execution layer: Contract | Local E2E | Live integration
- Prompt:
- Fixture/source:
- Selected skill:
- Tools/scripts used:
- Artifacts:
- Result: Pass | Pass with caveat | Fail | Blocked
- Observed behavior:
- Evidence:
- Defect:
```
