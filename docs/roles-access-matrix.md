# Roles & Access Matrix

This application uses **two independent authorization systems** plus a group-based
access mechanism:

1. **System role** — a global `isAdmin` flag on the user (`users.isAdmin`).
2. **Workspace role** — per-workspace membership (`workspace_members.role`):
   `owner`, `editor`, or `viewer`.
3. **Groups** — bundles of "prompt access" (skill + MCP-server grants) applied to
   non-admin users.

The two role systems are **near-orthogonal**. A user has exactly one system role
and a separate role in each workspace they belong to. Being a workspace Owner
grants no system-admin privileges. Being a system Admin grants **read-only,
audited oversight** of every workspace — and no ability to change one they are
not a member of. Everything a workspace can *do* still comes from membership.

---

## 1. Admins vs. Members in relation to Workspaces

This is the most commonly misunderstood interaction, so it is spelled out
explicitly.

### Membership governs *editing*; the system role governs *oversight*

Ordinary workspace authorization flows through
`WorkspaceService.ensureMembership()` (`backend/src/services/workspaceService.ts`),
which resolves a `workspace_members` row — or, for a private workspace, its owner.
No membership, no access:

```ts
if (normalizedWorkspace.visibility === 'private' && !adminOverride) {
  throw new AccessDeniedError('Private workspace access denied');
}
```

The one exception is the **platform-admin override**, and it is read-only.
A caller that passes `allowSystemAdmin: true` and is a platform admin
(`users.isAdmin` **or** a `platform_role_bindings` row — see
`services/governance/teamRoles.ts`) resolves to a synthesized membership whose
strength is derived from the *workspace record*, not from the caller:

| Workspace | Override resolves to |
|---|---|
| Any workspace a person owns (private or Shared) | `role: 'viewer'`, `canEdit: false` |
| A platform system workspace (`workspaces.isSystem`) | `role: 'owner'`, `canEdit: true` |

The system-workspace exception exists for exactly one thing: the Knowledge
Library storage workspace, which is owned by a system identity and is how global
knowledge bases are administered. It is not reachable by any human-owned route.

Consequently:

- An Admin **can read** any workspace's files, conversations and collaborators
  through the oversight surface, including other users' private workspaces.
- An Admin **cannot write** to a workspace they are not a member of — not rename,
  edit, share, publish or delete it. `requireEdit` fails against the override.
- Every override read that crosses a membership boundary writes an
  `audit_events` row: `action: 'admin.workspace.accessed'`,
  `platformOverride: true`, carrying the workspace's owner and visibility.
  Reads by an admin who *is* a member are not recorded as overrides.
- Ordinary workspace routes never pass `allowSystemAdmin`, so being an admin
  changes nothing on the normal request path.

### The admin oversight surface

`GET /api/admin/workspaces...`, mounted behind `requireSystemAdmin`
(`backend/src/api/adminWorkspaces.ts`), rendered at `/settings/workspaces`.
**Every route on it is a GET** — the mutation surface is empty by construction,
so a mistake there cannot damage a workspace.

| Route | Returns |
|---|---|
| `GET /api/admin/workspaces` | Every workspace: owner, visibility, status, file/member counts, retention dates |
| `GET /api/admin/workspaces/:id` | Workspace detail and collaborators |
| `GET /api/admin/workspaces/:id/files` | File tree |
| `GET /api/admin/workspaces/:id/files/:fileId/content` | File content (never writes a version row) |
| `GET /api/admin/workspaces/:id/conversations` | Conversations and messages |

### What Admins can do to a *user*

- **Deactivate** (`POST /users/:userId/deactivate`) — the routine lever.
  Suspends access everywhere, archives the user's private workspaces into the
  30-day trash (`trashReason: 'owner_deactivated'`), transfers each Shared
  workspace they own to a nominated owner immediately, and pauses their
  schedules. Reversible: `POST /users/:userId/reactivate` restores the archives
  it created (and only those). Preview first with
  `GET /users/:userId/deactivation-impact`.
- **Delete** (`DELETE /users/:userId`) — only for an already-deactivated user.
  Refuses while they own any *active* workspace, naming them. Archived and
  retired workspaces pass to the deleting admin so they stay restorable.
- Admins cannot deactivate or delete themselves, and the last remaining platform
  admin cannot be deactivated, demoted or deleted.

### Admin vs. Member — workspace-related capabilities

| Capability (workspace-related) | **System Admin** | **Member** |
|---|:---:|:---:|
| Read any workspace's content without membership (audited, read-only) | ✅ | ❌ |
| Edit/rename/share/delete a workspace without membership | ❌ | ❌ |
| Access a workspace they are a member of | ✅ (per workspace role) | ✅ (per workspace role) |
| Create a workspace (becomes its Owner) | ✅ | ✅ |
| See how many workspaces a user owns (impact previews) | ✅ | ❌ |
| Deactivate / reactivate a user | ✅ | ❌ |
| Bypass a workspace's read-only (`viewer`) restriction | ❌ | ❌ |

> **Takeaway:** an Admin can *see* anything in order to govern it, and can
> *change* nothing they do not belong to. Oversight is read-only and recorded;
> operating inside a workspace still requires being a collaborator.

### Workspace retention and recovery

Deleting a workspace does not destroy it:

| Stage | What happens |
|---|---|
| Owner deletes, or owner is deactivated | `status: 'trashed'`, `purgeAfter = now + 30 days`. Visible to the owner, restorable. |
| Retention expires (hourly sweep, `scheduleService.tick`) | `status: 'purged'`. **Rows, local mirror and object bytes are all retained.** Hidden from every read path, including the owner's. |
| Operator runs `npm run workspace:restore -- <id>` | Back to `active`, files intact. |
| Operator runs `npm run workspace:hard-purge -- <id> --confirm` | The only path that actually deletes. Never automatic. Audit trails survive. |

`workspaces.ownerId` is `ON DELETE RESTRICT`, so a user deletion can never
silently cascade a workspace away.

## 2. System role — full capability matrix

Set via the `ADMIN_EMAILS` env var (auto-promotes matching emails on login) or
toggled in the Users admin portal. Gates everything under the `requireSystemAdmin`
middleware.

| Capability | **Admin** | **Member** (default) |
|---|:---:|:---:|
| Use the agent / own workspaces | ✅ | ✅ |
| Settings portal (`/settings`) | ✅ | ❌ |
| Daily Reflections (`/settings/reflections`) | ✅ | ❌ |
| Skill Evolution review (`/settings/skill-evolution`) | ✅ | ❌ |
| User management — list users, promote/demote admins, deactivate/delete users (`/users`) | ✅ | ❌ |
| Read-only oversight of every workspace (`/settings/workspaces`) | ✅ | ❌ |
| Manage groups & group prompt access | ✅ | ❌ |
| Access **all** skills & MCP servers (bypass grants) | ✅ | ❌ (limited to group grants) |

A Member's access to slash-command skills and MCP servers is restricted to what
their **groups** grant. An Admin bypasses all grant checks entirely
(`backend/src/api/agent/policy.ts`, `backend/src/api/agent/slash.ts`).

---

## 3. Workspace role — full capability matrix

Per-workspace membership stored in `workspace_members`, enforced in
`WorkspaceService`. Independent of the system role.

| Capability | **Owner** | **Editor** | **Viewer** |
|---|:---:|:---:|:---:|
| View workspace, files, and conversations (read) | ✅ | ✅ | ✅ |
| Edit content / rename / send agent runs (`canEdit`) | ✅ | ✅ | ❌ |
| Invite collaborators | ✅ | ❌ | ❌ |
| Remove collaborators | ✅ | ❌ | ❌ |
| Delete the workspace | ✅ | ❌ | ❌ |

Notes:

- The creator of a workspace is automatically its **Owner** (`role: 'owner'`,
  `canEdit: true`).
- `canEdit` is derived from role: `true` for owner/editor, `false` for viewer.
  Edit-gated operations call `ensureMembership(..., { requireEdit: true })` and
  throw `Workspace is read-only for this user` for viewers.
- An **owner cannot be removed** as a collaborator (`Cannot remove workspace
  owner`).
- Only owners may invite/remove collaborators and delete the workspace.

---

## 4. Groups (access-control grouping, not a role)

Groups do **not** grant a workspace or system role. They bundle **prompt access** —
skill grants (`skill_grants`) and MCP-server grants
(`mcp_server_group_grants`) — that apply to their non-admin Member users.

- Only Admins can create/delete groups, manage membership, and edit group access.
- A user's effective non-admin prompt access = the **union** of grants across all
  their groups (`getEffectivePromptAccess`).
- Admins ignore group grants entirely (they already have full access).

---

## How the systems combine — worked example

A user can be:

- a system **Member** (no admin portal), **and**
- **Owner** of workspace A (full control there), **and**
- **Viewer** of workspace B (read-only there), **and**
- have no relationship to workspace C (no access at all).

Promoting that user to system **Admin** would unlock the settings/users/groups
portals and remove skill/MCP grant restrictions — but would **not** change their
access to workspaces A, B, or C.

---

*Sources: `backend/src/services/workspaceService.ts`,
`backend/src/services/userService.ts`, `backend/src/api/users.ts`,
`backend/src/api/routes.ts`, `backend/src/middleware/adminOnly.ts`,
`backend/src/api/agent/policy.ts`, `backend/src/api/agent/slash.ts`,
`backend/src/api/adminWorkspaces.ts`,
`backend/src/services/governance/teamRoles.ts`,
`packages/contracts/src/types.ts`.*
