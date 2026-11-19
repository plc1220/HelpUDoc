#!/bin/sh
# Run only against an isolated Docker daemon you control; this creates and removes
# a new project with disposable volumes. Never use this to verify a live stack.
set -eu
cd "$(dirname "$0")"

project="helpudoc-oss-smoke-$(date +%s)-$$"
export POSTGRES_USER=helpudoc POSTGRES_DB=helpudoc
export POSTGRES_PASSWORD="smoke-password-${project}"
export S3_ACCESS_KEY=oss-smoke-user S3_SECRET_KEY="smoke-secret-${project}"
export S3_BUCKET_NAME=helpudoc
export POSTGRES_PORT=0 REDIS_PORT=0 S3_PORT=0

compose() { docker compose -p "$project" -f compose.yaml "$@"; }
cleanup() { compose down --volumes --remove-orphans; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

query() {
    compose exec -T postgres psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"
}

object() {
    compose run --rm --no-deps --entrypoint /bin/sh bucket-init -ec '
        aws_s3() { aws --endpoint-url http://rustfs:9000 --cli-connect-timeout 2 --cli-read-timeout 5 s3api "$@"; }
        case "$1" in
            put) printf smoke-payload >/tmp/object; aws_s3 put-object --bucket "$S3_BUCKET_NAME" --key smoke.txt --body /tmp/object >/dev/null ;;
            get) aws_s3 get-object --bucket "$S3_BUCKET_NAME" --key smoke.txt /tmp/object >/dev/null; test "$(cat /tmp/object)" = smoke-payload ;;
            *) exit 2 ;;
        esac
    ' smoke "$1"
}

./check-compose.sh
compose up -d --wait --wait-timeout 150 postgres redis rustfs
compose run --rm --no-deps bucket-init
query "CREATE TABLE smoke (value text); INSERT INTO smoke VALUES ('smoke-payload');"
test "$(compose exec -T redis redis-cli --raw SET helpudoc:oss-smoke smoke-payload)" = OK
object put

# Recreate all three containers while keeping named volumes.
compose down
compose up -d --wait --wait-timeout 150 postgres redis rustfs
compose run --rm --no-deps bucket-init
test "$(query 'SELECT value FROM smoke;')" = smoke-payload
test "$(compose exec -T redis redis-cli --raw GET helpudoc:oss-smoke)" = smoke-payload
object get
echo 'OSS smoke passed: clean boot and Postgres, Redis, and RustFS data persisted across container recreation.'
