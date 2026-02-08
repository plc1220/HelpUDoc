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

docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up -d postgres redis minio minio-setup

set -a; source env/local/dev.env; set +a

cd backend && ENV_FILE=../env/local/dev.env npm run dev
cd agent && ENV_FILE=../env/local/dev.env uvicorn main:app --host 0.0.0.0 --port 8001 --reload
cd frontend && npm run dev
```

## 3) Local full-stack (Docker Compose)

```bash
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up --build
```

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

### 4.2 Build and push images (Cloud Build)

This is the recommended deploy path for GKE.

What it does:
- builds and pushes `helpudoc-backend`, `helpudoc-frontend`, `helpudoc-agent`
- rewrites the Kubernetes manifest image tags to the Cloud Build `$BUILD_ID` (in the build workspace only)
- runs `gke-deploy` to apply `infra/gke/k8s/*`

```bash
gcloud builds submit . \
  --config=infra/cloudbuild.yaml \
  --project="$PROJECT_ID" \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=false
```

Notes:
- The repo manifests intentionally reference `:latest`. Cloud Build pins them to `$BUILD_ID` at deploy time.
- `gke-deploy` uses a longer timeout because the agent image is large and can take >5 minutes to pull on a new node.

See `docs/ci-cd.md` for Cloud Build trigger setup and troubleshooting.

### 4.3 Create Secret + ConfigMap (one-time or when values change)

```bash
cp env/prod/secrets.env.example env/prod/secrets.env
cp env/prod/config.env.example env/prod/config.env

# Update these before applying:
# - SESSION_SECRET
# - POSTGRES_PASSWORD
# - GEMINI_API_KEY / RAG_LLM_API_KEY
# - S3_PUBLIC_BASE_URL (use /helpudoc when behind HTTPS)

kubectl apply -f infra/gke/k8s/00-namespace.yaml
kubectl -n helpudoc create secret generic helpudoc-secrets --from-env-file=env/prod/secrets.env
kubectl -n helpudoc create configmap helpudoc-config --from-env-file=env/prod/config.env
```

> **Important:** For HTTPS + Caddy, set `S3_PUBLIC_BASE_URL=/helpudoc` so browsers do not request `http://localhost:9000`.

### 4.4 Apply Kubernetes manifests

```bash
kubectl apply -f infra/gke/k8s/30-storage.yaml
kubectl apply -f infra/gke/k8s/40-postgres.yaml
kubectl apply -f infra/gke/k8s/41-redis.yaml
kubectl apply -f infra/gke/k8s/42-minio.yaml
kubectl apply -f infra/gke/k8s/43-minio-setup.yaml
kubectl apply -f infra/gke/k8s/50-app.yaml
kubectl apply -f infra/gke/k8s/60-frontend.yaml
kubectl apply -f infra/gke/k8s/70-caddy.yaml
```

Storage notes:
- `infra/gke/k8s/30-storage.yaml` includes `agent-config-pvc`, used by `/api/settings/agent-config` to persist the agent runtime config at `/agent/config/runtime.yaml`.
- `skills-pvc` is mounted at `/app/skills` for the backend settings "skills" page.

### 4.5 Get public URL and verify

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
