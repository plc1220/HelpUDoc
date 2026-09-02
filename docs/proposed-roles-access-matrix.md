# Proposed Roles & Access Matrix

> **Status: PROPOSED** — target-state model, not what ships today. It decomposes the
> current monolithic `isAdmin` flag into capability- and team-scoped roles, while
> keeping the existing workspace `owner`/`editor`/`viewer` roles unchanged. See
> `docs/roles-access-matrix.md` for the current state.

## Proposed roles

**System-level roles** (a user holds exactly one):

| Role | Scope | Summary |
|---|---|---|
| **Platform Admin** | Global superuser | Everything; implies all capabilities. Backward-compatible with today's `isAdmin`. |
| **Capability Admin** | Global, capability-scoped | Curates agent capabilities — skills, MCP servers, knowledge-base sources, skill-evolution. **No** user/infra powers. |
| **Team Admin** | Per-team | Administers their team(s): membership, team workspaces, shared knowledge, release approvals. |
| **Member** | Global (base) | Default authenticated user. Owns private workspaces; skill/MCP access limited to team/group grants. |

**Workspace-level roles** (a user holds one *per workspace*, independent of the system role):

| Role | Summary |
|---|---|
| **Owner** | Per-workspace admin: rename, delete, invite/remove collaborators. |
| **Editor** | Read + edit content, send agent runs. |
| **Viewer** | Read-only. |

Legend: ✅ allowed · ❌ denied · **Scoped** = allowed only within the role's own team/capability.

---

## System-level permissions

| Permission | Platform Admin | Capability Admin | Team Admin | Member |
|---|:---:|:---:|:---:|:---:|
| Create workspaces and interact with the AI agent | ✅ | ✅ | ✅ | ✅ |
| Access to the settings portal | ✅ (all sections) | ✅ (skills / MCP / KB sections only) | ❌ | ❌ |
| Skill Evolution review (`/settings/skill-evolution`) | ✅ | ✅ | ❌ | ❌ |
| User management — list users, promote/demote admins, delete users | ✅ | ❌ | ❌ | ❌ |
| Manage groups & group skill access | ✅ | ❌ (global) | **Scoped** (own team's grants only) | ❌ |
| Access all skills & MCP servers (bypass grants) | ✅ | ✅ | ❌ (team-granted only) | ❌ (team/group-granted only) |
| See how many workspaces a user owns (deletion impact) | ✅ | ❌ | ❌ | ❌ |
| Deactivate a user, archiving their private workspaces and handing over their Shared ones | ✅ | ❌ | ❌ | ❌ |
| Read-only oversight of every workspace (audited) | ✅ | ❌ | ❌ | ❌ |

---

## Cross-workspace permissions

**This section was revised when read-only admin oversight shipped.** The original
model denied cross-workspace reach to everyone, on the reasoning that draft privacy
should hold even against a Platform Admin. That was traded, deliberately, for the
ability to govern what exists on the platform — but only in the read direction.
Write access still comes from membership alone, for every role.

| Permission | Platform Admin | Capability Admin | Team Admin | Member |
|---|:---:|:---:|:---:|:---:|
| **Read** an arbitrary workspace without membership (audited) | ✅² | ❌ | ❌¹ | ❌ |
| **Write** to an arbitrary workspace without membership | ❌ | ❌ | ❌ | ❌ |
| Read another user's owned (private) workspaces' files/chat | ✅² | ❌ | ❌ | ❌ |

¹ A Team Admin reaches **team** workspaces via team membership (which satisfies the
membership check for team-scoped workspaces) — not arbitrary private workspaces of
other users.

² Through the read-only oversight surface (`GET /api/admin/workspaces...`), which
has no mutating routes at all. The override synthesizes a `viewer` membership with
`canEdit: false`, so `requireEdit` fails against it; the sole exception is a
platform **system** workspace (`workspaces.isSystem`), which no person owns and
which global knowledge administration depends on. Every override read that crosses
a membership boundary writes an `audit_events` row with `platformOverride: true`.
See `docs/roles-access-matrix.md` §1 for the shipped behaviour.

---

## Workspace-level permissions

Applies to whichever workspace the user is a member of. Independent of the system role.

| Permission | Owner | Editor | Viewer |
|---|:---:|:---:|:---:|
| Create a workspace (creator becomes its Owner) | ✅ᵃ | ✅ᵃ | ✅ᵃ |
| Access a workspace they are a member of | ✅ | ✅ | ✅ |
| Edit content / rename / send agent runs | ✅ | ✅ | ❌ |
| Invite / remove collaborators | ✅ | ❌ | ❌ |
| Delete the workspace | ✅ | ❌ | ❌ |
| Access an arbitrary workspace **without** membership | ❌ᵇ | ❌ᵇ | ❌ᵇ |
| Read another user's owned (private) workspaces' files/chat | ❌ᶜ | ❌ᶜ | ❌ᶜ |
| See how many workspaces a user owns (deletion impact) | ❌ᵈ | ❌ᵈ | ❌ᵈ |
| Trigger cleanup of a user's owned-workspace artifacts (via user deletion) | ❌ᵈ | ❌ᵈ | ❌ᵈ |
| Bypass a workspace's read-only (viewer) restriction | ❌ᵉ | ❌ᵉ | ❌ᵉ |

### Why these resolve the way they do — current system architecture

All workspace authorization funnels through one method,
`WorkspaceService.ensureMembership(workspaceId, userId, { requireEdit? })`
(`backend/src/services/workspaceService.ts`). It looks up a single
`workspace_members` row for `(workspaceId, userId)` and throws
`AccessDeniedError('Workspace access denied')` when none exists. There is **no
role- or admin-based bypass** anywhere on this path. Every row above follows from
that one design fact.

- **ᵃ Create → Owner is a *base user* action, not a workspace-role capability.**
  You cannot hold a role in a workspace that does not yet exist. `createWorkspace`
  inserts the `workspaces` row **and** a `workspace_members` row with
  `role: 'owner', canEdit: true` in the same call — so the creator *becomes* the
  Owner as a side-effect. It is ✅ for any authenticated user; the Owner/Editor/Viewer
  columns are marked ✅ only because every such user could do it, not because an
  existing role grants it.

- **ᵇ "Without membership" is a contradiction for these roles.** Owner, Editor and
  Viewer are *names for a `workspace_members` row*. A workspace role cannot exist
  without membership, so no role can reach a workspace it is not a member of. This
  is also why the system-role matrix denies it to Platform Admins — the check is
  membership, not privilege level.

- **ᶜ Roles are strictly per-workspace; there is no cross-workspace inheritance.**
  (The Platform Admin read override above is a *system-role* capability, not a
  workspace role — no Owner/Editor/Viewer gains anything from it.)
  Being Owner of workspace A confers nothing in workspace B — `ensureMembership` is
  scoped to the specific `workspaceId`. Reading another user's private workspace
  requires a `workspace_members` row *in that workspace*, which only its Owner can
  grant via `addCollaborator`. Hence ❌ for all workspace roles.

- **ᵈ These are Platform-Admin (user-management) actions, not workspace-role
  capabilities.** "Deletion impact" is `GET /users/:id/deletion-impact` and the
  cleanup is a side-effect of `DELETE /users/:id` — both mounted behind
  `requireSystemAdmin`, keyed on the *target user*, not on any workspace the acting
  user belongs to. A workspace role never reaches them. Architecturally worth noting:
  - `getUserDeletionImpact` only **counts** owned workspaces, shared memberships,
    OAuth tokens, and authored files/knowledge/conversations/messages — a preview,
    never content.
  - `deleteUser` runs in a transaction that **detaches** the user's authorship
    (nulls `createdBy`/`updatedBy`/`authorId`/`lastModifiedBy`) and deletes their
    `workspace_members`, group, grant, and OAuth rows — but does **not** delete the
    `workspaces` rows. The API route then loops the user's *owned* workspaces and
    calls `cleanupWorkspaceArtifacts`, which wipes the filesystem dir, the S3 prefix,
    and enqueues a RAG-index delete. So the acting admin gains **no read access** at
    any point; the owned workspace becomes an emptied shell (artifacts gone, DB row
    with a now-dangling `ownerId` remains). This is destructive cleanup, not access.

- **ᵉ There is no "read-only override" to hold.** Edit is gated by the `canEdit`
  boolean on the membership row: Owner/Editor have `canEdit: true`, Viewer has
  `canEdit: false`, and edit-gated calls use `ensureMembership(..., { requireEdit:
  true })` which throws `Workspace is read-only for this user`. Edit capability comes
  from *holding* the Editor/Owner role, not from bypassing the Viewer restriction —
  so no role "bypasses" it.

---

## Notes on the proposed changes

- **Capability Admin** comes from decomposing `requireSystemAdmin` into capability
  checks (`skills`, `mcp`, `kb`, `users`). `Platform Admin` = superuser implying all
  capabilities, so existing admins are unaffected.
- **Team Admin** is a new tier between Platform Admin and individual workspace Owner.
  It evolves the existing `groups` construct into `teams` (adds a membership `role`
  and a `team_workspaces` link), enabling separated **team** vs **private**
  workspaces and the private→team promotion/release flow.
- **Cross-workspace privacy is intentionally absolute**: no system role grants
  read access to another user's private workspace content. Admin power over
  workspaces remains *indirect* (deletion-impact preview and artifact cleanup on
  user deletion), never direct content access.
