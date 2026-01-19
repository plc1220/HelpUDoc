# HelpUDoc Agent Service

The agent service is a Python FastAPI application that orchestrates Gemini-powered agents for research, data analysis, and proposal creation. It also includes the `paper2slides` pipeline for turning source documents into presentation slides.

## Layout

- `helpudoc_agent/`: FastAPI app, runtime state, tools, and RAG worker.
- `paper2slides/`: end-to-end pipeline for extracting summaries and generating slides.
- `prompts/`: prompt templates for the core agents and subagents.
- `config/agents.yaml`: agent personas, tools, and routing configuration.
- `docs/`: internal documentation for image tools and workflows.
- `lightrag_server/`: optional LightRAG server config and notes.

## Agent personas

Personas are defined in `config/agents.yaml` and are available to the frontend persona selector.
Current personas include:

- `general-assistant`: General-purpose assistant with file editing and search tools.
- `research`: Research assistant with critique and sourcing pipeline.
- `data-agent`: Data analysis workflow with DuckDB + chart tooling.
- `proposal-agent`: Consultative proposal writer with research and planning subagents.
- `infographic-agent`: Generates AntV Infographic HTML files with SVG export.

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

The service loads `agent/.env`. Make sure it includes:

- `GEMINI_API_KEY` or `GOOGLE_CLOUD_API_KEY`
- `RAG_LLM_API_KEY` (if running the RAG worker)
- `LLM_MODEL` (for example `gemini-3-flash-preview`)

When running with Docker Compose, additional variables are provided automatically, such as `REDIS_URL`, `S3_ENDPOINT`, and `S3_BUCKET_NAME`.

### Running the application

```bash
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

The service will be available at `http://localhost:8001`.

## Running with Docker Compose

From the repo root:

```bash
docker compose -f infra/docker-compose.yml up --build agent
```

Compose will load `agent/.env` and connect the agent to the shared Redis and MinIO services.

## Useful scripts

- `scripts/start_agent.sh` starts the agent in the background and writes logs to `logs/agent.log`.
- `scripts/test_paper2slides.sh` runs the `paper2slides` pipeline on a local Markdown file.
