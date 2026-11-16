#!/usr/bin/env bash
# Use only on a disposable GitHub-hosted runner. Never run against an existing stack.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && -n "${RUNNER_TEMP:-}" ]] || {
  echo 'This rehearsal requires a disposable GitHub-hosted runner.' >&2
  exit 1
}
command -v aws jq lsof pgrep docker go curl >/dev/null
tmp="$(mktemp -d "$RUNNER_TEMP/rustfs-rehearsal.XXXXXXXX")"
mkdir -p "$tmp/repo/scripts" "$tmp/repo/env/local" "$tmp/repo/.minio-data" "$tmp/home"
cp scripts/migrate_minio_to_rustfs.sh "$tmp/repo/scripts/"
export HOME="$tmp/home"
migrate() { bash "$tmp/repo/scripts/migrate_minio_to_rustfs.sh" "$@"; }
network=
minio=
rustfs=
writer=
cleanup() {
  [[ -z "$writer" ]] || docker rm -f "$writer" >/dev/null 2>&1 || :
  [[ -z "$rustfs" ]] || docker rm -f "$rustfs" >/dev/null 2>&1 || :
  [[ -z "$minio" ]] || docker rm -f "$minio" >/dev/null 2>&1 || :
  [[ -z "$network" ]] || docker network rm "$network" >/dev/null 2>&1 || :
}
trap cleanup EXIT

cat >"$tmp/repo/env/local/stack.env" <<'ENV'
MINIO_ROOT_USER=fixture-minio
MINIO_ROOT_PASSWORD=synthetic-minio-test
RUSTFS_ROOT_USER=fixture-rustfs
RUSTFS_ROOT_PASSWORD=synthetic-rustfs-test
ENV
# Build a pinned official MinIO release; retired registry images are not reliable.
mkdir "$tmp/minio-image"
mkdir "$tmp/minio-source"
curl --fail --silent --show-error --location --retry 2 --max-time 90 \
  https://codeload.github.com/minio/minio/tar.gz/refs/tags/RELEASE.2025-10-15T17-29-55Z |
  tar -xz --strip-components=1 -C "$tmp/minio-source"
(cd "$tmp/minio-source" && CGO_ENABLED=0 go build -trimpath -o "$tmp/minio-image/minio" .)
docker build -t helpudoc-minio-rehearsal:local -f - "$tmp/minio-image" <<'DOCKERFILE'
FROM debian:bookworm-slim
COPY minio /minio
ENTRYPOINT ["/minio"]
DOCKERFILE
network="$(docker network create infra_default)"
minio="$(docker run -d --name helpudoc-minio --network "$network" -p 127.0.0.1::9000   -e MINIO_ROOT_USER=fixture-minio -e MINIO_ROOT_PASSWORD=synthetic-minio-test   -v "$tmp/repo/.minio-data:/data" helpudoc-minio-rehearsal:local server /data)"
rustfs="$(docker run -d --name helpudoc-rustfs --network "$network" -p 127.0.0.1::9000   -e RUSTFS_ACCESS_KEY=fixture-rustfs -e RUSTFS_SECRET_KEY=synthetic-rustfs-test   rustfs/rustfs:1.0.4)"
minio_url="http://$(docker port "$minio" 9000/tcp)"
rustfs_url="http://$(docker port "$rustfs" 9000/tcp)"
s3() {
  local endpoint=$1 user pass url
  shift
  case "$endpoint" in
    minio) user=fixture-minio; pass=synthetic-minio-test; url=$minio_url ;;
    rustfs) user=fixture-rustfs; pass=synthetic-rustfs-test; url=$rustfs_url ;;
    *) return 2 ;;
  esac
  AWS_ACCESS_KEY_ID="$user" AWS_SECRET_ACCESS_KEY="$pass" AWS_DEFAULT_REGION=us-east-1 \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    AWS_MAX_ATTEMPTS=1 AWS_EC2_METADATA_DISABLED=true AWS_PAGER= \
    aws --endpoint-url "$url" --cli-connect-timeout 2 --cli-read-timeout 4 s3api "$@"
}
for endpoint in minio rustfs; do
  ready=false
  for ((attempt=1; attempt<=30; attempt++)); do
    if s3 "$endpoint" list-buckets >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
  done
  if [[ $ready != true ]]; then
    docker logs "$minio"
    docker logs "$rustfs"
    exit 1
  fi
  for bucket in helpudoc langfuse; do
    s3 "$endpoint" create-bucket --bucket "$bucket" >/dev/null
  done
done

for bucket in helpudoc langfuse; do
  printf 'migration fixture: %s\n' "$bucket" >"$tmp/$bucket.txt"
  digest="$(sha256sum "$tmp/$bucket.txt" | cut -d' ' -f1)"
  s3 minio put-object --bucket "$bucket" --key 'nested/previous revision.txt' \
    --body "$tmp/$bucket.txt" --content-type text/plain \
    --metadata "helpudoc-sha256=$digest,fixture-origin=minio" >/dev/null
  s3 minio put-object --bucket "$bucket" --key sandbox-runs/transient.txt --body "$tmp/$bucket.txt" >/dev/null
  s3 rustfs put-object --bucket "$bucket" --key destination-extra.txt --body "$tmp/$bucket.txt" >/dev/null
done

# Use the actual copy path, and a disposable writer with the supported Langfuse name.
writer="$(docker run -d --name helpudoc-langfuse-worker --network "$network" --entrypoint sh rclone/rclone:1.76.0 -c 'exec sleep 300')"
migrate copy <<<y
[[ "$(docker inspect -f '{{.State.Running}}' "$writer")" == false ]]
migrate verify
for bucket in helpudoc langfuse; do
  digest="$(sha256sum "$tmp/$bucket.txt" | cut -d' ' -f1)"
  s3 rustfs head-object --bucket "$bucket" --key 'nested/previous revision.txt' |
    jq -e --arg digest "$digest" '.ContentType == "text/plain" and .Metadata["helpudoc-sha256"] == $digest and .Metadata["fixture-origin"] == "minio"' >/dev/null
  s3 rustfs get-object --bucket "$bucket" --key 'nested/previous revision.txt' "$tmp/recovered-$bucket" >/dev/null
  cmp "$tmp/$bucket.txt" "$tmp/recovered-$bucket"
  s3 rustfs list-objects-v2 --bucket "$bucket" --query 'Contents[].Key' --output json |
    jq -e 'sort == ["destination-extra.txt","nested/previous revision.txt"]' >/dev/null
done

# Same bytes but wrong user metadata must not pass, even with a destination-only key.
s3 rustfs put-object --bucket langfuse --key 'nested/previous revision.txt' \
  --body "$tmp/langfuse.txt" --content-type text/plain --metadata 'fixture-origin=wrong' >/dev/null
if migrate verify >"$tmp/bad-metadata.log" 2>&1; then
  cat "$tmp/bad-metadata.log"
  echo 'Verification accepted incorrectly migrated metadata.' >&2
  exit 1
fi
cat "$tmp/bad-metadata.log"
grep -F 'metadata differs: "nested/previous revision.txt"' "$tmp/bad-metadata.log"
echo 'Both buckets passed the rehearsal; destination extras survived and invalid metadata was rejected.'
