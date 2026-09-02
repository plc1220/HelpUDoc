# Learnings

Bugs that were shipped-and-caught, near-misses, and the traps in this codebase
that caused them. Written so the next person (or agent) does not rediscover them
the hard way.

Each entry: what broke, why it broke, and the rule that prevents it.

---

## 1. Empty strings are not null, and uuid columns reject them

**Severity: high — this took down every agent run that had no conversation.**

### What happened

The per-file audit trail writes an event inside the same transaction as the file
version. During Phase 2 the emitter gained `conversationId`. On the first live
agent run:

```
Failed to commit generated workspace files:
insert into "file_audit_events" … invalid input syntax for type uuid: ""
```

The audit insert threw → the artifact commit threw → the run was marked
`failed`. The user's file was never committed. A bookkeeping column killed the
whole feature.

### Why

The run pipeline passes optional identifiers through as `''`, not `undefined`.
The emitter used the nullish coalescing operator:

```ts
conversationId: input.conversationId ?? null,   // '' ?? null  ===  ''
```

`??` only substitutes for `null` and `undefined`. An empty string sails
straight through, and Postgres rejects `''` for a `uuid` column.

Every unit test passed. They only ever supplied a real id or omitted the field
entirely — never the empty string the real pipeline actually produces.

### Rules

- **Normalize before insert, not at the call site.** Optional id columns get
  `nullIfEmpty()` (`backend/src/services/fileAuditService.ts`), never bare `??`.
- **`??` is the wrong tool for strings arriving from HTTP or a queue.** Reach for
  it only when `''` is a legitimate value you want to keep.
- **When a value feeds both a hash and a column, normalize once and use the
  normalized value for both**, or the stored row and its checksum disagree.
- Test fixtures must include `''` and `'   '` for anything optional. "Real value
  or absent" is not adequate coverage — it is the shape that hides this bug.

### The bigger lesson

The write was deliberately inside the file-commit transaction so the trail could
never drift from reality. That is the right design, and it also means **an audit
defect is a user-facing outage**. Anything sharing a transaction with a user
action inherits that action's blast radius. Validate its inputs to the same
standard as the action itself.

---

## 2. `.system/` is storage, not documents — 98.6% of the audit trail was noise

**Severity: medium — no outage, but the feature was unusable and ingestion paid for it.**

### What happened

The first backfill produced 2,707 audit events across 2,345 "files". A sanity
check on the number showed:

| | events |
|---|---|
| internal (`.system/`, `sandbox-runs/`) | 2,686 |
| real user documents | **38** |

2,328 of those files were paths like:

```
.system/knowledge/5/bundles/<hash>/concepts/person/ong-chin-yin.md
```

OKF knowledge-bundle artifacts. **A single ingested document explodes into
hundreds of derived concept files**, each getting a `files` row.

### Why

`FileService` already had `isInternalWorkspacePath()` and applied it in nine
places — `getFiles`, folder listing, artifact commit. The new audit emitter
simply did not apply it. The exclusion existed; the new code did not know about
it because it was a **private method on one service**.

Cost, beyond noise: every knowledge ingestion wrote hundreds of audit rows and
computed a SHA-256 chain per file, on the ingestion hot path, for records
nothing will ever read.

### Rules

- **Cross-cutting classification does not belong to one service.** The helper now
  lives in `backend/src/lib/workspacePaths.ts` and `FileService` delegates to it,
  so the file browser and the audit trail cannot disagree about what "internal"
  means.
- **Enforce at the single funnel.** The exclusion sits in `recordFileEvent()` —
  every audit write in the codebase passes through it. One guard, no call site
  can forget.
- **Match on path segments, never substrings.** `path.includes('.system')` would
  silently swallow real documents named `my.system.notes.md`. There is a
  regression test asserting `system/notes.md`, `my.system.notes.md` and
  `sandbox-runs-summary.md` are all still audited.
- **When a count surprises you, go and look.** "2,345 files" was the only signal
  anything was wrong. A glance at the path distribution answered it in one query.

---

## 3. There were 9 write sites, not 7

### What happened

Analysis concluded all `file_versions` inserts funnelled through
`FileService.buildVersionRecord`, making it a clean single hook point. A
repo-wide grep found **two more** in
`workspacePublicationService.replaceWorkspaceContent` that bypass it entirely —
the tombstone-delete and the content-apply.

Instrumenting only `FileService` would have gone silently blind at exactly the
private→shared workspace boundary: publish, sync, restore, private-copy.

### Rules

- **Verify a "single choke point" claim with a repo-wide grep before designing
  around it.** `grep -rn "file_versions').insert" src/` takes seconds and is the
  difference between a complete trail and a hole where it matters most.
- Both stray sites turned out to be inside one function, so the fix stayed small
  — but only because the grep happened before implementation, not after.

---

## 4. `files.id` does not survive a workspace boundary

Not a bug — a domain fact that invalidates the obvious design.

`replaceWorkspaceContent` (`workspacePublicationService.ts`) is the single funnel
for publish, sync, restore, apply-review and create-private-copy. It matches
incoming content **by path**, against the *destination* workspace's own rows:
reuse that workspace's `files.id` if the path exists, else insert a fresh one.
The publication manifest carries **no `fileId`** at all — only `name`, `hash`,
`fileVersionId`, `objectKey`.

So a document published from a private workspace lands on a **different row**,
and any history keyed on `files.id` stops dead there.

**What is durable across the boundary:** `objectKey` and `sha256` are propagated
rather than re-uploaded, and the manifest carries the *source* `fileVersionId`.
That is the only link back, and the sync previously discarded it. Recording it
on the audit event is what makes a published document's origin traceable.

**Rule:** for anything that must survive publication, key on content identity
(`sha256`, `objectKey`, `fileVersionId`), never on `files.id`.

Related trap: `editingPolicy: 'direct'` flips a workspace to `team` **in place**
(same ids, no copy). Only `'review'` mints a separate workspace. Testing one does
not test the other — and it is easy to inspect the wrong file and conclude the
bridge is broken when it is working correctly on a different row.

---

## 5. Workspace deletion hard-deletes; audit tables must not cascade

`workspaceService.performWorkspaceDeletion()` runs `db('workspaces').del()`.
`files.workspaceId` is `onDelete('CASCADE')`, and `file_versions.fileId` likewise.
Private workspaces are deleted immediately; team workspaces trash for 30 days,
then purge.

A conventional `fileId` foreign key on the audit table would have **silently
erased the compliance trail at exactly the moment it matters**.

**Rules:**
- Audit tables are denormalized and self-contained: carry `workspaceId`,
  `filePath`, `sha256`, `objectKey` inline; no cascading FK.
- Object-store *bytes* are retained (`workspaceService.ts`, "retained until
  reference-aware GC exists") but **DB rows are not**. Do not infer one from the
  other.
- Verified, and worth knowing: nothing currently calls `objectStore.delete()`
  during trash or purge — those paths only `fs.rm` the local disk mirror.

---

## 6. Testing traps in this repo

### `Object.create(Service.prototype)` skips field initializers

The test suite constructs services this way throughout. A class field like:

```ts
private readonly cache = new Map();   // undefined in tests
```

is never initialized, and the first `.set()` throws. Caught when a new instance
field broke `workspaceArtifactCommit.test.ts`.

**Rule:** module-scoped state, or lazy init inside the accessor. Never rely on a
field initializer in a class the tests build this way.

### Predicting test failures is not the same as knowing coverage

Five publication tests were expected to fail once audit writes were added to
`replaceWorkspaceContent`. **None did** — because
`workspaceSharedWorkingSync.test.ts` *stubs `replaceWorkspaceContent` entirely*,
and the other four never reach it.

The good news was the bad news: that function's database writes had **no coverage
at all**, so new code there would have shipped unverified.

**Rule:** a test passing after you change a function does not mean the change is
safe. Check the test actually executes it. "No tests broke" is a coverage
question first, a correctness signal second.

### `transpile-only` means the test run does not typecheck

`npm test` uses `ts-node/register/transpile-only`. Type errors pass straight
through. Always run separately:

```bash
./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

One pre-existing error is expected (`scripts/workspace-state-report.ts`,
`getPrefixStats`). Diff against `HEAD` before blaming your change.

### Unit tests with fakes cannot find schema-level bugs

Entry 1 shipped with 300 passing tests. The mocks accepted `''` happily; only
Postgres rejects it. **Exercise the real database before declaring a
storage-layer feature done.**

---

## 7. Duplicate type definitions that shadow each other

`StartRunParams` is declared **twice** — `agent-runs/types.ts:19` (exported) and
`agent-runs/lifecycle.ts:46` (local, shadowing). Adding a field to the exported
one changed nothing; `startAgentRun` reads the local copy.

**Rule:** when a type edit "does not take", grep for a second declaration before
assuming a stale build:

```bash
grep -rn "type StartRunParams\|interface StartRunParams" src/
```

---

## 8. Environment traps

- **`backend/node_modules` may be absent.** There is no root `package.json`; each
  service installs independently. `npm test` fails with a confusing
  `Cannot find module 'ts-node/register/transpile-only'` — run `npm install` in
  `backend/`.
- **`npx tsc` resolves TypeScript from `frontend/node_modules`** and floods the
  output with bogus `@types/node` errors. Use `./node_modules/typescript/bin/tsc`.
- **Rebuild the container after backend edits.** `docker compose … up -d --build
  backend`, or you are testing the previous build and drawing conclusions from it.
- **Signed upload URLs are browser-shaped.** They sign `host;if-none-match` and
  point at the frontend proxy (`:5173`). curl cannot easily complete the flow:
  rewriting the host breaks the signature, and omitting `Content-Type` makes the
  completion step fail its mime check. To exercise such a path from the CLI, call
  the service directly with `ENV_FILE=../env/local/dev.env S3_ENDPOINT=http://localhost:9000`.
- **Langfuse is off unless `LANGFUSE_ENABLED=true`.** An empty `langfuseTraceId`
  is configuration, not a defect. But a *populated* one is not proof tracing
  works either — see entry 10.
- Pre-existing and unrelated: collab port `1234` is not published in compose;
  `/api/agent/personas` 404s despite `AGENT.md`; `google-workspace-mcp` restarts
  in a loop.

---

## 9. Secrets sitting in the working tree

`vertex-prd-sa.json` — a **production Google service account private key** — was
untracked but **not gitignored**, one `git add .` away from being committed.
Several other large artifacts (`backups/`, `skills-pvc-backup-*.tar.gz`,
`trace-*.json`) are in the same state.

**Rules:**
- Stage files explicitly. Never `git add .` / `git add -A` in this repo.
- Anything credential-shaped that has been in a working tree should be **rotated**,
  not merely deleted — removal does not undo exposure.
- Add ignores for the known offenders before the next person reaches for `add .`.

---

## 10. A string `command:` in compose is word-split — the setup job never ran

**Severity: high — all Langfuse tracing had been silently dead.**

### What happened

Traces had trace ids but nothing was ever visible in Langfuse. Keys, base URL
and `OTEL_SDK_DISABLED=false` all checked out; `auth_check()` returned `True`.
A probe span reported:

```
Transient error Internal Server Error encountered while exporting span batch
```

Server side:

```
Failed to upload JSON to S3 events/otel/... The specified bucket does not exist
NoSuchBucket
```

Langfuse v3 buffers every ingestion event to S3 before its worker writes to
ClickHouse. The `langfuse` bucket did not exist. The compose file *did* contain
`mc mb -p local/langfuse`.

### Why

```yaml
entrypoint: ["/bin/sh", "-c"]
command: >
  set -euo pipefail;
  until mc alias set local ...; do sleep 1; done;
  mc mb -p local/langfuse || true;
```

A **string** `command:` is word-split by compose. The resolved argv was:

```
entrypoint: ["/bin/sh", "-c"]
command:    ["set", "-euo", "pipefail"]
```

Everything after the first `;` was discarded. The container ran `sh -c set`,
printed a dump of shell variables, and **exited 0**. The job reported success
for as long as it had existed. Its logs were a variable dump that nobody read,
and `BASH_EXECUTION_STRING=set` in that dump was the giveaway.

Nothing noticed because the app auto-creates its own bucket at startup, so the
one bucket anybody looked at was always there.

### Rules

- **A multi-line shell script in compose must be a list with a block literal**,
  not a folded string:
  ```yaml
  command:
    - |
      set -euo pipefail
      mc mb -p local/langfuse
  ```
- **Verify what compose actually resolved**, not what the YAML looks like:
  ```bash
  docker compose -f infra/docker-compose.yml config --format json \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['services']['minio-setup']['command'])"
  ```
- **`exit 0` from a setup job is not evidence it did anything.** Assert the
  effect — the bucket, the table, the row — not the exit code.
- Once `set -e` actually takes effect, previously-dead commands start mattering:
  confirm each is idempotent (`mc mb -p` is; verified before relying on it) or a
  second `up` will fail the whole stack.

### The bigger lesson

**A generated id is not a delivered record.** The trace id existed because the
SDK mints it client-side; it says nothing about whether the span was accepted.
Any "is telemetry working?" check must query the receiving end.

---

## 11. A status change moves no bytes, and two short-circuits assume it does

**Severity: medium — the feature passed every unit test and did nothing live.**

### What happened

Editorial status was made to propagate from a Shared workspace into a private
copy on sync. All unit tests passed. Live:

```
private status AFTER sync: draft      # expected: approved
```

### Why

Two independent early-outs, both keyed on *content*:

1. The per-file loop in `replaceWorkspaceContent` skips a file whose bytes,
   name and mime type are unchanged.
2. `syncFromTeam` compares content hashes and returns `up_to_date` **before any
   write at all** when they match.

Publishing a file and then syncing it hits **both** — the bytes are identical by
definition; that is the whole point. The propagation code was placed on the
path that only runs when content changed.

### Rules

- **When adding a non-content field to a content-synchronising path, enumerate
  every early-out that short-circuits on content equality.** There were two, at
  different levels, and handling only the inner one still produced a no-op.
- The fix factored the logic into one `inheritFileStatus` helper called from
  both, rather than duplicating it.
- **Unit tests could not have caught this**: each exercised the branch it was
  written for. Only running the real publish-then-sync flow showed the no-op.
  For anything crossing a service boundary, run the actual scenario end to end.

---

## 12. Deriving a flag from data beats setting it at each call site

The plan was to pass `propagateStatus: true` at the two call sites writing into
a private workspace. A grep found **three** — `fastForwardSharedWorking` is a
third, and probably the most common sync path of the lot.

The flag now derives from the destination workspace inside
`replaceWorkspaceContent`:

```ts
const destination = await tx('workspaces').where({ id: workspaceId }).first();
const propagateStatus = Boolean(destination) && !isSharedWorkspaceRecord(destination);
```

**Rule:** if a flag is a *fact about the data* rather than a caller's intent,
derive it once at the funnel. A per-call-site flag is only as correct as your
enumeration of the call sites — and this repo has repeatedly had one more than
expected (see entry 3).

---

## 13. Recorded is not the same as reachable

Provenance was recorded correctly for **every** file type — the database already
held `pdf`, `png`, `txt` and `jpg` trails. Users still reported it worked "only
on `.md`".

The "File history" button had been nested inside the export `ButtonGroup`:

```tsx
{canPrintOrDownloadFile && (   // = isMarkdownFile || isHtmlFile
  <ButtonGroup label="Export file">
    …
    <IconButton label="File history" … />
```

The only entry point to the trail inherited a gate meant for print/download.
History is not an export action.

**Rules:**
- **Check the UI path before concluding the backend is limited.** One `GROUP BY`
  on extension showed capture was universal and reframed the whole question.
- Be wary of adding a control to an existing container for layout reasons: it
  silently inherits that container's render condition.

### Related: the codebase traps found alongside it

- **`withGovernanceLock` acquires its own connection**, so it cannot join a
  caller's transaction. Inside one, take the same lock with
  `pg_advisory_xact_lock` using the shared `governanceLockKeys()` derivation, or
  the two paths lock different things and neither serialises.
- **Guard order changes the error users see.** Checking "is publishing
  configured on this server" before "may this workspace publish at all" produced
  a misleading message and also blocked *unpublishing* on servers with no
  publication target. Order guards from most specific and most durable to least.
- **A modal's page-scroll guard can cancel the space key** at `body` level
  without exempting text fields — spaces silently vanish from a textarea while
  letters work. Two plausible hypotheses (dropdown focus, nesting inside a
  `role="button"`) were both wrong; only bisecting the event as it bubbled found
  it. **Instrument the actual event before writing the fix.**

---

## 14. A second `ensureMembership` on the same request, and a socket that never authenticated

Two traps from adding read-only admin oversight and user deactivation. Both were
invisible to the test suite and both took one run of the real flow to find.

### The authorization call you forgot was there

The admin workspace-detail route resolves access explicitly:

```ts
await workspaceService.ensureMembership(id, userId, { allowSystemAdmin: true });
const access = await workspaceService.listCollaborators(id, userId);   // 403
```

`listCollaborators` runs **its own** `ensureMembership`, without the override, and
threw `Private workspace access denied` — after the handler had already decided
access was granted. The sibling routes (`/files`, `/conversations`) worked, which
made it look like the override itself was broken rather than one callee.

**Rule:** granting access at the top of a handler does not grant it to the
services the handler calls. Before assuming an override reaches the whole
request, grep the callees for their own `ensureMembership`:

```bash
grep -n "ensureMembership" src/services/workspaceService.ts
```

Read-only methods can take `MembershipCheckOptions`; mutating ones deliberately
must not.

### `CONNECTED` from a websocket proves nothing

To check a deactivated user could no longer edit over the collab socket, a raw
`ws` client connected and reported `CONNECTED (auth accepted)` — apparently a
serious hole.

It was a false signal. Hocuspocus runs `onAuthenticate` only when the client
sends an **Auth message**; a bare `ws` socket completes the HTTP upgrade and
never sends one, so the check under test never executed. Driving the real
`HocuspocusProvider` (with `WebSocketPolyfill: ws`) and waiting for
`onAuthenticated` / `onAuthenticationFailed` gave the true answer:
`AUTH REJECTED — permission-denied`, with an active user still accepted as a
control.

**Rule:** a transport-level connection is not an authorization verdict. Probe a
protocol with that protocol's client, wait for the event that carries the
decision, and always run the positive control — a probe that rejects everything
looks identical to one that works.

### The rest of the same shape

- **`ON DELETE CASCADE` differed between fresh and migrated databases.**
  `workspaces.ownerId` was declared `CASCADE` in `createTable` but re-added as a
  bare `uuid` with no FK by the `ensureColumn` retrofit — so deleting a user
  destroyed every workspace they owned on one database and orphaned rows on
  another. One query settled it, and is worth running before trusting any
  cascade in this repo:
  ```sql
  SELECT conname, confdeltype FROM pg_constraint
  WHERE conrelid = 'workspaces'::regclass AND contype = 'f';
  ```
  (`c` = cascade, `r` = restrict, `a` = no action.)
- **Session-cached identity outlives the change you just made.**
  `userContextMiddleware` serves authenticated requests straight from
  `req.session.userContext` and never re-reads the row, so deactivating a
  signed-in user did nothing until their session expired. Status is now checked
  per request behind a 30-second cache that is invalidated on write. The test
  that matters is the awkward one: establish a session, deactivate, then reuse
  *that same cookie*.
- **A guard can be strict enough to create a dead end.** Refusing to delete a
  user while they own any non-purged workspace meant a deactivated user could
  not be deleted for 30 days, while the admin portal offered the button
  throughout. Archived and retired workspaces now pass to the deleting admin,
  who becomes their accountable owner; only *active* workspaces still block.
- **The client-side self-action guard had never worked.** `UsersPage` compared
  `currentUser?.id` — which carries the **externalId** — against a database
  uuid, so `isCurrentUser` was permanently false. The server guard was doing all
  the work. A comparison that never matches fails open and silently.

## Recurring theme

Most entries above share one root cause: **an assumption that was reasonable,
cheap to verify, and not verified.**

- "All writes funnel through this helper" → one grep proved otherwise.
- "`?? null` handles absent ids" → one test with `''` proved otherwise.
- "These tests cover this function" → one read of the test proved otherwise.
- "2,345 files sounds plausible" → one `GROUP BY` proved otherwise.
- "The compose file creates the bucket" → one `config --format json` proved otherwise.
- "There are two call sites" → one grep proved otherwise. Again.
- "It only works on markdown" → one `GROUP BY` proved otherwise.
- "The override grants access to this request" → one 403 proved otherwise.
- "This FK cascades" → one `pg_constraint` query proved it depended on how the
  database was created.

The check is almost always a single command. Run it before designing around the
assumption, not after shipping on it.

The second theme, newer: **success signals that are not evidence of success.**
A setup job exiting 0. A trace id that was minted locally. A green unit suite
for a code path the real flow never enters. A websocket that connected without
ever authenticating. Each looked like confirmation and
carried no information about the thing actually being asked. Assert the effect
at the receiving end.
