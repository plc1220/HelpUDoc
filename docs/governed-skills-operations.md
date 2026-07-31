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
