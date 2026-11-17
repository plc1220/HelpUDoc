# Zaku deployment steps

Working plan for deploying the full HelpUDoc stack to zaku, a single-node ZStack Kubernetes cluster (v1.35.1). Branch `chore/adapt-zaku`. Manifests live in `infra/zaku/k8s`, copied from `infra/gke/k8s`.

## Cluster facts

| Item | Value |
|---|---|
| Nodes | 1 (`zaku`), control-plane and worker. 64 CPU, about 500 GB RAM, no GPU resource listed |
| kubectl context | `admin@management-cluster` |
| Access | You are cluster-admin |
| StorageClass | `edge-lvm`, not marked default. Reclaim policy `Delete`, so deleting a PVC deletes its data |
| IngressClass | `zstack-ingress` (nginx). Ingress IP 10.3.100.103. ZStack's `zstack-gateway` Ingress already takes host `*` |
| TLS | cert-manager is installed, but no issuer is usable for our app |
| MetalLB | One IP (10.3.100.105). Don't use `type: LoadBalancer` |
| Registry | Keep GCR / Artifact Registry. Harbor exists on zaku but has no outside address |
| RuntimeClass | None. The sandbox policy requires `gvisor`, so code-running sandbox Jobs fail on zaku (U8). The rest of the app is unaffected |
| Gemini | GKE uses Vertex AI through the node identity. Zaku uses `GEMINI_API_KEY` instead, added to the agent container in `50-app.yaml` |
| DNS | nodelocaldns at 169.254.25.10 |
| Network | Calico enforces NetworkPolicy |

## Implementation steps

| # | Step | Status |
|---|---|---|
| 1 | Local kubectl reaches zaku | Done |
| 2 | Branch `chore/adapt-zaku`, copy to `infra/zaku/k8s` | Done, not committed |
| 3a | Connectivity checks: storage, PyPI, AWS | In progress |
| 3b | Connectivity check: private image pull | Blocked by U3 |
| 4 | Edit `infra/zaku/k8s` (see list below) | Gemini env done, rest ready |
| 5a | Generate internal secrets into `env/prod/secrets.env` | Ready |
| 5b | Add external-account secrets | Blocked by U4 |
| 5c | Create namespaces, Secret, ConfigMap, pull secret | Blocked by U3, U4 |
| 6 | Deploy in stages (see order below) | Waits for 3 to 5 |
| 7 | Run the CronJob once by hand, confirm timezone, enable it | After 6 |
| 8 | Write `infra/zaku/README.md` | Can start now |

### Step 4 edits

- `30-storage.yaml`: add `storageClassName: edge-lvm` to all 8 PVCs.
- Pull secret: attach it to the `default` and `helpudoc-agent` service accounts in `helpudoc`, and to `helpudoc-sandbox-runner` in `helpudoc-sandbox`. Pods inherit it from their service account. The agent's sandbox Jobs set no pull secret of their own, so this is the only way they get one.
- `71-ingress.yaml`: remove both `ManagedCertificate` objects and the `FrontendConfig`. Set `ingressClassName: zstack-ingress`, drop the GKE annotations, use a placeholder hostname until U5 is answered.
- `72-backendconfig.yaml`: delete it. It is GKE-only.
- `70-caddy.yaml`: remove the two `cloud.google.com/*` annotations. Replace `lc-demo.com` in the Caddyfile.
- `43-minio-setup.yaml`, `46-minio-private-object-policy.yaml`: pin `minio/mc:latest` to a fixed version.
- `50-app.yaml`: agent reads `GEMINI_API_KEY` from `helpudoc-secrets`. Done.
- `49-skill-sandbox.yaml`: apply unchanged for now. Leave `HELPUDOC_SANDBOX_RUNTIME_CLASS` unset in `config.env`. Sandbox Jobs get rejected until U8 is settled.

### Step 6 deploy order

Check each stage with `kubectl -n helpudoc get pods,pvc,jobs` before moving on.

1. Namespaces and storage (`00`, `02`, `30`)
2. Postgres, Redis, MinIO (`40`, `41`, `42`), then the MinIO setup Jobs (`43`, `46`)
3. ClickHouse and Langfuse (`44`, `45`)
4. Sandbox permissions, app, frontend (`49`, `50`, `60`)
5. Caddy and Ingress (`70`, `71`)
6. AWS pricing MCP (`51`)
7. Daily reflection CronJob (`52`), after step 7 of the plan

## Unresolved items

| # | Item | Blocks | Who | Status |
|---|---|---|---|---|
| U3 | Service account `zaku-image-puller` is created. It still needs `roles/artifactregistry.reader` on repos `gcr.io` (us) and `helpudoc` (asia-southeast1). Your roles can't grant it (`IAM_PERMISSION_DENIED`). Create its JSON key after the grant | 3b, 5c, most of 6 | Senior | Asked |
| U4 | Gemini key is in `secrets.env`. Still open: OAuth client secret, AWS keys, GCP cost service account, and whether internal secrets reuse production values or get generated fresh | 5b | Senior | Asked |
| U5 | Hostname and TLS for the Ingress | Real URL, Google login on a hostname | ZStack team | On hold. Test through a localhost port-forward |
| U6 | Splitting zaku into smaller worker VMs, and whether they share one physical host | Nothing | ZStack team | On hold. Stay single-node |
| U7 | Add `http://localhost:8080/api/auth/google/callback` as a redirect URI, and `http://localhost:8080` as a JavaScript origin, on the OAuth client `16646144790-fvdv...apps.googleusercontent.com`. It lives in project number 16646144790, which your account can't see | Login testing through port-forward | Senior or client owner | Asked |
| U8 | Sandbox Jobs require RuntimeClass `gvisor`, which zaku doesn't have. Either the ZStack team installs gVisor on the node, or a zaku policy drops the check and accepts weaker isolation for agent-run code | Only agent features that run code. Not a deploy blocker | Senior, ZStack team | Asked. Proceeding without gVisor |

## Connectivity checks

Tested and working:

1. Laptop to zaku with kubectl.
2. Cluster-admin permissions.
3. Pod DNS through nodelocaldns.
4. Pod to internet over HTTPS (google.com, Gemini API host resolves).
5. Pulling public images from Docker Hub.

Not tested yet:

6. Storage: a PVC on `edge-lvm` binds and a pod can write to it (step 3a).
7. PyPI: both MCP containers install packages at startup (step 3a).
8. AWS pricing API reachable from a pod (step 3a).
9. Private image pull from GCR with the pull secret (step 3b).
10. Gemini with a real key: the agent's first chat.
11. Ingress at 10.3.100.103 after the Ingress exists.
12. Laptop to app through port-forward.
13. Google login. Google accepts `http://` redirect URIs only for localhost, so a hostname needs TLS (U5).

## Warnings

- `gcloud container clusters get-credentials` switches kubectl to the GKE production cluster. Run `kubectl config use-context admin@management-cluster` right after, or a later `kubectl apply` hits production.
- Never put real values in a committed file. `env/**/*.env` is in `.gitignore`.
- The manifests use `imagePullPolicy: Always`, so the pull secret must stay valid for every pod restart. A one-hour access token is not enough.
