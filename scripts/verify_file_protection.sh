#!/usr/bin/env bash
#
# Live verification for "a signed-off file is read-only".
#
# Unit tests here run against fakes, and LEARNINGS.md §11 records a change that
# passed every test and did nothing live. This drives the real API.
#
# Requires AUTH_MODE=headers and a backend built from the current source
# (LEARNINGS.md §8: rebuild, or you are testing the old image).
#
# Usage:  ./scripts/verify_file_protection.sh [API_BASE]

set -uo pipefail

API="${1:-http://localhost:3000/api}"
OWNER="fileprot-owner@local.com"
CONTRIB="fileprot-contrib@local.com"
STAMP="$(date +%s)"

pass=0; fail=0

as() {
  local user="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/fileprot.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -o /tmp/fileprot.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user"
  fi
  echo
  cat /tmp/fileprot.body
}

status() { echo "$1" | head -1; }
body()   { echo "$1" | tail -n +2; }
jqr() {
  body "$1" | python3 -c '
import sys, json
try:
    node = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    try:
        node = node[int(key)] if key.lstrip("-").isdigit() else node[key]
    except Exception:
        sys.exit(0)
print(node)
' "$2" 2>/dev/null
}

check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1))
  else printf '  \033[31mFAIL\033[0m  %s  (expected %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

upload() { # upload <workspace> <path> <text>
  printf '%s\n' "$3" > /tmp/fileprot-seed.md
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/workspaces/$1/files" \
    -H "x-user-id: $CONTRIB" -H "x-user-name: $CONTRIB" -H "x-user-email: $CONTRIB" \
    -F "file=@/tmp/fileprot-seed.md;type=text/markdown" -F "path=$2"
}

fileIdFor() { # fileIdFor <workspace> <path>
  as "$OWNER" GET "/workspaces/$1/files" | body - 2>/dev/null
  as "$OWNER" GET "/workspaces/$1/files" | tail -n +2 | python3 -c '
import sys, json
for f in json.load(sys.stdin):
    if f.get("name") == sys.argv[1]:
        print(f["id"]); break
' "$2" 2>/dev/null
}

step "0. Set up a Shared workspace with one approved and one draft file"
r="$(as "$OWNER" POST /workspaces "{\"name\":\"File protection $STAMP\"}")"
WS="$(jqr "$r" "id")"
as "$CONTRIB" GET /workspaces >/dev/null
r="$(as "$OWNER" GET "/workspaces/user-directory?q=fileprot-contrib")"
CONTRIB_ID="$(jqr "$r" "users.0.id")"
[ -z "$WS" ] || [ -z "$CONTRIB_ID" ] && { echo "  setup failed"; exit 1; }

r="$(as "$OWNER" POST "/workspaces/$WS/share" \
  "{\"userIds\":[\"$CONTRIB_ID\"],\"role\":\"contributor\",\"editingPolicy\":\"direct\"}")"
check "workspace shared" 201 "$(status "$r")"

# Seeded by the contributor so the owner is not the last editor. The
# self-approval guard is gone, but keeping the roles distinct makes the test
# about protection rather than about who may approve.
check "signed-off file uploaded" 201 "$(upload "$WS" "signed.md" "# Signed off")"
check "draft file uploaded" 201 "$(upload "$WS" "scratch.md" "# Scratch")"
SIGNED="$(fileIdFor "$WS" "signed.md")"
DRAFT="$(fileIdFor "$WS" "scratch.md")"
echo "  signed.md=$SIGNED  scratch.md=$DRAFT"

step "1. Approve straight from draft (Part B: the new edge)"
# A reason is recorded when given and never demanded: the transition is already
# an audited decision carrying actor, time and from/to.
r="$(as "$OWNER" POST "/workspaces/$WS/files/$DRAFT/status" '{"toStatus":"approved"}')"
check "approved with no reason given" 200 "$(status "$r")"
r="$(as "$OWNER" POST "/workspaces/$WS/files/$DRAFT/status" \
  '{"toStatus":"draft","reason":"putting it back for the rest of the run"}')"
check "  and returned to draft" 200 "$(status "$r")"

r="$(as "$OWNER" POST "/workspaces/$WS/files/$SIGNED/status" \
  '{"toStatus":"approved","reason":"Agreed at standup; no review needed"}')"
check "approved with a reason" 200 "$(status "$r")"
check "  and the file is approved" "approved" "$(jqr "$r" "status")"

step "2. Approved means read-only — for everyone"
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$SIGNED/content" '{"content":"contributor edit"}')"
check "contributor is refused" 409 "$(status "$r")"
check "  with the protected code" "FILE_CONTENT_PROTECTED" "$(jqr "$r" "details.code")"

r="$(as "$OWNER" PUT "/workspaces/$WS/files/$SIGNED/content" '{"content":"owner edit"}')"
check "OWNER is refused too" 409 "$(status "$r")"

r="$(as "$OWNER" PATCH "/workspaces/$WS/files/$SIGNED" '{"name":"renamed.md"}')"
check "rename is refused" 409 "$(status "$r")"
r="$(as "$OWNER" DELETE "/workspaces/$WS/files/$SIGNED")"
check "delete is refused" 409 "$(status "$r")"

step "3. Negative control — a draft file in the same workspace still saves"
# A guard that refuses everything looks identical to one that works
# (LEARNINGS.md §14).
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$DRAFT/content" '{"content":"# Scratch\nstill editable"}')"
check "draft file still saves" 200 "$(status "$r")"

step "4. Sending it back is the way in"
r="$(as "$OWNER" POST "/workspaces/$WS/files/$SIGNED/status" '{"toStatus":"draft"}')"
check "owner returns it to draft, no reason needed" 200 "$(status "$r")"
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$SIGNED/content" '{"content":"# Corrected"}')"
check "and the file is editable again" 200 "$(status "$r")"

step "5. A publisher may now sign off their own edit"
r="$(as "$OWNER" PUT "/workspaces/$WS/files/$SIGNED/content" '{"content":"# Owner wrote this"}')"
check "owner edits the draft" 200 "$(status "$r")"
r="$(as "$OWNER" POST "/workspaces/$WS/files/$SIGNED/status" \
  '{"toStatus":"approved","reason":"Own work, vouched for"}')"
check "owner approves their own edit" 200 "$(status "$r")"

step "6. The draft file is editable again for the rest of the checks"
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$DRAFT/content" '{"content":"# Scratch\nstill fine"}')"
check "draft file remains editable" 200 "$(status "$r")"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspace left in place for inspection: $WS"
[ "$fail" -eq 0 ]
