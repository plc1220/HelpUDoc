# HITL Decision Debug Note

## Summary

Observed against `https://www.lc-demo.com` in the live `research_3` workspace after Google sign-in with a real browser session.

## Confirmed Behaviors

- Google login works and returns to the app.
- Workspace selection in `research_3` succeeds in the live UI.
- The approval card renders with `Approve`, `Edit`, and `Reject`.
- Clarification-style prompting is visible in the chat area, but approval actions still drive the active blocked flow.

## Observed Failures

- `Edit` opens the edit state, but `Save Changes` fails with `Failed to submit run decision`.
- `Reject` opens the confirmation state, but `Confirm Rejection` fails with `Failed to submit run decision`.
- `Approve` also fails to clear the approval card and does not cleanly advance the run.
- Edit feedback can appear as a normal chat message while the approval card remains open.
- A revised approval card can appear underneath the stale approval state, proving frontend run/interruption desync.

## Likely Root Causes

- Paused-run resume depended on in-memory backend context (`runContexts`), so approval decisions failed after backend restart while Redis still preserved the pending interrupt.
- Resume auth depended on a short-lived agent JWT, so delayed approval actions were vulnerable to token expiry.
- Approval bubble state and decision errors were not scoped tightly enough to the interrupt card, which made failed actions look like normal chat/system flow.

## Playwright Artifacts

- `output/playwright/hitl-edit-test.json`
- `output/playwright/hitl-edit-result.json`
- `output/playwright/hitl-edit-save-changes.json`
- `output/playwright/hitl-reject-test.json`
- `output/playwright/hitl-reject-confirm.json`
- `output/playwright/hitl-approve-test.json`
- `output/playwright/lc-demo-google-live-final-report.json`

