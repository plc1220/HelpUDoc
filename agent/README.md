# HelpUDoc Agent Service

The agent service is a FastAPI application that runs HelpUDoc's Gemini-powered assistant workflows.
It is responsible for:

- general assistant chat and streaming responses
- skill-aware execution using the repo's bundled `skills/` catalog
- on-demand inspection and search tools for workspace documents
- interrupt handling for human approvals, clarifications, and follow-up actions

## Layout

| Path | Purpose |
| ---- | ------- |
| `main.py` | FastAPI entry point used by local dev and Docker. |
| `helpudoc_agent/` | App factory, runtime state, tool loading, MCP integration, JWT checks, and chat orchestration. |
| `prompts/` | Prompt catalog for the general assistant and specialized prompt families. |
| `config/runtime.yaml` | Runtime configuration for models, tools, MCP servers, and agent behavior. |
| `docs/` | Supporting notes for image tools and internal agent workflows. |

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
| `AGENT_CONFIG_PATH` | Runtime config file path, usually `agent/config/runtime.yaml`. |
| `AGENT_JWT_SECRET` | Shared secret used to validate backend-issued agent requests. |
| `WORKSPACE_ROOT` | Workspace file root shared with the backend. |
| `REDIS_URL` | Redis connection used by agent run flows. |
| `S3_ENDPOINT`, `S3_BUCKET_NAME` | Shared private object storage settings for generated artifacts. |
| `GOOGLE_WORKSPACE_MCP_URL` | Hosted Google Workspace MCP endpoint when delegated tools are enabled. |
| `GOOGLE_DEVELOPER_KNOWLEDGE_PROJECT_ID` | Quota/billing project header used by the Google Developer Knowledge MCP endpoint. |
| `GCP_COST_SERVICE_ACCOUNT_JSON` / `GCP_COST_SERVICE_ACCOUNT_JSON_B64` | Optional service-account JSON for `gcp-cost` when node ADC scopes are insufficient. |

## Main API surfaces

### Agent discovery and chat

- `GET /agents`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/resume`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/respond`
- `POST /agents/{agent_name}/workspace/{workspace_id}/chat/stream/act`

### Document extraction

- `POST /documents/extract`

### Office previews and quick edits

- `POST /documents/office-preview` accepts signed workspace context plus `{workspaceId, filename, content}` (base64 DOCX/PPTX). Returns a PDF preview, original-source SHA revision, and optional DOCX paragraph/style metadata.
- `POST /documents/office-edit` additionally accepts the source `revision` and a validated paragraph/range edit. It returns new DOCX bytes; the backend owns permissions, strict version checks, history, and publication. These operations do not invoke an LLM or mutate a shared workspace path in the agent.
- Rendering requires LibreOffice Writer/Impress, redistributable fonts, and Linux `libseccomp2` (installed in `agent/Dockerfile`). Native macOS development uses LibreOffice plus `sandbox-exec`. `OFFICE_PREVIEW_SOFFICE` can set the converter executable explicitly.
- Each conversion uses a private temporary profile, denied network access, macro/OLE restrictions, a 60-second timeout, and a 2 GiB Linux child memory cap. Conversion concurrency is one. Previews are cached by source SHA/format/renderer version for 15 minutes within a 128 MiB / 16-entry budget. Input is limited to 25 MiB and PDF output to 50 MiB. Validated native charts with embedded XLSX data are supported; external linked content and active objects are rejected.
- Native quick edits byte-splice only the target paragraph in the original DOCX package. Unsupported or protected structures remain read-only. Annotation metadata uses the source revision, independent of regenerated PDF timestamps.
- Run `PYTHONPATH=agent agent/.venv/bin/python -m pytest agent/tests/test_document_quick_edit.py agent/tests/test_office_preview.py` from the repo root. Real rendering tests run when LibreOffice is available. `python agent/scripts/smoke_office_preview.py` exercises real DOCX/PPTX rendering and native edit/refresh without model credentials. Both CI and deployment image builds run this smoke before rollout.
- Shipping this feature requires rebuilding the agent image together with backend and frontend; no database migration is needed.

## MCP discovery during chat

Ordinary Fast/Pro chats expose `list_mcp_servers` and `load_mcp_tools` through
`MCPDiscoveryMiddleware`. The model can discover permitted services, choose one,
and call its operations in the same run without a `/mcp` tag. The harness does
not route by keywords or add MCP instructions to the system prompt.

The catalog reads configured names/descriptions without connecting. Loading
discovers actual schemas through `MCPServerManager`, applies Gemini preflight,
and makes the tools available through LangChain's model/tool middleware hooks.
An explicit `/mcp` selection or a skill's declared servers still works; a skill
loaded mid-run also makes its servers eligible at the next model step.

Only selected server IDs enter conversation checkpoints. Clients and credentials
remain in the existing user/policy/auth-scoped runtime; after a rebuild, selected
servers are reloaded using current credentials. Permissions and skill scope are
checked before both exposure and execution. Tools have deterministic server-qualified
names to avoid collisions. Failed discovery returns an error, never an empty-catalog
claim; detailed transport errors stay out of model-facing responses. Skill Builder
does not receive these execution capabilities.

Keep each server's `description` accurate so the model can select it from the
catalog. Actual operations, OAuth scopes, and file-transfer support depend on the
connected server. Loading a server only discovers tools; it does not run an upload
or other external operation.

Regression checks (no provider credentials needed):
`agent/.venv/bin/python -m pytest tests/test_mcp_discovery.py tests/test_mcp_binding.py tests/test_mcp_configuration.py`.
Set `HELPUDOC_LIVE_MCP_MODEL_TEST=1` with Gemini credentials to additionally evaluate
an untagged Drive request against the Fast model and mocked external operations.

Implementation references: [dynamic tool registration](https://docs.langchain.com/oss/python/langchain/tools#dynamic-tool-selection)
and [MCP integration](https://docs.langchain.com/oss/python/langchain/mcp).
This uses the pinned LangChain 1.3.2 middleware and existing `langchain-mcp-adapters`;
it does not require migration to the newer beta `langchain.mcp` API.

## Running with Docker Compose

From the repo root:

```bash
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build agent
```

## Useful scripts

- `scripts/start_agent.sh`: starts the agent in the background and writes logs to `logs/agent.log`

## Related docs

- [../README.md](../README.md)
- [../docs/api/README.md](../docs/api/README.md)
- [../docs/environment.md](../docs/environment.md)
