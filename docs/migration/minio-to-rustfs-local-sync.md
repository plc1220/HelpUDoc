# Local migration: MinIO to RustFS

This is a one-way copy of the local MinIO buckets (`helpudoc`, `langfuse`) into RustFS, run with `scripts/migrate_minio_to_rustfs.sh`. Both stores run from `infra/docker-compose.dependencies.yml` and stay up throughout. To run the same steps by hand, one command at a time, see [minio_rustfs_v1.md](minio_rustfs_v1.md).

| | MinIO (source) | RustFS (target) |
|---|---|---|
| Host ports (API, console) | 9000, 9001 | 9100, 9101 |
| rclone address, on network `infra_default` | `http://helpudoc-minio:9000` | `http://helpudoc-rustfs:9000` |
| Address for a host-run app | `http://localhost:9000` | `http://localhost:9100` |
| Login (`env/local/stack.env`) | `MINIO_ROOT_*` (default `minioadmin`) | `RUSTFS_ROOT_*` (default `rustfsadmin`) |

The script only reads MinIO, so `.minio-data` stays as the rollback. It uses `rclone copy`, never `sync`, so rerunning it never deletes anything from RustFS. Every listing, copy and check excludes `/sandbox-runs/**` (the agent's per-run transfer archives) on both sides.

## 1. Start both stores

```sh
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d rustfs rustfs-setup
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
```

Start RustFS first. If an older RustFS container still holds port 9000, this moves it to 9100 so MinIO can take 9000.

## 2. Copy

```sh
scripts/migrate_minio_to_rustfs.sh copy
```

The script does a dry run, lists the writers, and asks for confirmation. After you answer `y`, it:

1. Stops the backend (3000), agent (8001), Vite (5173), the knowledge worker, and any `langfuse` containers. Stop any other writer yourself.
2. Copies `.minio-data` to `~/helpudoc-migrate/minio-backup-<time>`.
3. Records the actual source counts in `~/helpudoc-migrate/<bucket>.source-count.txt`.
4. Runs `rclone copy --metadata --checksum` for each bucket.

Keep the writers stopped until step 4 passes.

## 3. Verify

```sh
scripts/migrate_minio_to_rustfs.sh verify
```

For each bucket, `verify` checks that:

- the number of objects identical in RustFS (same key, same bytes from `rclone check --download`) equals the source count;
- every object has the same size, content type and metadata, including `helpudoc-sha256`. It ignores `btime`, `mtime` and `tier`, which change on any copy.

It prints `PASS` or `FAIL`. Reports go to `~/helpudoc-migrate/`.

To fix one object, re-upload it with its metadata, then run `verify` again:

```sh
scripts/migrate_minio_to_rustfs.sh rclone copyto minio:<bucket>/<key> rustfs:<bucket>/<key> --metadata --ignore-times
```

Objects listed as `only in RustFS` are never deleted. Find out where each came from first, for example by checking whether the app references it:

```sh
docker exec helpudoc-postgres psql -U helpudoc -d helpudoc -c \
  "select \"fileId\" from file_versions where \"objectKey\" = '<key>'"
```

## 4. Point the app at RustFS and test

In `env/local/dev.env`, set:

```sh
S3_ENDPOINT=http://localhost:9100
AWS_ACCESS_KEY_ID=rustfsadmin                      # RUSTFS_ROOT_USER
AWS_SECRET_ACCESS_KEY=rustfsadmin                  # RUSTFS_ROOT_PASSWORD
VITE_DEV_OBJECT_PROXY_TARGET=http://localhost:9100 # if unset, Vite proxies to 9000, which is MinIO
```

Reload the env (`set -a; source env/local/dev.env; set +a`) and start the app. Before you reopen normal writes, check by hand:

1. An old file opens.
2. A new upload works and lands in RustFS (`scripts/migrate_minio_to_rustfs.sh rclone lsl --max-age 1h rustfs:helpudoc`).
3. Retrying a publication succeeds.

## Rollback

- **Nothing written to RustFS yet:** point `dev.env` back at `http://localhost:9000` with the MinIO login, then restart.
- **The app has written to RustFS:** Postgres now references objects that only RustFS has, so reconcile before switching back. Stop the writers. Run `verify`, which lists the new objects as `only in RustFS`. Then copy them back, dry run first:

  ```sh
  scripts/migrate_minio_to_rustfs.sh rclone copy rustfs:helpudoc minio:helpudoc --metadata --checksum --exclude '/sandbox-runs/**' --dry-run
  ```

- If **`.minio-data` itself is damaged:** restore it from `~/helpudoc-migrate/minio-backup-*`.
