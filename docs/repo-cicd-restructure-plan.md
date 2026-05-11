# HelpUDoc CI/CD and Repository Restructure Plan

Generated: 2026-05-10

**Merged in PR #59 (`ci-cicd-pr1-3`):** PR 1–3 items below are implemented on `master` (workflows, Dockerfiles, `50-app.yaml`, health routes, docs). One PR 3 checklist item remains intentionally deferred: exposing image-vs-PVC revision in the settings UI. Until then, revision marker files and `kubectl` inspection are documented in `docs/deploy.md`.

## Executive View

The CI/CD work and the repository cleanup should be treated as one program, but not one giant refactor. The fastest path is:

1. Make deploys cheaper and more predictable with Buildx cache, component toggles, and an infra toggle.
2. Create clear runtime ownership boundaries before moving code: web backend, agent API, document parsing, report/dashboard rendering, shared contracts, and infrastructure.
3. Refactor high-gravity files behind compatibility shims so tests and deploys keep working while names and directories improve.
4. Split the agent image only after dependency ownership is visible in code and requirements files.

My opinion: start with the CI/CD quick wins and env/config consolidation, then do code movement in thin slices. The repo has several big files that are doing real product work, so a rename-only cleanup would feel satisfying for a day and painful for a month. The best cleanup is boundary-first: make each service and feature own a small, obvious set of files.

## Current Evidence

From `graphify-out/GRAPH_REPORT.md`, the core graph "god nodes" are:

| Node | Source file | Meaning for restructure |
| --- | --- | --- |
| `WorkspaceState` | `agent/helpudoc_agent/state.py` | Agent runtime state is a central boundary and should stay stable during moves. |
| `SourceTracker` | `agent/helpudoc_agent/utils.py` | Citation/source tracking is shared agent infrastructure, not a random util. |
| `Settings`, `ToolConfig` | `agent/helpudoc_agent/configuration.py` | Runtime config is too central to leave as one mixed loader/model/env module. |
| `WorkspaceRagStore`, `RagConfig` | `agent/helpudoc_agent/rag_indexer.py` | RAG indexing is a service boundary and likely future worker image. |
| `DoclingParser` | `agent/paper2slides/raganything/parser.py` | Heavy parser code is shared by RAG and Paper2Slides, so it should not live under a Paper2Slides-only name. |
| `SkillPolicy` | `agent/helpudoc_agent/skills_registry.py` | Skills are platform config/runtime policy, not only prompt assets. |
| `DuckDBManager` | `agent/helpudoc_agent/data_agent_tools.py` | Data/dashboard tooling is a feature package and should be broken out. |
| `ToolFactory` | `agent/helpudoc_agent/tools_and_schemas.py` | Tool registration is central and should be modularized before adding more tools. |

Large files worth splitting:

| File | Approx lines | Current concern |
| --- | ---: | --- |
| `frontend/src/pages/WorkspacePage.tsx` | 7117 | Many unrelated workflows in one route component. |
| `agent/helpudoc_agent/app.py` | 3010 | FastAPI routes, schemas, lifecycle, RAG, Paper2Slides, streaming, and auth in one file. |
| `agent/helpudoc_agent/data_agent_tools.py` | 2852 | DuckDB, state, charts, dashboards, report generation, and tool factory together. |
| `frontend/src/components/chat/ChatMessageBubble.tsx` | 1968 | Message rendering, tool rendering, markdown, interrupts, and artifact previews together. |
| `agent/helpudoc_agent/tools_and_schemas.py` | 1849 | Tool registry plus many concrete tool implementations. |
| `backend/src/api/agent.ts` | 1384 | Agent run routes, slash metadata, Paper2Slides, policy, streaming, and proxy concerns together. |
| `backend/src/api/settings.ts` | 1266 | Runtime config, skills CRUD, skill builder, GitHub import, and admin settings together. |
| `backend/src/services/agentRunService.ts` | 1162 | Stream persistence, run lifecycle, resume, interrupts, cancellation, and telemetry together. |

Local workspace size is also noisy even though these files are ignored by git:

| Path | Size observed | Action |
| --- | ---: | --- |
| `.venv` | 2.4G | Keep ignored; add cleanup script and developer note. |
| `agent/.venv` | 2.7G | Keep ignored; prefer one documented Python env. |
| `frontend/node_modules` | 1.6G | Keep ignored; no action beyond docs. |
| `backend/workspaces` | 225M | Keep ignored; document runtime data location. |
| `.redis-data`, `.minio-data`, `.postgres-data` | 359M combined | Keep ignored; cleanup helper. |
| `agent/outputs` | 86M | Keep ignored; should move under runtime workspace/cache in future. |

## Target Boundaries

### Target Repository Shape

```text
.github/
  actions/
    gcp-auth/
    docker-buildx/
  workflows/
    ci.yml
    build-images.yml
    deploy-gke.yml
    infra-gke.yml
    deploy-langfuse-gke.yml

agent/
  Dockerfile.gke
  Dockerfile.base
  requirements-api.txt
  requirements-parser.txt
  requirements-reporting.txt
  requirements-runtime.txt
  requirements.txt
  helpudoc_agent/
    api/
    config/
    runtime/
    rag/
    skills/
    tools/
    integrations/
  document_intelligence/
    docling/
    raganything/
  presentation_pipeline/
    ...

backend/
  src/
    api/
      agent/
      settings/
    config/
    services/
      agent-runs/
      paper2slides/
      skills/
      workspaces/
    integrations/

frontend/
  src/
    features/
      workspace/
      chat/
      paper2slides/
      dashboard/
      settings/
    shared/
    services/

packages/
  contracts/
  dashboard-runtime/

infra/
  gke/
  env/
  scripts/

scripts/
  clean-runtime-artifacts.sh
  validate-env.*
```

### Naming Decisions

| Current name | Target name | Why |
| --- | --- | --- |
| `agent/helpudoc_agent/graph.py` | `agent/helpudoc_agent/runtime/agent_registry.py` | The file no longer describes a LangGraph graph. It builds/caches DeepAgents/LangChain agents. |
| `agent/paper2slides/` | `agent/presentation_pipeline/` | The feature now supports more than papers and may generate slides/posters from general docs. |
| `agent/paper2slides/raganything/` | `agent/document_intelligence/raganything/` | Doc parsing is used by RAG and attachment understanding, not only Paper2Slides. |
| `packages/shared` | `packages/contracts` plus `packages/dashboard-runtime` | Current package mixes API contracts, stream helpers, and dashboard runtime logic. |
| `backend/src/api/settings.ts` | `backend/src/api/settings/*` | One file owns too many admin surfaces. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/workspace/WorkspacePage.tsx` plus hooks/components | The route is a coordinator, not the owner of every workspace workflow. |

## Phase 0 - Prep and Guardrails

Goal: make later refactors safe and reversible.

| File | Change |
| --- | --- |
| `docs/repo-cicd-restructure-plan.md` | Keep this plan as the tracking document. |
| `docs/current-architecture.md` | Update after code movement, especially Langfuse status and any new worker boundaries. |
| `docs/ci-cd.md` | Update after workflow changes. |
| `docs/deploy.md` | Update after deploy mode split and skills/config init-container change. |
| `AGENTS.md` | Keep graphify rule. After code edits, run `graphify update .`. |
| `.gitignore` | Already ignores runtime data; add comments grouping local runtime dirs if desired. |
| `.dockerignore` | Already excludes major runtime dirs; add `backend/workspaces`, `agent/outputs`, and `graphify-out` if not already covered. |
| `scripts/clean-runtime-artifacts.sh` | New optional script to remove ignored local data: `.local-run`, `.pytest_cache`, Python caches, `agent/outputs`, `backend/workspaces`, local Docker volume dirs. Must print paths and require an explicit `--yes`. |

Validation:

- `git status --short` before each refactor.
- No source movement without tests or import shims.
- After code-file changes, run `graphify update .`.

## Phase 1 - CI/CD Quick Wins

Goal: fast deploys without changing application architecture.

### Workflow Files

| File | Action |
| --- | --- |
| `.github/workflows/deploy-gke.yml` | Add `workflow_dispatch` inputs: `build_backend`, `build_frontend`, `build_agent`, `deploy_infra`, `sync_runtime_assets`, `image_tag_suffix`, and optional `environment`. Default app deploy should build selected components, set images, wait rollout, and run smoke tests. |
| `.github/workflows/deploy-gke.yml` | Replace `docker build` and `docker push` with `docker buildx build --cache-from type=registry --cache-to type=registry,mode=max --push`. |
| `.github/workflows/deploy-gke.yml` | Gate RBAC checks, manifest apply, ConfigMap bootstrap, Langfuse secret bootstrap, and Langfuse DB bootstrap behind `inputs.deploy_infra == true`. |
| `.github/workflows/deploy-gke.yml` | Gate skills/config sync behind `inputs.sync_runtime_assets == true` as a legacy bridge. Keep it default-off; use init-container seeding for normal deploys. |
| `.github/workflows/deploy-agent-gke.yml` | Convert to a thin wrapper around the reusable build/deploy job, or delete after `deploy-gke.yml` supports component toggles. Keep only if operators strongly prefer one-click component workflows. |
| `.github/workflows/deploy-backend-gke.yml` | Same as above. |
| `.github/workflows/deploy-frontend-gke.yml` | Same as above. |
| `.github/workflows/deploy-langfuse-gke.yml` | Keep as infra workflow, but share auth setup with the new composite action. |
| `.github/workflows/ci.yml` | New PR workflow: backend tests, frontend lint/build, Python tests/smoke imports, no push. |
| `.github/workflows/build-images.yml` | New reusable workflow for selected image builds. Inputs: component list, tag, push true/false, registry host, cache namespace. |
| `.github/workflows/infra-gke.yml` | New manual workflow for manifest diff/apply/bootstrap only. It should support `kubectl diff` before apply. |
| `.github/workflows/secret-scan.yml` | Keep. Optionally make it part of required PR CI. |
| `.github/actions/gcp-auth/action.yml` | New composite action to remove repeated WIF/JSON auth logic from all workflows. |
| `.github/actions/docker-buildx/action.yml` | Optional composite action for registry auth plus common buildx flags. |

### Dockerfiles and Requirements

| File | Action |
| --- | --- |
| `agent/Dockerfile.gke` | Add `# syntax=docker/dockerfile:1.7` and use `RUN --mount=type=cache,target=/root/.cache/pip pip install ...`. |
| `agent/Dockerfile.gke` | Stop using `--no-cache-dir` for BuildKit cache layers. The pip cache is mounted, not baked into the final layer. |
| `agent/Dockerfile` | Apply the same BuildKit pip cache pattern for local image parity. |
| `backend/Dockerfile.gke` | Add npm cache mount for `npm ci`. Consider compiling TypeScript to `dist` instead of running production with `ts-node`. |
| `frontend/Dockerfile.gke` | Already uses npm cache. Keep and make sure Buildx registry cache covers this image. |
| `agent/scripts/smoke_import.py` | Keep as agent image smoke test. Add imports for the parser-worker split only after that split exists. |
| `tests/test_agent_import_smoke.py` | Keep. This is the repo-level guard that the agent runtime can import. |

### Deployment Smoke Tests

| File | Action |
| --- | --- |
| `.github/workflows/deploy-gke.yml` | Add post-rollout smoke checks: backend `/api/health` or equivalent, frontend HTTP GET, agent `/health`, and optional OAuth config sanity. |
| `backend/src/api/routes.ts` | Add or expose a simple health route if one does not already exist. |
| `agent/helpudoc_agent/app.py` | Keep or add `/health` and parser dependency diagnostics. Move later to `agent/helpudoc_agent/api/routes/health.py`. |
| `frontend/nginx.conf` | Ensure frontend health can be checked by fetching `/` or `/index.html`. |

## Phase 2 - Infra Mode Split and Runtime Asset Seeding

Goal: normal deploys mutate only image tags; infra/bootstrap runs only when requested.

| File | Action |
| --- | --- |
| `infra/gke/k8s/50-app.yaml` | Add init containers to seed `/app/skills` and `/agent/config` from image-bundled source paths. |
| `infra/gke/k8s/50-app.yaml` | Add source paths in images, for example `/app/skills-source` and `/app/agent-config-source`, so PVC mounts do not hide the source copy. |
| `infra/gke/k8s/50-app.yaml` | Patch init-container images in deploy workflow alongside backend/agent images. |
| `agent/Dockerfile.gke` | Copy `skills/` to `/app/skills-source` instead of only `/app/skills`. Copy `agent/config/runtime.yaml` to `/app/agent-config-source/runtime.yaml`. |
| `backend/Dockerfile.gke` | If backend remains the settings owner for skills, also copy `skills/` to a source path or rely on the agent init container. Choose one owner. |
| `.github/workflows/deploy-gke.yml` | Keep legacy `kubectl exec` skills/config sync default-off behind `inputs.sync_runtime_assets`; remove later only if operators no longer need the emergency bridge. |
| `infra/gke/k8s/30-storage.yaml` | Keep `skills-pvc` and `agent-config-pvc` only if admin UI needs runtime edits. If config becomes ConfigMap-backed, remove or deprecate `agent-config-pvc` later. |
| `backend/src/api/settings.ts` | During transition, settings page writes to PVC-backed paths as today. Add a visible version/source field later so operators know when PVC content diverges from image source. |
| `docs/deploy.md` | Document normal deploy versus infra/bootstrap deploy. |
| `docs/ci-cd.md` | Document component toggles and when to use `deploy_infra`. |

Important decision:

- If skills are product code, image-bundle them and use init-container copy.
- If skills are admin-editable runtime content, keep the PVC as the live layer and record the image source version. Do not use `kubectl exec` sync for normal deploys; keep it only as an explicit legacy bridge while operators still need it.

## Phase 3 - Environment and Config Unification

Goal: one canonical env inventory, typed loaders per runtime, and fewer duplicated variable defaults.

### New Shared Env Inventory

| File | Action |
| --- | --- |
| `infra/env/helpudoc.env.schema.yaml` | New canonical env catalog. For each var: owner service, type, default, secret/non-secret, local/prod required, docs, and deprecated aliases. |
| `scripts/validate-env.ts` | New validator for backend/frontend/prod env files. |
| `agent/helpudoc_agent/config/env.py` | New Pydantic env loader for agent-owned variables. |
| `backend/src/config/env.ts` | New Zod env loader for backend-owned variables. |
| `frontend/src/config/env.ts` | New typed Vite env adapter for `VITE_*` vars. |

### Existing Env Files

| File | Action |
| --- | --- |
| `env/local/dev.env.example` | Align names with schema. Prefer one model name set. Add comments for parser/RAG variables. |
| `env/local/stack.env.example` | Align with schema and remove drift from `dev.env.example`. |
| `env/local/paper2slides.env.example` | Either merge into `dev.env.example` under a Paper2Slides section or keep as feature overlay with schema validation. |
| `env/prod/config.env.example` | Generate or verify from schema. Keep only non-secret config. |
| `env/prod/secrets.env.example` | Generate or verify from schema. Keep only secrets. |
| `infra/gke/templates/20-configmap.yaml` | Align with schema names and defaults. |
| `infra/gke/templates/10-secrets.yaml` | Align with schema names. |
| `infra/gke/bootstrap/20-configmap.demo.yaml` | Keep as demo bootstrap, but make it obviously non-production. |
| `agent/config/runtime.yaml` | Move model/tool/MCP config out of ad hoc env duplication. Keep `${...}` references, but document every env var in schema. |

### Code Files to Change

| File | Action |
| --- | --- |
| `backend/src/index.ts` | Replace direct `process.env` session parsing with `backend/src/config/env.ts`. |
| `backend/src/config/workspaceRoot.ts` | Keep path diagnostics, but use env loader as input. |
| `backend/src/services/databaseService.ts` | Read typed DB config from env module. |
| `backend/src/services/s3Service.ts` | Read typed S3 config from env module. |
| `backend/src/services/googleOAuthService.ts` | Read typed OAuth config from env module. |
| `backend/src/services/langfuseClient.ts` | Read typed Langfuse config from env module. |
| `backend/src/api/agent.ts` | Replace duplicated path/env helpers with config modules. |
| `backend/src/api/settings.ts` | Replace duplicated path/env helpers with config modules. |
| `agent/helpudoc_agent/configuration.py` | Split settings models from env override logic. |
| `agent/helpudoc_agent/rag_indexer.py` | Move `RagConfig.from_env` into `agent/helpudoc_agent/rag/config.py`. |
| `agent/helpudoc_agent/rag_worker.py` | Move queue env parsing into `agent/helpudoc_agent/rag/config.py`. |
| `agent/helpudoc_agent/langfuse_callbacks.py` | Use agent env loader. |
| `agent/helpudoc_agent/sandbox_runner.py` | Use agent env loader for sandbox settings. |
| `agent/paper2slides/rag/config.py` | Use shared agent env helpers or the presentation pipeline config module. |
| `agent/paper2slides/generator/content_planner.py` | Use presentation config object rather than repeated `os.getenv`. |
| `agent/paper2slides/generator/image_generator.py` | Same. |
| `agent/paper2slides/core/stages/*.py` | Same. |

## Phase 4 - Agent Runtime Refactor

Goal: split the agent service by responsibility while keeping imports stable.

### Runtime and Config

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/graph.py` | `agent/helpudoc_agent/runtime/agent_registry.py` | Move `AgentRegistry`, `_clone_preservable_context`, model selection, tool binding, and middleware construction. |
| `agent/helpudoc_agent/graph.py` | Compatibility shim | Re-export `AgentRegistry` for one or two releases so tests and imports do not break immediately. |
| `agent/helpudoc_agent/configuration.py` | `agent/helpudoc_agent/config/models.py` | Move `ModelConfig`, `BackendConfig`, `MCPServerConfig`, `ToolConfig`, `Settings`. |
| `agent/helpudoc_agent/configuration.py` | `agent/helpudoc_agent/config/loader.py` | Move YAML loading, merge logic, env expansion, and `load_settings`. |
| `agent/helpudoc_agent/configuration.py` | `agent/helpudoc_agent/config/paths.py` | Move `PACKAGE_ROOT`, `AGENT_ROOT`, `REPO_ROOT`, default paths, workspace diagnostics. |
| `agent/helpudoc_agent/state.py` | `agent/helpudoc_agent/runtime/state.py` | Move when stable; keep shim at old path. |
| `agent/helpudoc_agent/memory_store.py` | `agent/helpudoc_agent/runtime/memory_store.py` | Move with registry because it is runtime persistence. |

### FastAPI Surface

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/app.py` | Keep `create_app` only: load settings, register routes, lifecycle. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/schemas.py` | Move Pydantic request/response classes. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/lifecycle.py` | Move startup dependency diagnostics, registry construction, RAG worker start/stop. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/routes/chat.py` | Move chat, resume, interrupt, and streaming routes. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/routes/rag.py` | Move RAG query/status routes and tagged RAG context helpers. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/routes/paper2slides.py` | Move Paper2Slides run/export routes. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/routes/attachments.py` | Move attachment understanding routes. |
| `agent/helpudoc_agent/app.py` | `agent/helpudoc_agent/api/routes/health.py` | Move health/diagnostics route. |
| `agent/main.py` | `agent/helpudoc_agent/api/app.py` import | Keep `main.py` as the uvicorn entrypoint, but import from the new app module. |

### Tools

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/tools_and_schemas.py` | `agent/helpudoc_agent/tools/factory.py` | Move `ToolFactory`. |
| `agent/helpudoc_agent/tools_and_schemas.py` | `agent/helpudoc_agent/tools/gemini.py` | Move `GeminiClientManager` and Gemini-native tools. |
| `agent/helpudoc_agent/tools_and_schemas.py` | `agent/helpudoc_agent/tools/web_sources.py` | Move `StructuredWebSource`, `StructuredWebAnswer`, source formatting. |
| `agent/helpudoc_agent/tools_and_schemas.py` | `agent/helpudoc_agent/tools/builtins/*.py` | Split built-in tools: skills, RAG, image URL, BigQuery export, PDF/image, report append. |
| `agent/helpudoc_agent/tools_and_schemas.py` | Compatibility shim | Re-export old names until tests and imports are migrated. |
| `agent/helpudoc_agent/tool_guard.py` | `agent/helpudoc_agent/tools/guard.py` | Move after factory split. |
| `agent/helpudoc_agent/bigquery_export_tools.py` | `agent/helpudoc_agent/tools/bigquery_export.py` | Move to tools package. |

### Skills

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/skills_registry.py` | `agent/helpudoc_agent/skills/registry.py` | Move discovery/loading. |
| `agent/helpudoc_agent/skills_registry.py` | `agent/helpudoc_agent/skills/policy.py` | Move `SkillPolicy` and policy helpers. |
| `agent/helpudoc_agent/skills_registry.py` | Compatibility shim | Keep old import path during migration. |
| `skills/**/SKILL.md` | No move in phase 4 | Keep skill content stable until runtime code is moved. |

### RAG and Document Understanding

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/rag_indexer.py` | `agent/helpudoc_agent/rag/store.py` | Move `WorkspaceRagStore`. |
| `agent/helpudoc_agent/rag_indexer.py` | `agent/helpudoc_agent/rag/config.py` | Move `RagConfig`, LightRAG env defaults, queue config. |
| `agent/helpudoc_agent/rag_indexer.py` | `agent/helpudoc_agent/rag/ingestion.py` | Move file ingestion, delete, safe path handling. |
| `agent/helpudoc_agent/rag_worker.py` | `agent/helpudoc_agent/rag/worker.py` | Move worker loop. |
| `agent/helpudoc_agent/rag_indexer.py` | Compatibility shim | Keep old import path. |
| `agent/helpudoc_agent/rag_worker.py` | Compatibility shim | Keep old import path. |

### Tests to Update

| File | Action |
| --- | --- |
| `tests/test_agent_main.py` | Update stubs from `helpudoc_agent.graph` to runtime module, then keep a small shim test. |
| `tests/test_mcp_binding.py` | Update monkeypatch paths to runtime/tool modules. |
| `tests/test_tool_factory.py` | Update imports to `helpudoc_agent.tools.factory`. |
| `tests/test_agent_configuration.py` | Update imports to config package. |
| `tests/test_mcp_configuration.py` | Update imports to config models/loader. |
| `tests/test_paper2slides_cache.py` | Leave until presentation package move. |

## Phase 5 - Data Tools and Dashboard Runtime

Goal: make the data/dashboard feature understandable and reduce duplicated JS/Python dashboard logic.

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/state.py` | Move `DataAgentSessionState`, query/chart/materialization records. |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/duckdb_manager.py` | Move `DuckDBManager` and workspace file registration. |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/query_tools.py` | Move schema/query/materialization callable tools. |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/chart_tools.py` | Move chart config generation and chart output handling. |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/dashboard_tools.py` | Move dashboard package generation. |
| `agent/helpudoc_agent/data_agent_tools.py` | `agent/helpudoc_agent/tools/data/factory.py` | Move `build_data_agent_tools`. |
| `agent/helpudoc_agent/data_report_renderers.py` | `agent/helpudoc_agent/tools/data/renderers/html_summary.py` | Move summary renderer. |
| `agent/helpudoc_agent/data_report_renderers.py` | `agent/helpudoc_agent/tools/data/renderers/dashboard_snapshot.py` | Move dashboard HTML snapshot renderer. |
| `packages/shared/src/dashboard/*` | `packages/dashboard-runtime/src/*` | Move frontend dashboard runtime helpers to a dedicated package. |
| `frontend/src/components/dashboard/DashboardCanvas.tsx` | Update imports | Import from `@helpudoc/dashboard-runtime`. |
| `frontend/src/components/dashboard/DashboardFilters.tsx` | Update imports | Import from `@helpudoc/dashboard-runtime`. |
| `agent/helpudoc_agent/data_report_renderers.py` | Future optional | Generate dashboard snapshot from the same spec contract as `packages/dashboard-runtime`; do not duplicate business semantics in two places. |
| `tests/test_data_skill_family.py` | Update imports and add tests for data tool package boundaries. |
| `agent/tests/test_data_agent_tools.py` | Split tests by query/chart/dashboard modules. |

## Phase 6 - Shared Packages

Goal: make shared TypeScript code a real package boundary.

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `packages/shared/package.json` | `packages/contracts/package.json` | Rename package to `@helpudoc/contracts`. Export types and stream client. |
| `packages/shared/src/types.ts` | `packages/contracts/src/types.ts` | Move app contracts. Consider splitting into `workspace.ts`, `conversation.ts`, `agent.ts`, `skills.ts`, `memory.ts`, `dashboard.ts`. |
| `packages/shared/src/services/agentStream.ts` | `packages/contracts/src/agentStream.ts` | Move stream chunk types and reconnect helper. |
| `packages/shared/src/dashboard/*` | `packages/dashboard-runtime/src/*` | Move dashboard-only runtime code. |
| `frontend/package.json` | Update dependencies | Replace `@helpudoc/shared` with `@helpudoc/contracts` and `@helpudoc/dashboard-runtime`. |
| `backend/package.json` | Add dependency | Add `@helpudoc/contracts` via file dependency or npm workspace. |
| `frontend/src/types.ts` | Update export | Re-export from `@helpudoc/contracts/types`, not relative `../../packages/shared`. |
| `frontend/src/services/agentApi.ts` | Update import | Import stream helper from `@helpudoc/contracts/agentStream`. |
| `frontend/src/services/settingsApi.ts` | Update import | Import `AgentStreamChunk` from package export. |
| `backend/src/services/*.ts` | Update imports | Replace `../../../packages/shared/src/types` with `@helpudoc/contracts/types`. |
| Root `package.json` | New optional | Add npm workspaces for `frontend`, `backend`, `packages/*` to make local package use less brittle. |
| Root `package-lock.json` | New optional | Only if npm workspaces are adopted. |
| `backend/tsconfig.json` | Update paths | Add package path aliases or rely on workspace install. |
| `frontend/tsconfig.app.json` | Update include | Ensure package types are resolved through dependencies, not source-relative imports. |
| `frontend/vite.config.ts` | Update optimize/deps if needed | Ensure linked packages compile cleanly. |

## Phase 7 - Backend Structure

Goal: make backend routes and services navigable.

### Agent API

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `backend/src/api/agent.ts` | `backend/src/api/agent/index.ts` | Route composition only. |
| `backend/src/api/agent.ts` | `backend/src/api/agent/runs.ts` | Start/resume/cancel/status/stream endpoints. |
| `backend/src/api/agent.ts` | `backend/src/api/agent/slash.ts` | Slash metadata and skill policy endpoints. |
| `backend/src/api/agent.ts` | `backend/src/api/agent/paper2slides.ts` | Paper2Slides job/export endpoints. |
| `backend/src/api/agent.ts` | `backend/src/api/agent/attachments.ts` | Current-turn multimodal and attachment understanding proxy helpers if they remain in agent routes. |
| `backend/src/api/agent.ts` | `backend/src/api/agent/policy.ts` | Effective agent policy, MCP delegated auth policy helpers. |
| `backend/src/api/routes.ts` | Update imports | Import `agentRoutes` from `backend/src/api/agent`. |

### Settings API

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `backend/src/api/settings.ts` | `backend/src/api/settings/index.ts` | Route composition only. |
| `backend/src/api/settings.ts` | `backend/src/api/settings/agentConfig.ts` | Runtime YAML read/write/merge. |
| `backend/src/api/settings.ts` | `backend/src/api/settings/skills.ts` | Skills CRUD and file content operations. |
| `backend/src/api/settings.ts` | `backend/src/api/settings/skillBuilder.ts` | Skill builder run/session/context endpoints. |
| `backend/src/api/settings.ts` | `backend/src/api/settings/githubImport.ts` | GitHub skill import inspect/apply. |
| `backend/src/api/settings.ts` | `backend/src/services/skills/skillPaths.ts` | Path resolution and allowed-prefix rules. |
| `backend/src/api/settings.ts` | `backend/src/services/skills/frontmatter.ts` | Frontmatter parse/format helpers. |
| `backend/src/api/routes.ts` | Update imports | Import settings router directory. |

### Agent Run Service

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `backend/src/services/agentRunService.ts` | `backend/src/services/agent-runs/types.ts` | Run status, context, metadata, interrupt types. |
| `backend/src/services/agentRunService.ts` | `backend/src/services/agent-runs/store.ts` | Redis stream/meta persistence. |
| `backend/src/services/agentRunService.ts` | `backend/src/services/agent-runs/interrupts.ts` | Interrupt parsing, signatures, resume payload normalization. |
| `backend/src/services/agentRunService.ts` | `backend/src/services/agent-runs/lifecycle.ts` | Start/resume/cancel orchestration. |
| `backend/src/services/agentRunService.ts` | Compatibility barrel | Re-export public functions used by API tests during migration. |
| `backend/tests/agentRunService.test.ts` | Update imports incrementally. |
| `backend/tests/runTelemetryService.test.ts` | Keep stable unless service API changes. |

### Other Backend Cleanups

| File | Action |
| --- | --- |
| `backend/src/services/paper2SlidesService.ts` | Move to `backend/src/services/paper2slides/service.ts`. |
| `backend/src/services/paper2SlidesJobService.ts` | Move to `backend/src/services/paper2slides/jobService.ts`. |
| `backend/src/types/paper2slides.ts` | Move to shared contracts if frontend and backend both need the exact same shape. |
| `backend/src/services/googleDriveService.ts` | Consider `backend/src/integrations/google/driveService.ts`. |
| `backend/src/services/googleOAuthService.ts` | Consider `backend/src/integrations/google/oauthService.ts`. |
| `backend/src/services/langfuseClient.ts` | Consider `backend/src/integrations/langfuse/client.ts`. |
| `backend/src/lib/skillsRegistry.ts` | Move under `backend/src/services/skills/registry.ts`. |

## Phase 8 - Frontend Structure

Goal: make product workflows feature-owned and shrink route components.

### Workspace Page

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/workspace/WorkspacePage.tsx` | Route-level coordinator only. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/workspace/hooks/useWorkspaceSelection.ts` | Workspace list/create/delete/rename/current selection. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/workspace/hooks/useWorkspaceFiles.ts` | File tree, file actions, content loading, RAG status. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/chat/hooks/useAgentRun.ts` | Run start/resume/cancel/status/stream reconnect. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/chat/hooks/useConversationState.ts` | Conversation load/append/truncate/history state. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/paper2slides/hooks/usePaper2SlidesJob.ts` | Paper2Slides options, job start, polling, export. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/dashboard/hooks/useDashboardArtifacts.ts` | Dashboard manifest/path resolution and artifact state. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/workspace/utils/workspacePaths.ts` | `normalizeWorkspaceRelativePath`, dashboard path helpers. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/features/paper2slides/components/PresentationModal.tsx` | Move bottom modal currently in same file. |
| `frontend/src/pages/WorkspacePage.tsx` | `frontend/src/pages/WorkspacePage.tsx` | Keep as a thin re-export initially to avoid route churn. |

### Chat

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `frontend/src/components/chat/ChatMessageBubble.tsx` | `frontend/src/features/chat/components/ChatMessageBubble.tsx` | Keep shell. |
| `frontend/src/components/chat/ChatMessageBubble.tsx` | `frontend/src/features/chat/components/ToolEventList.tsx` | Move tool rendering. |
| `frontend/src/components/chat/ChatMessageBubble.tsx` | `frontend/src/features/chat/components/InterruptCard.tsx` | Move approval/clarification UI. |
| `frontend/src/components/chat/ChatMessageBubble.tsx` | `frontend/src/features/chat/components/ArtifactPreview.tsx` | Move file/dashboard/presentation previews. |
| `frontend/src/components/chat/approvalReview.ts` | `frontend/src/features/chat/interrupts/approvalReview.ts` | Move with interrupt code. |
| `frontend/src/components/chat/interruptActions.ts` | `frontend/src/features/chat/interrupts/actions.ts` | Move with interrupt code. |
| `frontend/src/components/chat/chatTypes.ts` | `frontend/src/features/chat/types.ts` | Move after shared contract cleanup. |

### Files, Dashboard, Settings

| Current file | Target file(s) | Action |
| --- | --- | --- |
| `frontend/src/components/FileRenderer.tsx` | `frontend/src/features/files/FileRenderer.tsx` | Keep shell. |
| `frontend/src/components/FileRenderer.tsx` | `frontend/src/features/files/renderers/MarkdownRenderer.tsx` | Move markdown renderer. |
| `frontend/src/components/FileRenderer.tsx` | `frontend/src/features/files/renderers/OfficeRenderer.tsx` | Move docx/pptx handling. |
| `frontend/src/components/FileRenderer.tsx` | `frontend/src/features/files/renderers/DashboardRenderer.tsx` | Move dashboard-specific handling if any. |
| `frontend/src/components/dashboard/*` | `frontend/src/features/dashboard/components/*` | Move dashboard components. |
| `frontend/src/components/settings/*` | `frontend/src/features/settings/components/*` | Move settings components. |
| `frontend/src/services/settingsApi.ts` | Split into `frontend/src/features/settings/api/*.ts` | Separate agent config, skills, skill builder, users, reflections. |
| `frontend/src/types.ts` | Replace with package export | Re-export from `@helpudoc/contracts`. |

## Phase 9 - Paper2Slides and Parser/Image Split

Goal: isolate heavy document intelligence from the agent API and prepare for separate images.

### Package Movement

| Current file/directory | Target | Action |
| --- | --- | --- |
| `agent/paper2slides/` | `agent/presentation_pipeline/` | Move in a dedicated PR after tests pass. Keep `agent/paper2slides` as shim package importing from new package. |
| `agent/paper2slides/main.py` | `agent/presentation_pipeline/cli.py` | Move CLI implementation. Keep `paper2slides/main.py` shim. |
| `agent/paper2slides/__main__.py` | Shim | Continue supporting `python -m paper2slides` temporarily. |
| `agent/paper2slides/core/*` | `agent/presentation_pipeline/core/*` | Move. |
| `agent/paper2slides/generator/*` | `agent/presentation_pipeline/generation/*` | Move and rename for clarity. |
| `agent/paper2slides/summary/*` | `agent/presentation_pipeline/summarization/*` | Move. |
| `agent/paper2slides/prompts/*` | `agent/presentation_pipeline/prompts/*` | Move. |
| `agent/paper2slides/utils/*` | `agent/presentation_pipeline/utils/*` | Move, then split large files like `slide_assets.py`. |
| `agent/paper2slides/rag/*` | `agent/presentation_pipeline/rag/*` or shared `document_intelligence/rag` | Decide based on whether it remains presentation-specific. |
| `agent/paper2slides/raganything/*` | `agent/document_intelligence/raganything/*` | Move because `DoclingParser` is not presentation-only. Keep shim package. |
| `agent/raganything/*` | Remove or merge | There is a tiny top-level compatibility package. Collapse into the new parser package or keep as a temporary shim. |

### Backend/Frontend Integration

| File | Action |
| --- | --- |
| `agent/helpudoc_agent/paper2slides_runner.py` | Rename to `presentation_runner.py`; keep shim. Update command to call new module. |
| `agent/helpudoc_agent/app.py` | After API split, update routes to import from `presentation_runner.py`. |
| `backend/src/services/paper2SlidesService.ts` | Keep API naming for product continuity, but move directory to `services/paper2slides`. |
| `backend/src/services/paper2SlidesJobService.ts` | Same. |
| `frontend/src/services/paper2SlidesJobApi.ts` | Keep public API names until UI copy changes. |
| `frontend/src/constants/workspace.ts` | Consider renaming constants from `PAPER2SLIDES_*` to `PRESENTATION_*` only after product copy changes. |
| `tests/test_paper2slides_cache.py` | Update imports to `presentation_runner`; add shim import test for old name. |
| `tests/test_paper2slides_frontend_flow.sh` | Update to call the new CLI, then optionally keep a legacy command smoke test. |
| `agent/paper2slides/tests/test_slide_assets.py` | Move to `agent/presentation_pipeline/tests/`. |

### Dependency Split

| New file | Purpose |
| --- | --- |
| `agent/requirements-api.txt` | FastAPI, LangChain/LangGraph/DeepAgents, Google SDK, postgres checkpoint, Redis, Langfuse, lightweight runtime. |
| `agent/requirements-parser.txt` | Docling, MinerU, LightRAG, PyTorch CPU, torchvision, transformers, pypdf/pymupdf/opencv. |
| `agent/requirements-reporting.txt` | pandas, duckdb, matplotlib, seaborn, plotly, kaleido, python-pptx. |
| `agent/requirements-runtime.txt` | Includes api plus selected shared deps for current combined image. |
| `agent/requirements.txt` | Temporary umbrella including the split files for compatibility. |
| `agent/Dockerfile.base` | Heavy base image for parser/reporting dependencies. |
| `agent/Dockerfile.gke` | App image layered on base or installing `requirements-runtime.txt`. |
| `agent/Dockerfile.parser-worker` | Future parser worker image. |
| `agent/Dockerfile.report-worker` | Future reporting worker image if dashboards/reports get separate queue. |

## Phase 10 - Service and Image Boundary Split

Goal: reduce agent rebuild weight and isolate heavy workloads.

### Target Services

| Service | Image | Responsibility |
| --- | --- | --- |
| Backend API | `helpudoc-backend` | Auth, RBAC, workspace/files, conversations, job orchestration. |
| Frontend | `helpudoc-frontend` | React UI served by nginx. |
| Agent API | `helpudoc-agent-api` | Chat orchestration, tools, MCP binding, memory/checkpointing. |
| Parser worker | `helpudoc-parser-worker` | Docling/MinerU/LightRAG ingestion and attachment understanding. |
| Report worker | `helpudoc-report-worker` | Data dashboards, reports, PPTX/image-heavy generation if needed. |

### Files

| File | Action |
| --- | --- |
| `infra/gke/k8s/50-app.yaml` | Eventually remove parser-heavy env/deps from the agent API container. |
| `infra/gke/k8s/53-parser-worker.yaml` | New deployment or job worker for RAG/document parsing. |
| `infra/gke/k8s/54-report-worker.yaml` | Optional future worker if report generation needs isolation. |
| `backend/src/services/ragQueueService.ts` | Confirm queue payloads are stable enough for parser worker. |
| `agent/helpudoc_agent/rag/worker.py` | Becomes parser-worker entrypoint. |
| `agent/parser_worker.py` | New uvicorn-free worker entrypoint or module runner. |
| `agent/report_worker.py` | Optional future worker entrypoint. |
| `.github/workflows/build-images.yml` | Add selectable images: `agent-api`, `parser-worker`, `report-worker`. |
| `docs/current-architecture.md` | Update diagrams after worker split. |

## Phase 11 - Infra and Registry Modernization

Goal: modern GCP registry, cleaner manifests, and safer releases.

| File | Action |
| --- | --- |
| `.github/workflows/*.yml` | Support `REGISTRY_HOST` and image repository inputs so `gcr.io` to Artifact Registry is one config change. |
| `infra/gke/k8s/*.yaml` | Replace hard-coded `gcr.io/my-rd-coe-demo-gen-ai/...` with documented placeholders or Kustomize overlays. |
| `infra/gke/kustomization.yaml` | New optional Kustomize base for image substitutions. |
| `infra/gke/overlays/dev/kustomization.yaml` | Optional environment overlay. |
| `infra/gke/overlays/prod/kustomization.yaml` | Optional environment overlay with prod hosts/resources. |
| `infra/gke/README.md` | Add Artifact Registry setup and IAM notes. |
| `docs/ci-cd.md` | Document SHA tags plus environment aliases. |
| `.github/workflows/deploy-gke.yml` | Optionally push `:staging` or `:prod` aliases after SHA push, but deploy by SHA. |

## Phase 12 - Documentation and Developer Experience

| File | Action |
| --- | --- |
| `README.md` | Add concise repo map and link to architecture/deploy docs. |
| `agent/README.md` | Update package names after agent refactor. |
| `backend/README.md` | Add backend module map and local commands. |
| `frontend/README.md` | Add frontend feature directory map. |
| `docs/current-architecture.md` | Refresh diagrams. Note actual Langfuse instrumentation and worker split status. |
| `docs/environment.md` | Generate or manually align from env schema. |
| `docs/ci-cd.md` | Update to new workflows. |
| `docs/deploy.md` | Update normal deploy vs infra deploy. |
| `docs/data-skill-migration.md` | Update after data tools move and dashboard runtime package split. |
| `docs/dashboard-runtime-status.md` | Update after `packages/dashboard-runtime` split. |
| `docs/paper2slides-cache-bug.md` | Update paths after presentation package move. |

## Recommended Implementation Order

| Step | Work | Priority | Why |
| ---: | --- | --- | --- |
| 1 | Add Buildx registry cache and pip/npm cache mounts. | P0 | Immediate CI speed gain. |
| 2 | Add deploy inputs for component build toggles and `deploy_infra`. | P0 | Avoid rebuilding/deploying everything every run. |
| 3 | Add CI workflow with tests/builds and no push. | P0 | Creates safety net before refactors. |
| 4 | Add env schema and typed backend/agent env modules. | P0/P1 | Reduces hidden config drift before service split. |
| 5 | Replace `kubectl exec` skills/config sync with init-container seeding. | P1 | Makes deployments reproducible by image tag. |
| 6 | Split `graph.py`, `configuration.py`, and `app.py` with shims. | P1 | Removes agent naming confusion and central file risk. |
| 7 | Split data tools and dashboard runtime package. | P1 | Cleans up dashboard/data ownership and `packages` ambiguity. |
| 8 | Split backend `agent.ts`, `settings.ts`, and `agentRunService.ts`. | P1 | Makes API/service ownership readable. |
| 9 | Split frontend `WorkspacePage.tsx` and `ChatMessageBubble.tsx`. | P1 | Biggest frontend maintainability win. |
| 10 | Split requirements and create agent base image. | P1 | Prepares for image weight reduction. |
| 11 | Move parser code out of `paper2slides` and add parser worker image. | P1/P2 | Fixes naming and build-weight root cause. |
| 12 | Move from `gcr.io` to Artifact Registry and Kustomize overlays. | P2 | Good platform hygiene after pipeline is stable. |

## Validation Matrix

| Area | Commands/checks |
| --- | --- |
| Python agent | `python -m pytest tests/test_agent_import_smoke.py tests/test_agent_configuration.py tests/test_mcp_binding.py tests/test_tool_factory.py` |
| Agent container | `docker buildx build -f agent/Dockerfile.gke --load -t helpudoc-agent:test .` then `docker run --rm helpudoc-agent:test python /app/agent/scripts/smoke_import.py` |
| Backend | `cd backend && npm test` |
| Frontend | `cd frontend && npm run lint && npm run build` |
| Shared packages | `npm install` from workspace root if workspaces are adopted, then frontend/backend type checks. |
| GKE normal deploy | Build selected component only, `kubectl set image`, rollout wait, smoke tests. |
| GKE infra deploy | `kubectl diff`, apply manifests, bootstrap Langfuse/config only when requested. |
| Graph upkeep | After code-file edits: `graphify update .` |

## Compatibility Shim Policy

Use shims for package/file renames that have broad imports:

| Old path | Shim behavior | Removal condition |
| --- | --- | --- |
| `helpudoc_agent.graph` | Re-export from `helpudoc_agent.runtime.agent_registry`. | Remove after all tests/imports use new path and one release cycle passes. |
| `helpudoc_agent.configuration` | Re-export config models and `load_settings`. | Remove after app/tests/docs use `helpudoc_agent.config.*`. |
| `helpudoc_agent.tools_and_schemas` | Re-export `ToolFactory`, schemas, and managers. | Remove after tool modules are stable. |
| `helpudoc_agent.data_agent_tools` | Re-export `build_data_agent_tools` and key classes. | Remove after runtime config references new entrypoint. |
| `paper2slides` package | Re-export/forward to `presentation_pipeline`. | Remove only after CLI, backend, frontend, docs, and tests no longer refer to Paper2Slides as a package name. Product copy can still say Paper2Slides if desired. |
| `paper2slides.raganything` | Re-export from `document_intelligence.raganything`. | Remove after RAG and presentation pipeline imports are migrated. |
| `packages/shared` | Keep package alias or publish deprecation package. | Remove after backend/frontend import `@helpudoc/contracts` and `@helpudoc/dashboard-runtime`. |

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Large rename breaks imports across tests and runtime. | Move one boundary at a time and keep shims. |
| Docker cache does not hit because context changes too often. | Copy dependency manifests before source, use Buildx registry cache, and split requirements. |
| Skills PVC diverges from image source. | Add version marker during init seeding and surface source/version in settings. |
| Backend and agent disagree on env defaults. | Typed loaders generated/validated against one env schema. |
| Parser worker split changes runtime behavior. | First create base image and requirements split, then move queue worker, then remove parser deps from API image. |
| Frontend refactor causes UI regressions. | Split hooks/components behind existing page route and run Playwright smoke tests. |
| Shared package rename breaks Vite or ts-node. | Adopt npm workspaces or explicit `file:` dependencies in both frontend and backend. |

## Near-Term PR Breakdown

Use these checklists as the working tracker. Keep items unchecked until the PR is merged and docs/tests have been updated.

### PR 1 - `ci-build-cache`

Buildx cache, pip/npm cache mounts, component toggles, and `deploy_infra`.

- [x] Add `workflow_dispatch` inputs to `.github/workflows/deploy-gke.yml`: `build_backend`, `build_frontend`, `build_agent`, `deploy_infra`, `sync_runtime_assets`, optional `environment`, and optional tag suffix.
- [x] Replace `docker build` / `docker push` in `.github/workflows/deploy-gke.yml` with `docker buildx build --cache-from ... --cache-to ... --push`.
- [x] Add Buildx setup and registry-cache naming for backend, frontend, and agent images.
- [x] Gate backend image build on `inputs.build_backend`.
- [x] Gate frontend image build on `inputs.build_frontend`.
- [x] Gate agent image build on `inputs.build_agent`.
- [x] Update `kubectl set image` logic so only selected components are patched.
- [x] Gate RBAC verification behind `inputs.deploy_infra`.
- [x] Gate manifest apply behind `inputs.deploy_infra`.
- [x] Gate ConfigMap/bootstrap/Langfuse steps behind `inputs.deploy_infra`.
- [x] Temporarily gate skills/config `kubectl exec` sync behind `inputs.sync_runtime_assets`.
- [x] Add `# syntax=docker/dockerfile:1.7` to `agent/Dockerfile.gke`.
- [x] Add BuildKit pip cache mount to `agent/Dockerfile.gke`.
- [x] Add BuildKit pip cache mount to `agent/Dockerfile`.
- [x] Add npm cache mount to `backend/Dockerfile.gke`.
- [x] Run agent image smoke import with `agent/scripts/smoke_import.py`.
- [x] Update `docs/ci-cd.md` with the new manual deploy inputs.
- [x] Update `docs/deploy.md` with normal app deploy versus infra deploy guidance.

### PR 2 - `ci-docs-and-smoke`

PR CI, smoke routes/checks, and deployment docs.

- [x] Add `.github/workflows/ci.yml`.
- [x] Add backend test job running `cd backend && npm test`.
- [x] Add frontend lint/build job running `cd frontend && npm run lint && npm run build`.
- [x] Add Python smoke/test job for `tests/test_agent_import_smoke.py` and core agent tests.
- [x] Add no-push Docker build check for backend image.
- [x] Add no-push Docker build check for frontend image.
- [x] Add no-push Docker build check for agent image on default-branch pushes; PRs use Python agent smoke/core tests plus the CI gate to avoid duplicate heavy dependency installs.
- [x] Add or expose backend health endpoint under `/api/health`.
- [x] Add or expose agent runtime health endpoint under `/health`.
- [x] Add post-deploy backend smoke check in `.github/workflows/deploy-gke.yml`.
- [x] Add post-deploy frontend smoke check in `.github/workflows/deploy-gke.yml`.
- [x] Add post-deploy agent smoke check in `.github/workflows/deploy-gke.yml`.
- [x] Document smoke checks in `docs/ci-cd.md`.
- [x] Confirm `secret-scan.yml` still runs independently or as part of required checks.

### PR 3 - `runtime-assets-seeding`

Image-bundled skills/config source and init-container copy, replacing `kubectl exec` sync.

- [x] Choose the runtime asset ownership model: image-seeded PVC, ConfigMap, or admin-editable PVC with image source marker.
- [x] Update `agent/Dockerfile.gke` to copy `skills/` to `/app/skills-source`.
- [x] Update `agent/Dockerfile.gke` to copy `agent/config/runtime.yaml` to `/app/agent-config-source/runtime.yaml`.
- [x] Update `backend/Dockerfile.gke` only if backend remains the owner of settings/skills source assets (no change: agent image owns bundled source; init uses agent image).
- [x] Add init container in `infra/gke/k8s/50-app.yaml` to seed `/app/skills` from source assets.
- [x] Add init container in `infra/gke/k8s/50-app.yaml` to seed `/agent/config/runtime.yaml` from source assets.
- [x] Add a version/source marker file for seeded skills.
- [x] Add a version/source marker file for seeded agent config.
- [x] Ensure init containers do not overwrite admin-edited runtime assets unless explicitly configured.
- [x] Patch init-container images in deploy workflow when app image tags change.
- [x] Disable `kubectl exec` skills sync by default behind `inputs.sync_runtime_assets`.
- [x] Disable `kubectl exec` agent config sync by default behind `inputs.sync_runtime_assets`.
- [ ] Update settings API or UI to show image source version versus live PVC version if both exist (deferred; revision markers documented for operators in `docs/deploy.md`).
- [x] Update `docs/deploy.md` and `docs/ci-cd.md`.

### PR 4 - `env-schema`

Canonical env schema plus backend/agent typed env loaders.

- [x] Add `infra/env/helpudoc.env.schema.yaml`.
- [x] Catalog backend-owned env vars in the schema.
- [x] Catalog agent-owned env vars in the schema.
- [x] Catalog frontend `VITE_*` vars in the schema.
- [x] Mark secrets versus non-secrets.
- [x] Mark local required, prod required, and optional vars.
- [x] Add deprecated alias notes for variables such as `PARSER` versus `RAGANYTHING_PARSER`.
- [x] Add `backend/src/config/env.ts` using Zod or an equivalent typed parser.
- [x] Update `backend/src/index.ts` to read session/server config from `backend/src/config/env.ts`.
- [x] Update `backend/src/services/databaseService.ts` to read DB config from the env module.
- [x] Update `backend/src/services/s3Service.ts` to read S3 config from the env module.
- [x] Update `backend/src/services/googleOAuthService.ts` to read OAuth config from the env module.
- [x] Add `agent/helpudoc_agent/config/env.py` using Pydantic or dataclasses.
- [x] Update `agent/helpudoc_agent/configuration.py` env override logic to use the new env helper.
- [x] Update `agent/helpudoc_agent/rag_indexer.py` / future RAG config to use the new env helper.
- [x] Update `agent/helpudoc_agent/sandbox_runner.py` to use the new env helper.
- [x] Add `frontend/src/config/env.ts` for typed Vite env access.
- [x] Add env validation script under `scripts/`.
- [x] Validate `env/local/*.env.example` against schema.
- [x] Validate `env/prod/*.env.example` against schema.
- [x] Update `docs/environment.md`.

### PR 5 - `agent-runtime-rename`

Move `graph.py` to runtime registry with compatibility shim.

- [x] Create `agent/helpudoc_agent/runtime/__init__.py`.
- [x] Move `AgentRegistry` from `agent/helpudoc_agent/graph.py` to `agent/helpudoc_agent/runtime/agent_registry.py`.
- [x] Move `_clone_preservable_context` to `agent/helpudoc_agent/runtime/agent_registry.py`.
- [x] Keep `agent/helpudoc_agent/graph.py` as a compatibility shim.
- [x] Update `agent/helpudoc_agent/app.py` imports to use `helpudoc_agent.runtime.agent_registry`.
- [x] Update `tests/test_mcp_binding.py` imports and monkeypatch paths.
- [x] Update `tests/test_agent_main.py` stubs and cleanup lists.
- [x] Add a small test proving `from helpudoc_agent.graph import AgentRegistry` still works.
- [x] Update references in `docs/repo-cicd-restructure-plan.md` if the target path changes.
- [x] Run focused Python tests.
- [x] Run `graphify update .`.

### PR 6 - `agent-api-split`

Split `agent/helpudoc_agent/app.py` into API modules.

- [x] Create `agent/helpudoc_agent/api/__init__.py`.
- [x] Create `agent/helpudoc_agent/api/app.py` and move `create_app`.
- [x] Keep `agent/helpudoc_agent/app.py` as a compatibility shim or thin wrapper.
- [x] Move Pydantic request/response models to `agent/helpudoc_agent/api/schemas.py`.
- [x] Move startup/shutdown setup to `agent/helpudoc_agent/api/lifecycle.py`.
- [x] Move internal analysis/memory routes to `agent/helpudoc_agent/api/routes/internal.py`.
- [x] Move RAG query/status routes to `agent/helpudoc_agent/api/routes/rag.py`.
- [x] Move Paper2Slides routes to `agent/helpudoc_agent/api/routes/paper2slides.py`.
- [x] Move attachment understanding route to `agent/helpudoc_agent/api/routes/attachments.py`.
- [x] Move chat/stream/resume/respond/act routes to `agent/helpudoc_agent/api/routes/chat.py`.
- [x] Move skill contract route to `agent/helpudoc_agent/api/routes/skills.py`.
- [x] Move health/diagnostics route to `agent/helpudoc_agent/api/routes/health.py`.
- [x] Update `agent/main.py` to import `create_app` from the new API package.
- [x] Update tests that import `helpudoc_agent.app`.
- [x] Run focused agent API tests.
- [x] Run `graphify update .`.

### PR 7 - `shared-packages-split`

Split `packages/shared` into `contracts` and `dashboard-runtime`.

- [x] Add `packages/contracts/package.json`.
- [x] Move API/domain types from `packages/shared/src/types.ts` to `packages/contracts/src/types.ts`.
- [x] Move agent stream helper from `packages/shared/src/services/agentStream.ts` to `packages/contracts/src/agentStream.ts`.
- [x] Add package exports for `@helpudoc/contracts/types`.
- [x] Add package exports for `@helpudoc/contracts/agentStream`.
- [x] Add `packages/dashboard-runtime/package.json`.
- [x] Move `packages/shared/src/dashboard/*` to `packages/dashboard-runtime/src/*`.
- [x] Add package exports for `@helpudoc/dashboard-runtime`.
- [x] Update `frontend/package.json` dependencies.
- [x] Update `backend/package.json` dependencies if backend imports contracts directly.
- [x] Replace frontend relative imports from `packages/shared`.
- [x] Replace backend relative imports from `packages/shared`.
- [x] Decide whether to add npm workspaces at the repo root.
- [x] Keep `packages/shared` as a compatibility package or remove after all imports are migrated.
- [x] Run frontend build.
- [x] Run backend tests/type checks.

### PR 8 - `data-tools-split`

Data tools package and renderer split.

- [x] Create `agent/helpudoc_agent/tools/data/`.
- [x] Move `DataAgentSessionState` and record types to `tools/data/state.py`.
- [x] Move `DuckDBManager` to `tools/data/duckdb_manager.py`.
- [x] Move SQL/schema/materialization tools to `tools/data/query_tools.py`.
- [x] Move chart tools to `tools/data/chart_tools.py`.
- [x] Move dashboard generation tools to `tools/data/dashboard_tools.py`.
- [x] Move `build_data_agent_tools` to `tools/data/factory.py`.
- [x] Keep `agent/helpudoc_agent/data_agent_tools.py` as a compatibility shim.
- [x] Split `agent/helpudoc_agent/data_report_renderers.py` into data renderer modules.
- [ ] Update `agent/config/runtime.yaml` entrypoint for `data_agent_tools` when compatibility shim is no longer needed (deferred: `runtime.yaml` still targets the shim; entrypoint remains valid).
- [x] Update `tests/test_data_skill_family.py` (existing tests pass; monkeypatch paths unchanged).
- [x] Split or update `agent/tests/test_data_agent_tools.py` (added `agent/tests/test_tools_data_package.py` for package boundaries).
- [x] Run data-tool tests.
- [x] Run `graphify update .` (local run; `graphify-out/` remains gitignored).

### PR 9 - `backend-api-split`

Split backend agent/settings routes and agent run service.

- [ ] Create `backend/src/api/agent/index.ts`.
- [ ] Move agent run endpoints to `backend/src/api/agent/runs.ts`.
- [ ] Move slash metadata endpoint to `backend/src/api/agent/slash.ts`.
- [ ] Move Paper2Slides endpoints to `backend/src/api/agent/paper2slides.ts`.
- [ ] Move presentation endpoint to `backend/src/api/agent/presentation.ts`.
- [ ] Move effective agent policy helpers to `backend/src/api/agent/policy.ts` or a service module.
- [ ] Update `backend/src/api/routes.ts` to import the new agent router.
- [ ] Create `backend/src/api/settings/index.ts`.
- [ ] Move agent config routes to `backend/src/api/settings/agentConfig.ts`.
- [ ] Move skills CRUD routes to `backend/src/api/settings/skills.ts`.
- [ ] Move skill builder routes to `backend/src/api/settings/skillBuilder.ts`.
- [ ] Move GitHub import routes to `backend/src/api/settings/githubImport.ts`.
- [ ] Move skill path/frontmatter helpers to `backend/src/services/skills/`.
- [ ] Split `backend/src/services/agentRunService.ts` into `services/agent-runs/*`.
- [ ] Keep a compatibility barrel for old `agentRunService` exports.
- [ ] Update backend tests.
- [ ] Run `cd backend && npm test`.

### PR 10 - `frontend-workspace-split`

Split workspace route and chat renderers.

- [ ] Create `frontend/src/features/workspace/`.
- [ ] Move `WorkspacePage` implementation to `frontend/src/features/workspace/WorkspacePage.tsx`.
- [ ] Keep `frontend/src/pages/WorkspacePage.tsx` as a thin route re-export.
- [ ] Extract workspace selection logic into `features/workspace/hooks/useWorkspaceSelection.ts`.
- [ ] Extract file tree/content logic into `features/workspace/hooks/useWorkspaceFiles.ts`.
- [ ] Extract agent run lifecycle logic into `features/chat/hooks/useAgentRun.ts`.
- [ ] Extract conversation state logic into `features/chat/hooks/useConversationState.ts`.
- [ ] Extract Paper2Slides polling/options into `features/paper2slides/hooks/usePaper2SlidesJob.ts`.
- [ ] Extract dashboard artifact state into `features/dashboard/hooks/useDashboardArtifacts.ts`.
- [ ] Move `PresentationModal` into `features/paper2slides/components/PresentationModal.tsx`.
- [ ] Split `ChatMessageBubble.tsx` into message shell, tool events, interrupts, and artifact previews.
- [ ] Move dashboard components under `features/dashboard/components`.
- [ ] Move settings components under `features/settings/components`.
- [ ] Run `cd frontend && npm run lint`.
- [ ] Run `cd frontend && npm run build`.
- [ ] Run relevant Playwright smoke tests if available.

### PR 11 - `presentation-parser-split`

Move parser out of Paper2Slides and split requirements.

- [ ] Create `agent/presentation_pipeline/`.
- [ ] Move Paper2Slides CLI/core/generator/summary/utils modules into `presentation_pipeline`.
- [ ] Keep `agent/paper2slides` as a compatibility shim package.
- [ ] Create `agent/document_intelligence/`.
- [ ] Move `agent/paper2slides/raganything/*` into `agent/document_intelligence/raganything/`.
- [ ] Keep `paper2slides.raganything` as a compatibility shim.
- [ ] Update `agent/helpudoc_agent/paper2slides_runner.py` or rename it to `presentation_runner.py`.
- [ ] Update RAG imports that currently reference `paper2slides.raganything`.
- [ ] Update tests for new package paths.
- [ ] Add shim tests for old package paths.
- [ ] Create `agent/requirements-api.txt`.
- [ ] Create `agent/requirements-parser.txt`.
- [ ] Create `agent/requirements-reporting.txt`.
- [ ] Create `agent/requirements-runtime.txt`.
- [ ] Keep `agent/requirements.txt` as a temporary umbrella file.
- [ ] Add `agent/Dockerfile.base`.
- [ ] Update `agent/Dockerfile.gke` to use the split requirements or base image.
- [ ] Run Paper2Slides cache/frontend-flow tests.
- [ ] Run agent import smoke test.
- [ ] Run `graphify update .`.

### PR 12 - `artifact-registry-and-overlays`

Artifact Registry and Kustomize overlays.

- [ ] Choose Artifact Registry location and repository, for example `asia-southeast1-docker.pkg.dev/${PROJECT_ID}/helpudoc`.
- [ ] Add registry host/repository variables to GitHub workflows.
- [ ] Update Docker auth setup for Artifact Registry.
- [ ] Update image naming in build workflows.
- [ ] Keep deploy-by-SHA behavior.
- [ ] Optionally add environment alias tags such as `staging` or `prod`.
- [ ] Add `infra/gke/kustomization.yaml` or equivalent image substitution strategy.
- [ ] Add `infra/gke/overlays/dev/kustomization.yaml` if needed.
- [ ] Add `infra/gke/overlays/prod/kustomization.yaml` if needed.
- [ ] Remove hard-coded `gcr.io/my-rd-coe-demo-gen-ai/...` image references from manifests or isolate them in overlays.
- [ ] Update `infra/gke/README.md` with Artifact Registry setup and IAM.
- [ ] Update `docs/ci-cd.md`.
- [ ] Update `docs/deploy.md`.
