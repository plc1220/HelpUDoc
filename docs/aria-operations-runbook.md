# ARIA Clusters: Deployment, Backup and Restoration Runbook

For the maintainers of the three HelpUDoc clusters. It records how each cluster is
deployed, how backups work, how to restore skills and data, and the failures that have
already happened, so they do not happen again.

Internals of governed skills (blobs, packages, reconcile) are in
[`governed-skills-operations.md`](governed-skills-operations.md). Env files and local
testing are in [`AGENT.md`](../AGENT.md).

Last verified: 3 Nov 2026.

---

## 1. The clusters

| | aiengine-dev | aria-dev | aria-prd |
|---|---|---|---|
| GKE cluster | `helpudoc-cluster` (zone `asia-southeast1-a`) | `asia-southeast1-gke-dev-aria-01` (region `asia-southeast1`) | `asia-southeast1-gke-prd-aria-01` (region `asia-southeast1`) |
| Project | `ccob-my-ai-engine-dev` | `ccob-my-ai-engine-dev` | `ccob-my-ai-engine-prd` |
| URL | `aiengine-dev.skp.gov.my` | `aria-dev.skp.gov.my` | `aria.skp.gov.my` |
| Deployed by | `gcloud builds submit --config infra/cloudbuild.yaml` | `infra/gke/scripts/deploy-aria.sh dev …` | `infra/gke/scripts/deploy-aria.sh prd …` |
| Manifests | `infra/gke/k8s/` (applied on every deploy) | Hand-built; **never apply `infra/gke/k8s/`** | Hand-built; **never apply `infra/gke/k8s/`** |
| Routing | GCE Ingress → `helpudoc-caddy` | Gateway API `aria-gateway`, HTTPRoute `aria` → `helpudoc-caddy` | same as aria-dev |
| LB health check on Caddy | `GET /`, User-Agent `GoogleHC` | `/gateway-healthz` (HealthCheckPolicy `helpudoc-caddy-health`) | same as aria-dev |
| Binary Authorization | off | `ALWAYS_DENY` + digest allowlist | `ALWAYS_DENY` + digest allowlist |
| Images | `gcr.io/ccob-my-ai-engine-dev/helpudoc-*` | same registry, by digest | `asia-southeast1-docker.pkg.dev/ccob-my-ai-engine-prd/aria-releases/*`, by digest |
| Nightly backup | none | none | `aria-ops/aria-nightly-backup`, 03:00 MYT |

Namespace for the app on every cluster: `helpudoc`. App pod: `deploy/helpudoc-app`
(containers `backend`, `knowledge-worker`, `agent`, plus an MCP sidecar). It uses the
`Recreate` strategy, so a rollout always has a short gap.

Get credentials into a **separate kubeconfig per cluster**, so a command cannot land on
the wrong one:

```bash
export KUBECONFIG=~/.kube/aria-prd
gcloud container clusters get-credentials asia-southeast1-gke-prd-aria-01 --location asia-southeast1 --project ccob-my-ai-engine-prd
kubectl config current-context        # check before every write
```

---

## 2. Binary Authorization: the rule that causes most outages

- Admission runs **when a pod is created**. A running pod keeps running after its digest
  leaves the allowlist; the outage comes at its next restart (rollout, node drain,
  scale down and up, backup quiesce).
- **Init containers are not checked** (verified on prd on 3 Nov 2026 with a server-side
  dry run). Main containers are.
- The allowlist is edited in the Cloud Console or with `gcloud container binauthz policy`.
  Every change is in Cloud Audit Logs (`binaryauthorization.googleapis.com`, `UpdatePolicy`).

**Release practice: add the new digests; never replace an entry without checking what
still uses it.** Known users of non-app digests:

| Workload | Image | Notes |
|---|---|---|
| `helpudoc-caddy` | `caddy@sha256:d44355…` | Restarted by `maintenance.sh` |
| `aria-ops` backup CronJobs (prd) | the release agent image | `deploy-aria.sh deploy` moves them to each new agent digest |
| `helpudoc-app` sidecar `google-workspace-mcp` | `python@sha256:3dd7cc…` (dev) / `aria-releases/google-workspace-mcp@3dd7cc…` (prd) | |
| Postgres, Redis, MinIO, ClickHouse, Langfuse, `wait-deps` | pinned digests | |

`deploy-aria.sh <dev|prd> check` lists every image the deploy does not replace that is
not on the allowlist. Treat any line under "Not on the allowlist" as a pending outage.

Incidents this rule caused:
- **30 Oct, aria-dev:** a patch restarted `helpudoc-app`; its images had been replaced on
  the allowlist that morning; the new pod was refused and the app was down until the pod
  was pointed at allowlisted digests.
- **28 Oct – 3 Nov, aria-prd:** the backup CronJobs ran the 22 Oct agent digest, which the
  28 Oct allowlist update replaced. Every nightly backup failed silently for six nights.

To test an image without risk, use a server-side dry run (admission runs, nothing is stored):

```bash
cat <<EOF | kubectl -n aria-ops create --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata: {name: binauthz-probe}
spec:
  restartPolicy: Never
  containers: [{name: main, image: "<image@sha256:…>", command: ["true"]}]
EOF
```

---

## 3. Deploying

### 3.1 aiengine-dev

```bash
gcloud builds submit --project ccob-my-ai-engine-dev --config infra/cloudbuild.yaml .
```

- Builds images, applies `infra/gke/k8s/`, and syncs `skills/`, `plugins/` and
  `runtime.yaml` **from the uploaded working tree**. Untracked folders under `skills/`
  are shipped and registered as Platform Migration skills at startup. Clean the working
  tree first.
- Re-applies `70-caddy.yaml`, which ends maintenance mode (section 5).

### 3.2 aria-dev and aria-prd

**Build once** (dev project; serves both clusters; does not move `:latest`):

```bash
BUILD_ID=$(gcloud builds submit --project ccob-my-ai-engine-dev --config infra/cloudbuild-images.yaml --async --format='value(id)' .)
gcloud builds log --stream "$BUILD_ID" --project ccob-my-ai-engine-dev
COMMIT=$(git rev-parse --short HEAD)
```

**aria-dev:**

```bash
infra/gke/scripts/deploy-aria.sh dev check  "$BUILD_ID" "$COMMIT"   # read-only
infra/gke/scripts/deploy-aria.sh dev deploy "$BUILD_ID" "$COMMIT"
```

**aria-prd** (copies the dev-tested images byte for byte into the prd registry):

```bash
infra/gke/scripts/deploy-aria.sh prd check  "$BUILD_ID" "$COMMIT"   # lists MISSING images
infra/gke/scripts/deploy-aria.sh prd push   "$BUILD_ID" "$COMMIT"
# allowlist the new digests (ADD them; see section 2)
infra/gke/scripts/deploy-aria.sh prd check  "$BUILD_ID" "$COMMIT"
infra/gke/scripts/deploy-aria.sh prd deploy "$BUILD_ID" "$COMMIT"
```

`check` changes nothing. It verifies: digests allowlisted, every other image admissible,
`runtime.yaml` free of dev project IDs (prd rewrites them), backup state `RECOVERED`, not
inside the 02:00–04:00 MYT backup window, Gateway programmed, agent volumes read-only.

`deploy` then:
1. asks you to type the cluster name;
2. backs up the Deployments, CronJobs and the skills, plugins and agent-config volumes to
   a local `BACKUP_DIR` (the skills tar includes `.governed-versions/`);
3. sets the app, frontend, reflection and sandbox images, and moves the `aria-ops`
   backup CronJobs to the new agent digest;
4. syncs `skills/`, `plugins/` and `runtime.yaml` from `GIT_REF` (not the working tree);
5. restarts the app and runs the drift guard; prints rollback commands.

**What the skills sync does:** it deletes everything in `/app/skills` except
`.governed-versions/`, then extracts the repo's skills. Runnable folders of governed
skills that are not in git (for example the 10 SKP skills owned by Supervision) are
deleted, then rebuilt from `.governed-versions/` by the backend at the restart
(`Restored governed skill packages`). Nothing to do; check it afterwards (3.3).

### 3.3 After every deploy

```bash
kubectl -n helpudoc rollout status deploy/helpudoc-app
kubectl -n helpudoc logs deploy/helpudoc-app -c backend | grep -E "Restored governed skill packages|unreadable|migration parity"
kubectl -n helpudoc exec deploy/helpudoc-app -c agent -- \
  python -c "import requests; print('propose_skill' in requests.get('http://localhost:8001/agents').json()['agents'][0]['tools'])"
curl -s -o /dev/null -w "%{http_code}\n" https://aria.skp.gov.my/
```

Expect: no `unreadable` line; `True` (otherwise `runtime.yaml` on `agent-config-pvc` is
stale; see `AGENT.md` §5); `200`.

### 3.4 Rollback

`deploy-aria.sh` prints the exact commands at the end (they carry its own kubeconfig):
`kubectl rollout undo` for `helpudoc-app` and `helpudoc-frontend`, and `kubectl apply`
of the saved CronJobs. The PVC contents are in `BACKUP_DIR/*.tar`.

A rollback recreates pods. Their digests must still be on the allowlist (section 2).

---

## 4. Skills: ownership, deploys and restarts

- Ownership is database rows: `skills.ownerTeamId` (owning team),
  `team_skill_grants` (who may run it), `private_skill_drafts.ownerUserId` (draft owner).
- **Restarts and deploys never change an existing skill's owner.** Startup only creates
  rows for unregistered folders, and only refreshes content of skills still owned by
  Platform Migration.
- Change the owning team with `transferSkill` (`POST /api/skills/:skillId/transfer`,
  platform admin, audited). There is no UI button.
- A skill deleted from the database whose folder still exists comes back at the next
  restart, owned by Platform Migration.
- **A team-owned skill must not also live in git.** The deploy writes git's copy into
  `/app/skills/<key>`, startup only rebuilds missing folders, so the agent would run git's
  copy instead of the team's approved version. Remove it from `skills/` in the same
  release that transfers it. (Applies to `tos-analysis`, which is in git.)

---

## 5. Maintenance mode

```bash
infra/gke/scripts/maintenance.sh <aiengine-dev|aria-dev|aria-prd> on|off|status
```

- Swaps the `helpudoc-caddy` Caddyfile for one that answers 503 (HTML for pages, JSON for
  `/api` and `/helpudoc`) while health checks still get 200; `off` restores the saved file.
- Saves the live Caddyfile in ConfigMap `helpudoc-caddy-config-backup` while it is on.
- Uses its own kubeconfig; checks the Caddy image against the allowlist before restarting.
- The backend keeps running, so `kubectl exec` work (migrations, backups) still works.
- Ended by a `cloudbuild.yaml` deploy on aiengine-dev; `deploy-aria.sh` leaves it alone.

---

## 6. Backups (aria-prd)

### 6.1 What runs

| | Detail |
|---|---|
| CronJob | `aria-ops/aria-nightly-backup`, `0 3 * * *` Asia/Kuala_Lumpur |
| Watchdog | `aria-ops/aria-backup-recovery`, every 5 min; restores replicas after an interrupted run |
| Script | ConfigMap `aria-ops/aria-backup-script` (`backup-runner.py`) |
| Image | the release agent image (moved by `deploy-aria.sh deploy`) |
| Steps | suspends CronJobs, scales app workloads to 0, `pg_dumpall` → `gs://aria-ai-engine-prd-backups/<backupId>/postgres-all.sql.gz`, scales data workloads to 0, Backup for GKE backup (plan `aria-production-daily`, 8 volumes), restores replicas |
| Downtime | about 6 minutes nightly |
| Retention | 14 days |
| State | ConfigMap `helpudoc/aria-backup-runtime-state` (`phase` must be `RECOVERED`) |

**What is covered where:**

| Data | Database dump (Cloud Storage) | Backup for GKE (8 volumes) |
|---|---|---|
| Users, teams, workspaces, file records, skill ownership, grants, drafts, reviews, knowledge bases | ✅ | ✅ (`postgres-pvc`) |
| Skill content (`.governed-versions/`) | ❌ (only hashes) | ✅ (`skills-pvc`) |
| Workspace files and knowledge documents (MinIO) | ❌ | ✅ (`minio-pvc`) |
| `runtime.yaml`, plugins, workspaces mirror, Redis, ClickHouse | ❌ | ✅ |

### 6.2 Check that backups are working

```bash
gcloud beta container backup-restore backups list --project ccob-my-ai-engine-prd --location asia-southeast1 \
  --backup-plan aria-production-daily --sort-by=~createTime --format="table(name.basename(),state,createTime,volumeCount)" | head -3
kubectl -n helpudoc get cm aria-backup-runtime-state -o jsonpath='{.data.state\.json}'; echo
kubectl -n aria-ops get jobs --sort-by=.metadata.creationTimestamp | tail -5
```

The newest backup must be less than about 26 hours old, `SUCCEEDED`, 8 volumes.

**A failure is silent.** If a job pod is refused, the runner never starts, the state
stays `RECOVERED`, `FailedCreate` events expire within an hour, and only 3 failed jobs
are kept. Look for `Error creating: … denied by Binary Authorization` with
`kubectl -n aria-ops describe job <job>`.

### 6.3 Run a backup by hand

```bash
# non-disruptive preflight: test dump, exec stream, backup and bucket permissions
kubectl -n aria-ops create job aria-backup-check-$(date +%Y%m%d%H%M) --from=cronjob/aria-nightly-backup --dry-run=client -o json \
  | python3 -c "import json,sys; j=json.load(sys.stdin); j['spec']['template']['spec']['containers'][0]['command'].append('--check'); print(json.dumps(j))" \
  | kubectl create -f -

# full backup (about 6 minutes of downtime); outside 02:00-04:00 MYT
JOB=aria-manual-backup-$(date +%Y%m%d%H%M)
kubectl -n aria-ops create job "$JOB" --from=cronjob/aria-nightly-backup
kubectl -n aria-ops logs -f "job/$JOB"   # "Managed backup succeeded with eight volumes"
```

If jobs are refused, point both CronJobs at an allowlisted agent digest, then delete the
stuck jobs (`concurrencyPolicy: Forbid` blocks new runs while one is active):

```bash
IMG=asia-southeast1-docker.pkg.dev/ccob-my-ai-engine-prd/aria-releases/agent@sha256:<allowlisted>
kubectl -n aria-ops set image cronjob/aria-nightly-backup  backup=$IMG
kubectl -n aria-ops set image cronjob/aria-backup-recovery backup=$IMG
kubectl -n aria-ops delete jobs --field-selector status.successful=0
```

### 6.4 Quick copy without downtime

```bash
TS=$(date +%Y%m%d-%H%M)
kubectl -n helpudoc exec deploy/helpudoc-app -c backend -- tar -C /app/skills -czf - .governed-versions \
  | gcloud storage cp - gs://aria-ai-engine-prd-backups/manual-$TS/skills-governed-versions.tar.gz
kubectl -n helpudoc exec deploy/helpudoc-postgres -- sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U "$POSTGRES_USER"' \
  | gzip | gcloud storage cp - gs://aria-ai-engine-prd-backups/manual-$TS/postgres-all.sql.gz
```

The two files together restore every governed skill, draft and ownership row.

---

## 7. Restoration

### 7.1 Decide what was lost

| Symptom | Lost | Go to |
|---|---|---|
| Startup logs `Governed skills whose immutable content is unreadable`; skills or drafts fail with `SKILL_MATERIALIZATION_UNAVAILABLE` | skill content (`.governed-versions/blobs`) | 7.2 |
| Skills missing from the `/` menu but `content_blobs` rows and blobs exist | runnable folders only | restart the app; `reconcileGovernedPackages` rebuilds them |
| Wrong owner, grants or drafts; users or workspaces missing | database rows | 7.3 |
| Volume or namespace lost | several volumes | 7.4 |

List exactly which skill files are missing (each blob is named after its SHA-256):

```bash
PG=$(kubectl -n helpudoc get pods -l app=helpudoc-postgres -o jsonpath='{.items[0].metadata.name}')
kubectl -n helpudoc exec "$PG" -- sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "select \"contentHash\" from content_blobs"' > hashes.txt
kubectl -n helpudoc exec -i deploy/helpudoc-app -c backend -- sh -c \
  'while read h; do [ -r "/app/skills/.governed-versions/blobs/$(echo $h | cut -c1-2)/$h" ] || echo "MISSING $h"; done' < hashes.txt
```

### 7.2 Restore skill content

Blobs are content-addressed: any copy of the right bytes can be put back, and the hash
proves it. Once the files are back, restart the app; startup rebuilds every package and
runnable folder. Ownership is not touched.

Sources, best first:

1. **A tar of `.governed-versions`** (section 6.4, or `skills.tar` in a `deploy-aria.sh`
   `BACKUP_DIR`):
   ```bash
   kubectl -n helpudoc exec -i deploy/helpudoc-app -c backend -- tar -C /app/skills -xzf - .governed-versions < skills-governed-versions.tar.gz
   # for a deploy-aria.sh skills.tar (uncompressed, whole tree):
   # tar -xf skills.tar ./.governed-versions | kubectl … tar -C /app/skills -xf -
   kubectl -n helpudoc rollout restart deploy/helpudoc-app
   ```
   Extracting over the live tree only adds missing files; existing blobs are identical by
   construction.
2. **Backup for GKE** volume backup of `skills-pvc` (7.4). Restore it to a scratch
   location and copy `.governed-versions` back as in step 1. Do not restore it over the
   live namespace unless everything else is to be rolled back too.
3. **The originals**, verified by hash: base skills from git; skills migrated from
   aiengine-dev from aiengine-dev itself while it exists. For each missing hash, write the
   matching file to `/app/skills/.governed-versions/blobs/<first two chars>/<hash>`. Only
   skills that never existed anywhere else are unrecoverable this way.
4. If nothing has the content: archive the skill (`POST /api/skills/:skillId/archive`) and
   have its owner recreate it as a draft.

Then check: no `unreadable` line in the backend log, and the missing-file list from 7.1
is empty.

### 7.3 Restore database rows (ownership, users, workspaces)

`postgres-all.sql.gz` is a `pg_dumpall` of the whole instance. Restoring it rolls **every**
table back to the backup time. For a few rows, restore into a scratch database and copy
only those rows:

```bash
gcloud storage cp gs://aria-ai-engine-prd-backups/<backupId>/postgres-all.sql.gz .
gunzip -t postgres-all.sql.gz
# local scratch restore
docker run -d --name pg-restore -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16
gunzip -c postgres-all.sql.gz | psql -h localhost -p 55432 -U postgres
# inspect, e.g. who owned a skill at backup time
psql -h localhost -p 55432 -U postgres -d helpudoc -c 'select s."skillKey", g.name from skills s join groups g on g.id=s."ownerTeamId"'
```

Re-apply ownership changes through the app (`transferSkill`, team grants) rather than
editing rows, so audit events are written. Stop the app (`maintenance.sh … on`) before a
full restore into the live database.

### 7.4 Backup for GKE restore (volumes or the namespace)

Not yet rehearsed on these clusters. **Rehearse on aria-dev before relying on it.**

```bash
PROJECT=ccob-my-ai-engine-prd; LOC=asia-southeast1
gcloud beta container backup-restore backups list --project $PROJECT --location $LOC --backup-plan aria-production-daily
gcloud beta container backup-restore volume-backups list --project $PROJECT --location $LOC \
  --backup-plan aria-production-daily --backup <backupId>
```

- A restore plan selects the namespace and how existing resources are handled
  (`--namespaced-resource-restore-mode`) and whether volume data comes from the backup
  (`--volume-data-restore-policy=restore-volume-data-from-backup`).
- Restoring namespace `helpudoc` in place replaces **all 8 volumes**, rolling every
  service back to the backup time. Run `maintenance.sh aria-prd on` first.
- For a single volume (for example `skills-pvc`), restore into a scratch cluster or a
  renamed namespace, mount the restored PVC in a temporary pod, and copy what is needed.
- After any restore: section 3.3 checks, plus section 7.1's missing-file list.

### 7.5 Data migrated from aiengine-dev

On 3 Nov 2026 users, workspaces, skills and one knowledge base were migrated from
aiengine-dev to aria-prd with `backend/scripts/migration/` (export read-only on the
source, import on the target; dry run by default; idempotent). The item list is
`migration_items.md`. Chat history, file version history and original timestamps stayed
on aiengine-dev, which remains the record of that history.

---

## 8. Known gaps

- The nightly backup has no alert. A log-based alert on `FailedCreate` in `aria-ops`, or
  on a newest backup older than 26 hours, would catch the 28 Oct failure on day one.
- Skill content has no plain copy in Cloud Storage; the database dump holds only hashes.
  Adding a tar of `.governed-versions` to the nightly job, or uploading `deploy-aria.sh`'s
  `skills.tar`, would make 7.2 a download.
- The Backup for GKE restore in 7.4 has not been rehearsed.
- `helpudoc-app` init containers on prd still run the 22 Oct agent digest. Admission
  ignores init containers today; move them to the release image if that changes.
