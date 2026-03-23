# HelpUDoc Backend

The backend is an Express + TypeScript API for HelpUDoc. It handles:

- session and Google OAuth auth flows
- workspace membership and collaborator management
- file CRUD and preview access
- knowledge source CRUD
- agent run orchestration and paper-to-slides jobs
- conversation history persistence
- admin-only settings for agent config, skills, users, and skill-builder workflows
- the live collaboration WebSocket server

## Prerequisites

- Node.js 20+
- npm
- PostgreSQL, Redis, and MinIO/S3-compatible object storage

For local development, the repo's Docker Compose dependency stack is the easiest way to supply those services.

## Installation

```bash
cd backend
npm install
```

## Running locally

```bash
ENV_FILE=../env/local/dev.env npm run dev
```

API base URL: `http://localhost:3000/api`

The collaboration server starts alongside the API and listens on `ws://localhost:1234` by default.

## Key environment variables

### Sessions and auth

| Variable | Purpose |
| -------- | ------- |
| `SESSION_SECRET` | Express session signing secret. |
| `SESSION_NAME` | Session cookie name. |
| `SESSION_TTL_SECONDS` | Session lifetime in seconds. |
| `SESSION_COOKIE_SECURE` | Forces secure cookies outside local dev. |
| `SESSION_COOKIE_DOMAIN` | Optional cookie domain for shared deployments. |
| `AUTH_MODE` | `headers`, `oidc`, or `hybrid`. |
| `ADMIN_EMAILS` | Comma-separated admin allowlist for system admin access. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google sign-in credentials. |
| `GOOGLE_OAUTH_REDIRECT_URI` | OAuth callback URL. |
| `GOOGLE_OAUTH_POST_LOGIN_REDIRECT` | Where the frontend should land after sign-in. |
| `GOOGLE_OAUTH_SCOPES` | Google API scopes requested during sign-in. |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Encryption key for stored delegated OAuth tokens. |

### Persistence and infrastructure

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` or `POSTGRES_*` | PostgreSQL connectivity. |
| `DATABASE_SSL` | Optional database TLS mode. |
| `REDIS_URL` | Redis connection string. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | MinIO or S3 credentials. |
| `S3_ENDPOINT` | Object storage endpoint. |
| `S3_BUCKET_NAME` | Storage bucket for workspace artifacts. |
| `S3_PUBLIC_BASE_URL` | Browser-safe base URL for stored assets. |
| `WORKSPACE_ROOT` | Local/shared workspace storage directory. |
| `SKILLS_ROOT` | Skill catalog root managed by settings flows. |
| `AGENT_URL` | Base URL of the Python agent service. |
| `AGENT_CONFIG_PATH` | Shared runtime config path for agent settings editing. |
| `AGENT_JWT_SECRET` | Secret used to sign backend-to-agent requests. |
| `COLLAB_PORT` | Collaboration WebSocket server port. |

### Local fallback identity

When `AUTH_MODE` allows header-based auth, these defaults help local development work without a full sign-in flow:

- `DEFAULT_USER_ID`
- `DEFAULT_USER_NAME`
- `DEFAULT_USER_EMAIL`

## Running local dependencies

From the repo root:

```bash
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
```

This provisions PostgreSQL, Redis, and MinIO with the same defaults used by the example env files.

## Main API areas

### Auth

- `GET /api/auth/me`
- `GET /api/auth/google/start`
- `GET /api/auth/google/callback`
- `POST /api/auth/logout`

### Workspaces, files, and knowledge

- `GET/POST /api/workspaces`
- `GET/PATCH/DELETE /api/workspaces/:workspaceId`
- `GET/POST /api/workspaces/:workspaceId/collaborators`
- `GET/POST/PUT/PATCH/DELETE /api/workspaces/:workspaceId/files/...`
- `GET/POST/PUT/DELETE /api/workspaces/:workspaceId/knowledge/...`
- `POST /api/workspaces/:workspaceId/files/rag-status`

### Conversations and agent runs

- `GET/POST /api/workspaces/:workspaceId/conversations`
- `GET/DELETE /api/conversations/:conversationId`
- `POST /api/conversations/:conversationId/messages`
- `DELETE /api/conversations/:conversationId/messages`
- `GET /api/agent/slash-metadata`
- `POST /api/agent/runs`
- `GET /api/agent/runs/:runId`
- `GET /api/agent/runs/:runId/stream`
- `POST /api/agent/runs/:runId/cancel`
- `POST /api/agent/runs/:runId/decision`
- `POST /api/agent/runs/:runId/respond`
- `POST /api/agent/runs/:runId/act`
- `POST /api/agent/paper2slides/jobs`
- `GET /api/agent/paper2slides/jobs/:jobId`
- `POST /api/agent/paper2slides/export-pptx`

### Admin settings

These routes are protected by system-admin checks:

- `GET/PUT /api/settings/agent-config`
- `GET/POST /api/settings/skills`
- `GET/PUT /api/settings/skills/.../content`
- GitHub skill import inspect/apply endpoints
- Skill-builder session, uploads, run, stream, cancel, and decision endpoints
- `GET/PUT /api/users` and group management endpoints

## Dev notes

- The server initializes its database structures during startup.
- CORS is configured with `credentials: true` so cookie-based auth works in local and deployed flows.
- Session storage uses Redis via `connect-redis`.
- The collaboration server starts automatically from the same Node process.

## Related docs

- [../README.md](../README.md)
- [../docs/environment.md](../docs/environment.md)
- [../docs/deploy.md](../docs/deploy.md)
