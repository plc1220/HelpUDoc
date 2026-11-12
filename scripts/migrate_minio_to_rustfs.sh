#!/usr/bin/env bash
# One-way copy of the local MinIO buckets into RustFS.
# Runbook: docs/migration/minio-to-rustfs-local-sync.md
# The same steps by hand, one command at a time: docs/migration/minio_rustfs_v1.md
#
# Usage: scripts/migrate_minio_to_rustfs.sh <command>
#   copy          dry run, confirm, stop writers, back up .minio-data, record source counts, rclone copy
#   verify        keys, bytes, content type and metadata per bucket; lists RustFS-only objects, never deletes
#   rclone ARGS   rclone with the minio: and rustfs: remotes, e.g. `rclone lsl rustfs:helpudoc`

# Safety switches: stop at the first failing command (-e), treat an unset variable as an
# error (-u), and count a pipe (a | b) as failed if any part of it fails (pipefail).
# Where a failure is expected and harmless, such as grep finding nothing, the line ends in `|| true`.
set -euo pipefail

# ---- Settings ---------------------------------------------------------------

# Repo root, worked out from where this file lives, so the script runs from any folder.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Reports and backups. Every run reuses this folder and overwrites its reports;
# each backup gets its own timestamped folder inside it.
DIR="$HOME/helpudoc-migrate"
# Buckets to migrate. (a b) is a list, and "${BUCKETS[@]}" means every item in it.
BUCKETS=(helpudoc langfuse)
# rclone option that skips the agent's per-run transfer archives at the bucket root.
# Every listing, copy and check uses it on both sides, so the counts stay comparable.
EXCL=(--exclude '/sandbox-runs/**')
mkdir -p "$DIR" # -p: no error if the folder already exists
# Load the store logins (MINIO_ROOT_*, RUSTFS_ROOT_*). `.` runs the file inside this
# script; it only holds KEY=value lines, so this just sets those variables.
. "$ROOT/env/local/stack.env"

# ---- rclone connections -------------------------------------------------------

# rclone calls a saved connection a "remote", and reads remotes from variables named
# RCLONE_CONFIG_<REMOTE>_<SETTING>. These define two remotes, minio: and rustfs:,
# without writing a config file that holds passwords.
#   TYPE=s3            both stores speak the S3 protocol
#   PROVIDER           small product quirks; RustFS uses rclone's generic "Other"
#   ENDPOINT           container name and the port inside Docker. rclone runs in a container,
#                      where localhost would mean the rclone container itself.
#   ACCESS_KEY_ID, SECRET_ACCESS_KEY
#                      the login. ${X:-default} means "X, or the default if X is empty".
#   FORCE_PATH_STYLE   address files as host/bucket/file, which local stores need
# `export` passes the variables on to programs this script starts. That's how docker sees them.
export RCLONE_CONFIG_MINIO_TYPE=s3 RCLONE_CONFIG_MINIO_PROVIDER=Minio RCLONE_CONFIG_MINIO_FORCE_PATH_STYLE=true \
  RCLONE_CONFIG_MINIO_ENDPOINT=http://helpudoc-minio:9000 \
  RCLONE_CONFIG_MINIO_ACCESS_KEY_ID="${MINIO_ROOT_USER:-minioadmin}" \
  RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY="${MINIO_ROOT_PASSWORD:-minioadmin}" \
  RCLONE_CONFIG_RUSTFS_TYPE=s3 RCLONE_CONFIG_RUSTFS_PROVIDER=Other RCLONE_CONFIG_RUSTFS_FORCE_PATH_STYLE=true \
  RCLONE_CONFIG_RUSTFS_ENDPOINT=http://helpudoc-rustfs:9000 \
  RCLONE_CONFIG_RUSTFS_ACCESS_KEY_ID="${RUSTFS_ROOT_USER:-rustfsadmin}" \
  RCLONE_CONFIG_RUSTFS_SECRET_ACCESS_KEY="${RUSTFS_ROOT_PASSWORD:-rustfsadmin}"

# rcl: run rclone in a throwaway container on the stores' Docker network.
#   --rm                 delete the container when rclone finishes
#   $(compgen -e | ...)  turns each exported RCLONE_CONFIG_* name into "-e NAME", which copies
#                        that variable into the container. Only names appear on the command line,
#                        so the passwords never show up in `ps`.
#   --config /dev/null   no config file; the variables above are the config
#   "$@"                 every argument given to rcl: `rcl lsd minio:` runs `rclone lsd minio:`
rcl() { docker run --rm --network infra_default $(compgen -e | grep '^RCLONE_CONFIG_' | sed 's/^/-e /') rclone/rclone:1.76.0 --config /dev/null "$@"; }

# ---- Writers ------------------------------------------------------------------

# Print the process ID of everything that writes to storage: backend 3000, agent 8001,
# Vite 5173 (forwards browser uploads when S3_PUBLIC_ENDPOINT points at it) and the knowledge
# worker. lsof finds whatever listens on a port; pgrep finds a process by its command line.
# 2>/dev/null hides error messages, and `|| true` means "nothing running" isn't a failure.
writers() { { lsof -t -sTCP:LISTEN -iTCP:3000 -iTCP:8001 -iTCP:5173; pgrep -f 'node.*knowledgeWorker'; } 2>/dev/null || true; }

# ---- copy ---------------------------------------------------------------------

copy() {
  local b pid g ok # local: these variables exist only inside this function

  # 1. Dry run: show what would be copied. Nothing changes.
  for b in "${BUCKETS[@]}"; do rcl copy "minio:$b" "rustfs:$b" --metadata --checksum "${EXCL[@]}" --dry-run; done

  # 2. Show what will be stopped, then ask. Anything but y exits with nothing changed.
  echo "Writers to stop:"
  lsof -nP -sTCP:LISTEN -iTCP:3000 -iTCP:8001 -iTCP:5173 || true
  pgrep -fl 'node.*knowledgeWorker' || true
  docker ps --filter name=langfuse --format '{{.Names}}'
  read -r -p "Stop them and copy ${BUCKETS[*]} into RustFS? [y/N] " ok
  [ "$ok" = y ] || exit 1

  # 3. Stop each writer's whole process group: everything one terminal command started
  #    (npm -> nodemon -> ts-node, or the uvicorn reloader and its worker). Groups led by a
  #    shell (zsh, bash) are skipped, so your terminals stay open. kill -TERM is a polite
  #    "please stop", like Ctrl-C, and the minus in "-$g" means the whole group.
  for pid in $(writers); do
    g="$(ps -o pgid= -p "$pid" | tr -d ' ')" || continue
    case "$(ps -o comm= -p "$g")" in *sh) continue ;; esac
    kill -TERM -- "-$g" 2>/dev/null || true
  done
  # Langfuse writes to the langfuse bucket. xargs turns the container IDs into arguments for docker stop.
  docker ps -q --filter name=langfuse | xargs docker stop >/dev/null 2>&1 || true
  # Give them 3 seconds to exit, and refuse to copy while anything is still running.
  sleep 3
  if [ -n "$(writers)" ]; then echo "Still running, stop these yourself: $(writers | xargs)"; exit 1; fi

  # 4. Rollback copy of MinIO's data, named with the date and time. The migration only reads MinIO.
  cp -R "$ROOT/.minio-data" "$DIR/minio-backup-$(date +%Y%m%d-%H%M%S)"

  # 5. For each bucket, record the real object count (tee shows it and saves it), then copy.
  #    --metadata keeps the content type and helpudoc-sha256. --checksum skips files whose
  #    content already matches, so a rerun is safe. `copy` never deletes anything from RustFS.
  for b in "${BUCKETS[@]}"; do
    rcl size "${EXCL[@]}" "minio:$b" | tee "$DIR/$b.source-count.txt"
    rcl copy "minio:$b" "rustfs:$b" --metadata --checksum "${EXCL[@]}" -v
  done
  echo "Done. Keep writers stopped. Next: $0 verify"
}

# ---- verify -------------------------------------------------------------------

verify() {
  local b side src matched fail=0
  for b in "${BUCKETS[@]}"; do
    echo "== $b"
    # List every file and its metadata on both sides, saved as JSON.
    for side in minio rustfs; do rcl lsjson -R --files-only --metadata "${EXCL[@]}" "$side:$b" >"$DIR/$b.$side.json"; done

    # Download both copies of every file and compare them byte by byte. --combined - prints
    # one line per file, starting with a symbol:
    #   "=" same key and bytes, "+" missing in RustFS, "*" bytes differ, "!" error, "-" only in RustFS
    # check exits with an error whenever anything differs; `|| true` lets us read the report ourselves.
    rcl check "minio:$b" "rustfs:$b" --download --combined - "${EXCL[@]}" >"$DIR/$b.check.txt" 2>/dev/null || true

    # Real source count, and the number of files identical in RustFS (grep -c counts lines starting with "=").
    src="$(jq length "$DIR/$b.minio.json")"
    matched="$(grep -c '^=' "$DIR/$b.check.txt" || true)"
    echo "source objects: $src, identical in RustFS: $matched"

    # jq reads JSON. For each file, compare size, content type and metadata (helpudoc-sha256
    # included), ignoring btime, mtime and tier, which change on any copy.
    jq -rn --slurpfile s "$DIR/$b.minio.json" --slurpfile d "$DIR/$b.rustfs.json" '
      def v: map({key: .Path, value: [.Size, .MimeType, (.Metadata // {} | del(.btime, .mtime, .tier))]}) | from_entries;
      ($s[0] | v) as $s | ($d[0] | v) as $d
      | $s | keys[] | select($d[.] != null and $s[.] != $d[.]) | "metadata differs: \(.)"' >"$DIR/$b.problems.txt"
    # Add the missing, differing and error lines in plain words. >> appends to the file.
    grep '^[+*!]' "$DIR/$b.check.txt" | sed 's/^+ /missing in RustFS: /; s/^\* /bytes differ: /; s/^! /error: /' \
      >>"$DIR/$b.problems.txt" || true

    # The bucket fails if the counts differ or the problems file isn't empty (-s).
    if [ "$matched" != "$src" ] || [ -s "$DIR/$b.problems.txt" ]; then fail=1; cat "$DIR/$b.problems.txt"; fi
    # Files only RustFS has: listed for you to investigate, never deleted.
    grep '^- ' "$DIR/$b.check.txt" | sed 's/^- /only in RustFS, investigate (not deleted): /' || true
  done
  if [ "$fail" = 0 ]; then echo PASS; else echo "FAIL (fix one object: $0 rclone copyto minio:<b>/<key> rustfs:<b>/<key> --metadata --ignore-times)"; exit 1; fi
}

# ---- Pick the command -----------------------------------------------------------

# $1 is the first word after the script name. ${1:-} is empty if there isn't one
# (without it, set -u would stop with "unbound variable").
case "${1:-}" in
  copy)
    copy
    ;;
  verify)
    verify
    ;;
  rclone)
    shift # drop the word "rclone" and pass the rest to rclone as is
    rcl "$@"
    ;;
  *)
    echo "Usage: $0 {copy|verify|rclone}"
    exit 2
    ;;
esac
