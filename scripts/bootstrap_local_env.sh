#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ENV="$ROOT_DIR/env/local/dev.env"
STACK_ENV="$ROOT_DIR/env/local/stack.env"

copy_if_missing() {
  local source="$1"
  local target="$2"
  if [[ -f "$target" ]]; then
    echo "Keeping existing $target"
    return
  fi
  cp "$source" "$target"
  echo "Created $target"
}

generate_secret() {
  if command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import base64
import os
print(base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii"))
PY
    return
  fi
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  echo
}

set_env_if_blank() {
  local file="$1"
  local key="$2"
  local value="$3"
  if ! grep -q "^${key}=" "$file"; then
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
    echo "Set $key in $file"
    return
  fi
  if grep -q "^${key}=$" "$file"; then
    perl -0pi -e "s/^${key}=\\K\$/$(printf '%s' "$value" | perl -pe 's/([\\\\$@%])/\\\\$1/g')/m" "$file"
    echo "Set $key in $file"
  else
    echo "Keeping existing $key in $file"
  fi
}

copy_if_missing "$ROOT_DIR/env/local/dev.env.example" "$DEV_ENV"
copy_if_missing "$ROOT_DIR/env/local/stack.env.example" "$STACK_ENV"

TOKEN_KEY="$(generate_secret)"
set_env_if_blank "$DEV_ENV" "OAUTH_TOKEN_ENCRYPTION_KEY" "$TOKEN_KEY"
set_env_if_blank "$STACK_ENV" "OAUTH_TOKEN_ENCRYPTION_KEY" "$TOKEN_KEY"

cat <<EOF

Local env is ready.

Next:
  1. Edit env/local/dev.env and env/local/stack.env with real values for:
     - GEMINI_API_KEY
     - RAG_LLM_API_KEY, usually the same value for local dev
     - GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, if using Google login
     - GOOGLE_WORKSPACE_MCP_URL, if using the Google Workspace MCP sidecar
  2. Start dependencies:
     docker compose -f infra/docker-compose.dependencies.yml --env-file env/local/stack.env up -d
  3. Start backend, agent, and frontend using docs/environment.md.

These env files are ignored by git and are safe for machine-local credentials.
EOF
