# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

HelpUDoc is a multi-service workspace for AI-assisted document research and drafting. `AGENT.md` is the authoritative operator runbook (env files, testing sequence, deploy, PVC drift guard) — read it before any deploy or stack work. This file adds the architectural "why" behind the file map.

## Services and how they talk

Three independently-installed services plus shared TS packages. **There is no root `package.json`** — each service manages its own deps.

- **`frontend/`** — React + Vite SPA. Talks only to the backend. In dev, Vite proxies `/api` → `http://localhost:3000` (backend) and `/helpudoc` → MinIO. The frontend never calls the agent service directly.
- **`backend/`** — Express + TypeScript API (`:3000/api`) and the collaboration WebSocket server (`ws://localhost:1234`, Hocuspocus/Yjs). It owns all persistence (Postgres, Redis, object store) and is the **only** client of the agent service. Agent run orchestration + SSE stream state lives in `src/services/agentRunService.ts`; the HTTP transport to the agent is `src/services/agentService.ts`.
- **`agent/`** — FastAPI + DeepAgents runtime (`:8001`), Gemini-powered. Entry `main.py`; stream/orchestration in `helpudoc_agent/app.py`. Stateless w.r.t. app data — it reads the workspace filesystem and the `skills/` catalog, streams events back to the backend.

Request flow for an agent run: browser → backend `POST /api/agent/runs` → backend opens a stream to the agent → agent emits SSE events (`policy`, `interrupt`/`awaiting_approval`, `contract`, token deltas) → backend relays to the frontend, which renders HITL actions in `frontend/src/pages/WorkspacePage.tsx`. Human decisions post back via `POST /api/agent/runs/<id>/decision`.

### Shared TypeScript contracts
`packages/contracts/` (`@helpudoc/contracts`) is the single source of truth for API/stream types shared between frontend and backend, consumed **directly as `.ts` via tsconfig `paths`** (no build step — see `backend/tsconfig.json`). `packages/shared/` only re-exports from contracts + dashboard-runtime for back-compat. When changing agent stream event shapes, update contracts so both ends stay in sync.

## Skills, runtime config, and the PVC gotcha

- **`skills/`** (repo root) is the shared skill catalog (`research/`, `data/`, `pdf/`, `pptx/`, etc.). The agent loads and parses skill policy from `agent/helpudoc_agent/skills_registry.py`; the backend settings UI can **edit these files live**. Both backend and agent resolve `SKILLS_ROOT=skills` relative to repo root.
- **`agent/config/runtime.yaml`** is the runtime source of truth for model choice (Gemini), tool registry, `interrupt_on` HITL gates, and the code-interpreter (`ptc`) config. Plan-gate/HITL enforcement lives in `agent/helpudoc_agent/tools_and_schemas.py` and `plan_gates.py`.
- **Deployment gotcha:** in GKE, `skills/` and `runtime.yaml` are mounted from `skills-pvc` / `agent-config-pvc`. A deploy can succeed while runtime behavior stays stale because the PVC content didn't update. After any skill/HITL/runtime change, run the PVC drift guard in `AGENT.md §5` (greps `request_plan_approval` inside the running pod and asserts `/agents` exposes the tool).

## Commands

Env files (gitignored, hold secrets): `env/local/dev.env` for direct service runs, `env/local/stack.env` for Docker Compose. Bootstrap with `scripts/bootstrap_local_env.sh`. Compose only reads dev.env if you pass `--env-file env/local/dev.env`.

**Backend** (`cd backend`, Node 20+):
```bash
npm install
ENV_FILE=../env/local/dev.env npm run dev     # API + collab server
AUTH_MODE=headers ENV_FILE=../env/local/dev.env npm run dev   # local QA, no Google OIDC
npm test                                        # node --test over tests/*.test.ts
node -r ts-node/register/transpile-only -r tsconfig-paths/register --test tests/foo.test.ts  # single test
npm run validate:env
```

**Frontend** (`cd frontend`):
```bash
npm run dev                       # VITE_AUTH_MODE=headers to bypass Google sign-in
npm run build                     # tsc -b + vite build — use this as the typecheck gate
npm run lint                      # eslint, --max-warnings=0
npm run e2e                       # playwright (run e2e:install once)
```

**Agent** (`cd agent`, Python 3.10+):
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

**Python tests run from the repo root** (`conftest.py` puts `./` and `./agent` on `sys.path` — no install needed):
```bash
pytest                                          # full suite
python3 -m pytest -q tests/test_hitl_plan_approval_config.py   # single file
python3 -m pytest -q tests/test_hitl_plan_approval_config.py::test_name   # single test
```

**Full stack via Docker Compose** (from repo root):
```bash
docker compose --env-file env/local/dev.env -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d  # just Postgres/Redis/MinIO
```
Ports: frontend 5173, backend 3000, agent 8001, MCP sidecar 8000, MinIO 9000/9001.

Health checks: `curl http://localhost:3000/api/agent/personas` and `curl http://localhost:8001/agents`.

## Commits

- **Write the message in Simple Technical English.** Short sentences, active voice,
  present tense, one point per sentence. Prefer a plain word over a longer one. Avoid
  figurative language, idioms, and long clause chains. Name the identifiers you changed
  (`resolveWorkspaceToRestore`, `lastWorkspaceId`) instead of describing them.
- **Say why, not only what.** The diff already shows what changed. Record the reason a
  choice was made, and the alternative it rules out, so the next reader does not undo it.
- **No Claude attribution.** Do not add `Co-Authored-By: Claude`, a `Claude-Session:`
  link, or any similar trailer.
- **Stage files explicitly. Never `git add .` or `git add -A`.** The working tree holds
  untracked credentials and large artifacts — a service account key sat here once, and
  `backups/`, `skills-pvc-backup-*.tar.gz` and `trace-*.json` still do. Name each path.
  See `LEARNINGS.md` §9.
- **One commit per feature.** When a single file carries two features, split it by hunk
  (`git apply --cached` with a filtered patch) rather than merging the two. Confirm the
  intermediate commit still builds, or `git bisect` breaks on it.

## Gotchas

- **Writing arrays to Postgres `jsonb` columns.** The `pg` driver JSON-encodes plain **objects** automatically, but a raw JS **array** is coerced into a Postgres array literal (`{...}`) and rejected with `invalid input syntax for type json`. This has bitten the knowledge-ingestion persist path repeatedly (structure nodes, windows, concepts, embeddings, community/evidence/assertion/relationship arrays, and the `warnings` job column). **Convention:** for any `jsonb` value that can be an array, wrap it with `jsonbParam(db, value)` from `backend/src/lib/jsonb.ts` (null-aware, adds an explicit `::jsonb` cast), or `JSON.stringify(value)` as the shorthand inside a `batchInsert` row map. Object-valued `jsonb` (e.g. `metadata`, `locator`, `sourceRange`) can be passed raw. The array `jsonb` columns are declared with `table.jsonb(...)` in `backend/src/services/databaseService.ts`.

## Notes

- **Auth is hybrid.** `AUTH_MODE=headers` / `VITE_AUTH_MODE=headers` enable local dev without Google OIDC (backend trusts `x-user-id`); Google OAuth is used for delegated Google-backed tooling. Browser automation preloads a user in `localStorage` under `helpudoc-auth-user`.
- **`frontend/` uses the Astryx design system** — see `frontend/.claude/CLAUDE.md` for its component/token rules (no raw `<div>` layout, tokens not hex/px, `npx astryx` CLI to discover components). Follow it when writing frontend UI.
- Transient Gemini `500 Internal error` on agent runs is upstream availability, not necessarily a regression — retry before investigating.
- Deploy is via Cloud Build → GKE (`infra/cloudbuild.yaml`); verify with in-cluster `kubectl rollout status`. Details in `AGENT.md §5` and `docs/deploy.md`.
