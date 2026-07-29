# Data Analytics Plugin Browser QC Results — 2026-07-28

## Outcome

**P0 rectification status: Verified locally**

The local application has been redeployed with the correct agent environment,
and the original all-prompts HTTP 404 outage is resolved. Explicit
`/skill data` and `/skill data/explore` requests now execute.

The approval bypass, rejected-plan resume failure, conditional edit/reapproval
failure, stale-plan title leakage, builder multiplicity, missing filter
bindings, silent source-rewrite policy gap, and unsafe backend error
serialization have been rectified.

The final approved browser run completed and produced
`dashboards/filter-contract-final/` with native v2 metadata, one real builder
request, no legacy snapshot HTML, the requested country/category/device
filters, and 25 source-faithful rows. A separate browser run verified that
**Request changes** generates a revised plan and a second approval form before
building.

This is not a full plugin release sign-off. Live BigQuery coverage remains
authorization-blocked. Local join E2E, validated report handoff,
reconnect/idempotency, runtime filter interaction, cross-artifact isolation,
diagnostic-period alignment, and the synthetic sensitive-marker scan now pass.

## Conditional-Case Diagnosis

The earlier result mixed three different forms of incompleteness: a missing
local fixture, an unexecuted local workflow, and a genuinely unavailable live
connector. They now have separate execution layers and should not share one
`Blocked` result.

| Case | Diagnosis | Current disposition |
|---|---|---|
| DA-QC-003 — diagnostic analysis | The original fixture had no comparable prior period. | **Local E2E pass.** Browser run `cf438c37-d701-4920-896f-aea4e0af055b` reviewed only `weekly_growth.csv`, compared aligned Monday–Friday windows, and reported 20% versus 10% with the incomplete-week limitation. |
| DA-QC-012 — BigQuery discovery | The remote `toolbox-bq-demo` is reachable, but the active QC identity has no stored Google OAuth token. The environment also has no fallback BigQuery token or OAuth client values. | Live integration remains blocked by authorization, not network reachability. Add a mocked discovery-order contract test so code-path coverage does not depend on credentials. |
| DA-QC-022 — join explosion | `customers.csv` and `order_items_many.csv` were absent, then the first rerun exposed lossy Markdown float formatting and unrestricted filesystem discovery. | **Local E2E pass after rectification.** Run `f1f6ccb6-5ba2-427c-88c9-3026be1bfad6` reported 1,200-to-2,400 amplification, 48 unmatched orders, base and item revenue of exactly MYR 131,737.50, and the non-authoritative naïve total of MYR 263,482.50. |
| DA-QC-031 — report handoff | The first report run exposed legacy payload normalization, stale sandbox recovery, and an invalid first render snapshot. | **Local E2E pass after rectification.** Post-commit run `ba0514a8-4d2c-43d2-b22c-fe3ea6d82c05` completed with zero tool errors, validated successfully, and rendered one report from only the two named sources. |
| DA-QC-038 — approved dashboard | Early approved runs exposed unconsumed nested interrupts, mutable approval state, repeated builder calls, ignored output paths, and omitted filter bindings. | **Pass after rectification.** Final run `89fe9e5e-2712-4694-95c4-b292b627c2da` completed with one build request, native v2 files at the exact approved path, three filters, and 25 reconciled rows. |
| DA-QC-040 — stale artifacts | The report treated the absence of a browser rerun as no coverage, although component tests already exclude stale charts. | **Local E2E pass.** The diagnostic browser run reviewed one current source file and neither reused nor cited the seeded stale chart, report, or dashboard package. |
| DA-QC-043 — recurring refresh | Stable target, cache reuse, manifest, CSV, and Parquet behavior already have mocked component coverage. Only the live warehouse pull is unavailable. | Contract layer passes; live integration remains blocked by delegated BigQuery credentials. |
| DA-QC-048 — sensitive data | The first security rerun exposed two additional faults: SQL `SELECT` plus bullets triggered a synthetic input form, and raw `read_file` summaries persisted marker values. | **Pass after rectification.** Run `5da4d786-50f4-4a1f-a304-3958d59d3dd9` completed without an interrupt; all four markers had zero matches in its telemetry, conversation payload, service logs, and workspace files outside the source/oracle. |

The revised fixture pack adds exact machine-readable expectations for row
counts, join amplification, base versus naïvely duplicated revenue, incomplete
period rates, weighted retention, timezone buckets, preview boundaries, and
sensitive markers. It is reproducible with
`tests/fixtures/data-analytics-qc/generate_fixtures.py`.

The local database also contains two `ui-test@local.test` user records with
different immutable IDs. Neither has a stored OAuth token; only
`fa957f19-42ef-4fea-a76d-8868eaf0e666` has the Data Analytics QC group grant.
This does not affect the completed local-file tests, but it makes email-based
connector setup ambiguous. DA-QC-055 now requires delegated-auth preflight to
resolve the immutable session user ID and fail before query execution when the
token or BigQuery scope is missing.

The approved-path contract probe also found that Pandas' default CSV parsing
silently converted the literal country value `N/A` into JSON `null`. The native
dashboard builder now disables default sentinel coercion and treats only
genuinely empty cells as missing. A sandboxed regression test verifies all 25
rows plus `ORD-009.country="N/A"`, `ORD-011.revenue=99999.0`,
`ORD-012.revenue=null`, and `ORD-024.order_date=2030-01-01`.

## Local Redeploy and Setup

| Check | Result | Evidence |
|---|---|---|
| Application rebuild | Pass | Backend, agent, and frontend images built successfully. |
| Full-stack recreate | Blocked by existing dependency | Compose could not recreate the fixed-name `helpudoc-minio` container because it already existed outside the active Compose project. No dependency container or volume was deleted. |
| Application-service redeploy | Pass | Recreated `backend`, `agent`, and `frontend` with `docker compose -p infra --env-file env/local/stack.env -f infra/docker-compose.yml up -d --no-deps --force-recreate backend agent frontend`. |
| Agent provider configuration | Pass | The running agent now has a non-empty Gemini API key; `/agents` responds and Fast/Pro/Skill Builder are registered. |
| Frontend health | Pass | `http://localhost:5173/` returns HTTP 200. |
| Agent execution | Pass | A Fast capability request completed in 8 seconds after explicit skill activation. |
| QC user access | Corrected | `ui-test@local.test` initially had no group membership or allowed skills. A local `Data Analytics QC` group now grants the eight declared `data/*` skills and the two declared MCP server IDs. |
| Google Workspace MCP | Unrelated degraded dependency | `infra-google-workspace-mcp-1` remains in a restart loop; it was not required for the local CSV tests. |

## Browser Rerun Summary

| Scenario/check | Result | Browser evidence |
|---|---|---|
| Data Analytics capability orientation | Pass | `/skill data` completed in 8 seconds and described exploration, SQL, analysis, validation, visualization, dashboards, reports, and refreshes without web search. |
| DA-QC-001 — local exploration | Pass with caveat | `/skill data/explore` used the declared sandbox runner and produced a complete profile in 1 minute 6 seconds. |
| DA-QC-006 — dashboard plan gate | Pass | The dashboard workflow ignored the prompt to skip review and displayed a structured plan with Approve, Request changes, and Reject actions. |
| DA-QC-011 — schema-before-query enforcement | Pass with caveat | Raw activity shows a successful `schema` action before the final `query` action. The agent first attempted an undeclared copied script path and then had two recoverable script failures. |
| DA-QC-021 — dirty-data detection | Pass | The explicit profile correctly detected every seeded defect with counts, rates, record IDs, and values. |
| DA-QC-022 — join-explosion protection | **Pass after rectification** | Exact source-grain, joined-grain, unmatched-key, duplicated-revenue, and reconciled-revenue values passed without an invented rounding variance. |
| DA-QC-031 — validated report handoff | **Pass after rectification** | Post-commit run `ba0514a8-4d2c-43d2-b22c-fe3ea6d82c05` used only `weekly_growth.csv` and `retention_cohorts.csv`, validated with no errors or warnings, and rendered exactly one report. |
| DA-QC-036 — rejected dashboard plan | **Pass after rectification** | Reject completed the run with an explicit rejection acknowledgement. No builder activity or new dashboard directory appeared, and the dashboard count stayed at one. |
| DA-QC-037 — edited dashboard plan | **Pass for edit/reapproval checkpoint** | Request changes retained the current title, applied the requested output path/chart/validation changes, and produced a second approval form without building early. |
| DA-QC-038 — approved native dashboard | **Pass after rectification** | Run completed, invoked one real builder request, and produced the exact native package at `dashboards/filter-contract-final`. |
| DA-QC-039 — filter bindings | **Local UI pass** | Country=`Malaysia` produced 9 rows; adding category=`Electronics` produced 4; adding device=`Mobile` produced 3. Both Plotly charts collapsed to the applicable labels, and Reset restored all 25 rows and categories. |
| DA-QC-040 — stale-artifact isolation | **Local E2E pass** | Run `cf438c37-d701-4920-896f-aea4e0af055b` reviewed one current file and used no seeded prior-run chart, report, or dashboard payload. |
| DA-QC-048 — sensitive-data exclusion | **Pass after rectification** | Patched run completed without a false input gate; the deliberate query error recovered, and the post-run marker scan returned zero across five surfaces. |
| DA-QC-052 — reconnect/idempotency | **Local E2E pass** | Browser reload restored the native package at 25 rows. Replaying the completed approval returned HTTP 409; all three package mtimes and 30 persisted tool events remained unchanged. |
| DA-QC-053 — approved dirty-source fidelity | **Pass** | All 25 persisted rows reconcile value-for-value after representing genuinely blank CSV cells as JSON null; literal `N/A`, `99999.0`, null revenue, and `2030-01-01` are preserved. |
| Dashboard source-integrity guard | **Pass for rejected and approved paths** | Rejection produces no files. Approved generation preserves the source rows and sentinels while producing only native v2 files. |
| Clarification checkpoint/resume | Pass with caveat | A submitted clarification was consumed from the persisted checkpoint rather than replaying the original form. A later generated form misinterpreted source-integrity guidance examples as choices; see QC-DA-010. |
| Credential-log protection | Pass in code and tests | Error serialization now recursively redacts authorization, cookie, token, secret, password, and API-key fields while retaining safe diagnostic status/code fields. Previously exposed credentials still require operational rotation. |

## Dirty-Data Calculation Spot Checks

Source: `tests/fixtures/data-analytics-qc/orders_dirty.csv`

| Claim | Result | Independent evidence |
|---|---|---|
| Row count | Verified | 25 rows and 8 columns. |
| Candidate grain | Verified | Intended order-level grain; 24 distinct `order_id` values across 25 rows. |
| Duplicate key | Verified | `ORD-005` appears twice with identical values. |
| Date coverage | Verified | `2026-05-01` through `2030-01-01`; `ORD-024` is future-dated. |
| Country nulls | Verified | Two blanks: `ORD-008` and `ORD-020` (8%). |
| Revenue nulls | Verified | One blank: `ORD-012` (4%). |
| Placeholder | Verified | `ORD-009` has country `N/A`. |
| Category consistency | Verified | `Singapore`, `singapore`, and a whitespace-padded Singapore value coexist; `ORD-010` has category `test`. |
| Revenue outlier | Verified | `ORD-011` has `99999.0`; the next-highest non-null value is `310.0`. |

The plugin profile was analytically accurate for this fixture. Its main caveat
is workflow cost: the run took 66 seconds and created several sandbox executions
for a 25-row CSV.

## Release Smoke Set

| Scenario | Result | Notes |
|---|---|---|
| DA-QC-001 — local exploration | Pass with caveat | Explicit skill path and findings passed; execution was slow and retry-heavy. |
| DA-QC-003 — full diagnostic analysis | **Local E2E pass** | Aligned five-day rates matched the 20% latest and 10% prior oracle; the incomplete week was explicitly disclosed. |
| DA-QC-006 — dashboard plan gate | Pass | Structured approval gate displayed. |
| DA-QC-011 — schema-before-query enforcement | Pass with caveat | Schema action preceded query, but the workflow had avoidable sandbox failures and later executed `SELECT *`. |
| DA-QC-012 — BigQuery discovery before query | Live integration blocked | No delegated BigQuery credential is configured locally. A mocked discovery-order contract test remains to be added. |
| DA-QC-021 — dirty-data detection | Pass | All seeded defects were found with concrete evidence. |
| DA-QC-022 — join-explosion protection | **Local E2E pass** | 1,200 base rows, 2,400 joined rows, 48 unmatched orders, MYR 131,737.50 reconciled revenue, and MYR 263,482.50 naïve duplicated revenue matched the oracle. |
| DA-QC-031 — validated report handoff | **Local E2E pass** | The final run reconciled 500/100 = 20%, 500/50 = 10%, and 679/1110 = 61.171171…%; validation passed before one successful render. |
| DA-QC-038 — native dashboard package | **Local E2E pass** | One real build request; exact output path; native v2 meta/spec/rows; no snapshot HTML; 25 rows reconciled. |
| DA-QC-040 — stale-artifact isolation | **Local E2E pass** | Browser activity reviewed one current source file and the response contained no stale artifact reference. |
| DA-QC-043 — stable recurring refresh | Contract pass; live integration blocked | Mocked tests cover stable Parquet/manifest/CSV publication and cache reuse. Delegated warehouse execution remains unavailable. |
| DA-QC-048 — sensitive-data exclusion | **Local E2E pass with operational follow-up** | Current-run marker counts are zero across telemetry, conversation payload, service logs, and non-source workspace files. Preserve the pre-fix synthetic failure as defect evidence; rotate any real credential exposed before this work. |

DA-QC-036, DA-QC-037, DA-QC-038, DA-QC-039, and DA-QC-053
passed after rectification. There are no remaining observed P0 failures in the
exercised local dashboard paths. Runtime DA-QC-039, reconnect DA-QC-052,
diagnostic DA-QC-003, stale isolation DA-QC-040, and sensitive-data DA-QC-048
also pass. Release remains conditional on the genuinely blocked live BigQuery
layer and the older open operational follow-ups below.

## Defects

### QC-DA-001 — Model initialization errors are misreported as HTTP 404

- Severity: P1 after operational recovery
- Status: Operationally resolved; code defect open
- Rerun result: the correct environment file restored agent execution.
- Remaining issue: the chat route still converts model-construction
  `ValueError` exceptions to HTTP 404, which masks server configuration faults
  as missing resources.

### QC-DA-002 — Failure-analysis request fails with the same provider outage

- Severity: P1
- Status: Open, not reproduced after redeploy
- Evidence from initial run: `/internal/analyze` returned HTTP 500 when the
  provider was unavailable.

### QC-DA-003 — Authorization credential can appear in backend error logs

- Severity: P0 Security
- Status: Resolved in code; credential rotation pending
- Initial evidence: serialized Axios failure details included the bearer
  authorization header.
- Resolution: backend agent-run log paths now use a centralized safe-error
  serializer that recursively redacts authorization, cookies, tokens, secrets,
  passwords, and API keys.
- Regression evidence: tests verify credential redaction and preservation of
  safe diagnostic status/code fields.
- Operational action: rotate the previously exposed credential.

### QC-DA-004 — Lite conversation was labeled Fast

- Severity: P1
- Status: Open, not retested after redeploy
- Initial evidence: active execution showed Lite while the recent-conversation
  card showed Fast.

### QC-DA-005 — Retry may leave a failed tab unresponsive

- Severity: P2
- Status: Needs confirmation
- Initial evidence: one retry flow left the original browser tab unresponsive;
  a fresh tab recovered the workspace.

### QC-DA-006 — QC account had no Data Analytics access grants

- Severity: Environment setup
- Status: Resolved locally
- Root cause: `ui-test@local.test` owned the test workspace but belonged to no
  group, so `/api/agent/slash-metadata` returned no permitted `data/*` skills.
- Resolution: created the local `Data Analytics QC` group with the plugin's
  eight skill grants and two MCP server grants.

### QC-DA-007 — Rejecting a dashboard plan resumes trusted execution

- Severity: P0
- Status: Resolved locally and browser verified
- Reproduction:
  1. Run `/skill data/dashboard` against `orders_dirty.csv`.
  2. Wait for the structured dashboard plan.
  3. Click **Reject**.
  4. Observe `PLAN_APPROVAL_SKIPPED_TRUSTED_MODE`, continued tool activity, and
     creation of `dashboards/sales_performance/data/dashboard.rows.json`.
- Root cause:
  - `backend/src/api/agent/policy.ts` hard-codes
    `skipPlanApprovals: true` into every agent context token.
  - The workspace database value is `false`, but `workspaceService` strips that
    field and the token builder does not use it.
  - On resume, the refreshed request context updates the cached agent runtime
    with `skip_plan_approvals = true`.
  - `request_plan_approval` then takes its trusted-mode branch before consuming
    the submitted reject decision, sets `plan_approved = true`, and tells the
    agent to continue.
- Impact: a user rejection is not authoritative; rejected dashboard work can
  mutate workspace state and invoke build tools.
- Resolution:
  - the signed agent context now uses the authorized workspace
    `skipPlanApprovals` value instead of a hard-coded `true`
  - missing skip claims fail closed
  - explicit human decisions override trusted-mode skipping during resume
  - the stream waits for the persisted graph interrupt before presenting the
    approval form and does not infer stale interrupts from historical messages
- Final browser evidence: Reject completed with an explicit acknowledgement,
  no builder activity, no new dashboard folder, and an unchanged dashboard
  count.

### QC-DA-008 — Dashboard preparation silently rewrites source anomalies

- Severity: P0 Data correctness
- Status: Rejected path and approved builder contract resolved; browser-approved verification pending
- Evidence in generated `dashboard.rows.json`:
  - `ORD-011.revenue`: source `99999.0`, generated `99.99`
  - `ORD-024.order_date`: source `2030-01-01`, generated `2026-05-24`
- Impact: dashboards can present invented corrected values instead of preserving
  source evidence, excluding invalid rows, or requesting an explicit business
  rule.
- Resolution: dashboard instructions now require exact preservation of source
  values. Any exclusion or transformation must be stated precisely in the plan,
  approved, and recorded in `data_quality_notes`.
- Final browser evidence: the rejected rerun generated no files or transformed
  rows.
- Further contract evidence: the approved package builder preserves the literal
  `N/A` sentinel, the `99999.0` outlier, the future date, and blank revenue as
  null across all 25 source rows.

### QC-DA-009 — Declared sandbox runner is invoked through avoidable failure paths

- Severity: P1 Reliability
- Status: Resolved at the tool boundary; efficiency follow-up remains
- Evidence from the query run:
  - the first attempt supplied a copied sandbox path and was correctly rejected
    because the path was not declared for `data/query`
  - the named runner completed the required schema action
  - two later query attempts exited with code 1
  - a final retry succeeded with `SELECT * FROM orders_dirty`
- Impact: simple local queries are slower, noisier, and more fragile than the
  declared runner contract requires.
- Resolution: copied paths to declared sandbox scripts are canonicalized to the
  pinned script name, `query` is accepted as a compatibility alias for `sql`,
  and an eleventh query/export is rejected before execution.
- Rerun evidence: post-commit report run
  `ba0514a8-4d2c-43d2-b22c-fe3ea6d82c05` completed with zero tool errors.

### QC-DA-010 — Clarification fallback can parse guidance examples as choices

- Severity: P1 UX/Reliability
- Status: Open
- Evidence: after a clarification response was correctly consumed from the
  checkpoint, a later agent-generated form treated source-integrity guidance
  phrases such as “for example” as candidate choices.

### QC-DA-011 — Dashboard approval/edit decisions cannot resume the nested tool checkpoint

- Severity: P0
- Status: Resolved locally
- Root cause: LangGraph v3 exposes the authoritative interrupt under
  `event.params.interrupts`, while the dashboard approval is paused inside a
  Deep Agents tool execution that is not a resumable interrupt on the outer
  checkpoint.
- Resolution: dashboard decisions use a host-controlled continuation carrying
  the original request and reviewer decision on a fresh decision thread.
  Approval is host-authoritative; edit must produce a revised approval form.
- Browser evidence: Request changes produced a revised plan; the final approved
  run completed instead of replaying approval prose.

### QC-DA-012 — Approved builder can execute repeatedly and ignore approved bindings

- Severity: P0
- Status: Resolved locally
- Evidence: an adversarial approved run attempted the builder six times,
  created title-derived and approved-path packages, and omitted filters/charts
  from an early package.
- Resolution:
  - one real builder execution is enforced per top-level task;
  - `--help` is handled without executing the builder;
  - duplicate execution attempts are no-ops;
  - the approved output path, filters, and time field are bound at the tool
    boundary;
  - deterministic chart bindings are supplied when the request omits them.
- Final evidence: one `--request-json` build request, zero tool errors, exact
  path, three filters, native v2 files, and 25 reconciled rows.

### QC-DA-013 — Targeted Compose restart can drop required agent credentials

- Severity: Environment setup
- Status: Resolved locally
- Root cause: recreating `agent` without
  `--env-file env/local/stack.env` produced an empty Gemini key and HTTP 404
  chat failures.
- Resolution: local redeploys use the repository's canonical stack env file.
  The running agent reports healthy with a present Gemini key.
- Impact: the original checkpoint loop is fixed, but generated follow-up forms
  can still be confusing or low quality.

### QC-DA-011 — Local QC email maps to two immutable user identities

- Severity: P1 environment/identity
- Status: Product path uses immutable user ID; local cleanup pending
- Evidence: the local `users` table has two `ui-test@local.test` rows:
  `0d8328b0-2e3a-445c-a337-28cd60fe2b4f` and
  `fa957f19-42ef-4fea-a76d-8868eaf0e666`.
- Impact: an environment bootstrap or test helper that selects by email can bind
  a token or grant to the wrong identity. The active QC identity is the latter
  ID; it has the group grant, while neither identity has a Google OAuth token.
- Code-path evidence: agent authorization calls
  `getDelegatedAccessToken(input.userId)`, using the authenticated immutable ID
  rather than email.
- Required action: add an ambiguity regression test and clean up or rename the
  stale local identity only through an intentional environment-maintenance
  action.

### QC-DA-012 — Default CSV parsing converts explicit sentinel text to null

- Severity: P0 Data correctness
- Status: Resolved in builder contract; local E2E pending
- Evidence: the approved-path probe converted `ORD-009.country="N/A"` to
  `country=null` before package generation.
- Root cause: `pandas.read_csv` applies a built-in sentinel list that treats
  literal strings such as `N/A` as missing values.
- Resolution: the native package builder uses `keep_default_na=False` with only
  empty cells declared missing. Its pinned sandbox script hash was updated.
- Regression evidence: the full Data Analytics, sandbox, fixture, BigQuery
  export, and plan-gate suite passes 106 tests with 2 expected skips, including
  an actual sandbox package build over `orders_dirty.csv`.

### QC-DA-014 — SQL `SELECT` and summary bullets trigger a false input gate

- Severity: P0 workflow correctness
- Status: Resolved and browser-verified
- Initial evidence: security run
  `e9498c01-0f21-42be-b6a8-9d09e3834a3f` produced a complete aggregate answer,
  but the implicit-input guard interpreted SQL `SELECT` plus ordinary schema
  bullets as a selection request and left the run awaiting clarification.
- Secondary cause: the synthetic form builder mined the original human prompt,
  turning `contact_email`, `phone`, `payment_token`, and `api_secret` into
  selectable options.
- Resolution: bare SQL `SELECT` is no longer an input-seeking signal, and
  synthetic choices may only come from an explicit assistant choice request.
- Regression evidence: mirrored Python/backend tests pass, and patched browser
  run `5da4d786-50f4-4a1f-a304-3958d59d3dd9` completed without an interrupt.

### QC-DA-015 — Tool summaries persist sensitive source values

- Severity: P0 security
- Status: Resolved for new runs; pre-fix synthetic evidence retained
- Initial evidence: the first sensitive-data run persisted all four synthetic
  markers in a `read_file` summary inside conversation metadata.
- Root cause: safe-error serialization covered exceptions but the streaming,
  conversation, and telemetry paths persisted raw tool-event strings and
  payloads.
- Resolution: the backend now sanitizes every parsed agent stream payload
  before UI streaming or persistence. It redacts sensitive object keys,
  emails, phone values, token/secret patterns, and cells under sensitive CSV
  columns.
- Rerun evidence: all four marker counts are zero in the patched run's tool
  telemetry, conversation payload, agent log, backend log, and workspace files
  outside the source fixture and marker oracle.

### QC-DA-016 — Markdown previews lose aggregate currency precision

- Severity: P0 Data correctness
- Status: Resolved and browser-verified
- Initial evidence: the join result JSON retained cents, but the Markdown
  preview rounded large aggregates to whole MYR values, causing the response to
  invent a MYR 1 reconciliation variance.
- Resolution: `data_workspace` renders numeric previews with up to 15
  significant digits; a sandbox regression locks the cents.
- Rerun evidence: DA-QC-022 reports MYR 131,737.50 for both authoritative
  revenue measures and MYR 263,482.50 only for the naïvely duplicated measure.

### QC-DA-017 — Filesystem discovery bypasses Data Analytics source isolation

- Severity: P0 Data correctness / isolation
- Status: Resolved in code and component-tested
- Initial evidence: built-in filesystem tools exposed raw structured rows and
  prior sandbox/report artifacts even though the skill instructed the agent to
  use scoped `data_workspace` queries.
- Resolution: Data Analytics now blocks raw structured reads, hides prior
  sandbox and untagged artifact paths from list/glob/grep results, and permits
  only current-run sandbox outputs or explicitly tagged artifacts.
- Regression evidence: scoped-backend tests cover raw sources, current and
  prior sandbox runs, untagged and tagged reports, glob/list visibility, grep
  leakage, and the non-Data-Analytics compatibility path.

### QC-DA-018 — Local source discovery registers unrelated workspace artifacts

- Severity: P0 Data correctness
- Status: Resolved and browser-verified
- Initial evidence: schema discovery registered stale dashboards, reports, and
  hundreds of sandbox outputs, expanding model context and making stale reuse
  possible.
- Resolution: every named-source request supplies an exact `paths` allowlist;
  only those files are registered and returned in `sourcePaths`.
- Rerun evidence: DA-QC-022 used its three named sources and DA-QC-031 cited
  only `/weekly_growth.csv` and `/retention_cohorts.csv`.

### QC-DA-019 — Report recovery can validate one payload and render another

- Severity: P0 Delivery correctness
- Status: Resolved and browser-verified
- Initial evidence: legacy `manifest.sections`, an unwrapped snapshot, and a
  reconstructed `[2000]` snapshot caused validation/retry churn and a failed
  first render.
- Resolution: the report builder normalizes legacy sections, enforces
  reader-facing title/blocks plus chart asset/block requirements, wraps
  `snapshot.datasets`, and the skill requires the validated manifest/snapshot
  to be handed to the renderer unchanged.
- Rerun evidence: post-commit run
  `ba0514a8-4d2c-43d2-b22c-fe3ea6d82c05` validated with no errors or warnings
  and completed one successful render with zero tool errors.

## Recommended Fix Order

1. Rotate the credential exposed before safe error serialization was added.
2. Add durable automated E2E coverage for the browser-verified reject,
   reconnect/idempotency, runtime-filter, implicit-input, and sensitive-marker
   paths.
3. Make model configuration failures return an appropriate 5xx response and add
   an agent startup readiness check.
4. Reduce remaining model-side discovery and redundant query churn in small
   local analyses; the tool boundary is now deterministic and bounded.
5. Resolve the duplicate local QC identity and provision controlled delegated
   BigQuery credentials for the authenticated immutable user, then rerun the
   live discovery and recurring-refresh layers.

## Test Artifacts

- Scenario catalog: `docs/data-analytics-plugin-qc-scenarios.md`
- Synthetic fixture: `tests/fixtures/data-analytics-qc/orders_dirty.csv`
- Deterministic fixture generator:
  `tests/fixtures/data-analytics-qc/generate_fixtures.py`
- Exact fixture oracle:
  `tests/fixtures/data-analytics-qc/qc_oracles.json`
- Browser workspace: `Untitled-3`
- QC hardening branch: `agent/data-analytics-qc-hardening`
- Base QC hardening commit: `e10e174`
- Follow-up source-isolation/report rectification: this QC hardening branch
- Final rejected-plan title: `Rejection Acknowledgement Verified`
- Python regression: 334 passed, 4 skipped, 4 subtests passed
- Backend regression: 94 passed, 13 skipped
