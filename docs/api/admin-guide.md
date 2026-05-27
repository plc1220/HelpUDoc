# Admin guide

HTTP APIs for the **settings portal** and system administration. All routes below require an authenticated user with **system admin** (`isAdmin` on the user record or `ADMIN_EMAILS` at provision time).

Non-admin users receive `403` from `requireSystemAdmin` middleware.

Frontend entry: `frontend/src/features/settings/` and `frontend/src/services/settingsApi.ts`.

---

## Route prefixes

| Prefix | Purpose |
| ------ | ------- |
| `/api/settings` | Agent config, skills, skill builder, workspace overview |
| `/api/settings/reflections` | Daily analytics reflections |
| `/api/settings/skill-evolution` | Suggested skill/memory updates from usage |
| `/api/users` | Users, groups, RBAC for skills and MCP servers |

Full method/path tables: [API reference — Admin sections](reference.md#admin-settings-apisettings).

---

## Workspace overview

```http
GET /api/settings/workspace-overview
```

Aggregated stats for the admin dashboard (workspaces, skills health, optional Langfuse metrics). Read-only.

---

## Agent runtime configuration

Runtime YAML controls models, tools, and MCP servers the agent loads.

| Action | Request |
| ------ | ------- |
| Read merged config | `GET /api/settings/agent-config` → `{ content }` |
| Write live config | `PUT /api/settings/agent-config` → `{ content: "yaml..." }` |

File on disk is controlled by `AGENT_CONFIG_PATH` (often `agent/config/runtime.yaml`). GET merges repo base with live overrides.

---

## Skills catalog

Skills live on disk under `SKILLS_ROOT` (repo `skills/` in dev, image-bundled `/app/skills` in prod). The admin surface is read-only; skill changes ship through CD.

### List and view

- `GET /api/settings/skills` — metadata per skill (`valid`, errors, descriptions)
- `GET /api/settings/skills/:skillId/files` — relative paths
- `GET /api/settings/skills/:skillId/content?path=...` — read UTF-8 file
- Runtime write endpoints return `405`.

---

## GitHub skill import

Runtime GitHub skill import endpoints return `405`; import skills through the repo/CD path.

---

## Skill Builder assistant

Feature flag: `ENABLE_SKILL_BUILDER_ASSISTANT`.

Helps admins author skills via the `skill-builder` agent persona. Uses the **same durable run pattern** as workspace chat but under `/api/settings/skill-builder/runs/*`.

### Session and context files

| Step | Endpoint |
| ---- | -------- |
| Create isolated workspace id | `POST /api/settings/skill-builder/session` |
| List uploads | `GET /api/settings/skill-builder/context-files` |
| Upload reference file | `POST .../context-files` (multipart `file`) |
| Remove upload | `DELETE .../context-files/:fileId` |

Allowed extensions and max size returned on session create.

### Run assistant

| Step | Endpoint |
| ---- | -------- |
| Start | `POST /api/settings/skill-builder/runs` — `{ prompt, history?, contextFileIds?, selectedSkillId?, turnId? }` |
| Stream | `GET .../runs/:runId/stream?after=` |
| Status | `GET .../runs/:runId` |
| Cancel | `POST .../runs/:runId/cancel` |
| Approve plan | `POST .../runs/:runId/decision` |

Skill Builder does not expose `/respond` or `/act` on the settings router today; approval uses `/decision` only.

See [Agent runtime guide](agent-runtime-guide.md) for stream and HITL semantics.

---

## Daily reflections

Prefix: `/api/settings/reflections`

| Endpoint | Purpose |
| -------- | ------- |
| `GET /daily?date=&timezone=` | One day's reflection (or latest if no date) |
| `GET /trends?days=14&timezone=` | Trend series (max 90 days) |
| `POST /generate` | `{ date?, timezone? }` trigger generation |

Used by admin analytics UI; not part of workspace chat.

---

## Skill evolution

Prefix: `/api/settings/skill-evolution`

Suggests updates to skill learnings or user memory routing from conversation signals.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /suggestions?status=pending` | List (`pending`, `accepted`, `rejected`, `stale`, `all`) |
| `POST /suggestions/:id/decision` | `{ decision: accept\|reject, editedContent? }` |
| `POST /generate` | `{ limit?: 40 }` batch-generate suggestions |

---

## Users and groups

Prefix: `/api/users`

### Users

| Endpoint | Purpose |
| -------- | ------- |
| `GET /` | List all users |
| `PUT /:userId/admin` | `{ isAdmin: boolean }` |
| `GET /:userId/deletion-impact` | Preview workspaces/data affected |
| `DELETE /:userId` | Delete user (cannot delete self) |

### Groups (prompt access control)

Groups restrict which **skills** and **MCP servers** members may use in slash metadata and agent policy.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /groups/list` | All groups |
| `POST /groups` | `{ name }` create |
| `DELETE /groups/:groupId` | Delete group |
| `GET /groups/:groupId/access` | `{ skillIds, mcpServerIds }` |
| `PUT /groups/:groupId/access` | Replace allow lists |
| `GET /groups/:groupId/members` | Member list |
| `POST /groups/:groupId/members` | `{ userId }` add |
| `DELETE /groups/:groupId/members/:userId` | Remove |

Non-admin users see filtered `GET /api/agent/slash-metadata` based on group + admin flag.

---

## Environment flags (admin features)

| Variable | Effect |
| -------- | ------ |
| `ENABLE_GITHUB_SKILL_IMPORTER` | `false` → inspect/apply return 404 |
| `ENABLE_SKILL_BUILDER_ASSISTANT` | `false` → skill-builder routes 404 |
| `ENABLE_SKILL_SANDBOX_RUNNER` | Skill builder runs may sign JWT with sandbox permission |
| `ADMIN_EMAILS` | Comma-separated emails granted admin on OAuth login |

---

## Related

- [Integration guide](integration-guide.md) — how the main app authenticates  
- [API reference](reference.md) — exhaustive admin endpoint list  
- [Agent runtime guide](agent-runtime-guide.md) — durable runs for Skill Builder  
