# HelpUDoc on HPE GreenLake Private Cloud AI

Prepared for the user's **HPE AI Essentials 1.12.1** installation. This is an
initial deployment chart with local inference support; it has not been installed
or accepted on a PCAI cluster. Chart rendering and mocked inference checks do not
establish cluster compatibility or model quality.

The existing private Kubernetes branch is `origin/chore/adapt-zaku`. It contains
`docs/zaku_steps.md` and copied GKE manifests. This branch starts from current
`origin/master` (`c5108e6f`, PR #117), rather than inheriting the GKE-specific
storage classes, Google identity annotations, domains and image locations.

## What the chart installs

- One shared app pod: backend, Knowledge worker and Python agent; writable
  workspace, skills, plugins and runtime configuration claims. One replica with
  `Recreate` matches the existing shared-filesystem deployment model.
- Separate frontend and Caddy gateway deployments. The gateway routes `/api`,
  the configured private S3 bucket path, and the frontend. It flushes streamed
  API responses immediately and preserves the public Host for S3 signatures.
- Optional single-instance PostgreSQL 16, Redis 7 and RustFS (the digest already
  used by the repository). These are convenience services without HA guarantees.
  Each can be replaced with an existing site service.
- PCAI manual integration: Istio VirtualService, vendor workload labels and an
  optional gateway CUSTOM AuthorizationPolicy. There is no namespace-wide
  Kyverno mutation, cluster role or Google-specific resource.
- Optional daily-reflection CronJob, disabled initially.

This chart has no external Helm dependencies and packages without downloading
subcharts. All services use ClusterIP. Namespace creation belongs to PCAI or the
operator; the chart uses the selected Helm release namespace.

## Find the site settings

| Setting | Where to obtain it |
| --- | --- |
| Application hostname | Check the domain of an existing tool opened from **Tools & Frameworks**. Ask the PCAI administrator to reserve a HelpUDoc hostname under the ingress domain, including DNS and TLS coverage. Do not reuse an existing tool's hostname. |
| Container registry/project | Ask the platform administrator which private registry and project are approved for imported application images. If Harbor is installed, its UI shows the registry hostname and available projects. Obtain a pull credential or existing Kubernetes pull Secret. |
| Storage class | Ask the administrator for a supported persistent-storage class and available capacity. With cluster access, run `kubectl get storageclass`. The chart does not assume an HPE storage-class name. |
| Local inference | Obtain the deployed endpoint's API base URL, exact served model ID and API token from the model service owner. In AI Essentials, start with **Gen AI / Model Endpoints**; MLIS-managed deployments expose these from their deployment details. Confirm the interface is OpenAI Chat Completions and whether `/v1` is part of the supplied base URL. |
| Gateway authentication | Confirm the Istio gateway resource, namespace, ingress pod labels and registered external authorization provider. Example defaults reflect HPE documentation, not verified settings for this cluster. |
| Certificate trust | Obtain the private CA bundle if the model/database/integration certificates are not publicly trusted. Set `trust.configMap` and `trust.key`; the ConfigMap must be in the application namespace. |

For a first installation the PVC requests total **156 GiB**. CPU/memory requests
are initial planning defaults (about 2.4 CPU and 7.1 GiB for the steady-state
application and bundled services); measure actual document-processing workloads.
Inference GPUs/model memory are managed by the existing PCAI inference service
and are **not** included or requested by this chart.

## Local inference behavior

`model.provider: openai-compatible` sends requests only to the explicitly
configured endpoint. It uses `OPENAI_API_KEY` (or the name in `model.api_key_env`)
from the existing Secret, never a Gemini key. The token is an inference-service
credential; using the standard variable name does not send requests to OpenAI.
The client uses Chat Completions, not the Responses API, and sends NIM-compatible
`max_tokens`. Main, Fast, Lite and Pro can initially share one served model ID.

The deployed model must support streaming, tool calls and function-calling
structured output. Test those capabilities with the actual NIM/vLLM deployment;
a model being available in PCAI does not establish those capabilities. Output and
context limits must fit the model's deployment configuration.

The chart seeds an independent runtime profile with local document tools and the
local data-artifacts MCP. `inherit_defaults: false` prevents the bundled Gemini
and hosted MCP configuration from being merged back in. Native-text extraction
and Knowledge map/reduce enrichment can use the local model. Scanned-page OCR,
image generation, Google web grounding and Gemini embeddings are unavailable in
this profile. Vector and multimodal retrieval stay disabled; use lexical/graph
retrieval. Scanned-only files need a separately integrated local OCR service.

Sandbox skill/inline execution is disabled and the pod has no Kubernetes token.
Enabling sandbox execution requires a separate, reviewed deployment of job RBAC,
runtime isolation and network restrictions appropriate for PCAI; this chart
rejects simply turning those flags on. No Docker socket or privileged job runner
is mounted.

Langfuse is not installed here. To use an existing site Langfuse deployment, set
the non-secret tracing URL/flag through `config` and add its keys to the existing
Secret. Cloud research MCPs, Google Workspace MCP and Google OAuth/calendar
integrations require explicit configuration and allowed connectivity.

## Application login and PCAI login

PCAI gateway authentication is an outer access-control layer. HelpUDoc currently
implements Google OAuth application sessions for `AUTH_MODE=oidc`; importing the
chart does **not** add native PCAI Keycloak session support. Keep the application
login configured, or implement and verify a site identity adapter before a
fully disconnected rollout. Do not switch to `AUTH_MODE=headers`: client-supplied
identity headers are not authenticated application identities.

With Google login enabled, supply its OAuth client ID and secret, register
`https://<application-host>/api/auth/google/callback`, and build the frontend with
the corresponding client ID. Local inference itself needs no Google credentials.

## Build and mirror images

Build from this feature branch so the agent includes local-provider support.
The existing `.gke` Dockerfiles are reusable image recipes; the chart does not
use GKE workload identity. Use the target cluster architecture (normally amd64;
confirm with the administrator).

```sh
docker build --platform linux/amd64 -f backend/Dockerfile.gke \
  -t <registry>/<project>/backend:pcai-local-v1 .
docker build --platform linux/amd64 -f agent/Dockerfile.gke \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
  -t <registry>/<project>/agent:pcai-local-v1 .
docker build --platform linux/amd64 -f frontend/Dockerfile.gke \
  --build-arg VITE_API_URL=/api --build-arg VITE_AUTH_MODE=oidc \
  --build-arg VITE_GOOGLE_CLIENT_ID=<oauth-client-id> \
  -t <registry>/<project>/frontend:pcai-local-v1 .
```

Push those images to the site registry. For restricted egress, mirror Caddy,
PostgreSQL, Redis and RustFS as well, retaining the RustFS digest where the
registry preserves it. Override every image repository and use approved tags or
digests. Image pull Secrets apply to all deployments, init containers and the
optional CronJob. Image builds require a connected preparation environment or
site mirrors of the package/tool sources; the Helm package alone is not a
complete air-gap bundle.

## Prepare secrets and values

Copy `values-pcai.example.yaml` to a private file and replace the example host,
registry, storage class, gateway details and deployed model IDs. Keep actual
credentials outside this repository. Create the namespace and a Secret named
by `existingSecret` through the site's approved secret mechanism. Required keys:

| Secret key | Purpose |
| --- | --- |
| `SESSION_SECRET` | Long random application session secret |
| `AGENT_JWT_SECRET` | Independent long random backend/agent signing secret |
| `POSTGRES_PASSWORD` | Bundled PostgreSQL password |
| `DATABASE_URL` | Full, correctly URL-encoded PostgreSQL URI used by all app processes |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | S3 credentials; also bootstrap bundled RustFS |
| `OPENAI_API_KEY` | PCAI inference API token (or key named by `model.api_key_env`) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Required if retaining the existing Google application login |
| `REDIS_URL` | Required when `redis.enabled=false`; include credentials/TLS as appropriate |

With release `helpudoc`, bundled database connection:
`postgresql://helpudoc:<URL-encoded-password>@helpudoc-postgres:5432/helpudoc`.
Adjust the host if using a different release name or `fullnameOverride`.
`DATABASE_URL` must match the bundled database name/user/password, or the external
database. `AGENT_STORE_DATABASE_URL` is derived from it. Do not put credentials in
the model base URL or chart values. Avoid unrelated reserved connection keys in
the Secret: Secret env entries take precedence over generated ConfigMap entries.

When using external PostgreSQL, set `postgres.enabled=false`, `externalHost`,
database/user/port, the Secret URI, and any database SSL requirements. For
external S3, set `objectStore.enabled=false`, `externalEndpoint` and an HTTPS
`externalPublicEndpoint`, then provision a private bucket and its browser CORS
policy yourself. The chart bootstraps/restricts only its bundled RustFS bucket.
The browser must be able to reach the public endpoint for presigned requests.

## Validate, package and import

```sh
helm lint infra/helm/helpudoc --strict
helm template helpudoc infra/helm/helpudoc -n helpudoc \
  -f /secure/path/pcai-values.yaml > /tmp/helpudoc-rendered.yaml
python -m unittest discover -s infra/helm/tests -v
helm package infra/helm/helpudoc --destination /tmp/helpudoc-packages
```

In **Tools & Frameworks → Import Framework**, upload `helpudoc-0.1.0.tgz`, set the
namespace and release name used above, and paste the private site override values.
Keep `ezua.autoHelm=false`: this is a multi-service manual-integration chart.
Some PCAI screens call the compressed chart a `tar.gz`; Helm's `.tgz` is the same
archive format. Rename only the extension if the upload picker requires it.

If the installer cannot create an AuthorizationPolicy in `istio-system`, have
the platform administrator apply that rendered resource separately, then set
`ezua.authorizationPolicy.enabled=false` for the application installation. The
gateway policy must be in place and tested before enabling user access.

Alternatively, with an administrator-approved kubeconfig:

```sh
helm upgrade --install helpudoc infra/helm/helpudoc --namespace helpudoc \
  -f /secure/path/pcai-values.yaml --wait --timeout 15m
kubectl -n helpudoc get pods,pvc
kubectl -n helpudoc logs deployment/helpudoc-app -c agent
```

Validate TLS, PCAI gateway access, application login, one tool-using streamed
conversation, native-text upload/download, Knowledge publication and persistence
across a pod restart. Confirm that unauthorized object requests fail, presigned
uploads/downloads work, and requests reach only approved local endpoints. Inspect
actual runtime config and MCP inventory; do not infer that a ready pod proves
model execution, OCR coverage or authentication acceptance.

## Persistence, updates and recovery

Skills, plugins and runtime are seeded only on the first boot, preserving edits
on the claims. Changing the Helm `model` values later does **not** overwrite a
runtime file already on the config claim. Update that file through the approved
configuration workflow, or supply `runtimeConfigMap` containing a complete
`runtime.yaml` with `inherit_defaults: false` for declarative, read-only config.
Restart the app after changing that external ConfigMap or any referenced Secret;
subPath files and environment values do not update in a running container.

All created PVCs have `helm.sh/resource-policy: keep`. Back up PostgreSQL, RustFS
objects and writable app assets before upgrades. Helm rollback does not undo
application database schema changes or restore data. For a reinstall, explicitly
map retained volumes via `persistence.claims.<name>.existingClaim`; claims are not
automatically deleted or re-adopted. Plan site backups, quotas and namespace
network isolation before production use. No existing GKE data is migrated.

## References

- [HPE AI Essentials 1.12.x documentation](https://support.hpe.com/hpesc/public/docDisplay?docId=a00aie112hen_us)
- [HPE framework import / manual versus AutoHelm](https://support.hpe.com/hpesc/public/docDisplay?docId=a00aie111hen_us&docLocale=en_US&page=ManageClusters%2Fimporting-applications.html)
- [HPE framework gateway SSO example](https://docs.ezmeral.hpe.com/unified-analytics/15/ManageClusters/sso-support-for-imported-apps.html)
- [HPE PCAI model endpoint and API-token example](https://developer.hpe.com/blog/deploying-a-hugging-face-llm-in-hpe-private-cloud-ai/)
- [HPE internal Harbor registry example](https://developer.hpe.com/blog/setting-up-harbor-as-a-local-container-registry-in-hpe-private-cloud-ai/)

The routing and SSO examples span documented HPE versions. Verify exact gateway
labels, authorization provider, admission policy and storage behavior on 1.12.1.
