# RBAC For Skills and MCP Servers

## Summary
This document describes the current, preferred RBAC model for HelpUDoc:

1. Admins manage users and in-app groups from the Admin Portal.
2. Groups control which skills and MCP servers are available to prompting users.
3. The backend computes effective access from group membership and signs it into the agent token.
4. The Python agent enforces the policy when listing or loading skills and when exposing MCP servers.

This is intentionally simpler than a full deny/default-access model. The goal is to keep the admin experience easy to reason about: "Sales" can get sales skills, "HR" can get HR skills, and a user gets the union of all groups they belong to.

## Goals
- Admin can create multiple groups for different functions or teams.
- Admin can assign users to one or more groups.
- Admin can tie relevant skills to each group.
- Admin can tie relevant MCP servers to each group.
- The policy is enforced server-side and inside the agent runtime.

## Current Model

### Principals
- `user`: stored in `users`
- `group`: stored in `groups`
- `group_members`: joins users to groups

### Access Rules
- If `users.isAdmin == true`, the user can access all skills and all MCP servers.
- Otherwise, the effective access is the union of all skill grants and MCP server grants attached to the user’s groups.
- There are no deny rules in the current implementation.
- A user with no grants sees no restricted skills or MCP servers.

### Storage
- `skill_grants` stores group skill allowlists using `principalType = 'group'`.
- `mcp_server_group_grants` stores group MCP server allowlists.
- Grants are normalized and deduplicated before save.

## Backend Flow

### Effective Access
- `UserService.getEffectivePromptAccess(userId)` resolves:
  - whether the user is a system admin
  - allowed skill ids from all group memberships
  - allowed MCP server ids from all group memberships

### Slash Metadata
- `/api/agent/slash-metadata` filters available skills and MCP servers by the caller’s effective access.
- Admins see the full catalog.
- Non-admins see only what their groups allow.

### Runtime Token
- The backend signs the effective access into the agent JWT.
- The token includes `skillAllowIds` plus the resolved MCP policy.
- The agent does not infer RBAC from client headers.

### User Deletion
- Admins can delete users from `/settings/users`.
- Deletion removes owned workspaces, memberships, OAuth tokens, and authored references.
- Shared records keep history, but user references are detached where needed.

## Agent Enforcement

### Skills
- `list_skills` only returns allowed skills.
- `load_skill` denies loading a skill that is not allowed for the current user.
- Embedded `/skill` directives are rejected if the selected skill is not allowed.

### MCP Servers
- The runtime only exposes MCP servers that the backend marked as allowed for the user.
- The Python agent uses the signed policy from the backend, not raw request headers.

## Admin UI
- `/settings/users` is the control surface for:
  - system admin toggles
  - user deletion
  - group creation/deletion
  - group membership
  - group skill allowlists
  - group MCP server allowlists
- `/settings/agents` remains the skill registry and tools settings area.

## Assumptions
- Single-tenant deployment.
- Group-based allowlists are enough for v1.
- Skills are global across the workspace and are not workspace-specific.
- MCP server access is also global for prompting users in this implementation.
- Existing workspace-level MCP policies remain separate from group-based prompt RBAC.

## Follow-Up Ideas
- Add deny rules later only if we have a concrete product need.
- Add audit events for grant changes and user deletion.
- Consider a read-only "effective access" view for debugging group membership and grant issues.
