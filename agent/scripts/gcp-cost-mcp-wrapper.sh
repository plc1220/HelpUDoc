#!/bin/sh
set -eu

TMP_CREDENTIALS_PATH="/tmp/gcp-cost-service-account.json"

if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  if [ -n "${GCP_COST_SERVICE_ACCOUNT_JSON_B64:-}" ]; then
    printf '%s' "$GCP_COST_SERVICE_ACCOUNT_JSON_B64" | base64 -d > "$TMP_CREDENTIALS_PATH"
    export GOOGLE_APPLICATION_CREDENTIALS="$TMP_CREDENTIALS_PATH"
  elif [ -n "${GCP_COST_SERVICE_ACCOUNT_JSON:-}" ]; then
    printf '%s' "$GCP_COST_SERVICE_ACCOUNT_JSON" > "$TMP_CREDENTIALS_PATH"
    export GOOGLE_APPLICATION_CREDENTIALS="$TMP_CREDENTIALS_PATH"
  fi
fi

exec /usr/local/bin/gcp-cost-mcp-server "$@"
