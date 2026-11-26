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
| RuntimeClass | None. The sandbox policy requires `gvisor` |
| DNS | nodelocaldns at 169.254.25.10 |
| Network | Calico enforces NetworkPolicy |
| Gemini | GKE uses Vertex AI through the node identity. Zaku uses `GEMINI_API_KEY`, added to the agent container in `50-app.yaml` |

## Decisions

| Topic | Decision | Source |
|---|---|---|
| Registry | Keep GCR. Pull secret from service account `zaku-image-puller` | Senior |
| External secrets | Reuse production values: OAuth client secret, AWS keys, GCP cost service account. Copy from GKE `helpudoc-secrets` | Senior |
| Internal secrets | Generate a new set for zaku and share it with the working group | Senior |
| Hostname | `lumo-studio.cloudmile-coe.com` (senior's suggestion, confirm with ZStack). No DNS record exists yet. The `cloudmile-coe.com` zone is on Google Cloud DNS in another GCP project | Senior |
| Login testing | Through the hostname with HTTPS, not localhost | Senior |
| gVisor | Keep it. Ask ZStack to install gVisor and the `gvisor` RuntimeClass | Senior |
| Nodes | Stay single-node for now | Senior |

## Implementation steps

| # | Step | Status |
|---|---|---|
| 1 | Local kubectl reaches zaku | Done |
| 2 | Branch `chore/adapt-zaku`, copy to `infra/zaku/k8s` | Done, not committed |
| 3a | Connectivity checks: storage, PyPI, AWS | Done 2026-11-17, all pass |
| 3b | Connectivity check: private image pull | Ready. Create the SA key, then test |
| 4 | Edit `infra/zaku/k8s` (see list below) | Done 2026-11-17 except TLS section (U5b) |
| 5a | Generate internal secrets into `env/prod/secrets.env` | Ready |
| 5b | Copy external secrets from GKE `helpudoc-secrets` | Ready. Gemini key already in |
| 5c | Create namespaces, Secret, ConfigMap, pull secret `zaku-registry-pull` (in both `helpudoc` and `helpudoc-sandbox`) | After 3b |
| 6 | Deploy in stages (see order below) | Waits for 3 to 5 |
| 7 | Run the CronJob once by hand, confirm timezone, enable it | After 6 |
| 8 | Write `infra/zaku/README.md` | Can start now |

### Step 4 edits

- Done: `30-storage.yaml` sets `storageClassName: edge-lvm` on all 8 PVCs.
- Done: pull secret `zaku-registry-pull` on service accounts `default` (new object in `00-namespace.yaml`) and `helpudoc-agent` in `helpudoc`, and `helpudoc-sandbox-runner` in `helpudoc-sandbox` (`49-skill-sandbox.yaml`). Pods inherit it from their service account.
- Done: `49-skill-sandbox.yaml` drops the GKE Workload Identity annotation from `helpudoc-agent`.
- Done: `50-app.yaml` adds `GEMINI_API_KEY`, removes the GKE-only `nodeSelector` (`iam.gke.io/gke-metadata-server-enabled`, which would keep the app pod Pending), and sets `S3_PUBLIC_ENDPOINT` to `https://lumo-studio.cloudmile-coe.com`.
- Done: `71-ingress.yaml` rewritten for `zstack-ingress`. Hosts `lumo-studio.cloudmile-coe.com` and `langfuse.lumo-studio.cloudmile-coe.com`. nginx annotations replace the BackendConfig timeout (3600s), turn off response buffering for streams, and lift the 1m body limit. `tls:` is commented out until U5b.
- Done: `72-backendconfig.yaml` deleted.
- Done: `70-caddy.yaml` drops the `cloud.google.com/*` annotations and the `lc-demo.com` apex redirect.
- Done: local `env/prod/config.env` uses the zaku hostname for the cookie domain, OAuth redirect, post-login redirect and Langfuse URL, and sets `HELPUDOC_SANDBOX_RUNTIME_CLASS=gvisor`.
- Done: ported master's RustFS cutover (PR #114, rebased onto `23d1f7df`). New `47-rustfs.yaml` with `rustfs-pvc` on `edge-lvm`. `42-minio.yaml` scales MinIO to 0 and points the `minio` Service at RustFS, so the app keeps using `http://minio:9000`. `30-storage.yaml` raises `minio-pvc` to 100Gi; with MinIO at 0 replicas, `edge-lvm` never creates that disk. `49-skill-sandbox.yaml` lets sandbox Jobs reach both.
- Done (U10): `43-minio-setup.yaml` and `46-minio-private-object-policy.yaml` use `docker.io/rustfs/rc:v0.1.37` (pinned by digest) instead of `minio/mc:latest`, matching `rustfs-setup` in `infra/docker-compose.dependencies.yml`. Pull and commands tested on zaku 2026-11-17. GKE's copies still use `minio/mc`.

### Step 6 deploy order

Check each stage with `kubectl -n helpudoc get pods,pvc,jobs` before moving on.

1. Namespaces and storage (`00`, `02`, `30`)
2. Postgres, Redis, RustFS, `minio` Service (`40`, `41`, `47`, `42`), then the bucket setup Jobs (`43`, `46`). The Jobs talk to RustFS through the `minio` Service
3. ClickHouse and Langfuse (`44`, `45`)
4. Sandbox permissions, app, frontend (`49`, `50`, `60`)
5. Caddy and Ingress (`70`, `71`)
6. AWS pricing MCP (`51`)
7. Daily reflection CronJob (`52`), after step 7 of the plan

## Open items

| # | Item | Blocks | Who | Status |
|---|---|---|---|---|
| U3 | Pull permission for `zaku-image-puller`. Senior granted `roles/artifactregistry.viewer` at project level; it includes `artifactregistry.repositories.downloadArtifacts`, so it covers both repos. Create the JSON key next | 3b, 5c, most of 6 | Senior | Granted 2026-11-17. Key not created |
| U5a | DNS record for `lumo-studio.cloudmile-coe.com` pointing to zaku's Ingress (10.3.100.103 or whatever ZStack exposes). The zone lives in another GCP project | Reaching the app by name | ZStack, DNS zone owner | To ask |
| U5b | TLS certificate for the hostname: a cert-manager issuer on zaku, or a certificate file we store as a Secret | Google login (needs HTTPS) | ZStack | To ask |
| U5c | Who can reach the hostname: public internet, VPN, or office network only. Your laptop could not open 10.3.100.103 directly | Testing in a browser | ZStack | To ask |
| U6 | Splitting zaku into smaller worker VMs, and whether they share one physical host | Nothing | ZStack | On hold |
| U7 | Add `https://lumo-studio.cloudmile-coe.com/api/auth/google/callback` as a redirect URI and `https://lumo-studio.cloudmile-coe.com` as a JavaScript origin on the OAuth client `16646144790-fvdv...apps.googleusercontent.com`. It lives in project number 16646144790, which your account can't see | Google login | Senior or client owner | To ask after U5 |
| U8 | Install gVisor on the zaku node and create RuntimeClass `gvisor` | Agent features that run code | ZStack | To ask |
| U10 | Bucket Jobs `43`/`46` could not pull `minio/mc`. Switched to `rustfs/rc`. Still to ask: does zaku, a fresh install, need the MinIO rollback Deployment and `minio-pvc`? Also tell senior GKE's `43`/`46` have the same broken image | Nothing | You, senior | Fixed on zaku |
| U11 | Langfuse hostname `langfuse.lumo-studio.cloudmile-coe.com` needs its own DNS record and certificate. Add it to the ZStack ask, or drop it from the Ingress | Langfuse UI in a browser | You, ZStack | Open |
| U9 | Where to keep the new internal secrets. Senior suggested the working group; Secret Manager or a password manager is safer than chat | Sharing 5a values | You, senior | Open |

## Connectivity checks

Tested and working:

1. Laptop to zaku with kubectl.
2. Cluster-admin permissions.
3. Pod DNS through nodelocaldns.
4. Pod to internet over HTTPS (google.com, Gemini API host resolves).
5. Pulling public images from Docker Hub.
6. Storage: a 1Gi PVC on `edge-lvm` binds and a pod writes to it.
7. PyPI: `pypi.org` and `files.pythonhosted.org` reachable from a pod.
8. AWS pricing API reachable from a pod (HTTP 404 on the bare host, so the connection works).

Not tested yet:

9. Private image pull from GCR with the pull secret (step 3b).
10. Gemini with a real key: the agent's first chat.
11. Ingress at 10.3.100.103 after the Ingress exists.
12. Browser to `https://lumo-studio.cloudmile-coe.com` (needs U5).
13. Google login (needs U5, U7).

## Warnings

- Reading GKE secrets: fetch GKE credentials into a separate file so your zaku context stays current. `KUBECONFIG=~/.kube/gke-helpudoc gcloud container clusters get-credentials helpudoc-cluster --zone asia-southeast1-a --project my-rd-coe-demo-gen-ai`, then use `kubectl --kubeconfig ~/.kube/gke-helpudoc ...` for GKE only.
- Never put real values in a committed file. `env/**/*.env` is in `.gitignore`.
- The manifests use `imagePullPolicy: Always`, so the pull secret must stay valid for every pod restart. A one-hour access token is not enough.
