# Slide generation and editing diagnosis

Date: 2026-09-05. Scope: previous production browser evidence, current source inspection, local Chromium editor regression, frontend tests and production build.

## Findings and changes

| Area | Evidence / cause | Action |
| --- | --- | --- |
| Generation repeats after producing a deck | Production created two differently named HTML decks and ended with a contract error. Recovery code could reopen a setup gate after seeing a final artifact. | Preserved the existing lifecycle change that makes a completed deck authoritative during orphaned-run recovery. Full Redis-backed lifecycle tests remain unrun. |
| Unrequested PowerPoint export | Production assistant reported missing Node/npm during export of an HTML-only request. | Existing checkout changes explicitly gate PowerPoint export on user intent and cap repeated terminal sandbox failures; preserved, not newly implemented in this task. |
| Editing appears to save unexpectedly | WorkspacePage autosaves after 2 seconds. The old toolbar had no saving/error status and enabled Save whenever edit mode was active. | Added autosave disclosure, pending/saved/error feedback, retry, clean-state Save disabling, and ordered manual/automatic requests. |
| HTML toolbar can insert Markdown | B/I/H buttons applied Markdown delimiters to all non-Markdown files. | Replaced with Find; Undo/Redo restore editor focus. |
| Editor input and file switching | Monaco used its experimental EditContext surface. The component could retain a model across file identity changes. | Standard textarea input, automatic resize, keyed editor instance per workspace/file. |
| Narrow canvas hides controls | Production screenshot showed a roughly 160px canvas with a nonwrapping toolbar. | Wrap toolbar controls, truncate the filename with a full-title tooltip. |
| Pet overlaps Send | Production Send click focused the Lumo pet; screenshot shows the overlap. | Move the default pet position above the workspace composer. Manually positioned pets remain user-controlled. |
| Redundant preview request | FileRenderer supplies both loaded HTML and a path, but WorkspaceHtmlPreviewFrame fetched the path again. | Use supplied HTML and retain path for relative asset resolution; add fallback error handling. |
| Editor startup dependencies | Monaco wrapper used its default loader while a separate local Monaco import configured themes. FileEditor eagerly imported the document renderer. | Configure bundled Monaco and same-origin workers; lazy-load the document renderer only when needed. |

## Correction to the earlier browser report

The six-slide QC file contained an appended three-slide test fixture. This does not by itself prove a user-facing replacement or Undo defect. The earlier automation did not establish that Select All had succeeded. Local testing also exposed the distinction between Monaco's visible text surface and underlying input, and a Windows browser profile on a macOS host requiring Ctrl+A rather than host-mapped Command+A. The regression clicks the visible editor and uses the browser's platform before asserting the buffer is empty and replacing it.

Persistence without clicking Save is expected from autosave. `.fill()` on the old EditContext DIV is an automation incompatibility, not proof that humans cannot edit. The initial 16:9 render inspection also did not establish a complete visual quality pass across all sizes.

## Validation and performance

- 81 frontend unit tests passed.
- Backend agent policy/run tests: 41 passed, 16 Redis-dependent lifecycle tests skipped.
- Frontend TypeScript check and Vite production build passed.
- Local Playwright test covers exact HTML replacement, Undo/Redo, Find, switching to a second file, and 390px viewport rendering. It also asserts no jsDelivr request and no document-renderer module request for HTML editing.
- Local development editor readiness observed around 0.55–1.1 seconds during testing. These are development observations, not production timings or a before/after benchmark.
- Build still reports substantial optional chunks: Monaco approximately 1.09 MB gzip, Mermaid 0.66 MB gzip, Plotly 1.46 MB gzip, WorkspacePage 0.30 MB gzip. Local loading removes CDN dependence but does not remove this remaining bundle cost.

Run the editor regression against a local Vite server:

```sh
cd frontend
E2E_BASE_URL=http://127.0.0.1:5178 npx playwright test e2e/slide-editor-local.spec.ts --project=chromium
```

## Release checks still needed

These changes are local and have not been deployed. Before treating production as passed, run the Redis-backed generation lifecycle tests, then the authenticated production smoke test documented in `production-slide-qc.md`. Exercise autosave failure/retry and simultaneous collaboration against a running backend; the isolated editor browser test intentionally uses draft files and does not cover persistence or Yjs synchronization. Verify the chooser and full workspace toolbar on desktop and narrow layouts after deployment. No production artifact was changed during this diagnosis turn.
