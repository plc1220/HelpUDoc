# HelpUDoc

HelpUDoc is a multi-service workspace for research, drafting, and AI-assisted document workflows.
The repo currently combines:

- a React + Vite frontend for the workspace UI, file editing, agent chat, and settings
- an Express + TypeScript backend for auth, workspaces, files, knowledge, conversations, and admin APIs
- a FastAPI-based Python agent service for Gemini-powered runs, skills, RAG, and `paper2slides`
- shared infrastructure manifests for local Docker Compose and GKE deployment

## Repository layout

| Path | What lives here |
| ---- | --------------- |
| `frontend/` | Main web app, including workspace, chat, file rendering, paper-to-slides, and settings pages. |
| `backend/` | API server, persistence layer, auth/session handling, collaboration server, and admin endpoints. |
| `agent/` | FastAPI agent runtime, prompt catalog, RAG worker, and `paper2slides` pipeline. |
| `mobile/` | Expo-based mobile spike that currently proves shared-type reuse. |
| `packages/shared/` | Shared TypeScript exports used across apps. |
| `skills/` | Bundled skill prompts used by the agent runtime and editable through the settings flow. |
| `infra/` | Docker Compose files, Cloud Build configs, and Kubernetes manifests. |
| `env/` | Example environment files for local development and production deployment. |
| `docs/` | Architecture, environment, deployment, and planning docs. |
| `tests/` | Python regression and integration tests for the repo-level flows. |
| `scripts/` | Helper scripts for local agent startup and pipeline checks. |

## Quick start

### Full stack with Docker Compose

1. Copy the local stack env file:
   ```bash
   cp env/local/stack.env.example env/local/stack.env
   ```
2. Build and start everything from the repo root:
   ```bash
   docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build
   ```
3. Open the local services:
   - Frontend: `http://localhost:8080`
   - Backend API: `http://localhost:3000/api`
   - Agent service: `http://localhost:8001`
   - Google Workspace MCP sidecar: `http://localhost:8000`
   - MinIO API: `http://localhost:9000`
   - MinIO console: `http://localhost:9001`

To stop the stack:

```bash
docker compose -f infra/docker-compose.yml down
```

Add `-v` if you also want to remove the named Docker volumes.

## Local development

### 1. Prepare env files

```bash
cp env/local/dev.env.example env/local/dev.env
cp env/local/stack.env.example env/local/stack.env
```

### 2. Start shared dependencies only

```bash
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
```

This starts PostgreSQL, Redis, and MinIO with local on-disk data directories at the repo root (`.postgres-data/`, `.redis-data/`, `.minio-data/`).

### 3. Run each service

Backend:

```bash
cd backend
npm install
ENV_FILE=../env/local/dev.env npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Local QA without Google login:

```bash
# Backend: force local header auth instead of OIDC
cd backend
AUTH_MODE=headers ENV_FILE=../env/local/dev.env npm run dev

# Frontend: show the local app instead of the Google sign-in screen
cd frontend
VITE_AUTH_MODE=headers npm run dev
```

For browser automation, preload a local auth user in `localStorage` under
`helpudoc-auth-user`. The Playwright clarification test already does this.

Agent:

```bash
cd agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

Optional mobile app:

```bash
cd mobile
npm install
npm start
```

## Environment files

- `env/local/dev.env.example`: values for running backend and agent directly from your shell
- `env/local/stack.env.example`: values consumed by Docker Compose
- `env/prod/config.env.example`: non-secret production config for Kubernetes
- `env/prod/secrets.env.example`: production secrets template

See [docs/environment.md](docs/environment.md) for the full setup and auth notes.

## Testing and verification

Repo-level Python tests:

```bash
pytest
```

Frontend linting and browser checks:

```bash
cd frontend
npm run lint
npm run e2e
```

Targeted scripts:

- `scripts/test_paper2slides.sh`
- `backend/scripts/test_frontend_prompt_stream.mjs`
- `backend/scripts/test_rag_hybrid_flow.mjs`
- `backend/scripts/test_tagged_rag_query.mjs`
- `backend/scripts/test_upload_rag_flow.mjs`

## Key workflows in this repo

- Workspace creation, file CRUD, and live collaborative editing
- Agent chat with streaming updates, approvals, interrupt actions, and slash command metadata
- Knowledge source management tied to workspaces
- Paper-to-slides jobs with optional PPTX export
- Admin settings for agent config, bundled skills, GitHub skill imports, and skill-builder sessions
- Hybrid auth: local header-based development plus Google OAuth for delegated Google-backed tooling

## Docs worth reading next

- [docs/environment.md](docs/environment.md)
- [docs/deploy.md](docs/deploy.md)
- [docs/ci-cd.md](docs/ci-cd.md)
- [frontend/README.md](frontend/README.md)
- [backend/README.md](backend/README.md)
- [agent/README.md](agent/README.md)
- [infra/gke/README.md](infra/gke/README.md)
