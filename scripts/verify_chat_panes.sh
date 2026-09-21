#!/usr/bin/env bash
#
# Live verification for the workspace chat panes.
#
# Unit tests here run against fakes that never execute SQL and never exercise a
# real lifecycle transition (LEARNINGS.md §11). The behaviour this covers — an
# unshared workspace keeping a readable but frozen Team Chat — only exists in
# the interaction between `unshareWorkspace` and the collaboration gate.
#
# Requires AUTH_MODE=headers and a backend built from current source
# (LEARNINGS.md §8: rebuild, or you are testing the old image).
#
# Run it against the PREVIOUS build first: step 3 must fail there (it returns
# 201). A verification script where everything already passes verifies nothing.
#
# Usage:  ./scripts/verify_chat_panes.sh [API_BASE]

set -uo pipefail

API="${1:-http://localhost:3000/api}"
OWNER="panes-owner@local.com"
COLLAB="panes-collab@local.com"
STAMP="$(date +%s)"

pass=0; fail=0

as() {
  local user="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/panes.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -o /tmp/panes.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user"
  fi
  echo
  cat /tmp/panes.body
}
status() { echo "$1" | head -1; }
body()   { echo "$1" | tail -n +2; }
jqr() {
  body "$1" | python3 -c '
import sys, json
try: node = json.load(sys.stdin)
except Exception: sys.exit(0)
for key in sys.argv[1].split("."):
    try: node = node[int(key)] if key.lstrip("-").isdigit() else node[key]
    except Exception: sys.exit(0)
print(node)
' "$2" 2>/dev/null
}
check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1))
  else printf '  \033[31mFAIL\033[0m  %s  (expected %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

msg_count() {
  as "$1" GET "/workspaces/$2/collaboration/team-chat/messages" | tail -n +2 | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
rows = d.get("messages", d if isinstance(d, list) else [])
print(len(rows) if isinstance(rows, list) else -1)'
}

step "0. Set up"
r="$(as "$OWNER" POST /workspaces "{\"name\":\"Chat panes $STAMP\"}")"
WS="$(jqr "$r" "id")"
as "$COLLAB" GET /workspaces >/dev/null
CID="$(as "$OWNER" GET "/workspaces/user-directory?q=panes-collab" | tail -n +2 \
  | python3 -c 'import sys,json;u=json.load(sys.stdin)["users"];print(u[0]["id"] if u else "")')"
[ -z "$WS" ] || [ -z "$CID" ] && { echo "  setup failed"; exit 1; }
echo "  workspace: $WS"

step "1. A private workspace has no team surface at all"
check "team chat is refused while private" 409 \
  "$(status "$(as "$OWNER" GET "/workspaces/$WS/collaboration/team-chat/messages")")"

step "2. Shared: both members read and post"
r="$(as "$OWNER" POST "/workspaces/$WS/share" \
  "{\"userIds\":[\"$CID\"],\"role\":\"contributor\",\"editingPolicy\":\"direct\"}")"
check "workspace shared" 201 "$(status "$r")"
check "owner posts" 201 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/team-chat/messages" '{"body":"first message"}')")"
check "collaborator posts" 201 \
  "$(status "$(as "$COLLAB" POST "/workspaces/$WS/collaboration/team-chat/messages" '{"body":"a reply"}')")"
BEFORE="$(msg_count "$OWNER" "$WS")"
echo "  messages before unshare: $BEFORE"

step "3. Unshared: the history is readable, the room is closed"
check "unshare" 200 "$(status "$(as "$OWNER" POST "/workspaces/$WS/unshare" '{}')")"
check "owner still READS the history" 200 \
  "$(status "$(as "$OWNER" GET "/workspaces/$WS/collaboration/team-chat/messages")")"
check "  and the history is intact" "$BEFORE" "$(msg_count "$OWNER" "$WS")"
# This is the case that returns 201 on the previous build.
check "owner CANNOT post" 409 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/team-chat/messages" '{"body":"talking to myself"}')")"
r="$(as "$OWNER" POST "/workspaces/$WS/collaboration/team-chat/messages" '{"body":"x"}')"
check "  with the frozen code" "WORKSPACE_COLLABORATION_FROZEN" "$(jqr "$r" "details.code")"
check "collaborator still shut out" 403 \
  "$(status "$(as "$COLLAB" GET "/workspaces/$WS/collaboration/team-chat/messages")")"

step "4. Frozen covers the other write paths, not just messages"
check "creating a collaboration item is refused" 409 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects" \
    '{"type":"sticky_note","visibility":"workspace_audience","body":"note"}')")"

step "5. Re-sharing reopens it with the history intact"
check "reshare" 200 "$(status "$(as "$OWNER" POST "/workspaces/$WS/reshare" '{}')")"
check "owner can post again" 201 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/team-chat/messages" '{"body":"we are back"}')")"
check "  and nothing was lost" "$((BEFORE + 1))" "$(msg_count "$OWNER" "$WS")"

step "6. NEGATIVE CONTROL — an active shared workspace is untouched"
# A freeze that refuses everything looks identical to one that works
# (LEARNINGS.md §14).
r="$(as "$OWNER" POST /workspaces "{\"name\":\"Chat panes control $STAMP\"}")"
W2="$(jqr "$r" "id")"
as "$OWNER" POST "/workspaces/$W2/share" \
  "{\"userIds\":[\"$CID\"],\"role\":\"contributor\",\"editingPolicy\":\"direct\"}" >/dev/null
check "a never-unshared workspace still accepts posts" 201 \
  "$(status "$(as "$OWNER" POST "/workspaces/$W2/collaboration/team-chat/messages" '{"body":"still live"}')")"
check "and its collaborator too" 201 \
  "$(status "$(as "$COLLAB" POST "/workspaces/$W2/collaboration/team-chat/messages" '{"body":"still here"}')")"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspaces left for inspection: $WS  $W2"
[ "$fail" -eq 0 ]
