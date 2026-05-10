# CI/CD (GitHub Actions + GKE)

This document describes how HelpUDoc is built and deployed to GKE using GitHub Actions and the Kubernetes manifests under `infra/gke/k8s/`.

For local development and one-time cluster setup, start with `docs/deploy.md`.

## Overview

### Pull request CI (`ci.yml`)

On every pull request and push to `master` / `main`, `.github/workflows/ci.yml` runs.

**When jobs run**

- A **`changes`** job uses [`dorny/paths-filter`](https://github.com/dorny/paths-filter) so unrelated PRs skip stacks they did not touch (for example, a frontend-only PR skips backend tests and backend Docker validation).
- On **push to `master` or `main`** (including after a PR merge), **all** test and Docker validation jobs run so the default branch always gets a full pass.
- **Agent Docker** runs on **default-branch pushes only** (with `load: true` and `docker run … smoke_import.py`) so PRs that touch `agent/` are not charged twice for heavy dependencies (once for `pip install -r agent/requirements.txt` in **python-agent**, again inside a full image build). Merge to main still proves the image builds and that imports succeed inside the container.

**Jobs (parallel where enabled)**

- **Backend tests** — `cd backend && npm test`
- **Frontend** — `cd frontend && npm run lint && npm run build`
- **Python agent** — installs `agent/requirements.txt` plus `pytest`, then runs `tests/test_agent_import_smoke.py`, `tests/test_agent_configuration.py`, `tests/test_mcp_binding.py`, and `tests/test_tool_factory.py`
- **Docker build validation (no push)** — `docker/build-push-action@v6` with GitHub Actions cache (`cache-from` / `cache-to` `type=gha`, separate scope per image). These verify Dockerfile syntax, base image pulls, installs, and copy steps; they do **not** push, vulnerability-scan, or deploy. Backend/frontend builds do not load the image into the runner. The agent job on main **loads** the image and runs `python /app/agent/scripts/smoke_import.py` inside the container.

**Branch protection:** require the **`CI status`** (`ci-gate`) job so one check reflects the whole workflow (skipped jobs count as success for the gate).

**Secret scanning:** `.github/workflows/secret-scan.yml` still runs on its own triggers (`push` / `pull_request`). It is not folded into `ci.yml`; keep it as a separate required check if your branch protection rules need it.

### Manual deploy: `deploy-gke.yml`

The primary deploy pipelines are GitHub workflows:
- `.github/workflows/deploy-gke.yml` (full stack)
- `.github/workflows/deploy-frontend-gke.yml` (frontend only)
- `.github/workflows/deploy-backend-gke.yml` (backend only)
- `.github/workflows/deploy-agent-gke.yml` (agent only)
- `.github/workflows/deploy-langfuse-gke.yml` (ClickHouse + Langfuse only: storage, manifests, Postgres `langfuse` DB bootstrap, rollout health)

**Deploy Full Stack to GKE** (`.github/workflows/deploy-gke.yml`) is manual-only and supports component toggles, registry Buildx cache, infra gating, and post-rollout smoke checks.

When you run **Deploy Full Stack to GKE**, configure these `workflow_dispatch` inputs:

| Input | Default | Purpose |
| --- | ---: | --- |
| `build_backend` | true | Build/push `helpudoc-backend` and patch the backend + reflection CronJob images when true. |
| `build_frontend` | true | Build/push `helpudoc-frontend` and patch the frontend deployment when true. |
| `build_agent` | true | Build/push `helpudoc-agent`, patch the agent container, align init-container seed images, and run the image smoke import after push. |
| `deploy_infra` | false | When true: RBAC preflight, `kubectl apply -f infra/gke/k8s/`, first-time demo ConfigMap bootstrap, Langfuse key patching + DB bootstrap/wait. When false: skips manifest/bootstrap work (cluster must already have `helpudoc-config`). |
| `sync_runtime_assets` | false | Legacy `kubectl exec` sync of `skills/` and `agent/config/runtime.yaml` into PVCs. Prefer init-container seeding (see `docs/deploy.md`); leave false unless you need the old bridge. |
| `environment` | empty | Echo-only label for operators (does not switch GitHub Environment protection rules). |
| `image_tag_suffix` | empty | Appended to `github.sha` for all image tags in that run (for example `-hotfix1`). |

At least one of `build_backend`, `build_frontend`, or `build_agent` must be true.

**Buildx registry cache:** each image build uses `docker buildx build` with `--cache-from` / `--cache-to` pointing at `gcr.io/$PROJECT_ID/helpudoc-buildcache-{backend,frontend,agent}:buildcache` so repeated builds reuse layers.

**Post-deploy smoke checks** (always after rollout wait): an ephemeral `curlimages/curl` pod hits `http://backend.helpudoc.svc.cluster.local:3000/api/health` and fetches the frontend service root; the workflow then runs `python -c 'urllib.request.urlopen("http://127.0.0.1:8001/health")...'` inside the `agent` container of `deployment/helpudoc-app`.

The smaller **Deploy Frontend / Backend / Agent to GKE** workflows still build one image at a time and patch the matching deployment. Prefer **`deploy-gke.yml`** when you want Buildx cache, component toggles, and smoke checks in one place.

**Langfuse-only:** **`Deploy Langfuse to GKE`** applies `30-storage.yaml`, `44-clickhouse.yaml`, and `45-langfuse.yaml`, validates required `helpudoc-config` / `helpudoc-secrets` keys, runs `infra/gke/scripts/bootstrap-langfuse-db.sh --wait-rollout`, and waits for Langfuse web/worker rollouts.

In **`deploy-gke.yml`**, when **`deploy_infra` is true**, the workflow applies `infra/gke/k8s/`, creates the demo `helpudoc-config` only if it is missing (`infra/gke/bootstrap/20-configmap.demo.yaml`), runs Langfuse key patching + DB bootstrap, then merges OAuth keys from GitHub secrets. When **`deploy_infra` is false**, none of that runs: the cluster must already have `helpudoc-config` and the workloads you expect (run an infra deploy first on a brand-new cluster). Routine app deploys should keep **`deploy_infra` false** so image tags and rollouts are the only mutations.

## One Command Deploy (Manual)

Prereqs:
- `gcloud` authenticated
- You have access to the GCP project and the GKE cluster

### Full Stack (Backend + Agent + Frontend)
```bash
export PROJECT_ID=my-rd-coe-demo-gen-ai
export GKE_LOCATION=asia-southeast1-a   # zone or region (must match the cluster)
export CLUSTER=helpudoc-cluster

gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config=infra/cloudbuild.yaml \
  --substitutions=_GKE_LOCATION="$GKE_LOCATION",_GKE_CLUSTER="$CLUSTER",_RUN_E2E=false
```

### Frontend Only
Use `infra/cloudbuild-frontend.yaml` to rebuild and deploy only `helpudoc-frontend` (it applies only `infra/gke/k8s/60-frontend.yaml`).

```bash
export PROJECT_ID=my-rd-coe-demo-gen-ai
export GKE_LOCATION=asia-southeast1-a   # zone or region (must match the cluster)
export CLUSTER=helpudoc-cluster

gcloud builds submit . \
  --project="$PROJECT_ID" \
  --config=infra/cloudbuild-frontend.yaml \
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

## GitHub Actions Trigger

All deploy workflows are manual-only (`workflow_dispatch`) to avoid accidental rollouts on every push.

Run one of these in GitHub Actions:
- `Deploy Full Stack to GKE`
- `Deploy Frontend to GKE`
- `Deploy Backend to GKE`
- `Deploy Agent to GKE`
- `Deploy Langfuse to GKE`

## What Gets Persisted (PVCs)

GKE storage is defined in `infra/gke/k8s/30-storage.yaml` (includes `clickhouse-pvc` for Langfuse).

Key mounts used by the app:
- `skills-pvc` mounted at `/app/skills` (backend reads this via `SKILLS_ROOT`). On pod start, init containers may copy bundled skills from the agent image into an **empty** PVC once; see `docs/deploy.md`.
- `agent-config-pvc` mounted at `/agent/config` (backend reads runtime config via `AGENT_CONFIG_PATH=/agent/config/runtime.yaml`). Init containers may copy bundled `runtime.yaml` from the agent image when the PVC file is missing.
- `workspace-pvc` mounted at `/app/workspaces` (user data; deploy sync does not modify this path).

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

### Google OAuth callback/state errors

If users see `state_mismatch` or `oauth_callback_failed`, check these first:

1. Canonical callback URI:
   - `GOOGLE_OAUTH_REDIRECT_URI` should be exactly:
     - `https://lc-demo.com/api/auth/google/callback`
2. Post-login redirect:
   - `GOOGLE_OAUTH_POST_LOGIN_REDIRECT` should be:
     - `https://lc-demo.com/login`
3. OAuth secret values:
   - `GOOGLE_OAUTH_CLIENT_SECRET` must be present
   - `OAUTH_TOKEN_ENCRYPTION_KEY` must be present
4. Session cookie domain:
   - `SESSION_COOKIE_DOMAIN=.lc-demo.com` so apex and `www` share session state.
5. Caddy proxy header forwarding:
   - `/api` proxy must forward `X-Forwarded-Proto=https` to backend; otherwise secure cookies may not be set.

### Default admin bootstrap

- Admin bootstrap is optional and disabled by default.
- It is keyed by `users.externalId` (not email), and performs an upsert + `isAdmin=true`.
- Recommended practice:
  1. Use it only for first-time setup.
  2. Use your real identity provider external ID as the bootstrap value.
  3. Remove/blank bootstrap values after initialization to avoid persistent backdoor semantics.

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

### `Trigger Cloud Build deploy` fails before the build starts

If GitHub Actions fails in the `gcloud builds submit` step with either of the errors below, the problem is in GCP project configuration, not in the repo:

1. Missing project `environment` tag:
   ```text
   Project '...' lacks an 'environment' tag
   ```
   Fix by creating the required Resource Manager tag binding on the GCP project. Your organization policy is enforcing this before Cloud Build can run.

2. Forbidden from accessing `[PROJECT_ID]_cloudbuild` bucket:
   ```text
   ERROR: (gcloud.builds.submit) The user is forbidden from accessing the bucket [...]
   ```
   Fix by granting the identity used by GitHub Actions enough access to submit builds and use the Cloud Build staging bucket. In practice this usually means:
   - Cloud Build Editor or a custom role that can create builds
   - Storage access to the Cloud Build staging bucket
   - `serviceusage.services.use` permission on the project

If you are using Workload Identity Federation, apply those permissions to `${{ secrets.GCP_SERVICE_ACCOUNT }}`. If you are using a JSON key, apply them to that service account instead.

### Agent image pull is slow on new nodes

The agent image is large; a fresh node may take several minutes to pull it. This is why `gke-deploy` uses an extended timeout.

### E2E failures

The E2E step primarily exists to catch mixed-content / localhost asset URLs (e.g. `http://localhost:9000/...`).

If you hit that regression:
- Verify `S3_PUBLIC_BASE_URL` in the `helpudoc-config` ConfigMap (commonly `/helpudoc` when behind HTTPS + Caddy).
- Verify Caddy routes in `infra/gke/k8s/70-caddy.yaml`.
