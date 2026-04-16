#!/usr/bin/env bash
# Idempotent: ensure Postgres has a `langfuse` database; restart Langfuse if created.
# Optionally wait for Langfuse deployments to become ready (pass --wait-rollout).
set -euo pipefail

WAIT_ROLLOUT=false
if [[ "${1:-}" == "--wait-rollout" ]]; then
  WAIT_ROLLOUT=true
fi

NS="${KUBECTL_NAMESPACE:-helpudoc}"

PG_POD="$(kubectl -n "${NS}" get pods -l app=helpudoc-postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "${PG_POD}" ]]; then
  echo "Postgres pod not found; skipping Langfuse DB bootstrap."
  exit 0
fi

POSTGRES_DB="$(kubectl -n "${NS}" get configmap helpudoc-config -o jsonpath='{.data.POSTGRES_DB}')"
POSTGRES_USER="$(kubectl -n "${NS}" get configmap helpudoc-config -o jsonpath='{.data.POSTGRES_USER}')"
POSTGRES_PASSWORD="$(kubectl -n "${NS}" get secret helpudoc-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 --decode)"

HAS_LANGFUSE="$(kubectl -n "${NS}" exec -i "${PG_POD}" -- \
  env PGPASSWORD="${POSTGRES_PASSWORD}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -tAc "SELECT 1 FROM pg_database WHERE datname = 'langfuse'")"
HAS_LANGFUSE="$(echo "${HAS_LANGFUSE}" | tr -d '[:space:]')"

CREATED_LANGFUSE_DB=false
if [[ "${HAS_LANGFUSE}" != "1" ]]; then
  kubectl -n "${NS}" exec -i "${PG_POD}" -- \
    env PGPASSWORD="${POSTGRES_PASSWORD}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -c "CREATE DATABASE langfuse;"
  CREATED_LANGFUSE_DB=true
fi

if kubectl -n "${NS}" get deploy helpudoc-langfuse-web >/dev/null 2>&1; then
  if [[ "${CREATED_LANGFUSE_DB}" == "true" ]]; then
    kubectl -n "${NS}" rollout restart deployment/helpudoc-langfuse-web deployment/helpudoc-langfuse-worker
  fi
  if [[ "${WAIT_ROLLOUT}" == "true" ]]; then
    kubectl -n "${NS}" rollout status deployment/helpudoc-langfuse-web --timeout=600s
    kubectl -n "${NS}" rollout status deployment/helpudoc-langfuse-worker --timeout=600s
  fi
fi
