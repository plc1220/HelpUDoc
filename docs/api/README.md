# HelpUDoc API documentation

Documentation for HTTP APIs in HelpUDoc. Start here when onboarding; use the **reference** when you need exact request/response shapes.

## Guides (read these first)

| Guide | Who it's for | What you'll learn |
| ----- | ------------ | ----------------- |
| [Integration guide](integration-guide.md) | Frontend / client developers | How the app should call the backend, auth, and the recommended chat flow |
| [Agent runtime guide](agent-runtime-guide.md) | Anyone building chat or HITL | **Durable runs vs legacy endpoints**, streaming, interrupts, approve vs clarify vs act |
| [File & attachment flow](file-attachment-flow.md) | Workspace & chat features | Upload → understand → context refs → agent run |
| [Admin guide](admin-guide.md) | Settings portal / ops | Skills, users, groups, reflections, skill builder |

## Reference

| Doc | Contents |
| --- | -------- |
| [API reference](reference.md) | Full endpoint list (backend + agent service) |
| [Agent OpenAPI](http://localhost:8001/docs) | Interactive docs when the agent is running locally |

## Quick links

- Base URL (local): `http://localhost:3000/api`
- Shared TypeScript types: `packages/contracts/` (`@helpudoc/contracts`)
- Frontend API helpers: `frontend/src/services/` (`apiClient.ts`, `agentApi.ts`, `fileApi.ts`, …)
- [Environment setup](../environment.md) · [Deploy](../deploy.md)

## Suggested reading order for new developers

1. [Integration guide](integration-guide.md) — how clients talk to the backend  
2. [Agent runtime guide](agent-runtime-guide.md) — how a chat turn actually runs  
3. [File & attachment flow](file-attachment-flow.md) — if you touch uploads or `@file` mentions  
4. [API reference](reference.md) — lookup while implementing  
5. [Admin guide](admin-guide.md) — only if you work on settings / RBAC  
