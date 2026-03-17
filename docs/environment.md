# Environment and deployment setup

This repo separates local development env vars from production deployment secrets.

## Local development (run services directly)

1) Copy env templates:

```bash
cp env/local/dev.env.example env/local/dev.env
cp env/local/stack.env.example env/local/stack.env
```

2) Start shared infra (Postgres, Redis, MinIO):

```bash
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
```

3) Export env vars for dev shells:

```bash
set -a; source env/local/dev.env; set +a
```

4) Start services in separate terminals:

```bash
cd backend
ENV_FILE=../env/local/dev.env npm run dev
```

```bash
cd agent
ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

```bash
cd frontend
npm run dev
```

Notes:
- The backend and agent read `ENV_FILE` if set; otherwise they fall back to a local `.env` in their folder.
- Vite reads `VITE_*` values from the shell, so `VITE_GOOGLE_CLIENT_ID` in `env/local/dev.env` is enough.

## Local development (Docker Compose full stack)

```bash
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build
```

## Production (GKE)

Production expects Kubernetes Secret and ConfigMap to be created before Cloud Build deploys the manifests.

1) Create env files:

```bash
cp env/prod/secrets.env.example env/prod/secrets.env
cp env/prod/config.env.example env/prod/config.env
```

2) Create the namespace (first time only):

```bash
kubectl apply -f infra/gke/k8s/00-namespace.yaml
```

3) Create Kubernetes resources (one-time or whenever values change):

```bash
kubectl -n helpudoc create secret generic helpudoc-secrets --from-env-file=env/prod/secrets.env
kubectl -n helpudoc create configmap helpudoc-config --from-env-file=env/prod/config.env
```

4) Deploy via Cloud Build:

```bash
gcloud builds submit . --config=infra/cloudbuild.yaml --project=<PROJECT_ID> --substitutions=_GKE_LOCATION=<REGION>,_GKE_CLUSTER=<CLUSTER>
```

Notes:
- Templates for reference live in `infra/gke/templates/`.
- For production, store secret values in Google Secret Manager and generate `env/prod/secrets.env` from there instead of committing them.

## Google OAuth + Google-Delegated MCP

This project supports per-user Google OAuth delegation for Google-backed MCP servers such as `toolbox-bq-demo` and `google-workspace`.

Required backend env vars:

- `AUTH_MODE=hybrid` (`hybrid` allows both session/OIDC and local header fallback; use `oidc` for strict OIDC-only, `headers` for local-only)
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_OAUTH_POST_LOGIN_REDIRECT`
- `GOOGLE_OAUTH_SCOPES` (must include BigQuery plus the Gmail, Calendar, Drive, and Sheets scopes used by delegated Google Workspace MCP access)
- `GOOGLE_WORKSPACE_MCP_URL` (HTTP endpoint for the hosted Google Workspace MCP server)
- `OAUTH_TOKEN_ENCRYPTION_KEY` (32-byte base64url key)

If you expand `GOOGLE_OAUTH_SCOPES`, existing users must sign in with Google again so the backend can store a refresh token with the new grants.

Frontend env vars:

- `VITE_AUTH_MODE` (`hybrid` recommended; supports both local and Google sign-in when server is configured)
- `VITE_API_URL`

Operational validation checks:

1. Sign in with Google and verify `GET /api/auth/me` returns `authenticated: true`.
2. Run a BigQuery MCP query such as `SELECT SESSION_USER()` and verify it matches the logged-in user.
3. Run a Google Workspace MCP action that reads Gmail, Calendar, Drive, or Sheets with the same signed-in identity.
4. Run a sensitive-column query with two users:
   - restricted user -> masked values
   - privileged user -> unmasked values
