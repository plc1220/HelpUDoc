# Private and Team Workspaces — Product Specification

Status: Implemented MVP
Branch: `feat/private-team-workspaces`

## 1. Summary

HelpUDoc will separate workspaces into two categories:

- **Private workspaces** are visible only to their owner and are where editing happens.
- **Team workspaces** contain explicitly published versions that approved teammates can access.

Publishing must not grant teammates access to the underlying private workspace. A team workspace is a separate, stable version linked to one or more private working copies.

The user-facing model is:

- **Publish changes** sends a private workspace version to the team.
- **Sync team updates** brings the latest team version into a linked private workspace.

Version-control technology may be used internally, but its terminology must not appear in the product interface.

## 2. Problem

The current collaboration model shares one live workspace with owners, editors, and viewers. This does not meet the intended privacy model:

- Users want to experiment and make unfinished changes without exposing them.
- Teammates need access to approved workspace content, not the owner's live working environment.
- Users need deliberate control over when changes become visible to the team.
- Team members need a safe way to build on published work without editing it directly.

Changing labels on the existing sharing flow is insufficient. Private and team workspaces need separate content states and access boundaries.

## 3. Product Principles

1. **Private by default**
   Every newly created workspace starts as private.

2. **Publishing is deliberate**
   Private changes are never exposed automatically.

3. **Published content is stable**
   A team workspace changes only when an authorized user publishes a new version.

4. **Editing happens privately**
   Users create or open a private working copy before making changes to team content.

5. **The direction of every action is clear**
   `Publish changes` means private to team. `Sync team updates` means team to private.

6. **No silent overwrites**
   When both the private and team versions changed, the user reviews conflicts before publishing.

7. **Publishing has a narrow privacy boundary**
   Only supported workspace content is published. Personal activity and credentials are excluded.

## 4. Terminology

| Term | User-facing meaning |
|---|---|
| Private workspace | A workspace visible and editable only by its owner |
| Team workspace | The latest published workspace version available to a team |
| Private working copy | A private workspace linked to a team workspace |
| Publish changes | Update the team workspace from a private working copy |
| Sync team updates | Bring the latest team changes into a private working copy |
| Published version | A saved team version with author and publication time |
| Review needed | Both the private copy and team version changed since the last sync |

Do not use terms such as repository, commit, branch, push, pull, merge, local, remote, or origin in the UI.

## 5. Goals

- Clearly separate private and team workspaces in navigation.
- Keep all newly created work private until explicitly published.
- Let authorized users publish a complete workspace version to a team.
- Let teammates browse stable published content.
- Let teammates create private working copies of team workspaces.
- Support incoming team updates without silently discarding private work.
- Show enough status information for users to understand whether their private copy and the team version differ.
- Preserve published history for audit and recovery.

## 6. Non-goals for the First Release

- Real-time collaborative editing of a private workspace.
- Sharing a private workspace with selected individuals.
- Publishing selected files or folders.
- Simultaneously publishing one private workspace to multiple teams.
- Public or anonymous workspace links.
- Commenting, approvals, or formal review workflows.
- Advanced line-by-line conflict editing.
- Automatically publishing private changes.

## 7. Roles and Permissions

### Private workspace

| Role | Permissions |
|---|---|
| Owner | View, edit, rename, delete, sync, and publish if authorized for the linked team |
| Everyone else | No access |

A private workspace must never have collaborators or additional membership records.

### Team workspace

| Role | Permissions |
|---|---|
| Team owner | View, create a private working copy, manage access, publish, restore, archive |
| Publisher | View, create a private working copy, publish new versions |
| Viewer | View and create a private working copy |

Team workspaces are read-only during normal browsing. Even publishers edit through a private working copy.

Existing `editor` access may map to `Publisher`, while existing `viewer` access may remain `Viewer`.

## 8. Information Architecture

The workspace sidebar must have two visible sections:

### Private workspaces

- Contains private drafts and private working copies.
- Provides the primary `New workspace` action.
- Shows private/team synchronization status where applicable.

### Team workspaces

- Contains published workspaces available through team membership.
- Shows the team name, latest publisher, and last published time.
- Does not present direct file-editing controls.

Search should operate across both sections while preserving the category labels in its results.

If a user belongs to multiple teams, team workspaces should be grouped or labeled by team.

## 9. Workspace States

The state of a private workspace is derived from:

- whether it is linked to a team workspace;
- the team version on which it was last based;
- whether the private workspace changed after that version; and
- whether the team workspace has a newer published version.

| State | Condition | Primary action |
|---|---|---|
| Private draft | Never published | Publish to team |
| Published — up to date | No private or team changes | None |
| Changes to publish | Private changed; team did not | Publish changes |
| Team updates available | Team changed; private did not | Sync team updates |
| Review needed | Both private and team changed | Review changes |

Status must be shown in the private workspace list and within the opened workspace.

## 10. User Stories and Acceptance Criteria

### Story 1 — Create a private workspace

As a user, I want new workspaces to be private so that I can work without exposing unfinished content.

Acceptance criteria:

- A new workspace appears under `Private workspaces`.
- Only its creator can list, open, search, or access it.
- It has no share or collaborator action.
- Its initial status is `Private draft`.
- Creating or editing content does not create a team workspace.

### Story 2 — Publish a private workspace for the first time

As an authorized user, I want to publish a private workspace so that my team can access an approved version without seeing my private workspace.

Acceptance criteria:

- The workspace offers `Publish to team`.
- The publish dialog asks for a destination team.
- If the user belongs to one eligible team, it may be preselected.
- The dialog identifies what will and will not be published.
- Confirming creates a separate team workspace and its first published version.
- The private workspace remains private and becomes linked to the team workspace.
- Teammates cannot access the private workspace ID, files, conversations, or activity.
- The team workspace appears under `Team workspaces` for eligible team members.
- The private workspace status becomes `Published — up to date`.

### Story 3 — Browse a team workspace

As a teammate, I want to browse the latest published workspace so that I can use approved team content.

Acceptance criteria:

- A team workspace opens in read-only mode.
- It shows the latest publisher and publication time.
- File creation, editing, renaming, moving, and deletion controls are unavailable.
- The primary action is `Work privately`.
- A user cannot discover unpublished private changes through search, previews, APIs, activity feeds, or agent context.

### Story 4 — Create a private working copy

As a teammate, I want a private working copy so that I can modify published work without changing what the team currently sees.

Acceptance criteria:

- `Work privately` creates a private workspace based on the latest team version.
- The new workspace appears under `Private workspaces`.
- It records which team workspace and published version it came from.
- The original team workspace remains unchanged.
- If the user already has a linked private working copy, the action opens it instead of silently creating a duplicate.
- Unpublished edits are visible only to that user.

### Story 5 — Publish changes to an existing team workspace

As a Publisher, I want to publish my private changes so that the team workspace receives a deliberate new version.

Acceptance criteria:

- `Publish changes` is available when private changes exist and the user has publishing permission.
- Pending autosaves complete before publication begins.
- The user can enter an optional publication note.
- Publication creates a complete, immutable team version.
- The team workspace changes atomically; teammates never see a partially published version.
- The published version records its author and time.
- After success, the private workspace status becomes `Published — up to date`.
- Viewers may continue private work but cannot publish.

### Story 6 — Sync team updates

As a user with a private working copy, I want to bring in newer team changes so that my work is based on the latest published version.

Acceptance criteria:

- `Sync team updates` appears when the team has a newer version.
- If the private copy has no changes, syncing updates it directly.
- Syncing never publishes the user's private content.
- Syncing updates the recorded base team version.
- The user receives a completion message describing the result.
- A failed sync leaves the private workspace unchanged.

### Story 7 — Review concurrent changes

As a user, I want to review overlapping changes so that neither my work nor a teammate's published work is silently lost.

Acceptance criteria:

- If both sides changed, the status becomes `Review needed`.
- Changes to different files are combined automatically.
- For files changed on both sides, the review screen offers:
  - `Keep mine`
  - `Use team version`
  - a text comparison when supported
- Binary files do not attempt text comparison.
- File additions, deletions, moves, and renames are represented in the review.
- Resolving a review updates the private copy only.
- The user must still select `Publish changes` to update the team workspace.
- Cancelling review does not modify either version.

### Story 8 — View and restore publication history

As a Team owner, I want to inspect and restore published versions so that the team can recover from an incorrect publication.

Acceptance criteria:

- History shows publisher, publication time, optional note, and version identifier.
- A historical version can be previewed without changing the current version.
- Restoring creates a new published version rather than deleting history.
- Restoration does not modify anyone's private workspace automatically.
- Linked private copies show `Team updates available` after a restore.

## 11. Publishable Content Boundary

### Included in the first release

- User-visible workspace files.
- Folder structure.
- User-visible dashboard and artifact packages stored in the workspace.
- File and folder names, MIME types, and supported workspace metadata.

### Excluded

- Conversations and chat history.
- Agent messages, tool calls, run logs, and approval history.
- Draft prompts and unsent text.
- Workspace schedules and schedule run history.
- OAuth tokens, API keys, secrets, and credentials.
- MCP connection credentials and personal integrations.
- Personal settings, recent activity, and UI preferences.
- Hidden runtime files and internal system state.
- Temporary uploads, caches, and generated previews.

Search indexes and derived previews should be rebuilt from the published content rather than copied with private runtime state.

The publish confirmation must summarize this boundary in plain language.

## 12. Publishing and Sync Rules

### First publication

1. Complete pending file saves.
2. Validate the user's team and publishing permission.
3. Create the team workspace.
4. Save publication version 1 from an allowlisted content snapshot.
5. Link the private workspace to the team workspace and version 1.
6. Make the team workspace visible to eligible team members.

If any step fails, no partially visible team workspace should remain.

### Later publication

1. Complete pending file saves.
2. Compare the private workspace's base version with the current team version.
3. If they match, create a new team version atomically.
4. If the team version is newer, require sync or review first.
5. Update the private workspace's base version only after publication succeeds.

### Sync

1. Load the private base version and latest team version.
2. Determine private and team changes relative to the base.
3. Apply non-overlapping changes to the private workspace.
4. Require review for overlapping changes.
5. Leave the team workspace unchanged.

## 13. UX Requirements

### Primary actions

| Context | Action label |
|---|---|
| Unpublished private workspace | Publish to team |
| Linked private workspace with changes | Publish changes |
| Linked private workspace with incoming updates | Sync team updates |
| Linked private workspace with concurrent changes | Review changes |
| Team workspace without a private copy | Work privately |
| Team workspace with an existing private copy | Open private copy |

### Publish confirmation

The confirmation must show:

- destination team;
- team workspace name;
- whether this creates a new team workspace or updates an existing one;
- the content included in publication;
- a concise reminder that conversations, activity, and credentials remain private;
- an optional publication note;
- a final `Publish` action.

### Feedback

- Show progress for publication and sync operations.
- Prevent duplicate submissions while an operation is running.
- Report success with the new publication time.
- Report failures without changing status optimistically.
- Do not use vague messages such as `Sync complete` without stating what was updated.

## 14. Conceptual Data Model

The exact schema is an engineering decision, but the product requires these concepts:

### Workspace

- `visibility`: `private` or `team`
- `ownerId`: required for private workspaces
- `teamId`: required for team workspaces
- `currentPublishedVersionId`: set for team workspaces

### Private/team link

- `privateWorkspaceId`
- `teamWorkspaceId`
- `basePublishedVersionId`
- one active link per user and team workspace

### Published version

- immutable version ID
- team workspace ID
- sequential display number
- content snapshot reference
- publisher user ID
- publication note
- publication time

Team membership controls access to team workspaces. A publication link does not grant access to a private workspace.

## 15. Service and Security Requirements

- Every private workspace read or write must verify ownership.
- Team workspace reads must verify current team membership.
- Normal file mutation endpoints must reject team workspace mutations.
- Only the publication service may update a team workspace's current version.
- Publishing permission must be checked at publication time, not only when rendering the button.
- Published snapshots must use an explicit allowlist; they must not copy an entire workspace directory blindly.
- Removing a user from a team removes future team access but does not delete their private workspace.
- A removed user cannot publish to the former team.
- Server logs and error messages must not expose private paths or content to teammates.

## 16. Existing Workspace Migration

Recommended migration:

- Workspaces with only their owner as a member become private workspaces.
- Workspaces with multiple members become team workspaces using their current content as the initial published version.
- Existing owners become Team owners.
- Existing editors become Publishers.
- Existing viewers remain Viewers.
- Existing members retain access to the migrated team workspace.
- Private working copies are created only when a user selects `Work privately`.

Migration must preserve existing workspace IDs or provide redirects for saved links.

This migration plan requires product confirmation before implementation.

## 17. MVP Delivery Slices

### Slice 1 — Categories and privacy

- Add private/team workspace types.
- Categorize the sidebar.
- Make new workspaces private by default.
- Enforce owner-only access for private workspaces.
- Remove the private workspace sharing action.

### Slice 2 — First publication and team browsing

- Add team identity and publishing roles.
- Publish a private workspace to a team.
- Browse team workspaces in read-only mode.
- Enforce the publishable content boundary.

### Slice 3 — Private working copies and updates

- Create/open a private working copy.
- Publish later changes.
- Detect and display workspace states.
- Sync non-conflicting team updates.

### Slice 4 — Review and history

- Review overlapping changes.
- Add publication notes and history.
- Preview and restore earlier published versions.

## 18. End-to-End Acceptance Scenario

1. Alice creates `Customer research`; it appears only in her Private section.
2. Alice adds files and conversations. Bob cannot find or access any of them.
3. Alice publishes the workspace to the Research team.
4. Bob sees `Customer research` under Team workspaces and can browse its published files.
5. Bob cannot see Alice's conversations, agent activity, credentials, or later private edits.
6. Bob selects `Work privately` and edits his private copy.
7. Bob's changes remain invisible to Alice and the team.
8. Alice publishes another version. Bob sees `Team updates available`.
9. Bob syncs. Changes to different files are combined automatically.
10. If Alice and Bob changed the same file, Bob sees `Review needed` and chooses the desired content.
11. Bob publishes the resolved private copy if he is a Publisher.
12. The team sees Bob's new published version while Alice's and Bob's private workspaces remain private.

## 19. Implementation Decisions

The MVP uses these decisions:

1. Existing administrative groups are the initial teams used for workspace publication.
2. All team members may browse team workspaces and create private working copies.
3. Team owners and Publishers may publish immediately; an approval workflow is not included.
4. Existing single-member workspaces migrate to private workspaces. Existing multi-member workspaces migrate to team workspaces while preserving direct access.
5. Publication history and owner-only restore are included.
