#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Only placeholder values are used for static CI validation.
export POSTGRES_PASSWORD=compose-validation-only
export S3_ACCESS_KEY=compose-validation-only
export S3_SECRET_KEY=compose-validation-only
images=$(docker compose -f compose.yaml config --images)
printf '%s\n' "$images" | python3 -c '
import re
import sys
images = sys.stdin.read().splitlines()
if not images or not any("rustfs/rustfs@sha256:" in image for image in images):
    sys.exit("Expected a pinned RustFS image")
for image in images:
    if "minio" in image.lower() or not re.search(r"(:[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?|@sha256:[a-f0-9]{64})$", image):
        sys.exit(f"Unpinned or MinIO image: {image}")
print("OSS Compose images are version-pinned and MinIO-free")
'
