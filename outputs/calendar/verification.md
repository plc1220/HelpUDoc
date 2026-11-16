# Calendar verification — 7 November 2026

## Current local checks

| Scope | Result | Evidence |
| --- | --- | --- |
| Calendar domain, OAuth, proposals, Gmail, telemetry, schema, scheduler and completed-run hook | 68 passed; no skips | `/tmp/helpudoc-calendar-final-backend-tests.log` |
| Related backend policy, run, user and Drive regressions | 88 passed; 23 explicit environment-gated skips | `/tmp/helpudoc-calendar-final-regression-tests.log` |
| Frontend unit checks | 126 passed | `/tmp/helpudoc-calendar-final-frontend-tests.log` |
| Browser scenarios using simulated Google boundaries | 18 passed | `/tmp/helpudoc-calendar-child-e2e.log` |
| Agent authorization, runtime capability binding and related behavior | 51 passed | `/tmp/helpudoc-calendar-final-python-tests.log` |
| Frontend production build | Passed; existing large-chunk warning remains | `/tmp/helpudoc-calendar-final-build.log` |
| Backend TypeScript / focused frontend ESLint / whitespace check | Passed | `/tmp/helpudoc-calendar-final-backend-tsc.log`, `/tmp/helpudoc-calendar-final-lint.log`, `git diff --check` |
| AST graph | Refreshed after source changes | `/tmp/helpudoc-calendar-final-graphify.log` |

The combined passed count is **351**. It describes these check suites and does not establish full live provider or production acceptance.

## Live Google evidence

Account: `licheng.phan@mile.cloud`, dedicated Calendar grant.

- Created a private event with no attendees in Lumo.
- Edited its title and description in Lumo; verified both in Google Calendar.
- Saved a new title in Google; verified reconciliation back into Lumo.
- After explicit user cleanup approval, deleted the disposable event in Lumo.
- Verified no matching event in Lumo and **Could not find the requested event** at its original Google URL.

The screenshots `live-two-way-sync.jpg`, `live-google-event.jpg`, `live-test-removed-lumo.jpg` and `live-test-removed-google.jpg` document those stages. The disposable event no longer exists in the visible calendar. No attendees were invited.

## Remaining acceptance gates

| Gate | Current evidence / next requirement |
| --- | --- |
| Successful real-model briefing | Current configured model key was rejected with `API_KEY_INVALID`. Supply valid local model credentials; verify a new brief and its citations. |
| Live Drive Picker/context | Picker API key/app ID absent. Configure restricted browser key and project ID, consent to `drive.file`, then verify selection/open/link/unlink, shared-drive and revocation behavior. |
| Public Google watch lifecycle | HTTPS test callback absent. Verify actual channel delivery, renewals and fallback reconciliation after configuring a reachable endpoint. |
| Second user/calendar | Only one real account is authorized. A second consented test user is needed for live isolation, read-only/private-event and revocation cases. |
| Remaining live editing matrix | Real attendee notifications, recurring exceptions/series, all-day/timezone changes and ETag races still need consented test fixtures. |
| Existing live scheduler | Calculation and lifecycle regressions pass; a real scheduled execution after the feature remains unverified. |
| Full Compose runtime | Default MinIO image pull fails. A pinned official-source fallback passes Compose/Dockerfile checks; compilation/runtime are unverified with current low disk capacity. |
| Production rollout / operations | No production deployment performed. Consent/policy review, tenant retention configuration, monitoring collection and measured SLOs remain release work. |

The source document's expressly labelled Phase2+ work remains outside this MVP: meeting-relative schedules, proactive/IM briefings, Outlook, resource booking, confidence-rated extraction and Google Tasks. The open gates above remain part of acceptance and have not been reclassified as Phase2.
