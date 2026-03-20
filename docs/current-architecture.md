# Current HelpUDoc Architecture

This document captures the current HelpUDoc architecture as implemented in this repository and deployed via the GKE manifests under `infra/gke/k8s/`.

It is intentionally different from a target-state enterprise reference architecture. In particular, the current app does not have:

- a separate skill registry service
- a separate MCP auth broker service
- a separate sandbox enclave or gVisor execution tier
- a separate API gateway distinct from ingress plus Caddy
- Langfuse wired into the runtime yet

## 3.4 Architecture Diagrams

```mermaid
flowchart LR
  U["User Browser"]
  FE["Frontend UI<br/>React / Vite"]
  BE["Backend API<br/>Express / session / RBAC / settings"]
  AG["Agent Service<br/>FastAPI / Gemini orchestration"]
  CFG["Runtime Config + Skills Registry<br/>PVC-mounted files"]
  CODE["Restricted In-Process Execution<br/>DuckDB + sanitized Python chart code"]
  PG["PostgreSQL"]
  RD["Redis"]
  OBJ["MinIO / S3-compatible object storage"]
  IDP["Google OAuth / OIDC session auth"]
  MCP["Configured MCP Servers"]
  BQ["BigQuery via toolbox-bq-demo"]
  EXT["Other external tools / APIs"]
  OBS["Langfuse (planned)<br/>plus platform logs / metrics"]

  U --> FE
  FE -->|"REST / streaming API"| BE
  BE -. "signin / callback" .-> IDP
  BE --> PG
  BE --> RD
  BE --> OBJ
  BE -->|"internal HTTP + signed short-lived JWT"| AG
  AG -->|"runtime.yaml + SKILL.md"| CFG
  AG --> CODE
  AG --> PG
  AG --> RD
  AG --> OBJ
  AG -->|"RBAC-filtered MCP access"| MCP
  MCP --> BQ
  MCP --> EXT
  BE -. "planned traces / spans" .-> OBS
  AG -. "planned traces / spans" .-> OBS
```

```mermaid
flowchart TB
  subgraph APP["Current Application Planes"]
    subgraph UX["User and UI Plane"]
      U1["User browser session"]
      U2["React frontend"]
    end

    subgraph API["Application and Orchestration Plane"]
      A1["Express backend"]
      A2["FastAPI agent runtime"]
      A3["Runtime config + skills from mounted storage"]
    end

    subgraph DATA["State and Integration Plane"]
      D1["PostgreSQL"]
      D2["Redis"]
      D3["MinIO object storage"]
      D4["MCP servers"]
      D5["BigQuery / external systems"]
    end

    subgraph OBS["Observability"]
      O1["Request logs / platform monitoring"]
      O2["Langfuse (planned)"]
    end
  end

  U1 --> U2
  U2 --> A1
  A1 --> A2
  A2 --> A3
  A1 --> D1
  A1 --> D2
  A1 --> D3
  A2 --> D1
  A2 --> D2
  A2 --> D3
  A2 --> D4
  D4 --> D5
  A1 --> O1
  A2 --> O1
  A1 -.-> O2
  A2 -.-> O2
```

## 3.5 Infrastructure Architecture Diagram

```mermaid
flowchart TB
  U["User Browser"]
  IDP["Google OAuth / OIDC Provider"]

  subgraph EDGE["GKE Edge"]
    ING["GKE Ingress<br/>ManagedCertificate + FrontendConfig"]
    CAD["Caddy reverse proxy"]
  end

  subgraph APP["Application Workloads"]
    FE["helpudoc-frontend deployment"]
    subgraph POD["helpudoc-app deployment"]
      BE["backend container<br/>:3000"]
      AG["agent container<br/>:8001"]
    end
  end

  subgraph STATE["Platform State and Storage"]
    PG["Postgres service"]
    RD["Redis service"]
    MN["MinIO service"]
    PVC["PVCs<br/>workspace-pvc<br/>skills-pvc<br/>agent-config-pvc"]
  end

  subgraph EXT["External Services"]
    MCP["toolbox-bq-demo and other MCP servers"]
    BQ["BigQuery"]
    LF["Langfuse (planned)"]
  end

  U --> ING
  ING --> CAD
  CAD -->|" / "| FE
  CAD -->|"/api"| BE
  CAD -->|"/helpudoc"| MN
  U -. "OAuth redirect" .-> IDP
  BE -. "session auth / Google OAuth" .-> IDP
  BE -->|"localhost HTTP + signed JWT"| AG
  BE --> PG
  BE --> RD
  BE --> MN
  AG --> PG
  AG --> RD
  AG --> MN
  BE --> PVC
  AG --> PVC
  AG --> MCP
  MCP --> BQ
  BE -. "planned traces" .-> LF
  AG -. "planned traces" .-> LF
```

## Notes

- The frontend is a separate Kubernetes deployment and service.
- Caddy is the runtime reverse proxy. It routes `/api` to the backend, `/helpudoc` to MinIO, and other paths to the frontend.
- The backend and agent are co-located in the same `helpudoc-app` pod today. Backend-to-agent traffic uses `http://localhost:8001`.
- Delegated MCP auth is not a standalone service. The backend signs a short-lived context JWT for the agent and can embed per-server `mcpAuth` headers for delegated access.
- Code execution is currently restricted in process for specific tools, not isolated in a dedicated sandbox enclave.
- Langfuse should be shown as a planned observability sink until instrumentation is actually added to the backend and agent services.

## Repo Sources

- `infra/gke/k8s/50-app.yaml`
- `infra/gke/k8s/60-frontend.yaml`
- `infra/gke/k8s/70-caddy.yaml`
- `infra/gke/k8s/71-ingress.yaml`
- `backend/src/api/agent.ts`
- `backend/src/services/agentService.ts`
- `backend/src/middleware/userContext.ts`
- `agent/helpudoc_agent/mcp_manager.py`
- `agent/helpudoc_agent/data_agent_tools.py`
