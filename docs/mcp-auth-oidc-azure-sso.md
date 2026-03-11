# MCP Auth Architecture (OIDC Today, Azure AD SSO Next)

## Purpose

This document captures the current MCP authentication architecture in HelpUDoc and a practical path to extend it to Azure AD SSO without rewriting agent-side MCP logic.

## Current Architecture (Google OIDC + Delegated MCP Auth)

### Components

- Frontend UI
- Backend (Node): auth/session and credential broker
- Agent (Python): tool execution and MCP transport
- MCP toolbox (Cloud Run): MCP server for BigQuery tools

### Request/Auth Flow

1. User signs in to backend via OIDC (Google today).
2. Backend gets delegated Google access token for the user.
3. Backend signs a short-lived internal JWT (5 minutes) with `AGENT_JWT_SECRET`.
4. JWT includes:
- identity (`sub`, `userId`)
- MCP policy (`allowIds`, `denyIds`, `isAdmin`)
- per-server runtime headers (`mcpAuth`)
- auth fingerprint (`mcpAuthFingerprint`)
5. Agent verifies JWT and stores context.
6. Agent injects `mcpAuth` headers when opening MCP HTTP transport.
7. Toolbox validates bearer token and serves tool calls (for example `bq_list_tables`).

### Token Model

- External token: provider-issued access token used against MCP toolbox.
- Internal token: backend-issued JWT used only backend -> agent for trusted context propagation.

### Key Code Paths

- `/backend/src/services/agentToken.ts`
- `/backend/src/api/agent.ts`
- `/agent/helpudoc_agent/app.py`
- `/agent/helpudoc_agent/mcp_manager.py`

## Operational Requirements

- `AGENT_JWT_SECRET` must be non-empty in both backend and agent containers.
- Deployment manifest updates must be applied (not only image patch), otherwise new env vars do not reach pods.

If `AGENT_JWT_SECRET` is missing:
- backend cannot sign context token
- agent receives no `mcpAuth`
- toolbox calls fail with `401 Unauthorized`

## Future Architecture: Azure AD SSO

### Goal

Use Azure AD for enterprise SSO while preserving the same backend->agent contract (`mcpAuth` + policy).

### Design Principle

Keep identity-provider complexity in backend. Agent remains provider-agnostic and only forwards per-server auth headers from validated context.

### Target Flow

1. User authenticates to backend with Azure AD OIDC.
2. Backend credential broker resolves auth per MCP server:
- Azure-native server -> Azure token
- GCP-backed server (BigQuery toolbox) -> federation/token exchange to Google access token
3. Backend signs internal JWT with resolved `mcpAuth`.
4. Agent verifies JWT and uses headers exactly as today.

### Why This Is Preferred

- No IdP-specific code in agent
- Supports mixed providers per server
- Keeps policy enforcement and audit in one place (backend)

## Azure AD Extension Plan

1. Add Azure AD OIDC login in backend (`AUTH_MODE=oidc` in production).
2. Generalize backend credential broker to per-server auth resolvers.
3. Implement Azure -> Google token exchange resolver for BigQuery toolbox access.
4. Keep JWT payload schema stable (`mcpAuth`, `mcpAuthFingerprint`, policy).
5. Add observability for token source and expiry metadata (no token leakage).
6. Add integration tests for:
- signed token presence
- agent context extraction
- MCP call success/failure behavior

## Security Notes

- Keep internal JWT short-lived.
- Never log full bearer tokens.
- Keep refresh tokens/secrets backend-only.
- Agent should not persist long-lived credentials.
- Rotate `AGENT_JWT_SECRET` with coordinated backend+agent rollout.
