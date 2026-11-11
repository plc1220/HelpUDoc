## Update:

### Experiment results:

MinIO data in my local directory
<img width="626" height="203" alt="image" src="https://github.com/user-attachments/assets/179ef501-3ca6-4a45-9769-c258a94d20ca" />

Transferred to RustFS, both files kept and identical

<img width="625" height="280" alt="image" src="https://github.com/user-attachments/assets/ab367747-00a1-4be5-8c45-7ed390b523ef" />


## Detailed steps to run the code:
Run from the repo root in one terminal.

**1. Start the dependencies and stop the app.** Stop the backend, agent and knowledge worker. The `lsof` command should print nothing.

```sh
docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d postgres redis rustfs rustfs-setup
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

**2. Start a temporary MinIO on a copy of the data.** `~/helpudoc-migrate/minio-copy` must not already exist.

```sh
# make new dir helpudoc-migrate, copy .minio-data into a new folder minio-copy under this new dir
mkdir -p ~/helpudoc-migrate
cp -R .minio-data ~/helpudoc-migrate/minio-copy

  
# run temporary minio container, with the new copies
docker run -d --rm --name helpudoc-minio-migrate --network infra_default \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -v ~/helpudoc-migrate/minio-copy:/data \
  cgr.dev/chainguard/minio:latest server /data

# verify status of container
docker ps --filter name=helpudoc-minio-migrate
```

**3. Configure rclone.**

```sh
# create rclone.conf config fil
# source = minio, destination = rustfs
cat > ~/helpudoc-migrate/rclone.conf <<'EOF'
[minio]
type = s3
provider = Minio
endpoint = http://helpudoc-minio-migrate:9000
access_key_id = minioadmin
secret_access_key = minioadmin
force_path_style = true

[rustfs]
type = s3
provider = Other
endpoint = http://helpudoc-rustfs:9000
access_key_id = minioadmin
secret_access_key = minioadmin
force_path_style = true
EOF


# create shortcut command rcl 
# put rclone, helpudoc-minio-migrate, helpudoc-rustfs on the same docker netowrk (default)
rcl() { docker run --rm --network infra_default -v "$HOME/helpudoc-migrate:/work" rclone/rclone:1.76.0 --config /work/rclone.conf "$@"; }

# skip temp files to speed up
FILTERS=(--exclude 'sandbox-runs/**')
```

**4. Pre-Flight Validation, List both sides.** Expect 2 objects in MinIO and none in RustFS. The `grep` count must be above 0.

```sh
# display files in minio and rustfs (using the conf)
rcl lsl minio:
rcl lsl rustfs:

# export detailed file metadata into a JSON report
rcl lsjson -R --metadata minio:helpudoc > ~/helpudoc-migrate/minio.json

# count specific files and hashes for MinIO (BEFORE)
grep -c 'helpudoc-sha256' ~/helpudoc-migrate/minio.json
```

**5. Dry run.** Expect 2 `Skipped copy` lines for `helpudoc` and nothing for `langfuse`. Stop if any delete appears.

```sh
rcl sync minio:helpudoc rustfs:helpudoc --metadata --checksum "${FILTERS[@]}" --dry-run
rcl sync minio:langfuse rustfs:langfuse --metadata --checksum "${FILTERS[@]}" --dry-run
```

**6. Migration: Sync.**

```sh
rcl sync minio:helpudoc rustfs:helpudoc --metadata --checksum "${FILTERS[@]}" --progress
rcl sync minio:langfuse rustfs:langfuse --metadata --checksum "${FILTERS[@]}" --progress
```

**7. Post migration: Check contents.** Expect `0 differences found`.

```sh
# check: compare source and destination buckets, look for missing files
rcl check minio:helpudoc rustfs:helpudoc "${FILTERS[@]}" --download
```

**8. Prove every single migrated file is identical bit by bit. Compare SHA-256 lists.** Expect `IDENTICAL`.

```sh
# download every files in both buckets, calculate their sha256, save the sorted list of hashes into minio.sha and rustfs.sha
rcl hashsum sha256 --download "${FILTERS[@]}" minio:helpudoc | sort -k2 > ~/helpudoc-migrate/minio.sha
rcl hashsum sha256 --download "${FILTERS[@]}" rustfs:helpudoc | sort -k2 > ~/helpudoc-migrate/rustfs.sha

# compare both lists using diff and print IDENTICAL
diff ~/helpudoc-migrate/minio.sha ~/helpudoc-migrate/rustfs.sha && echo IDENTICAL
```

**9. Compare metadata.** Expect `MATCH`, and a `grep` count equal to step 4.

```sh
# generate destination metadata report
rcl lsjson -R --metadata "${FILTERS[@]}" rustfs:helpudoc > ~/helpudoc-migrate/rustfs.json

# keep path, size, content type and helpudoc-* metadata, then compare both sides
meta() { jq -S '[.[] | select(.IsDir | not) | {Path, Size, MimeType, meta: (.Metadata | with_entries(select(.key | startswith("helpudoc-"))))}] | sort_by(.Path)' "$HOME/helpudoc-migrate/$1.json"; }
diff <(meta minio) <(meta rustfs) && echo MATCH

# confirm the hashes are really there
grep -c 'helpudoc-sha256' ~/helpudoc-migrate/rustfs.json
```

**10. Stop the temporary MinIO and test anonymous access.** The `curl` must print `403`.

```sh
docker stop helpudoc-minio-migrate
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:9000/helpudoc/?list-type=2'
```

## Takeaways:
In **step 5 & 6**, I used sync instead of copy with the assumption that RustFS is empty when created. 

Here's the difference:
**sync**: 
* delete a file in destination if the file is not in source, source and destination identical. 

**copy**: 
* destination can have new files that source doesn't, the files in soucre get copied into destination.

In our case, sync is our assumed scenario.