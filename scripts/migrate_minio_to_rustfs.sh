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

# These probes use exit 1 (with no output) when there are no matches. Diagnostics
# or any other failure mean we cannot prove that it is safe to continue.
find_host_writers() {
  local result rc
  if result="$("$@" 2>&1)"; then
    if [[ ! "$result" =~ ^[0-9]+($'\n'[0-9]+)*$ ]]; then
      printf 'Unexpected writer inventory from %s: %s\n' "$1" "$result" >&2
      return 1
    fi
    printf '%s\n' "$result"
  else
    rc=$?
    if [ "$rc" -ne 1 ] || [ -n "$result" ]; then
      printf 'Writer inventory failed (%s exited %s): %s\n' "$1" "$rc" "$result" >&2
      return 1
    fi
  fi
}

host_writers() {
  find_host_writers lsof -nP -a -t +w -sTCP:LISTEN -iTCP:3000 -iTCP:8001 -iTCP:5173 || return 1
  find_host_writers pgrep -f 'node.*[k]nowledgeWorker' || return 1
}

local_langfuse() {
  docker ps -q --filter 'name=^/helpudoc-langfuse-(web|worker)$'
}

compose_writers() {
  local svc
  for svc in backend agent frontend knowledge-worker langfuse-web langfuse-worker; do
    docker ps -q --filter network=infra_default --filter "label=com.docker.compose.service=$svc" || return 1
  done
}

require_quiescent() {
  local host langfuse containers
  host="$(host_writers)" || return 1
  langfuse="$(local_langfuse)" || return 1
  containers="$(compose_writers)" || return 1
  if [ -n "$host" ] || [ -n "$langfuse" ] || [ -n "$containers" ]; then
    printf 'Writers are still running. Stop them before continuing.\nHost PIDs: %s\nDocker IDs: %s\n%s\n' \
      "$host" "$langfuse" "$containers" >&2
    return 1
  fi
}

# ---- copy ---------------------------------------------------------------------

copy() {
  local b host langfuse id ok backup
  [ -d "$ROOT/.minio-data" ] || { echo "Missing source .minio-data directory" >&2; return 1; }

  for b in "${BUCKETS[@]}"; do rcl copy "minio:$b" "rustfs:$b" --metadata --checksum "${EXCL[@]}" --dry-run; done

  # Never kill arbitrary host processes by port. If a known local port or command
  # is still active, the operator must stop it and retry.
  host="$(host_writers)"
  if [ -n "$host" ]; then
    printf 'Stop the local writers and retry (PIDs):\n%s\n' "$host" >&2
    return 1
  fi
  langfuse="$(local_langfuse)"
  printf 'Local Langfuse containers to stop: %s\n' "${langfuse:-none}"
  read -r -p "Stop them and copy ${BUCKETS[*]} into RustFS? [y/N] " ok
  [ "$ok" = y ] || return 1

  if [ -n "$langfuse" ]; then
    while IFS= read -r id; do
      docker stop "$id" || { echo "Could not stop Langfuse container $id; no copy performed." >&2; return 1; }
    done <<< "$langfuse"
  fi
  require_quiescent

  backup="$(mktemp -d "$DIR/minio-backup-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  cp -R "$ROOT/.minio-data/." "$backup/"

  for b in "${BUCKETS[@]}"; do
    require_quiescent
    rcl size "${EXCL[@]}" "minio:$b" | tee "$DIR/$b.source-count.txt"
    rcl copy "minio:$b" "rustfs:$b" --metadata --checksum "${EXCL[@]}" -v
  done
  require_quiescent
  echo "Done. Keep writers stopped. Next: $0 verify"
}

# ---- verify -------------------------------------------------------------------

verify() {
  local b side src matched rc fail=0
  require_quiescent
  for b in "${BUCKETS[@]}"; do
    echo "== $b"
    for side in minio rustfs; do
      rcl lsjson -R --files-only --metadata "${EXCL[@]}" "$side:$b" >"$DIR/$b.$side.json"
      jq -e 'type == "array" and
        all(.[]; (.Path | type) == "string" and (.Size | type) == "number" and
          (.MimeType | type) == "string" and ((.Metadata // {}) | type) == "object") and
        (map(.Path) | length == (unique | length))' "$DIR/$b.$side.json" >/dev/null
    done

    # --one-way deliberately allows destination-only keys. Any nonzero exit
    # now means the source was not fully verified, even if output looks normal.
    if rcl check "minio:$b" "rustfs:$b" --one-way --download --combined - "${EXCL[@]}" >"$DIR/$b.check.txt"; then
      :
    else
      rc=$?
      echo "$b: rclone check failed (exit $rc)" >&2
      fail=1
    fi

    src="$(jq length "$DIR/$b.minio.json")"
    matched="$(awk '/^= / { n++ } END { print n+0 }' "$DIR/$b.check.txt")"
    echo "source objects: $src, identical in RustFS: $matched"

    # Compare the inventories independently. Paths and metadata remain JSON
    # data rather than being parsed from rclone's line-oriented report.
    jq -rn --slurpfile s "$DIR/$b.minio.json" --slurpfile d "$DIR/$b.rustfs.json" '
      def v: map({key: .Path, value: [.Size, .MimeType, (.Metadata // {} | del(.btime, .mtime, .tier))]}) | from_entries;
      ($s[0] | v) as $s | ($d[0] | v) as $d
      | $s | keys[] as $k
      | if ($d | has($k) | not) then "missing in RustFS: \($k | @json)"
        elif $s[$k] != $d[$k] then "size, content type or metadata differs: \($k | @json)"
        else empty end' >"$DIR/$b.problems.txt"
    awk '/^[+*!] / { print }' "$DIR/$b.check.txt" >>"$DIR/$b.problems.txt"
    if [ "$matched" != "$src" ] || [ -s "$DIR/$b.problems.txt" ]; then
      fail=1
      cat "$DIR/$b.problems.txt"
    fi

    jq -rn --slurpfile s "$DIR/$b.minio.json" --slurpfile d "$DIR/$b.rustfs.json" '
      (($d[0] | map(.Path)) - ($s[0] | map(.Path)))[] | "only in RustFS, investigate (not deleted): \(. | @json)"'
  done
  require_quiescent
  if [ "$fail" -eq 0 ]; then
    echo PASS
  else
    echo "FAIL (inspect $DIR before retrying)" >&2
    return 1
  fi
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
