# RBAC For Skills (Single-Tenant, In-App Groups, OIDC)

## Summary
Implement enforceable RBAC for the repo-wide skills registry (the `SKILL.md` folders under `/Users/cmtest/Documents/HelpUDoc/skills`) by:
1. Upgrading identity to production-grade OIDC on the Node backend (no more trusting `X-User-*` headers for auth).
2. Adding in-app groups and per-skill allow/deny grants stored in Postgres.
3. Enforcing skill visibility and `load_skill` access inside the Python agent service, using a backend-signed internal token so RBAC cannot be bypassed by calling the agent directly.
4. Locking down the existing “Admin Portal” settings endpoints and UI (skills + runtime config editing) to system admins.

## Goals And Non-Goals
- Goal: Admin can control which users/groups can see/use specific skills (global per-user/group, not per-workspace).
- Goal: RBAC is enforced server-side (not spoofable by client headers).
- Goal: Admin UI exists for users/groups/skill grants.
- Non-goal: Restrict tool usage globally (tools remain broadly available); tool allowlists are enforced only as part of skill governance where a skill declares `tools:`.

## Authorization Model (Decision Complete)

### Principals
- User: authenticated via OIDC, stored in `users` table.
- Group: in-app managed group, stored in `groups` + `group_members`.

### Roles
- `system_admin`: can manage skills registry, runtime config, users/groups, and grants.
- Regular users: can use skills subject to grants.

Bootstrap rule (admin seed):
- Backend env var `ADMIN_EMAILS` (comma-separated) grants `system_admin` on first login, and can be changed later via admin UI.

### Skill Access Rules (Allow-By-Default With Overrides)
Define a `default_access` per skill:
- Source of truth: `SKILL.md` frontmatter field `default_access: allow|deny` (missing means `allow`).

Compute effective access for a given user and skill:
1. If `user.isAdmin == true`: ALLOW.
2. If any explicit DENY exists for the user (direct) or any of their groups: DENY.
3. If `default_access == deny`:
   - ALLOW only if any explicit ALLOW exists for the user or any group.
   - Otherwise DENY.
4. If `default_access == allow`:
   - ALLOW.

Store explicit grants as `(principal, skillId, effect)` where `effect` is `allow|deny`.

### Tool Allowlist Per Skill (Only When Declared)
- If a skill declares `tools:` in frontmatter, treat that as its allowed tool set while executing that skill.
- If a skill does not declare `tools:`, do not enforce a tool allowlist (compatibility with existing skills like `proposal-writing`).

## Data Model Changes (Backend Postgres)
Implement via `/Users/cmtest/Documents/HelpUDoc/backend/src/services/databaseService.ts` (this repo uses “create tables on startup”, not migrations).

Add tables and columns:

1. `users`
- Add `isAdmin boolean not null default false`
- Add `oidcIssuer text` and `oidcSubject text` (or store them combined in `externalId`; recommended is `externalId = issuer|sub` and keep these optional for debugging/audit)

2. `groups`
- `id uuid pk`
- `name text unique not null`
- `createdAt`, `updatedAt`

3. `group_members`
- `groupId uuid fk -> groups(id) on delete cascade`
- `userId uuid fk -> users(id) on delete cascade`
- `createdAt`, `updatedAt`
- PK `(groupId, userId)`

4. `skill_grants`
- `id bigserial pk` (or composite PK; bigserial is simplest for updates)
- `principalType text not null` enum-like: `user|group`
- `principalId uuid not null` (references users/groups by type)
- `skillId text not null`
- `effect text not null` enum-like: `allow|deny`
- `createdAt`, `updatedAt`
- Unique index on `(principalType, principalId, skillId)`

## Backend API Changes (Node)

### Authentication (OIDC)
Add routes under `/api/auth/*` in a new file, e.g. `/Users/cmtest/Documents/HelpUDoc/backend/src/api/auth.ts`, and mount from `/Users/cmtest/Documents/HelpUDoc/backend/src/api/routes.ts`.

Use `openid-client` (recommended) and `express-session` (already present in `/Users/cmtest/Documents/HelpUDoc/backend/src/index.ts`) to implement:
- `GET /api/auth/login`: redirect to IdP authorize endpoint (PKCE).
- `GET /api/auth/callback`: exchange code, validate ID token, upsert user, set `req.session.userContext`.
- `POST /api/auth/logout`: destroy session.
- `GET /api/auth/me`: return current user context + `isAdmin`.

Config env vars:
- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET` (if needed by IdP)
- `OIDC_REDIRECT_URL`
- `OIDC_POST_LOGOUT_REDIRECT_URL`
- `ADMIN_EMAILS`

Keep current header-based user context only for dev via a flag:
- `AUTH_MODE=oidc|headers` (default `oidc` in production, `headers` for local dev if desired).
- In `headers` mode, continue honoring `X-User-*` in `/Users/cmtest/Documents/HelpUDoc/backend/src/middleware/userContext.ts`.
- In `oidc` mode, ignore headers and require session user.

### Admin Enforcement Middleware
Add:
- `requireAuth(req)` ensures `req.userContext` exists.
- `requireAdmin(req)` ensures current user has `isAdmin`.

Apply `requireAdmin` to all existing settings endpoints in `/Users/cmtest/Documents/HelpUDoc/backend/src/api/settings.ts`:
- `/settings/agent-config` read/write
- `/settings/skills` CRUD and file edits

### RBAC Admin APIs (Groups + Grants)
Add routes under `/api/admin/*` (new router file, mounted in `/Users/cmtest/Documents/HelpUDoc/backend/src/api/routes.ts`), all protected by `requireAdmin`:
- `GET /api/admin/users` list users
- `PATCH /api/admin/users/:userId` set `isAdmin` true/false
- `GET /api/admin/groups` list groups with member counts
- `POST /api/admin/groups` create group
- `DELETE /api/admin/groups/:groupId` delete group
- `GET /api/admin/groups/:groupId/members` list members
- `POST /api/admin/groups/:groupId/members` add member by userId (and optionally by email lookup)
- `DELETE /api/admin/groups/:groupId/members/:userId` remove member
- `GET /api/admin/skill-grants?skillId=...` list grants for a skill
- `PUT /api/admin/skill-grants` upsert a grant (principalType, principalId, skillId, effect)
- `DELETE /api/admin/skill-grants` delete a grant

Also add a non-admin endpoint for runtime use:
- `GET /api/skills/effective` returns the caller’s effective skill access (at least `deniedSkillIds` and `allowedSkillIdsForDefaultDeny`) to support UI hints, and to support backend->agent policy generation.

## Agent Service Enforcement (Python FastAPI)

### Internal Auth Between Backend And Agent
Goal: prevent bypass by direct calls to the agent service.

Add an internal bearer token that the backend attaches to every request to the agent:
- Backend signs a JWT with `AGENT_INTERNAL_JWT_SECRET` (HS256) including:
  - `userExternalId` (or backend userId)
  - `workspaceId`
  - `isAdmin`
  - `skillDenyIds` (array of skill ids)
  - `skillAllowIds` (array of skill ids; only needed for default_access=deny skills)
  - `iat`, `exp` short TTL (5 minutes)

Agent service verifies this JWT on:
- `/agents/{agent_name}/workspace/{workspace_id}/chat`
- `/agents/{agent_name}/workspace/{workspace_id}/chat/stream`
- (Optional but recommended) `/rag/workspaces/{workspace_id}/query` and `/rag/workspaces/{workspace_id}/status` if those are reachable outside the cluster.

Implementation touchpoints:
- `/Users/cmtest/Documents/HelpUDoc/backend/src/services/agentService.ts` to attach `Authorization: Bearer <jwt>` to axios requests.
- `/Users/cmtest/Documents/HelpUDoc/agent/helpudoc_agent/app.py` to validate the JWT and extract the policy into `runtime.workspace_state.context`, for example:
  - `runtime.workspace_state.context["skill_policy"] = {...}`

Dependencies:
- Add `pyjwt` to `/Users/cmtest/Documents/HelpUDoc/agent/requirements.txt`.

### Skill RBAC Enforcement Inside Tools
Modify `/Users/cmtest/Documents/HelpUDoc/agent/helpudoc_agent/tools_and_schemas.py`:
- In `_build_list_skills_tool`:
  - Load skills from disk as today.
  - Filter to skills the current user is allowed to access using `skill_policy` from context plus per-skill `default_access` parsed from SKILL.md frontmatter.
- In `_build_load_skill_tool`:
  - Deny loading content for disallowed skills (return a clear “Access denied” message).
  - If allowed, return the content.

This is the core enforcement point that prevents non-admins from discovering/loading restricted skills.

## Frontend Changes (Admin UI + OIDC)

### Auth UI
Update `/Users/cmtest/Documents/HelpUDoc/frontend/src/auth/AuthProvider.tsx` and `/Users/cmtest/Documents/HelpUDoc/frontend/src/pages/LoginPage.tsx`:
- Replace localStorage-based “user identity” with cookie session:
  - On app load, call `/api/auth/me` via `/Users/cmtest/Documents/HelpUDoc/frontend/src/services/apiClient.ts`.
  - If 401, show LoginPage with a “Continue” button that navigates to `/api/auth/login`.
- Keep a dev-only bypass if desired behind `import.meta.env.DEV`.

Update `/Users/cmtest/Documents/HelpUDoc/frontend/src/services/apiClient.ts`:
- Remove `X-User-*` headers in OIDC mode (or keep only when `AUTH_MODE=headers`).

### Admin Pages
Implement the previously “coming soon” Users page and add group/grant management.

Recommended placement:
- Keep `/settings/agents` for skill registry editing (admin-only anyway).
- Implement `/settings/users` as “Access Control”:
  - Users table: email, display name, isAdmin toggle.
  - Groups panel: create/delete group, add/remove members.
  - Skill access panel: select skill, view current grants, add allow/deny grants for groups/users.

Frontend touchpoints:
- `/Users/cmtest/Documents/HelpUDoc/frontend/src/pages/UsersPage.tsx` (replace placeholder).
- Add new service module `/Users/cmtest/Documents/HelpUDoc/frontend/src/services/adminRbacApi.ts` for the new endpoints.

Also add route guards:
- If user is not admin and tries to navigate to `/settings/*`, show a 403 page or redirect to `/`.

## Tests

### Backend (Node)
Add unit tests for skill access evaluation logic (pure function):
- Cases:
  - admin overrides everything
  - default allow + deny grant denies
  - default deny + allow grant allows
  - user grant overrides group grant (deny wins if both present)

If no Node test runner exists yet, add a minimal one (recommended: `vitest`) or keep tests as lightweight TypeScript scripts invoked by CI.

### Agent (Python)
Add tests under `/Users/cmtest/Documents/HelpUDoc/tests`:
- `list_skills` filters restricted skills when policy denies
- `load_skill` denies restricted skill
- `load_skill` allows permitted skill
- JWT verification rejects missing/expired/invalid token (for chat endpoints)

### E2E (Frontend)
Extend Playwright spec(s) to validate:
- Non-admin cannot open `/settings/agents` and cannot fetch `/api/settings/skills`.
- Admin can open and edit skills.

## Rollout Plan
1. Land OIDC auth + `AUTH_MODE` toggle (keep headers mode for local dev).
2. Add `isAdmin` and admin enforcement on existing settings endpoints.
3. Add groups + grants tables and admin APIs.
4. Add Admin UI for users/groups/grants.
5. Add backend->agent internal JWT + skill filtering in agent tools.
6. Harden: optionally require internal JWT for RAG endpoints too, if externally reachable.

## Assumptions And Defaults
- Single-tenant instance, so no `tenantId` column is required.
- Skills live on a shared filesystem across users (current behavior).
- Default skill access is `allow` unless `default_access: deny` is set in SKILL.md frontmatter.
- Tools are globally allowed; RBAC is primarily about skill visibility/access and admin-only skill registry editing.
