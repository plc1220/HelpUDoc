# HelpUDoc

HelpUDoc is a research and proposal authoring workspace that combines:

- a TypeScript/Express **backend** for workspaces, knowledge, and persistence (PostgreSQL, Redis, MinIO/S3)
- a React/Vite **frontend** for the collaborative UI, editors, and visualization tools
- a Python **agent service** that orchestrates Gemini-powered multi-agent workflows

The repository is organized so you can run the full stack with Docker or develop each component independently.

## Repository layout

| Path | Description |
| ---- | ----------- |
| `agent/` | FastAPI service, prompt catalog, and paper2slides pipeline. |
| `backend/` | Express/TypeScript API, persistence, and workspace metadata. |
| `frontend/` | Vite + React client application. |
| `infra/` | Docker Compose files for the full stack and shared dependencies. |
| `docs/` | Product specs and internal documentation (`docs/specs/` includes the OpenAPI contract). |
| `scripts/` | Helper scripts for local runs. |
| `tests/` | Integration and regression tests. |

### Detailed app tree (current)

```
HelpUDoc/
├── frontend/                      # Vite + React client app
│   ├── src/
│   │   ├── pages/                # Route-level pages
│   │   │   ├── WorkspacePage.tsx
│   │   │   ├── UsersPage.tsx
│   │   │   ├── DashboardPage.tsx
│   │   │   ├── KnowledgePage.tsx
│   │   │   ├── AgentSettingsPage.tsx
│   │   │   ├── BillingPage.tsx
│   │   │   └── LoginPage.tsx
│   │   ├── components/           # Reusable UI components
│   │   │   ├── settings/
│   │   │   │   ├── AgentSettingsTabs.tsx
│   │   │   │   ├── CoreAgentsTab.tsx
│   │   │   │   ├── SubagentsTab.tsx
│   │   │   │   ├── ToolsTab.tsx
│   │   │   │   └── SettingsShell.tsx
│   │   │   ├── WorkspaceList.tsx
│   │   │   ├── FileList.tsx
│   │   │   ├── FileEditor.tsx
│   │   │   ├── FileRenderer.tsx
│   │   │   ├── PlotlyChart.tsx
│   │   │   ├── PersonaSelector.tsx
│   │   │   ├── CollapsibleDrawer.tsx
│   │   │   └── ExpandableSidebar.tsx
│   │   ├── services/             # API clients
│   │   │   ├── apiClient.ts
│   │   │   ├── agentApi.ts
│   │   │   ├── conversationApi.ts
│   │   │   ├── fileApi.ts
│   │   │   ├── knowledgeApi.ts
│   │   │   ├── paper2SlidesJobApi.ts
│   │   │   ├── presentationApi.ts
│   │   │   ├── settingsApi.ts
│   │   │   └── workspaceApi.ts
│   │   ├── auth/
│   │   │   ├── AuthProvider.tsx
│   │   │   └── authStore.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── theme.ts
│   │   ├── types.ts
│   │   ├── index.css
│   │   └── plotly.js-dist-min.d.ts
│   ├── public/                   # Static assets
│   ├── package.json
│   ├── package-lock.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── eslint.config.js
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── Dockerfile
│   └── nginx.conf
│
├── backend/                       # Express + TypeScript API
│   ├── src/
│   │   ├── api/                  # Route handlers
│   │   │   ├── agent.ts
│   │   │   ├── conversations.ts
│   │   │   ├── files.ts
│   │   │   ├── knowledge.ts
│   │   │   ├── logging.ts
│   │   │   ├── routes.ts
│   │   │   ├── settings.ts
│   │   │   └── workspaces.ts
│   │   ├── services/             # Domain + integration services
│   │   │   ├── agentService.ts
│   │   │   ├── conversationService.ts
│   │   │   ├── databaseService.ts
│   │   │   ├── fileService.ts
│   │   │   ├── knowledgeService.ts
│   │   │   ├── paper2SlidesService.ts
│   │   │   ├── presentationService.ts
│   │   │   ├── ragQueueService.ts
│   │   │   ├── redisService.ts
│   │   │   ├── s3Service.ts
│   │   │   ├── userService.ts
│   │   │   └── workspaceService.ts
│   │   ├── types/                # Shared types
│   │   │   ├── knowledge.ts
│   │   │   ├── presentation.ts
│   │   │   ├── user.ts
│   │   │   └── session.d.ts
│   │   ├── middleware/
│   │   │   └── userContext.ts
│   │   ├── config/
│   │   │   └── personas.ts
│   │   ├── core/
│   │   │   └── agent.ts
│   │   ├── errors.ts
│   │   └── index.ts
│   ├── scripts/                  # Local test scripts
│   │   ├── test_frontend_prompt_stream.mjs
│   │   ├── test_rag_hybrid_flow.mjs
│   │   ├── test_tagged_rag_query.mjs
│   │   └── test_upload_rag_flow.mjs
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── README.md
│   └── .env.example
│
├── agent/                         # Python agent service + pipelines
│   ├── main.py
│   ├── README.md
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── config/
│   │   └── agents.yaml
│   ├── prompts/                  # Prompt catalog
│   │   ├── data_agent/
│   │   ├── general/
│   │   ├── proposal_agent/
│   │   └── research/
│   ├── helpudoc_agent/           # API + orchestration helpers
│   ├── paper2slides/             # Paper-to-slides pipeline
│   ├── lightrag_server/
│   │   ├── README.md
│   │   └── env.example
│   └── docs/                     # Agent docs and references
│
├── docs/                          # Product specs and internal docs
│   └── specs/                     # UI spec + OpenAPI contract
├── infra/                         # Docker Compose stacks
│   ├── docker-compose.yml
│   └── docker-compose.dependencies.yml
├── scripts/                       # Helper scripts
│   ├── start_agent.sh
│   └── test_paper2slides.sh
├── tests/                         # Regression tests
├── pyproject.toml                 # Python project config
├── uv.lock                        # Python lockfile
├── env/                           # Env templates (local/prod)
├── LICENSE
└── README.md
```

## Running with Docker Compose

1. **Prerequisites:** Docker Desktop 4.30+ (or Engine 26+), plus a Gemini API key.
2. **Create a local env file:**
   ```bash
   cp env/local/stack.env.example env/local/stack.env
   ```
3. **Build and start (from repo root):**
   ```bash
   docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build
   ```
4. **Services:**
   - Frontend UI: http://localhost:8080
   - Backend API: http://localhost:3000/api
   - Agent service: http://localhost:8001
   - PostgreSQL (5432), Redis (6379), MinIO API (9000) and console (9001) are forwarded for convenience.
5. **Stopping:** `docker compose -f infra/docker-compose.yml down` tears the stack down but keeps named volumes (`postgres_data`, `redis_data`, `minio_data`). Use `-v` if you also want to reset data stores.

### Common environment variables

Compose reads variables from `env/local/stack.env` (or your shell), so you can override defaults safely:

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database credentials shared between Postgres and the backend. | `helpudoc` / `helpudoc` / `helpudoc` |
| `SESSION_SECRET`, `SESSION_NAME`, `SESSION_TTL_SECONDS` | Express session configuration. | `change-me`, `helpudoc.sid`, `604800` |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO admin credentials used by the backend and agent. | `minioadmin` / `minioadmin` |
| `S3_BUCKET_NAME` | Bucket created during startup for document storage. | `helpudoc` |
| `GEMINI_API_KEY` / `GOOGLE_CLOUD_API_KEY` | Credentials for the Gemini-powered agent service. | required for agent |

The frontend build accepts `FRONTEND_API_URL` (default `/api`) as a build argument. Override it with `FRONTEND_API_URL=... docker compose -f infra/docker-compose.yml build frontend` if you need a different API base URL.

## Local development workflow

You can iterate on each component separately while still using Docker for the shared dependencies.

See `docs/environment.md` for the full dev vs. production setup guide.

For roadmap details on the planned mobile companion app (React Native + Expo), see `docs/mobile-app-development-plan.md`.

1. **Spin up databases only**
   ```bash
   docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
   ```
2. **Backend API**
   ```bash
   cd backend
   npm install
   ENV_FILE=../env/local/dev.env npm run dev
   ```
   Configure values in `env/local/dev.env` (for example `POSTGRES_HOST=localhost`, `REDIS_URL=redis://localhost:6379`, `S3_ENDPOINT=http://localhost:9000`).
3. **Frontend**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Set `VITE_API_URL` (and `VITE_GOOGLE_CLIENT_ID`) in `env/local/dev.env` or your shell to point at your backend (for example `http://localhost:3000/api`).
4. **Agent service**
   ```bash
   cd agent
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
   ```
   Ensure `env/local/dev.env` has the required Gemini credentials before starting the service.

## Useful tips

- The backend automatically migrates/creates tables during startup.
- The agent service relies on MinIO/S3 to share generated artifacts with the frontend; keep services on the same network (Compose handles this automatically).
- When updating the frontend API base URL, rebuild the frontend image so the static files pick up the new value.
- Named Docker volumes (`postgres_data`, `redis_data`, `minio_data`) retain your workspaces and uploads between restarts. Remove them when you need a clean slate.
