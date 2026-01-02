#!/usr/bin/env bash
set -euo pipefail

# Simulates the frontend "/presentation" request by invoking the Paper2Slides
# CLI with the same flags the backend uses (slides, general content, fast mode).
# Outputs are written alongside the input file (under that folder).
#
# Usage:
#   ./tests/test_paper2slides_frontend_flow.sh [path/to/input.md]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_INPUT="$REPO_ROOT/backend/workspaces/b271bf3a-cfda-4ac1-aa83-523d0012ac6a/china-trade-surplus.md"
INPUT_FILE="${1:-$DEFAULT_INPUT}"

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Input file not found: $INPUT_FILE" >&2
  exit 1
fi

INPUT_DIR="$(cd "$(dirname "$INPUT_FILE")" && pwd)"
PY_BIN="$REPO_ROOT/agent/.venv/bin/python"
[[ -x "$PY_BIN" ]] || PY_BIN="$(command -v python)"

if [[ -z "$PY_BIN" ]]; then
  echo "Python interpreter not found" >&2
  exit 1
fi

export PYTHONPATH="$REPO_ROOT/agent${PYTHONPATH:+:$PYTHONPATH}"

FROM_STAGE="${P2S_FROM_STAGE:-}"

echo "Running paper2slides on ${INPUT_FILE}"
echo "Outputs will be stored under ${INPUT_DIR}"
[[ -n "$FROM_STAGE" ]] && echo "from-stage override: ${FROM_STAGE}"

set -x
"$PY_BIN" -m paper2slides \
  --input "$INPUT_FILE" \
  --output slides \
  --content general \
  --style academic \
  --length short \
  --fast \
  --parallel 2 \
  --output-dir "$INPUT_DIR" \
  ${FROM_STAGE:+--from-stage "$FROM_STAGE"}

set +x
echo ""
echo "Recent outputs:"
find "$INPUT_DIR" -maxdepth 3 -type f \( -name '*.pdf' -o -name '*slide-*.*' \) -print | tail -n 20
