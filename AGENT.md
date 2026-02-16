# HelpUDoc Agent Runbook

This document is the practical operator guide for local development, testing, and deployment of HelpUDoc.

## 1) Environment Files (Critical)

Use the correct env file for the correct runtime mode.

- `env/local/dev.env`
  - Purpose: local non-container runs (`backend`, `agent`, `frontend` in dev mode).
  - Status: gitignored, contains real secrets/keys.
  - Example source template: `env/local/dev.env.example`.
- `env/local/stack.env`
  - Purpose: Docker Compose stack wiring (`infra/docker-compose.yml`).
  - Status: usually non-secret defaults plus local overrides.
  - Example source template: `env/local/stack.env.example`.
- `env/prod/secrets.env` and `env/prod/config.env`
  - Purpose: Kubernetes Secret/ConfigMap inputs for GKE.
  - Source templates: `env/prod/secrets.env.example`, `env/prod/config.env.example`.

Important:
- If you want Compose to consume values from `env/local/dev.env`, you must pass `--env-file env/local/dev.env`.
- Without `--env-file`, Compose will not automatically read `env/local/dev.env`.

Recommended local stack command:

```bash
docker compose --env-file env/local/dev.env -f infra/docker-compose.yml up -d
```

## 2) Project Structure

Top-level folders and what they own:

- `frontend/`
  - React + Vite UI.
  - Main workspace UX: `frontend/src/pages/WorkspacePage.tsx`.
  - API clients: `frontend/src/services/*.ts`.
- `backend/`
  - Express API + persistence orchestration.
  - Agent API routes: `backend/src/api/agent.ts`.
  - Run orchestration and stream state: `backend/src/services/agentRunService.ts`.
  - Agent transport: `backend/src/services/agentService.ts`.
- `agent/`
  - FastAPI + DeepAgents runtime.
  - App entry: `agent/main.py`.
  - Runtime stream logic: `agent/helpudoc_agent/app.py`.
  - Skill loading and policy extraction: `agent/helpudoc_agent/skills_registry.py`.
  - Tool gating and HITL checks: `agent/helpudoc_agent/tools_and_schemas.py`.
  - Runtime config: `agent/config/runtime.yaml`.
- `infra/`
  - Local compose and GKE deployment assets.
  - Local stack: `infra/docker-compose.yml`.
  - Cloud Build pipeline: `infra/cloudbuild.yaml`.
  - K8s manifests: `infra/gke/k8s/`.
- `docs/`
  - Deployment guide: `docs/deploy.md`.
  - CI/CD guide: `docs/ci-cd.md`.

## 3) Feature Map

Primary app features and file references:

- Workspaces, files, and collaboration metadata
  - Backend routes: `backend/src/api/workspaces.ts`, `backend/src/api/files.ts`.
  - Frontend views: `frontend/src/pages/WorkspacePage.tsx`.
- Knowledge/RAG ingestion and query
  - Backend routes: `backend/src/api/knowledge.ts`.
  - Agent endpoints: `agent/helpudoc_agent/app.py`.
- Agent chat runs and streaming
  - Backend run APIs: `backend/src/api/agent.ts`.
  - Stream state: `backend/src/services/agentRunService.ts`.
  - Frontend stream handling: `frontend/src/services/agentApi.ts`.
- Skill-driven HITL + artifact contract
  - Skill policy parsing: `agent/helpudoc_agent/skills_registry.py`.
  - Plan-gate enforcement: `agent/helpudoc_agent/tools_and_schemas.py`.
  - Policy/interrupt/contract stream events: `agent/helpudoc_agent/app.py`.
  - HITL UI actions: `frontend/src/pages/WorkspacePage.tsx`.
- Settings and runtime config editing
  - Backend settings APIs: `backend/src/api/settings.ts`.
  - Agent runtime file: `agent/config/runtime.yaml` (or mounted `/agent/config/runtime.yaml` in GKE).

## 4) Testing Procedure

Run this sequence after changes.

### A. Bring stack up with env

```bash
docker compose --env-file env/local/dev.env -f infra/docker-compose.yml up -d --build
```

### B. Basic health checks

```bash
curl -sS http://localhost:3000/api/agent/personas
curl -sS http://localhost:8001/agents
docker compose -f infra/docker-compose.yml ps
```

### C. Targeted regression tests

```bash
python3 -m pytest -q tests/test_hitl_plan_approval_config.py
python3 -m pytest -q tests/test_agent_main.py
```

### D. Frontend type/build check

```bash
cd frontend && npm run build
```

### E. HITL + artifacts API smoke test

1. Create/find workspace:

```bash
curl -sS -H 'x-user-id: local-user' -H 'Content-Type: application/json' \
  -d '{"name":"hitl-test"}' \
  http://localhost:3000/api/workspaces
```

2. Start run:

```bash
curl -sS -H 'x-user-id: local-user' -H 'Content-Type: application/json' \
  -d '{"persona":"fast","prompt":"Use the research skill. Research recent Japan politics and explain normalization.","workspaceId":"<workspace-id>"}' \
  http://localhost:3000/api/agent/runs
```

3. Stream and verify events:
- expect `policy` event with research policy when research skill is selected
- expect `interrupt`/`awaiting_approval` before external research tools if HITL required

4. Submit decision:

```bash
curl -sS -H 'x-user-id: local-user' -H 'Content-Type: application/json' \
  -d '{"decision":"approve"}' \
  http://localhost:3000/api/agent/runs/<run-id>/decision
```

5. Verify artifacts in workspace:
- expected files include `/question.txt`, `/research_plan.md`, `/research_notes.md`, `/knowledge_graph.md`, `/synthesis.md`, and final report file.

Note:
- If Gemini upstream returns transient `500 Internal error encountered`, retry the run. That is an external model availability issue, not necessarily an app regression.

## 5) Deploy Procedure

### Local deploy (full stack on Docker)

```bash
docker compose --env-file env/local/stack.env -f infra/docker-compose.yml up -d --build
```

### GKE deploy with Cloud Build (recommended)

Use `infra/cloudbuild.yaml` as the source of truth.

```bash
export PROJECT_ID=<gcp-project>
export GKE_LOCATION=<zone-or-region>
export CLUSTER=<cluster-name>

gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config=infra/cloudbuild.yaml \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=false
```

Post-deploy verification:

```bash
kubectl -n helpudoc get deploy helpudoc-app helpudoc-frontend -o wide
kubectl -n helpudoc rollout status deployment/helpudoc-app
kubectl -n helpudoc rollout status deployment/helpudoc-frontend
```

Rollback:

```bash
kubectl -n helpudoc rollout undo deployment/helpudoc-app
kubectl -n helpudoc rollout undo deployment/helpudoc-frontend
```

## 6) CI/CD Skill Reference

When working on deployment, rollout failures, image update issues, or settings/skills page failures in GKE, follow:

- Skill doc: `/Users/cmtest/.codex/skills/helpudoc-ci-cd/SKILL.md`
- Related repo docs: `docs/deploy.md`, `docs/ci-cd.md`

This skill reflects the current operational expectation:
- deploy via Cloud Build
- verify rollout in-cluster
- treat running image tags and PVC mounts as first-class debugging signals.
