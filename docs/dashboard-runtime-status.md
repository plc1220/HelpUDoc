# Dashboard Runtime Status

This document captures the recent dashboard-runtime work for the `data/dashboard`
skill: what we planned, what is currently implemented, the main problems we hit
during QA, and the likely next changes.

It is intentionally practical. The goal is to give product, engineering, and QA
one shared view of the current dashboard state before more iteration.

## Summary

The dashboard effort moved through several phases:

1. A workspace-native dashboard object model
2. A live same-origin runtime with session restore and HTML fallback
3. Experiments with Dash- and Streamlit-backed sidecar runtimes (now retired for
   the main product path)
4. **Current:** a **durable dashboard package** rendered **natively in the
   frontend** (React + Plotly), driven by a **shared TypeScript engine** and
   **`chartRuntimeDefs`** in `dashboard.spec.json`, with browser-friendly rows in
   `data/dashboard.rows.json`. The agent streams **`dashboard_artifact`** (not a
   dashboard session); there is **no Streamlit proxy, no backend session TTL, and
   no sidecar** on the critical path.

The user-facing model:

- users invoke `/skill data/dashboard`
- a dashboard appears as one folder object under `dashboards/`
- the canvas loads the package from the workspace (spec and rows)
- interactive filtering and charts use the shared engine + Plotly in the browser

The largest remaining gaps are less about transport and more about:

- dashboard spec quality and validation
- generator discipline under real QA prompts
- package completeness, especially missing `data/dashboard.rows.json`
- eventual per-chart filter scoping (`applies_to`) and richer aggregates if the
  spec grows

## What We Planned

The target dashboard architecture had these goals:

- dashboards should be first-class workspace objects, not loose HTML files
- the durable artifact should live under `dashboards/<slug>/`
- the frontend should show one dashboard row in the file tree
- the canvas should render from the **saved package** (native) rather than
  depending on a short-lived server session
- the system should persist all files the native canvas needs
- the agent should generate declarative dashboard specs, not arbitrary app code
- tagged local Parquet or CSV should be the primary source for interactive
  dashboards

We also wanted the dashboard skill to behave like the research and slides flows:

- inspect the dataset
- produce a plan
- ask for review
- only then build the dashboard

Later, we refined the quality goal further:

- optimize for executive-polish dashboards
- use a stronger layout contract
- freeze chart lineup after approval
- avoid freeform chart-code retries in the happy path

## What We Implemented

### Workspace object model

Dashboard generation targets a **package folder** rather than a flat HTML file.

The intended package shape includes:

- `dashboards/<slug>/dashboard.meta.json`
- `dashboards/<slug>/dashboard.spec.json`
- `dashboards/<slug>/data/dashboard.rows.json` (row-level data for the browser)

The frontend treats the folder itself as the primary dashboard object and opens
it in the canvas. Artifact selection continues to flow through the file pane.

### Dashboard skill flow

`data/dashboard` uses a review-first contract:

- it requests clarification when the dataset/runtime choice is ambiguous
- it produces a dashboard plan
- it requires approval before the build phase
- strict dashboard mode prefers tagged local datasets over fresh BigQuery
  rediscovery

### Native canvas runtime (current)

The live sidecar (Streamlit/Dash) and backend proxy/session paths were removed
from the product shape in favor of:

- **`runtimeKind: "native"`** in generated metadata/spec
- **`chartRuntimeDefs`** as the executable chart contract (deterministic;
  frontend does not interpret open-ended narrative chart metadata)
- **`@helpudoc/dashboard-runtime`**: filters, aggregates, Plotly payload
  building
- stream events: **`dashboard_artifact`** carrying paths/ids for the package the
  user should open

### Package Handling

The canvas supports:

- loading `dashboard.spec.json`, `data/dashboard.rows.json`, and related assets
  from the workspace API
- Plotly charts rendered in-app
We also have:

- folder-path normalization for dashboard packages
- hidden/internal artifact handling in the workspace tree

### Dashboard spec and renderer improvements

`dashboard.spec.json` aims to carry structured fields (version, title, filters,
layout, charts, dataset refs, etc.). The **native** path emphasizes:

- **`chartRuntimeDefs`** for what to render
- shared engine semantics for browser interactivity

## What Went Well

- The workspace-native dashboard object model is much clearer than the original
  loose HTML artifact model.
- The **durable package + native renderer** removes an entire class of
  same-origin proxy, session TTL, and sidecar failures.
- The dashboard skill supports plan approval instead of jumping straight to
  generation.
- Tagged local datasets are a better fit for iterative dashboard work than
  repeated warehouse exploration.
- The package model makes spec and row output easier to reason about than ad
  hoc generated HTML.

## Main Difficulties We Faced

_Historical note: several items below reflect the earlier sidecar/session era._

### 1. Runtime shape changed while the product contract stayed similar

We iterated through Dash- and Streamlit-oriented runtimes before settling on the
native package. User-facing flows stayed familiar, but implementation churn
surfaced restore and transport regressions along the way.

### 2. Agent generation still wandered too much

Even after stricter dashboard-mode guidance, real runs still showed:

- repeated discovery steps
- repeated clarification
- unnecessary fallback to BigQuery materialization
- query budget waste on recovery instead of dashboard intent

This is a generator-discipline problem more than a transport problem.

### 3. Chart generation remained brittle

Several runs still fell back into weak chart bindings or empty structured specs.

Observed issues included:

- syntax errors while generating chart code (legacy paths)
- empty structured chart specs
- semantically swapped metric vs dimension bindings
- dashboards saved with little or no interactive content

### 4. Session restore after refresh was fragile (legacy sidecar)

When the canvas depended on an in-memory live session, refresh or container
restart could break hydration even though the package existed on disk. The
**native** path avoids that coupling; any remaining issues are workspace load
and path normalization, not session TTL.

### 5. Package files were easy to make incomplete

Some generated packages were marked ready without the row file the native
canvas needs, which produced a ready-looking folder that could not open.

### 6. Package path normalization was easy to get wrong

Some generated dashboards were accidentally written one folder too deep, which
made the file tree select the wrong folder and broke asset lookup.

### 7. Clarification UX had input and loop issues

Observed clarification issues included:

- spaces being stripped while typing structured clarification responses
- repeated clarification loops when the agent judged the response too vague
- dead-loop protection terminating the run instead of giving a more helpful
  explanation

## Current State

Today, the dashboard system is best described as:

- **Architecturally aligned** with the durable package + native renderer plan
- **Deterministic chart execution** via `chartRuntimeDefs` and the shared TS
  engine
- Still subject to **generator and spec-quality** variance in real QA

What is true right now:

- the dashboard package model exists **including** `data/dashboard.rows.json`
- the **native** renderer path is the intended default; sidecar sessions are
  not part of the core flow
- generated dashboards should include `dashboard.meta.json`,
  `dashboard.spec.json`, and `data/dashboard.rows.json`
- review-first dashboard planning exists
- the agent emits **`dashboard_artifact`** for the UI to route users to the new
  package

What is not yet consistently true:

- every dashboard run produces a strong structured spec
- every generated package includes the rows file required by the canvas
- every generated chart binding is semantically correct
- every output looks polished enough for executive use
- filters may apply globally to all charts until `applies_to` (or equivalent)
  is wired through the engine

## Why Failures Still Happen

### Failure class: empty or weak spec

Some dashboards were saved with:

- empty `charts` / `chartRuntimeDefs`
- empty `filters`
- empty `datasetRef`

That creates a technically valid package folder but not a useful dashboard.

### Failure class: wrong package path

Some dashboards were saved inside an extra nested folder. The runtime package
was valid, but the UI selected the outer folder and could not find the real
files.

### Failure class: missing row payload

The folder can contain metadata and a spec, but the UI cannot hydrate charts if
`data/dashboard.rows.json` is missing or the spec points to the wrong preview path.

### Failure class: ambiguous clarification

Some dashboard runs failed because the clarification answer stayed too vague,
causing the agent to emit the same clarification again and trip the loop guard.

## Likely Next Changes

### 1. Harden package load

- verify `dashboard.spec.json` and `data/dashboard.rows.json` paths end-to-end
- keep path normalization and tree selection robust for oddly nested outputs

### 2. Make strict dashboard mode truly spec-first

- fail hard if `datasetRef`, `charts`, or `chartRuntimeDefs` are empty where
  required
- forbid legacy chart-code fallback on the main dashboard happy path
- build the package directly from approved structured specs and bounded query
  results

### 3. Tighten generator discipline

- one schema inspection
- one optional preview query
- one bounded aggregate bundle
- no duplicate clarification once dataset and goal are known
- no warehouse materialization when the tagged local dataset is sufficient

### 4. Strengthen spec validation

- require meaningful business metadata where we enforce quality bars
- validate metric vs dimension semantics by chart type

### 5. Engine enhancements (when spec demands it)

- respect **`filter_schema.applies_to`** (or equivalent) so filters target
  specific charts
- extend **`count_distinct`** (and similar) to non-numeric categorical fields if
  generated specs need it

### 6. Separate debugging classes

Track separately:

- workspace package/preview plumbing
- dashboard quality and aesthetics

## Recommended Near-Term Plan

1. Harden package open + row preview for generated artifacts.
2. Enforce spec-first dashboard generation with strict validation at save time.
3. Tighten spec validation before package save.
4. Add or refine executive templates once strict mode is dependable.
5. Iterate on filter scoping and aggregate coverage as the spec evolves.

## Documents To Keep In Sync

When the dashboard system changes again, update these docs together:

- `docs/current-architecture.md`
- `docs/data-analytics-platform-user-flow.md`
- `docs/data-skill-migration.md`
- `skills/data/dashboard/SKILL.md`
