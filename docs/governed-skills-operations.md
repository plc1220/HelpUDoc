# Governed Skills Operations

This runbook covers rollout, validation, recovery, and rollback for personal skills and governed team publication.

## User flow

- Creating or saving a personal skill validates and publishes an immutable revision for its owner without human approval. Invalid edits remain saved while chat uses the last valid revision. A publication storage failure is shown on the personal skill; saving again retries it.
- Sharing freezes a review candidate. The author can continue editing and using their personal skill. Approval and rejection leave the personal skill intact.
- A lead can publish directly to their own team, including their own work. The recorded decision retains `selfApproved`; no self-approval environment flag is required.
- Approved skills are available through owning-team membership, including new members. Approval also records the team grant. Individual grant maintenance cannot remove owning-team access.
- Personal edits do not update team versions. Subsequent publication is a reviewed improvement with a newer semantic version.
- Each chat turn uses signed exact versions. Personal skills are never inherited through workspace sharing or published-workspace pins.

## Skill Creator

- Proposals are checked by the package validator before Save is enabled, and checked again on the builder save endpoint. Unknown tool/server declarations, unsafe paths, missing manifests, and invalid script contracts block saving. Validation feedback can be sent back to the creator for correction. A proposal has not been saved until the user chooses **Save personal skill**.
- **Import from GitHub** accepts a public repository, skill folder, or `SKILL.md` URL. A repository root must contain `SKILL.md`; otherwise the response lists candidate skill paths. Use a commit permalink for branch names containing slashes. Imports resolve an immutable commit, verify Git blob hashes, and retain source provenance in the saved package.
- GitHub imports currently support UTF-8 text packages up to 30 files / 2 MB. Binary assets must be uploaded separately. Symlinks, submodules, redirects, truncated repository trees, and unsupported files are rejected rather than silently omitted. The importer fetches only GitHub's public API, supplies no credentials, and never installs or executes repository code. Source licenses and notices must be retained when adapting a skill.
- The guided builder uses a private, hidden system workspace with a real UUID and owner membership, so run telemetry and authorization use the same workspace identity.
- Context supports DOCX, XLSX/XLSM, PPTX, PDF, text/data formats, and images (20 MB per file). Upload metadata and originals persist under `WORKSPACE_ROOT/.skill-builder/context-files`; only selected files are copied into a unique `.system/skill-builder-context/` run folder. This reserved internal path survives workspace mirror reconciliation and is excluded from workspace artifact ingestion.
- Users select personal/team skills and registered MCP servers with `/`, and knowledge sources/bases with `@`, in the composer’s inline picker. References are reauthorized on each run and saved in `references/registered-resources.json`. Tags do not grant runtime access; MCP credentials and connection settings are never included.
- Docker Compose uses `http://agent:8001` for backend-to-agent requests. Use `DOCKER_AGENT_URL` only for an explicit container-network override; host-side `AGENT_URL=http://localhost:8001` must not override this address.
- A signed builder context selects a dedicated authoring prompt and read-only document tools. MCP connections, workflow execution, and workspace writes are disabled. Uploaded documents and referenced instructions remain source material, not instructions to the creator. Proposed files are saved only through the governed draft API.

## Runtime and storage

- PostgreSQL is the governance source of truth.
- Immutable blobs and version packages are materialized below `skills/.governed-versions/`. Owner-only packages use `personal/<draft UUID>/<revision UUID>` inside the package store and never enter the shared registry. Optional workspace sync excludes immutable storage.
- `skills/<skillKey>` is a reconstructable compatibility pointer to the selected default version.
- Team Workspace tokens contain an exact signed `skillId`, `versionId`, semantic version, and manifest hash. The agent recomputes the package manifest before loading it and never falls back to the default when a pin is missing or invalid.

## Rollout

1. Back up PostgreSQL and the configured skill storage.
2. Deploy the schema and application together.
3. Start the backend once. Startup backfills existing registry packages as immutable `1.0.0` versions, migrates legacy Team and direct-user grants, and logs `Governed skill migration parity`.
4. Require `ready: true` and empty `unmappedRegistrySkills`, `manifestMismatches`, and `unmappedLegacyGrants` before treating governed writes as authoritative.
5. Verify a member can immediately use a valid personal save and submit it for lead approval. Verify a lead can publish their own skill directly.
6. Verify owning-team members can use approved skills automatically, other users cannot consume personal skills, and published workspaces retain exact pins.
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

## Admin anomaly blocking

The admin execution controls on the Skills page support an entire skill or a specific package, plus a required reason for blocking and unblocking. `PUT /api/skills/execution-controls` accepts `skillKey`, optional `versionId`, `blocked`, and `reason`. Only platform admins may change these controls.

- A whole-skill block covers all versions of that identity. A package block uses the immutable manifest hash and applies to identical personal and team packages.
- Blocks override team membership, grants, and pins. A lead cannot clear them by restoring a version or approving a submission.
- PostgreSQL records blocks and audit events. Runtime markers live in `skills/.governed-blocks/`; backend and agent must share this storage, as they do for immutable packages. Preserve it alongside package storage. Startup recreates markers from database records.
- Already-issued pins are checked when loading skills. Active skills check markers before subsequent guarded tool calls. Processes already executing may finish within their existing limits; blocking does not forcibly terminate a running process.
- Removing a personal skill separately revokes its existing runtime pins.

## Suspension and rollback

- Suspend an unsafe exact version with `POST /api/skills/:skillId/versions/:versionId/suspend`.
- Suspension excludes the version when issuing new tokens. Use an admin execution block for an anomaly requiring enforcement against already-issued tokens and active turns.
- If another active version exists, suspension of the default selects and materializes the newest active fallback.
- Restore an eligible suspended version with the corresponding `/restore` endpoint.
- Roll back new pins by selecting a prior active version with `PUT /api/skills/:skillId/default-version`.
- Existing workspaces never upgrade automatically. Change their exact pin explicitly and publish a new immutable workspace version.

## Application rollback

For a short compatibility rollback window:

1. Stop new governed writes at the edge or stop the backend.
2. Preserve all governed database tables, `skills/.governed-versions/`, and `skills/.governed-blocks/`; do not delete drafts, candidates, decisions, versions, grants, pins, notifications, or audit events.
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
