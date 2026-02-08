# CI/CD (Cloud Build + GKE)

This document describes how HelpUDoc is built and deployed to GKE using Google Cloud Build and the Kubernetes manifests under `infra/gke/k8s/`.

For local development and one-time cluster setup, start with `docs/deploy.md`.

## Overview

The deployment pipeline is `infra/cloudbuild.yaml`.

It:
1. Builds and pushes three images to `gcr.io/$PROJECT_ID/*`:
   - `helpudoc-backend`
   - `helpudoc-agent`
   - `helpudoc-frontend`
2. Tags each image with both `$BUILD_ID` and `latest`.
3. Rewrites the image tags in the manifests (in the Cloud Build workspace only) to use `$BUILD_ID`.
4. Applies `infra/gke/k8s/` via `gke-deploy`.
5. Optionally runs Playwright E2E to catch mixed-content / localhost-asset regressions.

Important: the repo manifests intentionally keep `:latest` in git. Cloud Build pins the deployed release to a specific `$BUILD_ID` at deploy time.

## One Command Deploy (Manual)

Prereqs:
- `gcloud` authenticated
- You have access to the GCP project and the GKE cluster

```bash
export PROJECT_ID=my-rd-coe-demo-gen-ai
export GKE_LOCATION=asia-southeast1-a   # zone or region (must match the cluster)
export CLUSTER=helpudoc-cluster

gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config=infra/cloudbuild.yaml \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=false
```

If you want E2E:
```bash
gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config=infra/cloudbuild.yaml \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=true,_E2E_BASE_URL="https://lc-demo.com"
```

Notes:
- `gke-deploy` uses a longer `--timeout` because the agent image is large and may take more than 5 minutes to pull on a new node.
- The manifest rewrite step is tag-agnostic, so it works even if the manifests already contain a previous `$BUILD_ID` (prevents "sticky tags").

## Recommended Cloud Build Trigger (Auto)

Set up a Cloud Build trigger (in GCP Console) that:
- Triggers on pushes to `master`
- Uses config file: `infra/cloudbuild.yaml`
- Sets substitutions:
  - `_GKE_CLUSTER=helpudoc-cluster`
  - `_GKE_LOCATION=asia-southeast1-a` (or your region if the cluster is regional)
  - `_RUN_E2E=false` by default
  - `_E2E_BASE_URL=https://...` only if `_RUN_E2E=true`

This gives you "push to master => build => deploy" without running commands locally.

## What Gets Persisted (PVCs)

GKE storage is defined in `infra/gke/k8s/30-storage.yaml`.

Key mounts used by the app:
- `skills-pvc` mounted at `/app/skills` (backend reads this via `SKILLS_ROOT`).
- `agent-config-pvc` mounted at `/agent/config` (backend reads runtime config via `AGENT_CONFIG_PATH=/agent/config/runtime.yaml`).

If the settings pages are broken in a new cluster, confirm these PVCs exist and are mounted into the `helpudoc-app` deployment.

## Verify a Deployment

Check which images are running:
```bash
kubectl -n helpudoc get deploy helpudoc-app helpudoc-frontend -o wide
```

Check rollouts:
```bash
kubectl -n helpudoc rollout status deployment/helpudoc-app
kubectl -n helpudoc rollout status deployment/helpudoc-frontend
```

Check logs:
```bash
kubectl -n helpudoc logs deploy/helpudoc-app -c backend --tail=200
kubectl -n helpudoc logs deploy/helpudoc-app -c agent --tail=200
```

## Rollback

Fast rollback to previous ReplicaSet:
```bash
kubectl -n helpudoc rollout undo deployment/helpudoc-app
kubectl -n helpudoc rollout undo deployment/helpudoc-frontend
kubectl -n helpudoc rollout status deployment/helpudoc-app
kubectl -n helpudoc rollout status deployment/helpudoc-frontend
```

If you need a specific version, redeploy by running Cloud Build again (it will generate a new `$BUILD_ID`) or manually patch images (not recommended as the default workflow).

## Troubleshooting

### Cloud Build says FAIL but the cluster is still updating

Most commonly: the rollout exceeded the readiness wait.

Actions:
1. Check rollout status in the cluster:
   ```bash
   kubectl -n helpudoc rollout status deployment/helpudoc-app
   kubectl -n helpudoc rollout status deployment/helpudoc-frontend
   ```
2. If rollouts are still progressing, wait.
3. If stuck, inspect pods/events:
   ```bash
   kubectl -n helpudoc get pods -o wide
   kubectl -n helpudoc describe pod <pod-name>
   ```

### Agent image pull is slow on new nodes

The agent image is large; a fresh node may take several minutes to pull it. This is why `gke-deploy` uses an extended timeout.

### E2E failures

The E2E step primarily exists to catch mixed-content / localhost asset URLs (e.g. `http://localhost:9000/...`).

If you hit that regression:
- Verify `S3_PUBLIC_BASE_URL` in the `helpudoc-config` ConfigMap (commonly `/helpudoc` when behind HTTPS + Caddy).
- Verify Caddy routes in `infra/gke/k8s/70-caddy.yaml`.

