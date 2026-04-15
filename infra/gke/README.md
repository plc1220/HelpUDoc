# HelpUDoc GKE deployment

This directory contains the Kubernetes assets for running HelpUDoc on Google Kubernetes Engine.

It is organized around two kinds of files:

- `k8s/`: manifests that are meant to be applied to a cluster
- `templates/`: reference templates for config data that should be turned into real Secrets and ConfigMaps

## What gets deployed

The GKE setup covers the same services as local Compose:

- backend API
- agent service
- frontend
- PostgreSQL
- Redis
- MinIO
- ClickHouse (for Langfuse v3)
- Langfuse web + worker (LLM observability)
- Caddy ingress/proxy components

The backend and agent are intentionally co-located around shared workspace/config volumes to match the current application architecture.

## Directory map

| Path | Purpose |
| ---- | ------- |
| `k8s/00-namespace.yaml` | Namespace creation |
| `k8s/30-storage.yaml` | PVCs for workspaces, agent config, and skills |
| `k8s/40-postgres.yaml` | PostgreSQL workload |
| `k8s/41-redis.yaml` | Redis workload |
| `k8s/42-minio.yaml` | MinIO workload |
| `k8s/43-minio-setup.yaml` | Bucket/bootstrap job (includes `langfuse` bucket) |
| `k8s/44-clickhouse.yaml` | ClickHouse for Langfuse |
| `k8s/45-langfuse.yaml` | Langfuse web + worker + `langfuse-web` Service |
| `k8s/50-app.yaml` | Combined backend + agent application deployment |
| `k8s/60-frontend.yaml` | Frontend deployment/service |
| `k8s/70-caddy.yaml` | Caddy proxy deployment/service |
| `k8s/71-ingress.yaml` | GKE ingress |
| `k8s/72-backendconfig.yaml` | GKE BackendConfig |
| `templates/10-secrets.yaml` | Example secret template |
| `templates/20-configmap.yaml` | Example config template |
| `scripts/bootstrap-langfuse-db.sh` | Idempotent `CREATE DATABASE langfuse` + optional Langfuse rollout wait (used by Cloud Build and GitHub Actions) |

## Prerequisites

- `gcloud`, `kubectl`, and Docker
- a GCP project with Artifact Registry and GKE enabled
- a created GKE cluster
- production env files prepared from `env/prod/*.example`

## Recommended deploy path: Cloud Build

From the repo root, the most reliable path is:

1. Create production env files:
   ```bash
   cp env/prod/secrets.env.example env/prod/secrets.env
   cp env/prod/config.env.example env/prod/config.env
   ```
2. Fill in the real values for database passwords, session secrets, OAuth settings, Gemini keys, storage URLs, and **Langfuse** keys (`CLICKHOUSE_PASSWORD`, `LANGFUSE_*` — see `env/prod/secrets.env.example` and `env/prod/config.env.example`).
3. Point **`LANGFUSE_NEXTAUTH_URL`** at the public Langfuse origin (must match the Ingress host). The sample Ingress uses `langfuse.lc-demo.com`; add a DNS **A** record for that host to the same load balancer IP as the main app, and include the domain in `ManagedCertificate` (already listed in `k8s/71-ingress.yaml` for the demo hostname).
4. Authenticate to the cluster:
   ```bash
   gcloud container clusters get-credentials <CLUSTER> --region <REGION> --project <PROJECT_ID>
   ```
5. Create namespace and config objects:
   ```bash
   kubectl apply -f infra/gke/k8s/00-namespace.yaml
   kubectl -n helpudoc create secret generic helpudoc-secrets --from-env-file=env/prod/secrets.env
   kubectl -n helpudoc create configmap helpudoc-config --from-env-file=env/prod/config.env
   ```
6. Submit the build and deploy pipeline:
   ```bash
   gcloud builds submit . \
     --config=infra/cloudbuild.yaml \
     --project=<PROJECT_ID> \
     --substitutions=_GKE_LOCATION=<REGION_OR_ZONE>,_GKE_CLUSTER=<CLUSTER>,_RUN_E2E=false
   ```

Cloud Build handles image builds and applies the manifests in `infra/gke/k8s/`, then runs `infra/gke/scripts/bootstrap-langfuse-db.sh --wait-rollout` so the Langfuse Postgres database exists before rollouts are considered successful.

### GitHub Actions: Langfuse-only

For clusters where app images are already deployed but Langfuse (ClickHouse + Langfuse + DB bootstrap) must be installed or updated without a full stack build, use the **`Deploy Langfuse to GKE`** workflow (`.github/workflows/deploy-langfuse-gke.yml`). It validates required ConfigMap/Secret keys, applies `30-storage.yaml`, `44-clickhouse.yaml`, and `45-langfuse.yaml`, then runs the same bootstrap script with rollout waits. Backend and agent workflows intentionally do not apply these manifests so they cannot roll out Langfuse without its prerequisites.

## Manual manifest apply

If you need to apply manifests yourself after images already exist, apply them in this order:

```bash
kubectl apply -f infra/gke/k8s/30-storage.yaml
kubectl apply -f infra/gke/k8s/40-postgres.yaml
kubectl apply -f infra/gke/k8s/41-redis.yaml
kubectl apply -f infra/gke/k8s/42-minio.yaml
kubectl apply -f infra/gke/k8s/43-minio-setup.yaml
kubectl apply -f infra/gke/k8s/44-clickhouse.yaml
kubectl apply -f infra/gke/k8s/45-langfuse.yaml
kubectl apply -f infra/gke/k8s/50-app.yaml
kubectl apply -f infra/gke/k8s/60-frontend.yaml
kubectl apply -f infra/gke/k8s/70-caddy.yaml
kubectl apply -f infra/gke/k8s/71-ingress.yaml
kubectl apply -f infra/gke/k8s/72-backendconfig.yaml
```

After `45-langfuse.yaml` (with Postgres running), create the `langfuse` database and wait for Langfuse to become ready:

```bash
infra/gke/scripts/bootstrap-langfuse-db.sh --wait-rollout
```

If you are not using Cloud Build's image-tag rewriting, update the deployment image references yourself with `kubectl set image` or by editing the manifests before apply.

## Storage and config notes

- `30-storage.yaml` provisions PVCs used by workspaces, agent config, and shared skills.
- The backend settings UI expects a writable skills mount and a writable `runtime.yaml` mount.
- `templates/` files are examples only; the live cluster normally gets `helpudoc-secrets` and `helpudoc-config` from `kubectl create ... --from-env-file`.

## Verification

Check the main public entrypoint:

```bash
kubectl -n helpudoc get svc helpudoc-caddy
```

Then verify rollout state:

```bash
kubectl -n helpudoc get deploy,pods
```

## Related docs

- [../../docs/deploy.md](../../docs/deploy.md)
- [../../docs/ci-cd.md](../../docs/ci-cd.md)
- [../../docs/environment.md](../../docs/environment.md)
