# HelpUDoc Agent Service

The agent service is a FastAPI application that runs HelpUDoc's Gemini-powered assistant workflows.
It is responsible for:

- general assistant chat and streaming responses
- skill-aware execution using the repo's bundled `skills/` catalog
- RAG status and query endpoints for workspace files
- the `paper2slides` pipeline and PPTX export helpers
- interrupt handling for human approvals, clarifications, and follow-up actions

## Layout

| Path | Purpose |
| ---- | ------- |
| `main.py` | FastAPI entry point used by local dev and Docker. |
| `helpudoc_agent/` | App factory, runtime state, tool loading, MCP integration, JWT checks, and chat orchestration. |
| `paper2slides/` | Multi-stage paper-to-slides pipeline and export utilities. |
| `prompts/` | Prompt catalog for the general assistant and specialized prompt families. |
| `config/runtime.yaml` | Runtime configuration for models, tools, MCP servers, and agent behavior. |
| `docs/` | Supporting notes for image tools and internal agent workflows. |
| `lightrag_server/` | Optional local LightRAG helper config. |

The shared skill catalog lives at the repo root in `skills/`. In Docker and production it is mounted into the agent runtime so the backend settings UI can edit it.

## Prerequisites

- Python 3.10+
- `pip`
- Access to Gemini credentials (`GEMINI_API_KEY` or `GOOGLE_CLOUD_API_KEY`)

## Installation

```bash
cd agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running locally

The agent reads `ENV_FILE` if provided; otherwise it falls back to `agent/.env`.

```bash
ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

Service URL: `http://localhost:8001`

## Important environment variables

| Variable | What it controls |
| -------- | ---------------- |
| `GEMINI_API_KEY` / `GOOGLE_CLOUD_API_KEY` | Primary model credentials. |
| `RAG_LLM_API_KEY` | Optional RAG-specific LLM credential. |
| `LLM_MODEL` | Default model identifier used by the runtime. |
| `AGENT_CONFIG_PATH` | Runtime config file path, usually `agent/config/runtime.yaml`. |
| `AGENT_JWT_SECRET` | Shared secret used to validate backend-issued agent requests. |
| `WORKSPACE_ROOT` | Workspace file root shared with the backend. |
| `REDIS_URL` | Redis connection used by RAG worker flows. |
| `S3_ENDPOINT`, `S3_BUCKET_NAME`, `S3_PUBLIC_BASE_URL` | Shared object storage settings for generated artifacts. |
| `GOOGLE_WORKSPACE_MCP_URL` | Hosted Google Workspace MCP endpoint when delegated tools are enabled. |

## Main API surfaces

### Agent discovery and chat

- `GET /agents`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/resume`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/respond`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/act`

### RAG helpers

- `POST /rag/workspaces/{workspace_id}/query`
- `POST /rag/workspaces/{workspace_id}/status`

### Paper-to-slides

- `POST /paper2slides/run`
- `POST /paper2slides/export-pptx`

## Paper-to-slides notes

`paper2slides` is a staged pipeline that can:

- ingest uploaded source files
- run RAG-backed analysis
- generate slide content and assets
- return a PDF payload and optional PPTX export

The frontend wraps this through backend job endpoints, while the agent service performs the actual generation work.

## Running with Docker Compose

From the repo root:

```bash
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build agent
```

## Useful scripts

- `scripts/start_agent.sh`: starts the agent in the background and writes logs to `logs/agent.log`
- `scripts/test_paper2slides.sh`: exercises the paper-to-slides pipeline on a local input file

## Related docs

- [../README.md](../README.md)
- [../docs/environment.md](../docs/environment.md)
- [lightrag_server/README.md](lightrag_server/README.md)
