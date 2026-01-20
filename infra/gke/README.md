# GKE deployment (prototype)

This folder provides a simple GKE deployment for the full HelpUDoc stack based on the existing Docker Compose setup.
It is aimed at a working prototype. For production, consider managed services (Cloud SQL, Memorystore, and GCS) and a
separate image build/release process.

## Why GKE over Cloud Run for this repo

- The app is multi-service (backend, agent, frontend) plus stateful dependencies (Postgres, Redis, MinIO).
- The backend and agent share a workspace folder; GKE lets us mount a shared volume in a single pod.
- Cloud Run would require externalizing all state and reworking the local workspace dependency.

## Quick start (manual deploy)

1) Set GCP project + region

```sh
export PROJECT_ID=my-rd-coe-demo-gen-ai
export REGION=asia-southeast1
```

2) Create a GKE cluster (zonal)

```sh
gcloud container clusters create helpudoc \ 
  --project "${PROJECT_ID}" \ 
  --region "${REGION}" \ 
  --num-nodes 2
```

3) Configure kubectl

```sh
gcloud container clusters get-credentials helpudoc --region "${REGION}" --project "${PROJECT_ID}"
```

4) Create a Docker Artifact Registry repo

```sh
gcloud artifacts repositories create helpudoc \ 
  --project "${PROJECT_ID}" \ 
  --location "${REGION}" \ 
  --repository-format docker
```

5) Build + push images

```sh
export REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/helpudoc"

docker build -t "${REGISTRY}/helpudoc-backend:manual" backend
docker build -t "${REGISTRY}/helpudoc-agent:manual" agent
docker build -t "${REGISTRY}/helpudoc-frontend:manual" frontend

gcloud auth configure-docker "${REGION}-docker.pkg.dev"

docker push "${REGISTRY}/helpudoc-backend:manual"
docker push "${REGISTRY}/helpudoc-agent:manual"
docker push "${REGISTRY}/helpudoc-frontend:manual"
```

6) Apply Kubernetes manifests

```sh
kubectl apply -f infra/gke/k8s/00-namespace.yaml
kubectl apply -f infra/gke/k8s/10-secrets.yaml
kubectl apply -f infra/gke/k8s/20-configmap.yaml
kubectl apply -f infra/gke/k8s/30-storage.yaml
kubectl apply -f infra/gke/k8s/40-postgres.yaml
kubectl apply -f infra/gke/k8s/41-redis.yaml
kubectl apply -f infra/gke/k8s/42-minio.yaml
kubectl apply -f infra/gke/k8s/43-minio-setup.yaml
kubectl apply -f infra/gke/k8s/50-app.yaml
kubectl apply -f infra/gke/k8s/60-frontend.yaml
```

7) Update app images

```sh
kubectl -n helpudoc set image deployment/helpudoc-app \
  backend="${REGISTRY}/helpudoc-backend:manual" \
  agent="${REGISTRY}/helpudoc-agent:manual"

kubectl -n helpudoc set image deployment/helpudoc-frontend \
  frontend="${REGISTRY}/helpudoc-frontend:manual"
```

8) Get the frontend URL

```sh
kubectl -n helpudoc get svc helpudoc-frontend
```

## Notes

- The backend and agent run in a single pod to share `WORKSPACE_ROOT` on a single PVC.
- MinIO is deployed in-cluster for compatibility with the current S3 code path.
- Update `infra/gke/k8s/10-secrets.yaml` and `infra/gke/k8s/20-configmap.yaml` with real values before deploying.
- For production, move Postgres/Redis/MinIO to managed services and use a real RWX storage class (Filestore) if you
  split backend and agent into separate pods.

## GitHub Actions (optional)

If you want GitHub Actions to deploy automatically, see `.github/workflows/deploy-gke.yml`.
It uses Workload Identity Federation. Create a Workload Identity Provider + Service Account and add repository secrets:

- `GCP_PROJECT_ID` (e.g. `my-rd-coe-demo-gen-ai`)
- `GCP_REGION` (e.g. `asia-southeast1`)
- `GKE_CLUSTER` (e.g. `helpudoc`)
- `GCP_WORKLOAD_PROVIDER` (the full provider resource name)
- `GCP_SERVICE_ACCOUNT` (service account email)

Example setup commands:

```sh
export PROJECT_ID=my-rd-coe-demo-gen-ai
export REGION=asia-southeast1
export SA_NAME=helpudoc-github

# Service account
gcloud iam service-accounts create "${SA_NAME}" --project "${PROJECT_ID}"

# Grant minimal roles
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/container.developer
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/artifactregistry.writer

# Create Workload Identity pool/provider (example)
gcloud iam workload-identity-pools create "github-pool" --project "${PROJECT_ID}" --location="global"
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project "${PROJECT_ID}" --location="global" --workload-identity-pool="github-pool" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"

# Allow GitHub repo to impersonate SA
gcloud iam service-accounts add-iam-policy-binding \
  "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github-pool/attribute.repository/ORG/REPO"
```

Replace `ORG/REPO` with your GitHub org/repo.
