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
docker compose -f infra/docker-compose.yml --env-file env/local/stack.env up -d postgres redis minio minio-setup
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
