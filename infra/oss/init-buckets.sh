#!/bin/sh
set -eu

s3api() {
    aws --endpoint-url http://rustfs:9000 --cli-connect-timeout 2 --cli-read-timeout 4 s3api "$@"
}

# Wait for an authenticated request, not just an open port.
attempt=1
until s3api list-buckets >/dev/null 2>&1; do
    if [ "$attempt" -ge 30 ]; then
        echo "RustFS did not become ready or rejected the configured S3 credentials." >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 2
done

for bucket in "$S3_BUCKET_NAME" langfuse; do
    if ! s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
        s3api create-bucket --bucket "$bucket" >/dev/null
    fi
    s3api head-bucket --bucket "$bucket" >/dev/null
done
