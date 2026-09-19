# Team Chat Threads implementation review

Status: **PASS — implementation validated locally; rollout remains disabled.**

Reviewer: Codex. Implementation: Kiro CLI. Review date: 2026-09-20.

## Current implementation status

Kiro completed the backend and frontend implementation. Independent backend review passed 394 tests (367 passed, zero failed, 27 skipped), six permanent Release B integration tests, and six agent history-tool tests. The frontend production build and 124 unit tests pass. The scoped browser validation passes 26/26 tests, including Release A, Release B, annotation, private-work return, submission refresh/apply, exact anchor guards, and 320/420px layout coverage.

No changes have been committed, deployed, or enabled in production. Both thread rollout flags remain default-off.

## Acceptance notes

1. **Dirty and immutable anchors:** unsaved text remains dirty after switching to preview; missing or dirty anchors produce zero new-comment POSTs, while replies remain available. Clean comments carry the exact viewed UUID.
2. **Explicit sharing:** a private annotation requires confirmation, preserves its historical version, discloses only the selected excerpt and body, excludes private replies, and can link the new shared object to a thread.
3. **Private work and review:** Work privately reuses the authorized linked copy, avoids opening the shared proposal on entry, records a user-scoped origin, and returns to the original thread/proposal. Submission refresh shows the frozen selection immediately; Apply shows the applied state and removes the Apply action.
4. **Responsive and gated UI:** Release B surfaces are hidden when the gate is off. The real thread panel passes 320px and 420px bounds checks, including long titles and all actions.
5. **Graph and checks:** `graphify update .` completed after the final code changes (7,064 nodes, 18,303 edges). The full local scoped run uses `tsc -b`, `npm run build`, unit tests, and single-worker browser tests.

## Evidence already established

These results refer to the accepted final checkpoint:

- Independently ran 18 local browser tests: nine actual thread-panel tests, two thread regressions, and seven standalone work-history/proposal/annotation tests. All passed before the final integration changes.
- Independently reproduced and verified fixes for delayed-send draft ownership, stable retry identity, sign-out cleanup, revoked-access cleanup and stopped polling, thread-list refresh/pagination races, and escaped context input budgets.
- Independently ran 12 real PostgreSQL/MinIO proposal-storage tests: immutable selection, atomic application/rollback, stale/concurrent writers, duplicate application, and mirror locking passed.
- Independently checked file provenance across interleaved threads, rename/deletion, failed-run committed changes, immutable byte access, dependency selection, and private-revision races.
- Independently verified public proposal/object responses redact private-copy identifiers, unauthorized conversion cannot replace another member's private copy, frozen bytes remain unchanged after private edits, and revoked viewers are refused.
- Independently verified annotation path-only creation pins the version and file identity; file changes mark the anchor stale; invalid reattachment is rejected; explicit annotation feedback reaches Lumo; retry preserves frozen content after body/anchor edits; and current authorization is rechecked.
- Actual prepared annotation contexts measured 7,315/8,000 and 23,315/24,000 serialized characters in the oversized escaped-content probe. Full frozen feedback was readable from the exact materialized reference file.
- Twelve concurrent schema-initialization attempts passed after moving both function and trigger DDL under the same advisory lock.
- Six agent history-tool tests passed independently.
- The current backend suite independently passes: 394 tests total, 367 passed, zero failed, 27 skipped. The permanent Release B suite passes all six regressions, including actual prepared-context budgets, historical anchors, concurrent initialization, and a private-revision write race.
- Independent full-page probes pass for private entry/return, original discussion navigation, stale Shared-revision refresh, selected-only submission, and exact apply-once behavior. Historical sharing, same-tab origin cleanup, and separate clean/dirty/missing anchor probes also pass.

## Continuation notes

The complete local handoff, Kiro session IDs, review requests, probe scripts, and logs are in `/tmp/helpudoc-kiro-threads/`. Start with `HANDOFF.md`; the newest active-session entry supersedes earlier quota-stop entries.

Use only the local browser target `http://127.0.0.1:5179` for this work. The repository's default Playwright target is a production site; every test command must explicitly set `E2E_BASE_URL=http://127.0.0.1:5179`.

Acceptance is governed by [the implementation specification](./team-chat-threads-spec.md), particularly F1–F8 and A-01–A-13/B-01–B-05. No production rollout, commit, or deployment was performed; both rollout flags remain default-off.
