# HelpUDoc

HelpUDoc is a research and proposal authoring workspace that combines:

- a TypeScript/Express **backend** that manages workspaces, sources, generated documents, and persistence (PostgreSQL, Redis, MinIO/S3)
- a React/Vite **frontend** that provides the collaborative UI, editors, and visualization tools
- a Python **agent service** that orchestrates Gemini-powered multi-agent workflows for research, data analysis, and proposal creation

The repository is structured so you can run the entire stack locally via Docker or develop each component independently with familiar tooling.

## Repository layout

| Path | Description |
| ---- | ----------- |
| `frontend/` | Vite + React client application, UI components, and build assets. |
| `backend/` | Express/TypeScript API, database migrations that auto-create tables, and workspace metadata. |
| `agent/` | FastAPI app exposing multi-agent endpoints plus Gemini configuration, prompts, and custom tools. |
| `docker-compose.yml` | Production-style stack that brings up the frontend, backend, agent, PostgreSQL, Redis, and MinIO. |
| `docker-compose.minio.yml` | Helper compose file for spinning up only the persistence dependencies (Postgres, Redis, MinIO). |
| `specs/` | Product and technical reference material that describes desired behaviors. |
| `tests/` | Placeholder for end-to-end or integration tests. |

Each runtime has its own README with component-specific notes; the sections below summarize the common tasks.

## Running with Docker Compose

1. **Prerequisites:** Docker Desktop 4.30+ (or Engine 26+) with Compose V2, and a Gemini API key (set `GEMINI_API_KEY` in your shell or `.env` file before launching the stack).
2. **Build and start:** from the repo root run:
   ```bash
   docker compose up --build
   ```
3. **Services:**
   - Frontend UI → http://localhost:8080
   - Backend API → http://localhost:3000/api
   - Agent service → http://localhost:8001
   - PostgreSQL (5432), Redis (6379), MinIO API (9000) and console (9001) are forwarded for convenience.
4. **Stopping:** `docker compose down` tears the stack down but keeps the named volumes (`postgres_data`, `redis_data`, `minio_data`). Use `docker compose down -v` if you also want to reset the data stores.

### Customizing environment variables

Compose reads standard variables from your shell, so you can override defaults safely:

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database credentials shared between Postgres and the backend. | `helpudoc` / `helpudoc` / `helpudoc` |
| `SESSION_SECRET`, `SESSION_NAME`, `SESSION_TTL_SECONDS` | Express session configuration. | `change-me`, `helpudoc.sid`, `604800` |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO admin credentials used by the backend and agent. | `minioadmin` / `minioadmin` |
| `S3_BUCKET_NAME` | Bucket created during startup for document storage. | `helpudoc` |
| `GEMINI_API_KEY` / `GOOGLE_CLOUD_API_KEY` | Credentials for the Gemini-powered agent service. | _required for agent_ |

The frontend build accepts `VITE_API_URL` as a build argument (default `http://backend:3000/api`). Adjust it by running `docker compose build --build-arg VITE_API_URL="..." frontend` if you need a different API base URL.

## Local development workflow

You can iterate on each component separately while still using Docker for the shared dependencies.

1. **Spin up databases only**
   ```bash
   docker compose -f docker-compose.minio.yml up -d
   ```
2. **Backend API**
   ```bash
   cd backend
   npm install
   npm run dev
   ```
   Environment defaults live in `backend/.env`. When running locally make sure `POSTGRES_HOST`, `REDIS_URL`, and `S3_ENDPOINT` reference the containers (`localhost` works when exposing ports as shown above).
3. **Frontend**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Set `VITE_API_URL` in `frontend/.env` or your shell to point at your backend (e.g., `http://localhost:3000/api`).
4. **Agent service**
   ```bash
   cd agent
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --host 0.0.0.0 --port 8001 --reload
   ```
   Copy `agent/config/agents.yaml` if you need environment-specific overrides and ensure `GEMINI_API_KEY` is exported in your shell.

## Useful tips

- The backend automatically migrates/creates tables during startup, so you don't need a separate migration command.
- The agent service relies on MinIO/S3 to share generated artifacts with the frontend; keep the services on the same network (Compose handles this automatically).
- When updating the frontend API base URL, rebuild the frontend image so the static files pick up the new value.
- Named Docker volumes (`postgres_data`, `redis_data`, `minio_data`) retain your workspaces and uploads between restarts. Remove them when you need a clean slate.

With these pieces in place you can demo the full HelpUDoc experience locally or adapt the Compose stack for staging/production deployments.
