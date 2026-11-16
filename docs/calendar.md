# Smart Calendar v0.3 implementation

Local implementation and acceptance work for `Lumo_Smart_Calendar_Technical_Design_v0.3.html`. The live release gates below remain open. Issue #111 adds one opt-in meeting-relative rule: a pending-review follow-up to one Team Chat thread for one timed Google meeting occurrence. See [the rule and acceptance notes](calendar-review-follow-up.md). Broader meeting-relative triggers, proactive briefings, IM enrichment, Outlook, resource booking, confidence-rated extraction and Google Tasks remain future work.

## Experience

The existing calendar icon opens an Astryx Agenda dialog. **Open Calendar** puts Calendar in the center Canvas, retaining the existing Files and Agent pane controls. Desktop supports Agenda, Day, Week and Month; mobile uses Agenda and a detail sheet. Calendar is personal across workspaces. The optional workspace filter affects only Lumo records.

Create, edit, delete, reschedule and resize meetings use Google directly through the backend domain. The UI previews drag/resize changes before Save, retains unsaved fields on conflicts, and offers the latest version for comparison. All-day end dates are exclusive. Recurring occurrence and series edits/deletions are explicit and use the chosen resource's ETag.

Automations use the existing scheduler APIs and tables. They never create Google events. The scheduler form and management dialog use Astryx. Existing workspace tasks are projected through their canonical collaboration service, with its current visibility checks. Personal commitment suggestions are non-blocking until confirmed; confirming one does not create a calendar block.

All new UI uses Astryx components and the existing theme's typography, spacing and interaction system. Cozy Owl tokens override the theme colors; the spec's illustrative blue/violet/green legend is represented by icons, labels and Cozy Owl accents to comply with `AGENTS.md`.

## Connections and authorization

Calendar consent uses the existing Google authorization-code/PKCE flow with a dedicated `calendar=true` mode. It requests `openid`, `email`, calendar-list read and event-read scopes by default. **Enable event editing** explicitly upgrades to event-write permission; Drive linking adds `drive.file`. Review follow-up rules use only reads and an internal Team Chat append, with no Calendar writes, external messaging or model/tool calls. Calendar grants are stored separately from the general agent Google grant, encrypted by the existing AES-256-GCM vault. Multiple Google accounts can be linked to the same authenticated Lumo user without replacing that user's login identity.

Calendar consent excludes previously granted unrelated scopes. For Calendar-only testing, `/api/auth/google/start?identityOnly=true&returnTo=%2F%3Fcalendar%3Dopen` signs in with basic identity scopes without replacing or storing a general Google service grant. This mode requires its original server session through the callback.

Account, calendar, event and file references are resolved against the authenticated server user. The current application uses globally unique user UUIDs rather than a separate tenant identifier; private Calendar records are partitioned by that existing identity boundary. Team task/file access additionally uses the owning workspace services. There is no caller-supplied user or tenant override.

Every event operation checks the current grant and provider calendar role. Writes require ETags and idempotency keys. Only successful provider responses commit UI changes. Creates use a deterministic provider ID and a request fingerprint to recover an ambiguous response without creating a duplicate. Requests use PATCH to preserve fields the editor does not expose.

The Agent receives a signed capability for the explicitly selected meeting reference. Its internal reader checks that reference, the current user, workspace membership and Google permissions again. Calendar-wide listing requires a separate **Allow Agent to read this calendar** selection and signed source capability; a selected meeting alone cannot authorize range enumeration. Runtime tool bindings are rebuilt when these capabilities change. Calendar context clears when navigating to another workspace or conversation.

Native `calendar_create_event`, `calendar_update_event` and `calendar_delete_event` tools create immutable proposals through the domain. The user follows the proposal link to an Astryx review form, then explicitly saves or confirms deletion. The backend records the Agent initiator and human approval, rechecks current write rights and uses the same conditional provider mutation. Raw Calendar MCP mutations remain blocked. Calendar-scoped runs use the source-bound domain connectors, and do not inherit general Google MCP credentials with account-wide mail/file access. The normal Agent workflow retains its existing Google MCP policy when no Calendar context is attached.

Approval is durable before the provider call. An uncertain action stays `APPLYING`, with the exact approved payload and ETag locked for explicit retry. Attempt leases prevent competing retries from changing approval state. A provider-confirmed deletion remains recoverable if local proposal finalization fails. No proposal database connection is held across provider calls. Sync and mutations use their held transaction for vault, authorization, cache and receipt work so a single-connection pool cannot deadlock on nested database access.

## Sync and degraded mode

Each calendar has a stable full/incremental cursor. Cursor updates commit only after the last page; a 410 response rebuilds only that calendar projection. A PostgreSQL advisory lock serializes sync with local mutations. Successful writes reconcile immediately. Google remains the source of truth. Active event projections are bounded per user/calendar and evict the least recently refreshed cached entries. Cancellation tombstones retain identity/version fields only and expire under the technical cache policy; provider events are never deleted by cache maintenance. Expired brief content and unapproved pending proposals are removed without deleting approved retry state, receipts or audit history.

An authenticated watch notification is only a hint. Channel ID, resource ID, encrypted channel secret and expiry must match. Hints mark a source pending; the worker reconciles every 30 seconds, with a two-minute periodic catch-up and watch renewal before expiration. Repeated hints do not create automation runs. The existing scheduler is unchanged.

Transient provider failures allow a previously authorized cached view with stale/read-only status. Known authorization failures deny access and invalidate cached evidence. Calendar disconnection removes Calendar credentials and cached meeting content. Personal link references can remain unavailable until the relevant source is reauthorized; workspace file links continue to use workspace access checks. HTTP responses are private/no-store, request logs omit query strings and bodies, and credentials are never placed in model evidence.

## Related files and briefs

Related files are personal overlays on meetings, tasks, commitments and runs. Google Picker authorizes explicit Drive selection; search only discovers files permitted by the actual grant. Workspace file selection uses the existing file service. Every link read/use rechecks source access. Explicit references and conservative title matches produce at most three permission-checked suggestions with provenance. They become confirmed only when the user links them. Dismissed suggestions stay distinct from confirmed links.

Occurrence links stay local to that date. An explicit series-scope selection enables reuse on other occurrences; series-link changes invalidate dependent briefs. Completed-run outputs are linked using their immutable file version and actual file/run audit provenance. A completion hook creates these associations, and run-link reads reconstruct them after an interrupted hook. Unlinking an output records a dismissal so catch-up does not recreate it. Meeting association remains a separate explicit action.

Prepare briefing uses the selected event and discloses absent sources. Reading linked text requires the user's **Include linked document text** selection. The bounded reader considers at most five documents and 12,000 characters per document in model evidence. Text/JSON/XML and Google Docs/Slides text or first-sheet Sheets CSV exports have a 32 KB input limit. PDF and DOCX inputs have an 8 MiB limit and use the existing Agent service's deterministic isolated parser, without model calls or action tools. PDF review covers at most ten pages of native text; DOCX review covers bounded main-document paragraphs and tables. Visuals, OCR, attachments, extra sheets and other unreviewed content are disclosed as gaps. Unsupported or over-limit sources are excluded with a visible gap.

**Include previous occurrence** is a separate opt-in for recurring meetings. It searches only the selected series within the previous seven days, lists at most 1,000 metadata entries and reads only the latest prior occurrence. Its identity, access and revision are checked before completing and opening the brief. No previous occurrence is read by default.

Gmail is a separate explicit opt-in source. Manual metadata search uses the user's existing general Google grant with actual `gmail.readonly` rights; this feature neither expands consent nor borrows a Calendar account's credentials. Only up to five threads chosen by the user are read when Prepare is pressed. Each contributes at most five messages and 8,000 text characters; attachments are excluded. Current mailbox identity, history revision and access are checked before completion and when the brief is opened. Thread bodies are not stored in brief rows. Meeting changes, saves and revocation clear the UI's selected Gmail sources. No IM content is retrieved.

Briefs record server-built citations, event ETags, file revisions, retrieval times and a source fingerprint. Source access and versions are checked again before completion and on read. A changed/revoked source invalidates the brief. Source text is untrusted evidence and the brief analyzer has no action tools. Jobs show queued/ready/failed states and time out explicitly instead of remaining queued forever.

## Operational evidence

`GET /api/settings/calendar/telemetry` requires current database-verified platform administrator access. It exposes bounded, content-free counters and latency histograms for provider actions/error classes, retries, sync health, watch lifecycle, briefs, Agent policy outcomes and UI interactions. It contains no user, resource, message or credential labels. These metrics are per-process lifetime and need a collector for aggregation across replicas; they do not establish measured SLO compliance.

Calendar tables have compound user/subject and user/calendar indexes. Provider date strings remain lexical in the projection index; it must not be described as normalized UTC range indexing. Live provider lookups remain authoritative. A tenant-specific retention policy and production monitoring collection still need operational configuration.

## Configuration

The existing OAuth client must allow the configured `GOOGLE_OAUTH_REDIRECT_URI` and the Calendar API scopes. Keep `OAUTH_TOKEN_ENCRYPTION_KEY` stable and secret. Do not rotate it without migrating existing grants.

Optional Calendar settings are wired into Compose, GKE and the environment examples:

| Setting | Purpose |
| --- | --- |
| `CALENDAR_CACHE_MAX_EVENTS` | Active cached events per user/calendar; default 5,000, integer 1–50,000. |
| `CALENDAR_CACHE_TOMBSTONE_DAYS` | Content-free cancellation tombstone lifetime; default 90 days, integer 1–365. |
| `CALENDAR_WEBHOOK_URL` | Public HTTPS URL ending in `/api/v1/calendar/watch`. Leave empty locally to use reconciliation polling. |
| `GOOGLE_PICKER_API_KEY` | Browser API key restricted to Google Picker and the actual frontend HTTP referrers. |
| `GOOGLE_PICKER_APP_ID` | Google Cloud project number associated with the OAuth client/Picker app. |
| `FRONTEND_URL` | Trusted frontend origin for cross-origin manual mutations; same-origin requests are supported. |

Do not add Calendar write scopes to the general `GOOGLE_OAUTH_SCOPES` setting. Calendar's dedicated consent path supplies its own incremental scopes.

## Verification and release gates

Local tests simulate Google at the provider boundary and use an isolated PostgreSQL schema. They establish implementation behavior, not Google production acceptance.

```sh
# From backend/
CALENDAR_INTEGRATION=1 node -r ts-node/register/transpile-only -r tsconfig-paths/register --test tests/calendar.test.ts tests/calendarOAuth.test.ts tests/scheduleService.test.ts
CALENDAR_INTEGRATION=1 RUN_CALENDAR_LIFECYCLE_TESTS=1 node -r ts-node/register/transpile-only -r tsconfig-paths/register --test tests/calendar*.test.ts tests/scheduleService.test.ts
npx tsc --noEmit -p tsconfig.json

# From frontend/ with local Vite running
npm test
npm run build
E2E_BASE_URL=http://127.0.0.1:5173 npm run e2e -- e2e/calendar-local.spec.ts --workers=1

# From repository root
agent/.venv/bin/python -m pytest -q tests/test_calendar_policy.py tests/test_calendar_runtime_scope.py tests/test_hitl_plan_approval_config.py tests/test_agent_main.py tests/test_tool_factory.py
graphify update .
```

Release still requires two consented test users/calendars to exercise real create/edit/delete, attendee notifications, recurring exceptions/series, Google-to-Lumo edits, watch delivery/renewal, grant revocation and Drive Picker access/revocation. Configure the public callback and Picker, record those results, and measure the spec's proposed SLOs before claiming production readiness. No production deployment or Google acceptance is established by local mocks.

### Local acceptance evidence, 7 November 2026

`licheng.phan@mile.cloud` completed the dedicated Calendar consent. A private, attendee-free disposable event was created and edited in Lumo, and its updated title and description were verified in Google Calendar. A subsequent title change saved in Google was reconciled back into Lumo. This verifies the basic live two-way path for one account; it does not establish the remaining release matrix above.

After the user confirmed cleanup, deletion through Lumo completed successfully. The event disappeared from Lumo, and its original Google URL returned **Could not find the requested event**; Google showed no events for that test day. Screenshots are saved under `outputs/calendar/live-test-removed-*.jpg`.

Full Compose startup was attempted with the runbook command and failed while pulling the existing `minio/minio:latest` dependency (`pull access denied`). The direct local backend and Vite services remained available. Picker settings and a public HTTPS watch URL are absent from the local environment. Google Cloud CLI resource inspection was blocked by expired credentials requiring interactive reauthentication.

An opt-in, pinned official-source MinIO development fallback is prepared in `infra/docker-compose.minio-source.yml`; see `docs/minio-source-dev.md`. Compose and Dockerfile checks pass. Actual compilation remains unverified because the host has about 6.3 GiB free at 97% capacity; no unrelated storage was pruned. Full container acceptance remains open.

The local Agent starts successfully with `agent/.venv` (the root `.venv` has an older DeepAgents version). A live, event-only briefing reached the model service but failed with `API_KEY_INVALID`; Lumo displayed its failed/retry state. Successful real-model briefing acceptance therefore remains unverified until valid model credentials are supplied. Local provider-boundary tests cover successful bounded briefing, consent, citations, revision invalidation and source revocation.

Latest local verification: **68 Calendar/OAuth/scheduler/schema/lifecycle checks, 88 related backend regressions, 126 frontend unit checks, 18 browser scenarios and 51 Agent checks passed**. The related backend suite also reports 23 explicit environment-gated skips. Frontend production build, backend type checking, focused UI lint and diff checks pass. Detailed evidence and remaining live gates are in `outputs/calendar/verification.md`.
