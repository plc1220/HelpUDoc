# MCP Connections + Auth Broker Plan

## Problem Statement
We need MCP integrations to scale across many third-party endpoints without:
- Creating duplicate MCP servers per role/credential (operationally inefficient).
- Baking one-off auth logic into the agent per vendor.
- Breaking long-term goals like per-user BigQuery policy tags or identity federation.

## Core Design (Decision)
Split MCP into two layers:

1. **MCP Server (endpoint definition, non-secret)**
   - Transport + URL + metadata.
   - Defined in `runtime.yaml` (via Admin Tools UI).

2. **MCP Connection (auth binding, potentially secret)**
   - References an MCP Server + defines how to authenticate.
   - Stored in Postgres (NOT in `runtime.yaml`), managed via Admin UI.
   - RBAC grants apply to **connections** (not servers).

This allows one endpoint to have multiple bindings (workspace-shared token, per-user OAuth, federated identity, etc.) without duplicating server definitions.

## Principles
- **Backend is the credential broker**:
  - Holds refresh tokens / long-lived secrets.
  - Mints short-lived per-request auth material (headers/tokens).
- **Agent only receives ephemeral credentials**:
  - No refresh tokens.
  - Prefer minutes TTL.
- **Uniform RBAC**:
  - Same allow/deny + default_access pattern as skills.
- **Vendor-agnostic**:
  - Support a small set of auth types that cover most vendors.

## Auth Types (Initial Set)
Define `authType` on a connection:
- `none`
- `static_header` (workspace-shared API key / PAT / bearer token stored in backend secrets)
- `oauth_delegated` (per-user OAuth; backend stores refresh token and mints access token per request)
- `oidc_federation` (token exchange / workload identity to get short-lived access tokens)
- `custom` (escape hatch; minimal support, admin-only)

Notes:
- BigQuery policy tags generally require `oauth_delegated` (or a federation/impersonation flow that resolves to a user principal recognized by BigQuery).

## RBAC Model (Connections)
### Default Access
Each connection has `default_access: allow|deny` (default `allow`).

Effective access for a user and a connection:
1. `isAdmin` (system admin) => ALLOW.
2. Any explicit DENY (direct user or group) => DENY.
3. If `default_access == deny` => ALLOW only if explicit ALLOW exists.
4. Else ALLOW.

### Why Grants Move To Connections
Using servers as the grant unit forces "one server per credential" if multiple credentials are needed.
Connections make "one server, many bindings" possible.

## Data Model (Backend Postgres)
Implemented using the existing "create tables on startup" pattern in `backend/src/services/databaseService.ts`.

### Tables
1. `mcp_connections`
- `id uuid pk`
- `workspaceId uuid fk -> workspaces(id) on delete cascade`
- `name text not null` (user-facing display)
- `serverId text not null` (references `runtime.yaml` server `name`)
- `authType text not null` (`none|static_header|oauth_delegated|oidc_federation|custom`)
- `defaultAccess text not null default 'allow'`
- `createdAt`, `updatedAt`

2. `mcp_connection_grants`
- `id bigserial pk`
- `principalType text not null` (`user|group`)
- `principalId uuid not null`
- `connectionId uuid not null fk -> mcp_connections(id) on delete cascade`
- `effect text not null` (`allow|deny`)
- `createdAt`, `updatedAt`
- unique `(principalType, principalId, connectionId)`

3. `mcp_connection_secrets`
- `connectionId uuid pk fk -> mcp_connections(id) on delete cascade`
- `encryptedJson bytea/text not null` (backend-owned encryption key)
- `createdAt`, `updatedAt`

4. `user_oauth_tokens` (generic)
- `id bigserial pk`
- `userId uuid not null fk -> users(id) on delete cascade`
- `provider text not null` (e.g. `google`)
- `encryptedJson bytea/text not null` (refresh token + metadata)
- `createdAt`, `updatedAt`
- unique `(userId, provider)`

## Backend Responsibilities
### Admin CRUD APIs
Add admin routes (protected by `requireAdmin` or owner+admin, depending on your admin model):
- `GET/POST/PATCH/DELETE /api/admin/mcp-connections`
- `GET/PUT/DELETE /api/admin/mcp-connection-grants`

### Non-Admin Runtime APIs
- `GET /api/mcp/connections?workspaceId=...`
  - returns only connections the current user can access (plus server metadata).

### Credential Broker
When running the agent, backend computes:
- RBAC policy (allowed connectionIds).
- For each allowed connection, generate `headers` to reach the MCP server.

The backend then passes to the agent (in the backend-signed JWT):
```json
{
  "mcpConnections": [
    { "id": "uuid", "name": "bq-user", "serverId": "toolbox-bq-demo" }
  ],
  "mcpAuth": {
    "uuid": { "Authorization": "Bearer <short-lived-access-token>" }
  }
}
```

## Agent Responsibilities
### Tool Surfacing
The agent must be able to load tools per connection. Two options:

Option A (recommended): **tool name prefixing**
- For each connection, create a distinct MCP "server name" (e.g. `conn_<id>`).
- Enable tool name prefixing so tools become `conn_<id>_bq_list_tables`.
- This avoids tool name collisions if multiple connections point to the same endpoint.

Option B: no prefixing
- Only works if you guarantee one connection per tool namespace.

### No Long-Lived Secrets
Agent must not store refresh tokens. It only uses `mcpAuth[connectionId]` headers at runtime.

## Phased Delivery Plan
### Phase 0: Keep Current Server Registry (Done / Current)
- MCP servers in `runtime.yaml`.
- RBAC allow/deny for servers only.

### Phase 1: Connections + static_header (Workspace Scope)
- Add tables: `mcp_connections`, `mcp_connection_secrets`, `mcp_connection_grants`.
- Admin UI: create connection for a server and store a token (encrypted).
- Backend injects `Authorization` header per request.
- Agent loads tools with per-connection prefixing.

### Phase 2: oauth_delegated (Per User)
- Add `user_oauth_tokens` and Google OAuth flow for BigQuery.
- Backend mints access token per request for the user.
- Same connection model; only the resolver differs.

### Phase 3: federation
- Add `oidc_federation` resolver(s) (audience-based ID tokens, token exchange).
- Optionally add backend-side proxying if needed for complex vendor auth or audit.

## Open Questions (Need Decisions)
- Scope of connections:
  - workspace-only vs allow per-user connection bindings (most vendors: workspace; BigQuery policy tags: per-user).
- Who can manage connections:
  - system_admin only vs workspace owners.
- Whether to proxy MCP calls via backend for some auth types (stronger control, more moving parts).

