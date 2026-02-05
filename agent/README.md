# HelpUDoc Agent Service

The agent service is a Python FastAPI application that orchestrates Gemini-powered agents for research, data analysis, and proposal creation. It also includes the `paper2slides` pipeline for turning source documents into presentation slides.

## Layout

- `helpudoc_agent/`: FastAPI app, runtime state, tools, and RAG worker.
- `paper2slides/`: end-to-end pipeline for extracting summaries and generating slides.
- `prompts/`: system prompt templates (general router prompt is active).
- `config/runtime.yaml`: model, backend, tool registry, and MCP configuration.
- `skills/`: reusable skills the general assistant can load on demand.
- `docs/`: internal documentation for image tools and workflows.
- `lightrag_server/`: optional LightRAG server config and notes.

## Skills-first routing

The service runs a single general assistant. Specialized behavior is implemented as skills
under `skills/<skill-id>/SKILL.md`. Each skill can declare the tools it needs in frontmatter,
and the assistant loads only the relevant skills per request.

## Getting started

### Prerequisites

- Python 3.10+
- `pip`

### Installation

```bash
cd agent
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Environment variables

The service reads variables from `ENV_FILE` if provided; otherwise it falls back to `agent/.env`.
For local development, copy `env/local/dev.env.example` to `env/local/dev.env` and export it:

```bash
set -a; source ../env/local/dev.env; set +a
```

Required values:

- `GEMINI_API_KEY` or `GOOGLE_CLOUD_API_KEY`
- `RAG_LLM_API_KEY` (if running the RAG worker)
- `LLM_MODEL` (for example `gemini-3-flash-preview`)

When running with Docker Compose, additional variables are provided automatically, such as `REDIS_URL`, `S3_ENDPOINT`, and `S3_BUCKET_NAME`.

### Running the application

```bash
ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

The service will be available at `http://localhost:8001`.

## Running with Docker Compose

From the repo root:

```bash
docker compose -f infra/docker-compose.yml up --build agent
```

Compose will connect the agent to the shared Redis and MinIO services using `env/local/stack.env` if provided.

## Useful scripts

- `scripts/start_agent.sh` starts the agent in the background and writes logs to `logs/agent.log`.
- `scripts/test_paper2slides.sh` runs the `paper2slides` pipeline on a local Markdown file.
