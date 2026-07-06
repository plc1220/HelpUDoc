# Skill Evolution Live DB Cleanup

Snapshot source: live GKE Postgres in namespace `helpudoc`, pod `helpudoc-postgres-9dd7fc57b-4dpvf`.

Snapshot time: 2026-07-06.

Applied cleanup time: 2026-07-06 01:50 UTC.

## Current counts

| Status | Count |
| --- | ---: |
| pending | 0 |
| rejected | 42 |
| stale | 241 |
| accepted | 4 |

## Applied decisions

Accepted with target updates:

- `123bb4cf-6127-4d87-ab78-b1836ef903a4` (`proposal-writing`): installed `/app/skills/proposal-writing/docs/HELPUDOC_LEARNINGS.md`.
- `518cebe7-0f47-4702-8c61-b1bde9328901` (`frontend-slides`): installed edited `/app/skills/frontend-slides/docs/HELPUDOC_LEARNINGS.md` without deprecated gate names.
- `820d524a-d0a3-424b-9963-80b24e2336b8` (workspace memory): installed edited CSV/diagram guidance plus `pptx` vs `frontend-slides` deck routing.
- `f750eada-f93a-4738-a6f5-1f6898ad54b9` (global memory): installed edited tagged-file validation scope guidance.

Rejected:

- `9622412e-f9c3-40bd-a411-843ab6b9381e`: obsolete global slide routing to `frontend-slides`.
- `8c9a22a1-189a-43ba-b2d6-ec495b29e3ab`: obsolete workspace pitch deck routing to `frontend-slides`.
- `089c891d-8237-43bf-8d64-84b9aa4cd234`: target `general` is not a discoverable repo skill.
- `a33bc3ce-37f2-44a1-af8e-76ba5e6dfaf6`: broad global tool workaround was not accepted as durable routing memory.

## Pending queue cleanup

Status: completed. The original review notes are retained below for audit.

### Reject as obsolete or conflicting

1. `9622412e-f9c3-40bd-a411-843ab6b9381e`
   - Target: `/memories/global/skill-routing.md`
   - Reason: Routes all slide/deck/presentation generation to `frontend-slides`.
   - Cleanup: Reject. Current repo routing sends `.ppt`, `.pptx`, PowerPoint, Google Slides, native deck creation/editing/templates, and PPTX output to `pptx`; `frontend-slides` is only for explicit HTML/web presentations.

2. `8c9a22a1-189a-43ba-b2d6-ec495b29e3ab`
   - Target: `/memories/workspaces/60c938e5-0f63-42de-8b54-d491de930e36/skill-routing.md`
   - Reason: Routes pitch deck/slide creation to `frontend-slides`.
   - Cleanup: Reject or replace with an edited rule that distinguishes `pptx` native decks from `frontend-slides` HTML/web decks.

3. `089c891d-8237-43bf-8d64-84b9aa4cd234`
   - Target: `general`
   - Reason: `general` is not a discoverable repo skill.
   - Cleanup: Reject. If the behavior is still desired, move it into runtime/system routing guidance or a real skill.

### Edit before accepting

4. `518cebe7-0f47-4702-8c61-b1bde9328901`
   - Target: `frontend-slides`
   - Reason: Useful learning about not retrying completed A2UI gates, but the proposal mentions old gates (`style_path_selection`, `mood_or_preset_selection`).
   - Cleanup: Accept only after editing to: if `workflow_action` reports a gate is already completed, continue from the next incomplete gate or final deck generation instead of retrying. Avoid reintroducing deprecated gates in new runs.

5. `820d524a-d0a3-424b-9963-80b24e2336b8`
   - Target: `/memories/workspaces/1c92261a-c989-46fa-8c3b-1d382c86fc16/skill-routing.md`
   - Reason: Mixed proposal-slide and WBS CSV guidance. CSV/WBS guidance is still useful; old slide routing likely needs `pptx`/`frontend-slides` distinction.
   - Cleanup: Edit before accepting. Keep the large CSV guidance; update deck routing to `pptx` for native decks and `frontend-slides` only for explicit HTML/web decks.

6. `a33bc3ce-37f2-44a1-af8e-76ba5e6dfaf6`
   - Target: `/memories/global/skill-routing.md`
   - Reason: Broad tool workaround guidance for `google_search` timeout and strict SQL summary workflow.
   - Cleanup: Review carefully. Accept only if the workaround is still true for current tools. Otherwise reject as too broad for global memory.

7. `f750eada-f93a-4738-a6f5-1f6898ad54b9`
   - Target: `/memories/global/skill-routing.md`
   - Reason: User expected `/skill data/validate` with a tagged PDF to validate the new file, not continue prior research.
   - Cleanup: Edit before accepting. The current rule should say tagged files override previous run context; if the tagged file is a PDF, prefer the `pdf` skill or explicit file-grounded validation rather than generic `data/validate`.

### Good accept candidate

8. `123bb4cf-6127-4d87-ab78-b1836ef903a4`
   - Target: `proposal-writing`
   - Reason: Reinforces the proposal artifact contract after a failed run did not write output to a workspace file.
   - Cleanup: Accept or edit lightly. This aligns with existing `proposal-writing` artifact policy.

## Non-pending cleanup

### Nonexistent skill targets

These are not pending, so they do not block the review queue, but they are useful hygiene signals:

| Target skill | Statuses | Note |
| --- | --- | --- |
| `sheets` | 1 rejected, 2 stale | `sheets` was removed; spreadsheet routing now belongs to `xlsx` and `data/*`. |
| `file-management` | 1 rejected | No current repo skill. |
| `general` | 1 pending, 1 rejected, 15 stale | No current repo skill; pending row should be rejected or migrated. |

### Stale volume

There are 241 stale rows. They are historical superseded proposals. They are safe to leave for audit, but the UI should default to `pending` and avoid surfacing stale rows unless explicitly filtered.

If operational cleanup is desired later, consider deleting stale/rejected rows older than 60-90 days after exporting a backup.

## Suggested review order

1. Reject obsolete frontend-slides global/workspace routing rows: `9622412e...`, `8c9a22a...`.
2. Reject or migrate the `general` pending row: `089c891d...`.
3. Edit/accept `proposal-writing`: `123bb4cf...`.
4. Edit/accept `frontend-slides` gate handling: `518cebe7...`.
5. Review workspace/global memory rows that mix current and stale routing: `820d524a...`, `a33bc3ce...`, `f750eada...`.
