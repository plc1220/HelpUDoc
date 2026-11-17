# GKE migration: MinIO to RustFS

PR #103 rehearses a local migration. Production uses the additional manifests
and verification procedure here; applying its Docker Compose file does not
migrate GKE.

## Deployment and recovery

- Project: `my-rd-coe-demo-gen-ai`; cluster: `helpudoc-cluster`, zone
  `asia-southeast1-a`; namespace: `helpudoc`.
- MinIO's `minio-pvc` was expanded from 20 GiB to 100 GiB after
  `XMinioStorageFull` blocked artifact commits.
- The generated `06_pillars_8_12.md` from failed run
  `b69bdb4a-0acb-4007-be4a-4026c5c00da0` was backed up and committed as file
  4202, version 2, through `FileService.commitWorkspaceArtifacts`. Its stored
  SHA-256 is `dd0e4a21c9688d5aeb0bace2405efee6740684aeb0e21ec66b238242bc471d66`.
  The original failed-run status is retained; its metadata records the recovery.
- RustFS 1.0.4 is pinned by digest in `infra/gke/k8s/47-rustfs.yaml` and uses
  a separate 100 GiB `rustfs-pvc`. It never mounts MinIO's data directory.
- The existing Secret references are reused to preserve application credentials.
  Both services are internal ClusterIP services; the RustFS console is disabled.
- Service `rustfs` always points at RustFS. Service `minio-rollback` always
  points at the retained MinIO deployment. After verification, Service `minio`
  is switched to RustFS, preserving existing backend, agent, Langfuse, sandbox
  and public signed-URL endpoints.
- Before cutover, apply the updated `allow-inline-sandbox-transfer` NetworkPolicy
  in `infra/gke/k8s/49-skill-sandbox.yaml`. Its destination selector must include
  both `helpudoc-minio` and `helpudoc-rustfs` in namespace `helpudoc`, on TCP 9000
  only. Preserving the Service hostname does not preserve pod-based egress
  permission. The MinIO destination remains allowed for rollback.
- Signed upload metadata must remain in `X-Amz-SignedHeaders`. The backend
  compatibility fix uses `unhoistableHeaders`; without it RustFS rejects uploads
  carrying the SHA-256 metadata header as unsigned. Deploy this fix before
  switching Service `minio`.

## Prepare and copy

Use the intended Kubernetes context explicitly. Save the existing deployment
images, replica counts, Service selector and CronJob suspension state before
changing them. Check for active agent runs and sandbox jobs before maintenance.
Block public mutation requests, including previously signed PUT uploads, at
Caddy before draining the app. Preserve the exact live Caddy configuration and
restore it after the new backend passes its internal checks and the old MinIO
pod has stopped. Stopping MinIO also closes any proxy keep-alive connections
that still target the source.

```sh
kubectl apply -f infra/gke/k8s/47-rustfs.yaml
kubectl apply -f infra/gke/operations/rustfs-migration.yaml
kubectl -n helpudoc rollout status deployment/helpudoc-rustfs
kubectl -n helpudoc wait --for=condition=Ready pod/helpudoc-rustfs-migration --timeout=300s
```

The migration pod provides rclone 1.76.0 and a verifier sharing a reports PVC.
Its source remote uses `minio-rollback`, so the later Service switch cannot
accidentally turn a source read into a destination read. Do not print the pod's
credential environment. The verifier image is pinned to the pre-migration
backend revision and is used only as a Node runtime.

```sh
kubectl -n helpudoc exec helpudoc-rustfs-migration -c rclone -- sh -ec '
  for bucket in helpudoc langfuse; do
    rclone --config /dev/null mkdir rustfs:$bucket
    rclone --config /dev/null copy minio:$bucket rustfs:$bucket \
      --fast-list --metadata --checksum --transfers 32 --checkers 64
  done
'
```

An initial copy may run while the app is online. `--fast-list` matters for the
large, deeply nested Langfuse event tree. Copy all keys, including internal keys;
do not blindly reuse local sandbox exclusions in production. Use `copy`, never
`sync`; retain source data. Inventory bucket versioning, policies, retention,
replication and non-root identities before migration. Object copying does not
transfer IAM or historical S3 versions. The inspected production buckets had
no configured versioning, bucket policies, lifecycle, replication or object lock.

## Freeze and verify

Pause all writers for the final delta and verification. Suspend the reflection
CronJob, drain active requests/runs, scale `helpudoc-app`, `helpudoc-langfuse-web`
and `helpudoc-langfuse-worker` to zero, and wait for their pods to disappear.
Prevent independent sandbox jobs or external writers from running. Preserve
database backups and a snapshot of MinIO's disk at this boundary. Keep writers
stopped through cutover, or restore the source and abort.

The freeze may be staged by bucket: pause Langfuse first and verify its archive
while the app still serves the independent workspace bucket from MinIO. After
that check passes, pause the app for the workspace delta and verification. Do not
resume either bucket's writers until that bucket has switched to the verified
destination.

Repeat the copy above for any bucket that still accepted writes during the
initial copy. Then use the streamed verifier to check every object's bytes,
SHA-256, size, content type and custom metadata in one pass. It independently
lists the destination to detect additional keys. Streaming avoids holding object
bodies in memory or repeatedly listing the deeply nested tracing archive.

```sh
kubectl -n helpudoc exec -i helpudoc-rustfs-migration -c verifier -- \
  sh -c 'cat > /reports/verify-rustfs-objects.js' \
  < infra/gke/scripts/verify-rustfs-objects.js
# Launch a check after this bucket's writers are frozen. Repeat with helpudoc
# after pausing the app and copying its final delta.
bucket=langfuse
kubectl -n helpudoc exec helpudoc-rustfs-migration -c verifier -- \
  sh -c 'nohup env NODE_PATH=/app/node_modules node /reports/verify-rustfs-objects.js "$1" /reports </dev/null >"/reports/$1.verification.log" 2>&1 &' sh "$bucket"
kubectl -n helpudoc exec helpudoc-rustfs-migration -c verifier -- \
  tail -n 2 /reports/langfuse.verification.log
# Written only when the check finishes: require 0 and passed:true in the summary.
kubectl -n helpudoc exec helpudoc-rustfs-migration -c verifier -- \
  cat /reports/langfuse.verification.exit /reports/langfuse.verification.json
```

Run long checks detached inside the pod so a Kubernetes connection timeout
cannot terminate verification. Do not treat a successful launch as a successful
check. Every completed check must exit 0. The verifier rejects missing or additional keys,
duplicate keys and mismatched content type, size or custom metadata, including
`helpudoc-sha256`. It ignores only rclone's transfer timestamps and storage tier.
Save its per-object JSONL manifests, JSON summaries and copy logs before removing
the tools. The verifier was exercised against matching objects, changed bytes,
changed custom metadata, a missing key and an additional key; only the matching
case passed.

## Cut over and check

Only after frozen-source verification succeeds, apply the compatibility Service
selector and retained MinIO replica count from `42-minio.yaml`. Restore the
writers' original replica counts and CronJob state. Archive the reports and remove
the temporary migration pods before restarting the app on a capacity-constrained
cluster. Start the app first, then Langfuse, to avoid resource fragmentation.
Existing clients continue
using `http://minio:9000`, now served by RustFS.

Verify backend and agent health, retrieval of old and recovered file versions,
fresh upload/download, signed uploads with metadata, server-side copy,
immutable publication retry and overwrite rejection. Anonymous listing and
downloads must still return 403. Confirm new Langfuse events reach RustFS and
check pod readiness/restarts. Run an isolated gVisor sandbox through input
download, execution and result upload; confirm backend port 3000 remains
unreachable from that sandbox. This procedure changes storage and the small
backend upload compatibility fix, not unrelated application features.

## Rollback

Keep the source PVC and disk snapshot. Never mount the source disk in RustFS.
Before any switch back, freeze writers again.

If RustFS has accepted writes, Postgres can reference RustFS-only objects.
Copy both buckets back to `minio-rollback` using `--metadata --checksum`, with a
dry run first, then verify keys, bytes and metadata before changing Service
`minio` back to selector `app: helpudoc-minio`. Start the retained MinIO
deployment before that reverse copy. Reconcile changed or deleted objects and
database references explicitly; a blind Service rollback can lose newer writes
or resurrect deletions. A disk snapshot alone is not a rollback of later
application and database state.

Restore original app, Langfuse and CronJob states only after the rollback checks
pass. No source objects, PVCs or snapshots are deleted by this migration.

## Verified production cutover: 17 November 2026

The live migration verified all 354,964 objects: 2,077 in `helpudoc` and
352,887 in `langfuse`, totalling 17,422,904,070 bytes. Every object matched
its source bytes, SHA-256, size, content type and custom metadata; neither
bucket had missing or additional destination keys. The first live inventory
preceded the tracing freeze, so its earlier tracing count was slightly lower.

The deployed backend image is `gcr.io/my-rd-coe-demo-gen-ai/helpudoc-backend:bc92a8e7-rustfs`
at digest `sha256:ae21404d8846378d057e5e86c360ab01509a26dbdfc16e430e8fddd7dd4265a4`.
It contains the signed-upload fix on production base `c3f916cf`. Live backend
and agent readiness, public signed upload/download, immutable retry/conflict,
server copy and anonymous access denial passed. A synthetic tracing export
was read back through Langfuse and its new event object was read from RustFS.

The original MinIO deployment is stopped; its 100 GiB PVC and READY snapshot
`helpudoc-minio-pre-rustfs-20261117` remain available for rollback. The snapshot
is stored in `asia-southeast1`. The app, both Langfuse deployments and the daily
reflection schedule were restored. Temporary migration pods and their reports
PVC were removed after the reports were archived privately. Recovery backups
and verification reports under `outputs/recovery/` are excluded from Git.

The inline-sandbox egress policy was also verified after extending its S3
destination selector to RustFS. A real gVisor Job in `helpudoc-sandbox`
downloaded its input, executed, uploaded its result and read it back through
the trusted runner. Its attempt to reach backend TCP 3000 was denied. The
probe Job and its temporary transfer objects were cleaned up.
