#!/bin/bash
set -euo pipefail
# Creates the Langfuse app database on first Postgres cluster init only.
exists="$(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='langfuse'")"
if [ "$exists" != "1" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE DATABASE langfuse;"
fi
