# HelpUDoc Deployment Guide

This guide covers how to deploy HelpUDoc locally (for testing) and to GKE (production-style).

If you want the "CI/CD and Cloud Build" view (triggers, build tags, rollback, troubleshooting), read `docs/ci-cd.md`.

## 1) Prerequisites

- **Docker** (for local + builds)
- **kubectl** and **gcloud** (for GKE)
- A GCP project with:
  - Container Registry (`gcr.io/...`) or Artifact Registry enabled
  - GKE cluster created
  - DNS A records for your domain pointing to the Caddy LoadBalancer IP

## 2) Local development (services on your machine)

```bash
cp env/local/dev.env.example env/local/dev.env
cp env/local/stack.env.example env/local/stack.env

docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d

set -a; source env/local/dev.env; set +a

cd backend && ENV_FILE=../env/local/dev.env npm run dev
cd agent && ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
cd frontend && npm run dev
```

## 3) Local full-stack (Docker Compose)

```bash
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build
```

The Docker Compose frontend is published at `http://localhost:5173`.

## 4) GKE deployment (recommended)

### 4.1 Configure GCP

```bash
export PROJECT_ID=my-rd-coe-demo-gen-ai
export GKE_LOCATION=asia-southeast1-a   # zone or region (matches your cluster)
export CLUSTER=helpudoc-cluster
```

```bash
# Use --zone or --region depending on how the cluster was created.
# Zonal cluster:
gcloud container clusters get-credentials "$CLUSTER" --zone "$GKE_LOCATION" --project "$PROJECT_ID"
#
# Regional cluster:
# gcloud container clusters get-credentials "$CLUSTER" --region "$GKE_LOCATION" --project "$PROJECT_ID"
```

### 4.2 Recommended full-stack deploy (GitHub Actions)

The primary full-stack deploy path is the manual **Deploy Full Stack to GKE** workflow in `.github/workflows/deploy-gke.yml`.

**App deploy (default)** — leave **`deploy_infra`** false and **`sync_runtime_assets`** false:

- Builds and pushes only the images you select (`build_backend`, `build_frontend`, `build_agent`; all default true) using **Docker Buildx** with **registry layer cache** (`gcr.io/$PROJECT_ID/helpudoc-buildcache-*`).
- Tags selected images with `github.sha` plus optional **`image_tag_suffix`**.
- Requires an existing `helpudoc-config` ConfigMap (bootstrap the cluster once before relying on app-only deploys).
- Patches deployment images only for components you built; when the agent image changes, it also patches the **init-container** images used for runtime asset seeding.
- Merges OAuth keys from GitHub repository secrets (same as before).
- Waits for `helpudoc-app` and `helpudoc-frontend` rollouts, then runs **post-deploy smoke checks** against `GET /api/health` on the backend service, a GET on the frontend service, and `GET /health` on the agent container (`127.0.0.1:8001`).

**Infra / bootstrap deploy** — set **`deploy_infra`** true (use sparingly):

- Runs the Kubernetes RBAC preflight, `kubectl apply -f infra/gke/k8s/`, first-time demo `helpudoc-config` if missing, Langfuse secret/config patching, Langfuse DB bootstrap + rollout wait, then continues with OAuth + image rollout as in an app deploy.

**Runtime assets (skills + agent config on PVCs):** the `helpudoc-app` pod includes **init containers** (`seed-skills`, `seed-agent-config`) that copy from image paths **`/app/skills-source`** and **`/app/agent-config-source/runtime.yaml`** into the PVC mounts **only when the target paths are empty**, so normal pod restarts do not wipe admin edits. Each image carries `.HELPUDOC_SOURCE_REVISION` (build tag / commit) beside the bundled tree; after a successful seed, the same filename may appear under the PVC for operators to diff **image revision** versus **live PVC** content (`kubectl exec` into the backend container and `cat /app/skills/.HELPUDOC_IMAGE_SOURCE_REVISION` or `/agent/config/.HELPUDOC_IMAGE_SOURCE_REVISION`).

**Legacy PVC sync:** if you temporarily need the old `kubectl exec` tar/rsync behaviour, set **`sync_runtime_assets`** true. It is destructive for `/app/skills` when enabled; prefer init seeding for new clusters.

Required GitHub secrets:
- `GCP_PROJECT_ID`
- `GKE_LOCATION`
- `GKE_CLUSTER`
- one auth mode: `GCP_WORKLOAD_PROVIDER` + `GCP_SERVICE_ACCOUNT`, or
  `GCP_CREDENTIALS_JSON`
- `VITE_GOOGLE_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_OAUTH_POST_LOGIN_REDIRECT`
- `OAUTH_TOKEN_ENCRYPTION_KEY`
- optional Langfuse overrides: `CLICKHOUSE_PASSWORD`,
  `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY`,
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
  `LANGFUSE_INIT_USER_PASSWORD`

Notes:
- The deploy is manual-only (`workflow_dispatch`), not automatic on every push.
- PR validation runs `.github/workflows/ci.yml` on pushes and pull requests to `master` / `main` (path-filtered on PRs; full matrix on merge to `master` / `main`; see `docs/ci-cd.md`).
- The build jobs do not talk to the cluster; the deploy job does all `kubectl` work after selected image pushes succeed.
- The checked-in manifests still reference `:latest`; the workflow patches the
  running `helpudoc-app` and `helpudoc-frontend` deployments to the commit SHA
  after rollout (and patches init-container agent images when the agent image is rebuilt).
- `infra/gke/k8s/52-daily-reflection-cron.yaml` also exists in the manifest
  directory. It currently uses the checked-in backend image reference when
  manifests are applied; update it manually if the CronJob must run a specific
  SHA image.

See `docs/ci-cd.md` for more workflow details and troubleshooting.

### 4.3 Alternative full-stack deploy (Cloud Build)

`infra/cloudbuild.yaml` remains available for local/operator-triggered deploys.
It builds the same three app images in parallel, tags them with Cloud Build
`$BUILD_ID`, rewrites app/frontend manifest image tags in the build workspace,
applies `infra/gke/k8s/` through `gke-deploy`, bootstraps Langfuse, syncs
PVC-backed runtime files, optionally bootstraps an admin user, and can run E2E.

```bash
gcloud builds submit . \
  --config=infra/cloudbuild.yaml \
  --project="$PROJECT_ID" \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=false
```

Notes:
- The repo manifests intentionally reference `:latest`. Cloud Build pins the
  app/frontend deployment manifests to `$BUILD_ID` in the build workspace.
- `gke-deploy` uses a longer timeout because the agent image is large and can
  take more than 5 minutes to pull on a new node.

### 4.4 Create Secret + ConfigMap (one-time or when values change)

```bash
cp env/prod/secrets.env.example env/prod/secrets.env
cp env/prod/config.env.example env/prod/config.env

# Update these before applying:
# - SESSION_SECRET
# - POSTGRES_PASSWORD
# - GEMINI_API_KEY / RAG_LLM_API_KEY
# - S3_PUBLIC_BASE_URL (use /helpudoc when behind HTTPS)
# - AUTH_MODE=hybrid
# - SESSION_COOKIE_DOMAIN=.lc-demo.com
# - GOOGLE_OAUTH_CLIENT_ID
# - GOOGLE_OAUTH_REDIRECT_URI=https://lc-demo.com/api/auth/google/callback
# - GOOGLE_OAUTH_POST_LOGIN_REDIRECT=https://lc-demo.com/login
# - GOOGLE_OAUTH_SCOPES must include https://www.googleapis.com/auth/cloud-platform for google-developer-knowledge
# - GOOGLE_DEVELOPER_KNOWLEDGE_PROJECT_ID=my-rd-coe-demo-gen-ai
# - GCP_COST_SERVICE_ACCOUNT_JSON_B64 (recommended if gcp-cost cannot use node ADC)
# - GOOGLE_OAUTH_CLIENT_SECRET (in secrets.env)
# - OAUTH_TOKEN_ENCRYPTION_KEY (in secrets.env)
# - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (in secrets.env, for AWS Pricing MCP)
# - AWS_REGION=us-east-1 (in config.env)

kubectl apply -f infra/gke/k8s/00-namespace.yaml
kubectl -n helpudoc create secret generic helpudoc-secrets --from-env-file=env/prod/secrets.env
kubectl -n helpudoc create configmap helpudoc-config --from-env-file=env/prod/config.env
```

> **Important:** For HTTPS + Caddy, set `S3_PUBLIC_BASE_URL=/helpudoc` so browsers do not request `http://localhost:9000`.

### 4.5 Apply Kubernetes manifests

```bash
kubectl apply -f infra/gke/k8s/00-namespace.yaml
kubectl apply -f infra/gke/k8s/30-storage.yaml
kubectl apply -f infra/gke/k8s/40-postgres.yaml
kubectl apply -f infra/gke/k8s/41-redis.yaml
kubectl apply -f infra/gke/k8s/42-minio.yaml
kubectl apply -f infra/gke/k8s/43-minio-setup.yaml
kubectl apply -f infra/gke/k8s/44-clickhouse.yaml
kubectl apply -f infra/gke/k8s/45-langfuse.yaml
kubectl apply -f infra/gke/k8s/49-skill-sandbox.yaml
kubectl apply -f infra/gke/k8s/51-aws-pricing-mcp.yaml
kubectl apply -f infra/gke/k8s/52-daily-reflection-cron.yaml
kubectl apply -f infra/gke/k8s/50-app.yaml
kubectl apply -f infra/gke/k8s/60-frontend.yaml
kubectl apply -f infra/gke/k8s/70-caddy.yaml
kubectl apply -f infra/gke/k8s/71-ingress.yaml
kubectl apply -f infra/gke/k8s/72-backendconfig.yaml
```

Storage notes:
- `infra/gke/k8s/30-storage.yaml` includes `agent-config-pvc`, used by `/api/settings/agent-config` to persist the agent runtime config at `/agent/config/runtime.yaml`.
- `skills-pvc` is mounted at `/app/skills` for the backend settings "skills" page.
- `infra/gke/k8s/49-skill-sandbox.yaml` creates namespace-scoped `Role` and
  `RoleBinding` objects for sandbox job execution. On GKE, the deploy identity
  needs Kubernetes RBAC for these resources and Cloud IAM permissions such as
  `container.roles.*` and `container.roleBindings.*` (or
  `roles/container.admin` for a dedicated deploy service account).
- `infra/gke/k8s/51-aws-pricing-mcp.yaml` runs a FastMCP HTTP proxy in front of
  the `awslabs.aws-pricing-mcp-server` stdio process so the agent can consume it
  as a normal remote MCP server inside the cluster.
- `infra/gke/k8s/52-daily-reflection-cron.yaml` creates the daily reflection
  CronJob.
- `infra/gke/k8s/72-backendconfig.yaml` creates the GKE BackendConfig used by
  the ingress/service annotations.

If you apply manifests manually, also run the Langfuse DB bootstrap once
Postgres is ready:

```bash
chmod +x infra/gke/scripts/bootstrap-langfuse-db.sh
infra/gke/scripts/bootstrap-langfuse-db.sh --wait-rollout
```

For manual deploys that should run a specific image tag, patch the workloads
after applying manifests:

```bash
IMAGE_TAG="<commit-sha-or-build-id>"
kubectl -n helpudoc set image deployment/helpudoc-app \
  backend="gcr.io/${PROJECT_ID}/helpudoc-backend:${IMAGE_TAG}" \
  agent="gcr.io/${PROJECT_ID}/helpudoc-agent:${IMAGE_TAG}"
kubectl -n helpudoc set image deployment/helpudoc-frontend \
  frontend="gcr.io/${PROJECT_ID}/helpudoc-frontend:${IMAGE_TAG}"
```

### 4.6 Get public URL and verify

```bash
kubectl -n helpudoc get svc helpudoc-caddy
```

Make sure your domain (e.g., `lc-demo.com`) points to the `EXTERNAL-IP` of `helpudoc-caddy`.

## 5) Troubleshooting

### 5.0 Verify which build is deployed

```bash
kubectl -n helpudoc get deploy helpudoc-app helpudoc-frontend -o wide
```

### 5.1 Mixed content / media 404s

If you see `http://localhost:9000/...` in the browser:

- Confirm `S3_PUBLIC_BASE_URL=/helpudoc` in the `helpudoc-config` ConfigMap
- Ensure Caddy is proxying `/helpudoc*` to `minio:9000` (see `infra/gke/k8s/70-caddy.yaml`)

### 5.2 Restart pods after config changes

```bash
kubectl -n helpudoc rollout restart deployment/helpudoc-app deployment/helpudoc-caddy
kubectl -n helpudoc rollout status deployment/helpudoc-app
kubectl -n helpudoc rollout status deployment/helpudoc-caddy
```

### 5.3 Rollback (fast)

If a rollout breaks the cluster, this is usually the quickest rollback:

```bash
kubectl -n helpudoc rollout undo deployment/helpudoc-app
kubectl -n helpudoc rollout undo deployment/helpudoc-frontend
kubectl -n helpudoc rollout status deployment/helpudoc-app
kubectl -n helpudoc rollout status deployment/helpudoc-frontend
```

## 6) Optional: E2E validation

The repo includes a Playwright test that verifies no `localhost:9000` URLs are generated:

```bash
cd frontend
npm ci
npx playwright install chromium
E2E_BASE_URL=https://lc-demo.com npm run e2e
```
