# API reference

Exhaustive endpoint listing for the **backend** (Express) and **agent** (FastAPI) HTTP APIs.

For onboarding, read the [documentation index](README.md) first — especially the [Agent runtime guide](agent-runtime-guide.md) for `/api/agent/run` vs `/runs` and HITL endpoints.

TypeScript shapes: `packages/contracts/` (`@helpudoc/contracts`).

## Base URLs

| Environment | Backend | Agent |
| ----------- | ------- | ----- |
| Local dev | `http://localhost:3000` | `http://localhost:8001` |
| Docker Compose | proxied as `/api/` from frontend | `http://agent:8001` (internal) |

- Backend routes are mounted at **`/api`** (except root health below).
- Agent interactive OpenAPI: `http://localhost:8001/docs` (Swagger), `/redoc`, `/openapi.json`.

## Authentication

### Backend

Most routes require an authenticated **user context**. Unauthenticated requests typically receive `401` with `{ "error": "Missing user context" }`.

| Mode (`AUTH_MODE`) | How clients authenticate |
| ------------------ | ------------------------ |
| `headers` | Request headers: `X-User-Id` (required), optional `X-User-Name`, `X-User-Email`. No session cookie. |
| `oidc` | Session cookie after Google OAuth (`GET /api/auth/google/start` → callback). |
| `hybrid` (default) | Session if present; otherwise same headers as `headers`. |

**CORS:** credentials enabled. Allowed headers include `Content-Type`, `Authorization`, `X-User-Id`, `X-User-Name`, `X-User-Email`.

**Admin routes:** `/api/settings/*`, `/api/users/*`, and nested admin paths use `requireSystemAdmin` (user must be system admin via `ADMIN_EMAILS` or DB flag).

### Agent

Called by the backend with optional **`Authorization: Bearer <JWT>`** signed with `AGENT_JWT_SECRET`. The JWT carries `userId`, `workspaceId`, MCP allow/deny lists, and related policy. Internal routes require a valid token with `userId`.

Browser clients normally **do not** call the agent directly; they use backend `/api/agent/*` proxies.

## Common error shape

```json
{ "error": "Human-readable message", "details": {} }
```

Validation errors often return `400` with `{ "error": "Invalid input" }` or Zod issue details.

---

## Backend API

### Health (no `/api` prefix)

#### `GET /api/health`

Liveness probe.

**Response `200`**

```json
{ "status": "ok", "service": "helpudoc-backend" }
```

---

### Auth — `/api/auth`

#### `GET /api/auth/me`

Current session / auth mode.

**Response `200`**

| Field | Type | Description |
| ----- | ---- | ----------- |
| `authenticated` | boolean | Whether `user` is present |
| `authMode` | `"headers"` \| `"oidc"` \| `"hybrid"` | Server config |
| `googleConfigured` | boolean | OAuth client configured |
| `user` | object \| null | `{ userId, externalId, displayName, email, isAdmin }` |

#### `GET /api/auth/google/start`

Starts Google OAuth (PKCE). **Disabled when `AUTH_MODE=headers`.**

**Query**

| Param | Description |
| ----- | ----------- |
| `returnTo` | Optional path starting with `/` (post-login redirect hint) |

**Response:** `302` redirect to Google, or `400`/`503` JSON error.

#### `GET /api/auth/google/callback`

OAuth callback (Google redirects here). **Response:** `302` to configured post-login URL; errors encoded in redirect query.

#### `POST /api/auth/logout`

Destroys session and clears session cookie.

**Response `200`:** `{ "success": true }`

---

### Workspaces — `/api/workspaces`

All routes require user context.

#### `GET /api/workspaces`

List workspaces for the current user.

**Response `200`:** array of `Workspace` (see `@helpudoc/contracts`).

#### `POST /api/workspaces`

Create workspace.

**Body**

```json
{ "name": "optional display name" }
```

**Response `201`:** created `Workspace`.

#### `GET /api/workspaces/user-directory`

Search users for collaborator invites.

**Query:** `q` (string), `limit` (number, default 20), `excludeSelf` (`1`/`true`/`yes`).

**Response `200`:** `{ "users": [ ... ] }`

#### `GET /api/workspaces/:workspaceId`

**Response `200`:** `Workspace` or error if not a member.

#### `PATCH /api/workspaces/:workspaceId`

Rename workspace (owner/editor rules enforced in service).

**Body:** `{ "name": "string (1–255 chars)" }`

**Response `200`:** updated `Workspace`.

#### `DELETE /api/workspaces/:workspaceId`

**Response `204`** on success.

#### `GET /api/workspaces/:workspaceId/collaborators`

**Response `200`:** `{ "collaborators": [ ... ] }`

#### `POST /api/workspaces/:workspaceId/collaborators`

**Body** (exactly one of `userId` or `externalUserId`):

```json
{
  "userId": "uuid",
  "externalUserId": "string",
  "displayName": "optional when using externalUserId",
  "role": "editor" | "viewer"
}
```

**Response `204`**

#### `DELETE /api/workspaces/:workspaceId/collaborators/:targetUserId`

**Response `204`**

---

### Files — `/api/workspaces/:workspaceId/files`

Requires workspace membership; mutating routes require edit access where enforced.

#### `GET .../files`

List files. May include `understandingStatus`, `understandingMode`, `understandingError`, `derivedArtifactFileId`.

**Response `200`:** `File[]`

#### `GET .../files/folders`

**Response `200`:** `{ "folders": [ ... ] }`

#### `GET .../files/preview?path=<relativePath>`

JSON preview metadata and content encoding.

#### `GET .../files/preview/raw?path=<relativePath>`

Raw bytes with `Content-Type` from file MIME.

#### `GET .../files/:fileId/content`

**Response `200`:** file record with base64 or text `content`.

#### `POST .../files`

Multipart upload.

| Part | Description |
| ---- | ----------- |
| `file` | Binary (required) |
| `path` | Optional relative path / name |

**Response `201`:** created `File` (may include understanding fields if auto-processing started).

#### `POST .../files/text`

**Body:** `{ "name", "content", "mimeType?" }`

**Response `201`:** created file.

#### `POST .../files/folders`

**Body:** `{ "path": "folder/path" }`

**Response `201`**

#### `PUT .../files/:fileId/content`

**Body:** `{ "content": "string", "version?": number }`

**Response `200`:** updated file.

#### `PATCH .../files/:fileId`

Rename/move.

**Body:** `{ "name?": string, "path?": string, "version?": number }` (at least one of `name` or `path`).

#### `DELETE .../files/:fileId`

**Response `204`**

#### `DELETE .../files/folders?path=<folderPath>`

**Response `204`**

#### `POST .../files/context`

Build derived-artifact context refs for agent turns.

**Body:** `{ "fileIds": [1, 2, ...] }` (1–20 positive integers)

**Response `201`:** `{ "fileContextRefs": FileContextRef[] }`

#### `POST .../files/rag-status`

Proxy to agent RAG status.

**Body:** `{ "files": ["path/one.md", "/path/two.pdf"] }`

**Response `200`:** `{ "statuses": { "<path>": { "status", "updatedAt?", "error?" } } }`

#### `GET .../files/drive/search`

Google Drive picker search (requires linked Google OAuth for user).

**Query:** `query?`, `scope?` (`recent` \| `my-drive` \| `shared`), `pageToken?`

**Response `200`:** `GoogleDriveSearchResult`

#### `POST .../files/drive/import`

**Body:** `{ "fileIds": ["driveFileId", ...] }` (1–20)

**Response `201`:** `{ "files": File[] }`

---

### Attachments — `/api/workspaces/:workspaceId/attachments`

#### `POST .../attachments/jobs`

Prepare Drive/workspace attachments for a chat turn.

**Body**

```json
{
  "conversationId": "string",
  "turnId": "string",
  "driveFileIds": ["optional"],
  "sourceFileIds": [1, 2]
}
```

**Response `201`:** job object with `id`, `status` (`pending` \| `running` \| `ready` \| `failed`), etc.

#### `GET .../attachments/jobs/:jobId`

**Response `200`:** job status and results.

---

### Knowledge — `/api/workspaces/:workspaceId/knowledge`

#### `GET /`

List knowledge sources.

#### `GET /:knowledgeId`

Single item (numeric id).

#### `POST /`

**Body**

```json
{
  "title": "required",
  "type": "text" | "table" | "image" | "presentation" | "infographic",
  "description": "optional",
  "content": "optional",
  "fileId": 123,
  "sourceUrl": "https://...",
  "tags": {},
  "metadata": {}
}
```

**Response `201`**

#### `PUT /:knowledgeId`

Partial update (same fields as create, all optional).

#### `DELETE /:knowledgeId`

**Response `204`**

---

### Conversations — `/api`

#### `GET /workspaces/:workspaceId/conversations?limit=5`

Recent conversations. `limit` must be a positive number.

**Response `200`:** `ConversationSummary[]`

#### `POST /workspaces/:workspaceId/conversations`

**Body:** `{ "persona": "fast" | "pro" | ... }`

**Response `201`:** conversation object.

#### `GET /conversations/:conversationId`

**Response `200`:** conversation with `messages[]` or `404`.

#### `POST /conversations/:conversationId/messages`

Append or replace a message.

**Body**

```json
{
  "sender": "user" | "agent",
  "text": "string",
  "turnId": "optional",
  "replaceExisting": false,
  "metadata": {
    "thinkingText": "optional",
    "toolEvents": [],
    "bodySource": "assistant" | "summary",
    "runId": "optional",
    "status": "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled",
    "pendingInterrupt": { }
  }
}
```

User messages must have non-empty `text` after trim.

**Response `201`:** message record.

#### `DELETE /conversations/:conversationId/messages?afterMessageId=<id>`

Truncate messages after the given id.

**Response `200`:** `{ "deleted": number }`

#### `DELETE /conversations/:conversationId`

**Response `204`** or `404`.

---

### User memory — `/api/me`

#### `GET /api/me/memory?workspaceId=<optional>`

**Response `200`:** `UserMemoryView`

#### `PATCH /api/me/memory`

**Body**

```json
{
  "scope": "global" | "workspace",
  "section": "preferences" | "context" | "skill-routing",
  "workspaceId": "required if scope=workspace",
  "content": "markdown or text"
}
```

#### `GET /api/me/memory/suggestions?workspaceId=<optional>`

**Response `200`:** suggestions list.

#### `POST /api/me/memory/suggestions/:suggestionId/decision`

**Body:** `{ "decision": "accept" | "reject", "editedContent?": "string" }`

---

### Agent (backend proxy) — `/api/agent`

Workspace membership (edit) required for runs. The backend signs JWTs and forwards to the agent service.

**Lifecycle overview:** [Agent runtime guide](agent-runtime-guide.md) explains durable runs vs legacy `/run` and `/run-stream`, streaming, and `/decision` / `/respond` / `/act`.

#### `GET /api/agent/slash-metadata`

Skills and MCP servers visible to the user for `/` commands in chat.

**Response `200`**

```json
{
  "skills": [{ "id", "name", "description?", "valid", "error?", "warning?" }],
  "mcpServers": [{ "name", "description?" }]
}
```

#### Agent runs (summary)

| Method | Path | Notes |
| ------ | ---- | ----- |
| `POST` | `/api/agent/run` | Legacy sync — full reply in one response |
| `POST` | `/api/agent/run-stream` | Legacy stream — JSONL on same POST |
| `POST` | `/api/agent/runs` | **Durable run** — returns `runId` |
| `GET` | `/api/agent/runs/:runId` | Metadata + `pendingInterrupt` |
| `GET` | `/api/agent/runs/:runId/stream?after=` | NDJSON events ([chunk types](#agent-stream-events)) |
| `POST` | `/api/agent/runs/:runId/cancel` | Cancel |
| `POST` | `/api/agent/runs/:runId/decision` | HITL approve / edit / reject |
| `POST` | `/api/agent/runs/:runId/respond` | HITL clarification |
| `POST` | `/api/agent/runs/:runId/act` | HITL button action |

See [Agent runtime guide](agent-runtime-guide.md) for when to use each path.

#### `POST /api/agent/run` *(legacy synchronous)*

**Body:** [Agent run request body](#agent-run-request-body). **Response `200`:** full agent reply.

#### `POST /api/agent/run-stream` *(legacy streaming)*

Same body. **Response:** `application/jsonl`.

#### `POST /api/agent/runs`

**Body:** [Agent run request body](#agent-run-request-body) plus optional `conversationId`, `turnId`. **Response `200`:** `{ "runId", "status" }`.

#### `GET /api/agent/runs/:runId`

Statuses: `queued`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`.

#### `GET /api/agent/runs/:runId/stream?after=0-0`

NDJSON; keepalive `{"type":"keepalive"}`.

#### `POST /api/agent/runs/:runId/cancel`

**Response `200`:** `{ "status": "cancelled" }`

#### `POST /api/agent/runs/:runId/decision`

**Body:** `{ "decision": "approve"|"edit"|"reject", "editedAction?", "message?" }`. **`409`** if not an approval interrupt.

#### `POST /api/agent/runs/:runId/respond`

**Body:** `{ "message?", "selectedChoiceIds?", "selectedValues?", "answersByQuestionId?" }`. **`409`** if not clarification.

#### `POST /api/agent/runs/:runId/act`

**Body:** `{ "actionId", "text?" }`

#### Agent run request body

Used by `POST /api/agent/run`, `/run-stream`, and `/runs`.

```json
{
  "persona": "fast",
  "prompt": "user message",
  "workspaceId": "workspace-uuid",
  "conversationId": "optional",
  "history": [{ "role": "user", "content": "..." }],
  "forceReset": false,
  "turnId": "optional",
  "taggedFiles": ["relative/path.md"],
  "currentTurnFileIds": [1, 2],
  "internetSearchEnabled": false,
  "fileContextRefs": [
    {
      "sourceFileId": 1,
      "sourceName": "doc.pdf",
      "sourceMimeType": "application/pdf",
      "sourceVersionFingerprint": "hash",
      "artifactId": "id",
      "artifactVersion": 1,
      "derivedArtifactFileId": 2,
      "derivedArtifactPath": "derived/...",
      "effectiveMode": "part" | "parser" | "hybrid",
      "status": "pending" | "partial" | "ready" | "failed" | "superseded",
      "summary": null,
      "lastError": null
    }
  ]
}
```

`currentTurnFileIds` attachments are inlined as multimodal blocks when under `CURRENT_TURN_MULTIMODAL_MAX_BYTES` (default 8MB).

---

### Admin settings — `/api/settings`

**Requires system admin.** Narrative guide: [Admin guide](admin-guide.md).

#### `GET /api/settings/workspace-overview`

Dashboard aggregates (workspaces, skills, Langfuse, etc.).

#### Agent runtime config

| Method | Path | Body / response |
| ------ | ---- | ----------------- |
| `GET` | `/api/settings/agent-config` | `{ "content": "YAML string" }` |
| `PUT` | `/api/settings/agent-config` | `{ "content": "YAML" }` → `{ "success": true }` |

#### Skills catalog

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/settings/skills` | `{ "skills": SkillMetadata[] }` |
| `POST` | `/api/settings/skills` | `{ "id", "name?", "description?" }` scaffold skill |
| `GET` | `/api/settings/skills/:skillId/files` | `{ "files": ["SKILL.md", ...] }` |
| `GET` | `/api/settings/skills/:skillId/content?path=rel` | `{ "content": "..." }` |
| `PUT` | `/api/settings/skills/:skillId/content` | `{ "path", "content" }` |
| `POST` | `/api/settings/skills/parse-actions` | `{ "text": "..." }` → parsed action array |
| `POST` | `/api/settings/skills/apply-actions` | `{ "actions": [...] }` batch file ops |

**Action types for `apply-actions`:** `create_skill`, `upsert_text`, `upload_binary_from_context`, `delete_file`.

#### GitHub skill import

Disabled when `ENABLE_GITHUB_SKILL_IMPORTER=false`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `POST` | `/api/settings/skills/import/github/inspect` | `{ "url", "ref?", "githubToken?" }` → session + file preview |
| `POST` | `/api/settings/skills/import/github/apply` | `{ "importSessionId", "destinationSkillId?", "onCollision": "copy" }` |

#### Skill Builder assistant

Disabled when `ENABLE_SKILL_BUILDER_ASSISTANT=false`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `POST` | `/api/settings/skill-builder/session` | `{ workspaceId, limits, allowedExtensions }` |
| `GET` | `/api/settings/skill-builder/context-files` | List uploaded context files |
| `POST` | `/api/settings/skill-builder/context-files` | Multipart `file` upload |
| `DELETE` | `/api/settings/skill-builder/context-files/:fileId` | Remove context file |
| `POST` | `/api/settings/skill-builder/runs` | Start builder agent run (persona `skill-builder`) |
| `GET` | `/api/settings/skill-builder/runs/:runId` | Run metadata |
| `POST` | `/api/settings/skill-builder/runs/:runId/cancel` | Cancel |
| `POST` | `/api/settings/skill-builder/runs/:runId/decision` | HITL approval |
| `GET` | `/api/settings/skill-builder/runs/:runId/stream?after=0-0` | NDJSON stream (same as agent runs) |

**Skill Builder run body:** `{ "prompt", "history?", "contextFileIds?", "selectedSkillId?", "turnId?", "forceReset?" }`

#### Reflections — `/api/settings/reflections`

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/daily?date=YYYY-MM-DD&timezone=` | Daily reflection |
| `GET` | `/trends?days=14&timezone=` | Trend points (days 1–90) |
| `POST` | `/generate` | `{ "date?", "timezone?" }` generate reflection |

#### Skill evolution — `/api/settings/skill-evolution`

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/suggestions?status=pending` | `pending` \| `accepted` \| `rejected` \| `stale` \| `all` |
| `POST` | `/suggestions/:id/decision` | `{ "decision": "accept" \| "reject", "editedContent?" }` |
| `POST` | `/generate` | `{ "limit?": 40 }` manual generation |

---

### Admin users — `/api/users`

**Requires system admin.**

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/` | `{ "users": [...] }` |
| `PUT` | `/:userId/admin` | `{ "isAdmin": boolean }` |
| `GET` | `/:userId/deletion-impact` | Impact summary before delete |
| `DELETE` | `/:userId` | Delete user (not self) |
| `GET` | `/groups/list` | List groups |
| `POST` | `/groups` | `{ "name" }` create group |
| `DELETE` | `/groups/:groupId` | Delete group |
| `GET` | `/groups/:groupId/access` | Prompt access (`skillIds`, `mcpServerIds`) |
| `PUT` | `/groups/:groupId/access` | Replace access |
| `GET` | `/groups/:groupId/members` | List members |
| `POST` | `/groups/:groupId/members` | `{ "userId": "uuid" }` |
| `DELETE` | `/groups/:groupId/members/:userId` | Remove member |

---

## Agent service API

Base URL: `http://localhost:8001`. Unless noted, chat routes accept optional `Authorization: Bearer <JWT>` from the backend.

### Health

#### `GET /health`

```json
{
  "status": "ok",
  "service": "helpudoc-agent",
  "dependencies": { }
}
```

### Agent discovery and chat

#### `GET /agents`

Lists personas, tools, and MCP servers.

**Response `200`**

```json
{
  "agents": [
    {
      "name": "fast" | "pro" | "skill-builder",
      "displayName": "string",
      "description": "string",
      "tools": ["tool_name", ...],
      "subagents": []
    }
  ],
  "mcpServers": [ ... ]
}
```

#### `POST /agents/{agent_name}/workspace/{workspace_id}/chat`

Synchronous chat.

**Body (`ChatRequest`)**

```json
{
  "message": "string",
  "history": [{ "role": "user", "content": "..." }],
  "forceReset": false,
  "fileContextRefs": [],
  "messageContent": [{ "type": "text", "text": "..." }],
  "internetSearchEnabled": false,
  "langfuseTraceContext": {}
}
```

**Response `200`:** `{ "reply": <any> }`

#### `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream`

Server-Sent Events / streaming JSONL of tokens, tool events, interrupts.

**Body:** same as `ChatRequest`.

#### `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/resume`

Resume after HITL approval.

**Body (`ResumeChatRequest`)**

```json
{
  "decisions": [
    { "type": "approve" },
    { "type": "reject", "message": "..." },
    { "type": "edit", "edited_action": { "name": "...", "args": {} }, "message": "..." }
  ],
  "langfuseTraceContext": {}
}
```

#### `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/respond`

Clarification response.

**Body (`InterruptResponseRequest`)**

```json
{
  "message": "optional",
  "selectedChoiceIds": [],
  "selectedValues": [],
  "answersByQuestionId": {},
  "langfuseTraceContext": {}
}
```

#### `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/act`

Structured interrupt button action.

**Body (`InterruptActionRequest`)**

```json
{
  "action": { "id": "action_id", "value": "optional", "payload": {}, "text": "optional" },
  "langfuseTraceContext": {}
}
```

### RAG

#### `POST /rag/workspaces/{workspace_id}/query`

**Body**

```json
{
  "query": "string",
  "mode": "local",
  "onlyNeedContext": true,
  "includeReferences": false
}
```

**Response `200`:** `{ "response": "context string" }`

#### `POST /rag/workspaces/{workspace_id}/status`

**Body:** `{ "files": ["relative/path1", "path2"] }`

**Response `200`:** `{ "statuses": { "<path>": { "status", "updatedAt", "error" } } }`

### Attachments

#### `POST /attachments/understand`

Derive markdown summary / outline from an attachment.

**Body**

```json
{
  "fileName": "doc.pdf",
  "mimeType": "application/pdf",
  "contentB64": "optional base64",
  "workspaceId": "optional with relativePath",
  "relativePath": "optional workspace-relative path"
}
```

Either `contentB64` or `workspaceId` + `relativePath` is required.

**Response `200`:** `AttachmentUnderstandingResponse` — `title`, `summary`, `outline`, `markdown`, `sections`, `extractedAssets`, `effectiveMode`, `status`.

### Skills

#### `GET /skills/{skill_id}/contract`

Skill policy for runtime (tools, MCP, HITL flags).

**Response `200`**

```json
{
  "skillId": "string",
  "name": "string",
  "description": "string",
  "tools": [],
  "mcpServers": [],
  "requiresHitlPlan": false,
  "requiresWorkspaceArtifacts": false,
  "requiredArtifactsMode": "string",
  "prePlanSearchLimit": 0,
  "sourcePath": "filesystem path"
}
```

### Internal (backend-only)

Requires `Authorization: Bearer` JWT with `userId`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `POST` | `/internal/analyze` | `{ "systemPrompt", "userPrompt" }` → `{ "text" }` |
| `GET` | `/internal/memories?path=rel` | Read user memory file |
| `PUT` | `/internal/memories` | `{ "path", "content" }` write memory file |
| `DELETE` | `/internal/memories` | `{ "path" }` delete memory file |

---

## Agent stream events

When consuming `/api/agent/runs/:runId/stream` or agent `chat/stream`, chunks align with `AgentStreamChunk` in `packages/contracts/src/agentStream.ts`:

| `type` | Meaning |
| ------ | ------- |
| `token` / `chunk` | Assistant text delta |
| `thought` | Reasoning text |
| `policy` | Active skill / HITL / artifact policy |
| `tool_start` / `tool_end` / `tool_error` | Tool execution lifecycle |
| `dashboard_artifact` | Dashboard package metadata |
| `interrupt` | Approval or clarification UI payload |
| `keepalive` | Stream heartbeat |
| `done` | Turn complete |
| `error` / `contract_error` | Failure |

---

## TypeScript types

Import from `@helpudoc/contracts`:

| Type | Use |
| ---- | --- |
| `Workspace`, `File`, `FileContextRef` | Workspace UI |
| `ConversationSummary`, `ConversationMessage` | Chat history |
| `AgentStreamChunk` | Run streaming |
| `PendingInterrupt`, `InterruptAction` | HITL UI |
| `UserMemoryView`, `SkillEvolutionSuggestion` | Settings / memory |
| `GoogleDriveSearchResult` | Drive picker |

Source files: `packages/contracts/src/types.ts`, `packages/contracts/src/agentStream.ts`.

---

## Collaboration WebSocket

Not part of `/api`: the backend starts a **Yjs** collaboration server (default `ws://localhost:1234`, `COLLAB_PORT`). Document sync is separate from the REST API.

---

## Related documentation

- [Documentation index](README.md)
- [Agent runtime guide](agent-runtime-guide.md)
- [Integration guide](integration-guide.md)
- [File & attachment flow](file-attachment-flow.md)
- [Admin guide](admin-guide.md)
- [environment.md](../environment.md)
- [deploy.md](../deploy.md)
- [backend/README.md](../../backend/README.md)
- [agent/README.md](../../agent/README.md)
