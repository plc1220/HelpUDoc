# Governed Skills Operations

This runbook covers rollout, validation, recovery, and rollback for the first governed-skill delivery.

## Runtime and storage

- PostgreSQL is the governance source of truth.
- Immutable blobs and version packages are materialized below `skills/.governed-versions/`.
- `skills/<skillKey>` is a reconstructable compatibility pointer to the selected default version.
- Team Workspace tokens contain an exact signed `skillId`, `versionId`, semantic version, and manifest hash. The agent recomputes the package manifest before loading it and never falls back to the default when a pin is missing or invalid.

## Rollout

1. Back up PostgreSQL and the configured skill storage.
2. Deploy the schema and application together.
3. Start the backend once. Startup backfills existing registry packages as immutable `1.0.0` versions, migrates legacy Team and direct-user grants, and logs `Governed skill migration parity`.
4. Require `ready: true` and empty `unmappedRegistrySkills`, `manifestMismatches`, and `unmappedLegacyGrants` before treating governed writes as authoritative.
5. Verify a member can create a private draft, submit it, and have a different owning Team Lead approve it.
6. Verify a granted user can invoke an exact workspace pin and that an ungranted user cannot.
7. Keep `ENABLE_GOVERNED_SKILLS=true` (the default) to reject legacy registry writes.

The migration and startup process are idempotent. Existing packages remain available through their default compatibility paths while governed versions are added.

## Activation and materialization failure

Activation first writes a complete immutable package into a temporary directory, verifies its manifest, and atomically renames it into the exact-version cache. Default promotion preserves and restores the previous package if the filesystem operation fails.

When activation returns `SKILL_MATERIALIZATION_UNAVAILABLE`:

1. Check storage capacity, ownership, mount availability, and write permissions for `SKILLS_ROOT`.
2. Inspect the `skill_version.activation_failed` audit event using the review-request identifier.
3. Correct the storage fault.
4. Confirm the review is `approved` with `activationStatus: failed`; the Team Lead decision remains immutable.
5. Retry with `POST /api/skill-reviews/:requestId/actions/retry-activation`, the current `expectedRequestRevision`, and a new idempotency key. No active version is exposed until materialization succeeds.

The immutable cache is reconstructable. It may be evicted while the backend is stopped; the source blobs and database records must be retained.

## Private draft execution

A user runs their own private draft in a Private Workspace they own, without Team review. The
spec bounds this to testing: a Team Workspace or published workspace never inherits or invokes
a private proposal.

- `private_workspace_skill_draft_pins` records which draft a workspace uses and at which exact
  revision. `PUT` and `DELETE /api/workspaces/:workspaceId/skill-draft-pins/:draftId` maintain it.
- Pinning materializes the draft revision under `skills/.governed-versions/packages/` beside the
  approved versions. The revision id is a UUID and `skill_draft_revisions.manifestHash` uses the
  same canonical hash as an approved version, so the agent loads a draft through the existing
  exact-pin path and recomputes the manifest before trusting it.
- `buildAgentAuthToken` merges draft pins into `skillAllowIds` and `skillVersionPins` only when
  `workspaceMode` is `private`. The pin query matches on `private_skill_drafts.ownerUserId`, so a
  workspace that changes hands does not carry the previous owner's draft with it.
- A new-skill draft cannot claim a `skillKey` that is already governed. An improvement draft
  deliberately shadows its source skill, and the proposer must already be entitled to that skill.
- Editing a pinned draft advances every pin to the new revision and prunes the superseded
  package. Draft packages are reconstructable from `content_blobs` and
  `skill_draft_revision_files`, exactly as approved versions are, so the cache may be evicted
  while the backend is stopped.
- Set `ENABLE_PRIVATE_SKILL_RUNTIME=false` to stop private drafts reaching the runtime. Pin rows
  survive, so the switch disables execution without destroying user work.

## Suspension and rollback

- Suspend an unsafe exact version with `POST /api/skills/:skillId/versions/:versionId/suspend`.
- Suspension is checked while issuing tokens and again during exact-version resolution. New invocation fails immediately.
- If another active version exists, suspension of the default selects and materializes the newest active fallback.
- Restore an eligible suspended version with the corresponding `/restore` endpoint.
- Roll back new pins by selecting a prior active version with `PUT /api/skills/:skillId/default-version`.
- Existing workspaces never upgrade automatically. Change their exact pin explicitly and publish a new immutable workspace version.

## Application rollback

For a short compatibility rollback window:

1. Stop new governed writes at the edge or stop the backend.
2. Preserve all governed database tables and `skills/.governed-versions/`; do not delete drafts, candidates, decisions, versions, grants, pins, notifications, or audit events.
3. Deploy the prior read path with `ENABLE_GOVERNED_SKILLS=false` only after confirming the default compatibility packages are intact.
4. Do not re-enable Skill Evolution generation or apply archived suggestions.
5. When the governed release is restored, startup will repeat parity validation and retain all work created before rollback.

Rollback changes the active application path; it does not reverse or discard governed state.

## Verification commands

From `backend/`, with the local environment loaded:

```bash
npx tsc --noEmit
npm test
RUN_GOVERNANCE_INTEGRATION=1 node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  --test tests/skillGovernance.integration.test.ts
```

From `agent/`:

```bash
.venv/bin/python -m compileall -q helpudoc_agent
.venv/bin/python -m pytest -q tests
```

From `frontend/`:

```bash
npm run build
```

## Blob storage and the deploy

`skills/.governed-versions/` holds the content-addressed blobs and immutable version
packages for every governed skill. It is gitignored and exists only on the skills volume.

The Cloud Build step `sync-skills-pvc` replaces the skills tree with the repo's copy. It
must never delete `.governed-versions/`: the blobs are the only copy of the content for
every skill a user created through Skill Governance, and the repo cannot restore them.
Deleting it orphans the Postgres rows, so the catalog keeps listing skills whose content
reads back as `SKILL_MATERIALIZATION_UNAVAILABLE`, and `list_skills` stops offering them
because it walks the filesystem. The step excludes that directory with
`find /app/skills -mindepth 1 -maxdepth 1 ! -name '.governed-versions'`.

The per-skill compatibility pointers (`skills/<skillKey>`) and the version packages under
`.governed-versions/packages/` are caches. `reconcileGovernedPackages` rebuilds both from
the blobs at backend startup and logs `Restored governed skill packages`.

A blob that is gone cannot be rebuilt from anything. Startup logs the affected skills as
`Governed skills whose immutable content is unreadable`. Restore the volume from a backup,
or archive those skills with `POST /api/skills/:skillId/archive`.

To audit blob reachability, compare `content_blobs` against the volume:

```bash
kubectl -n helpudoc exec "$PG_POD" -- env PGPASSWORD="$PW" \
  psql -U "$USER" -d "$DB" -At -c 'select "contentHash" from content_blobs' |
while read -r h; do
  kubectl -n helpudoc exec "$APP_POD" -c backend -- \
    test -r "/app/skills/.governed-versions/blobs/${h:0:2}/$h" || echo "MISSING $h"
done
```

## Self-approval

A proposer does not decide their own candidate. Two opt-ins relax that, both off by
default, and both recorded on `skill_review_decisions.selfApproved` and the audit event:

- `ALLOW_SINGLE_LEAD_SKILL_SELF_APPROVAL=true` lets the sole active Lead of a Team
  approve their own proposal. It applies only while that Team has exactly one Lead.
- `ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL=true` lets a Platform Admin approve a
  candidate **they proposed**, whatever the Team's Lead count.

The second grants no authority over anyone else's proposal: an admin still cannot
decide a candidate somebody else submitted, and is still not a reviewer. It exists so
an admin who is the only person able to review a Team is not permanently blocked from
landing their own skill.

Turning either on removes the second pair of eyes for the cases it covers. Audit for
them with:

```sql
select r."id", u.email, d."createdAt"
from skill_review_decisions d
join skill_review_requests r on r.id = d."requestId"
join users u on u.id = d."reviewerUserId"
where d."selfApproved" = true
order by d."createdAt" desc;
```
