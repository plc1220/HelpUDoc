#!/usr/bin/env bash
#
# Live verification for applying several proposals to one Shared workspace.
#
# Applying replaces Shared Working with the private copy wholesale, so accepting
# one proposal makes every other open proposal stale — even when they touch
# different files. A stale apply now rebases the copy and retries once.
#
# None of this is reachable from the unit suite: it needs two real private
# copies, a real merge and a real revision sequence (LEARNINGS.md §11).
#
# Requires AUTH_MODE=headers and a backend built from current source
# (LEARNINGS.md §8: rebuild, or you are testing the old image).
#
# Run against the previous build first: step 3 returns 409 there.
#
# Usage:  ./scripts/verify_proposal_rebase.sh [API_BASE]

set -uo pipefail

API="${1:-http://localhost:3000/api}"
OWNER="rebase-owner@local.com"
ALICE="rebase-alice@local.com"
BOB="rebase-bob@local.com"
STAMP="$(date +%s)"

pass=0; fail=0

as() {
  local user="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/rb.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -o /tmp/rb.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user"
  fi
  echo
  cat /tmp/rb.body
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

user_id() {
  as "$OWNER" GET "/workspaces/user-directory?q=$1" | tail -n +2 \
    | python3 -c 'import sys,json;u=json.load(sys.stdin)["users"];print(u[0]["id"] if u else "")'
}
file_id() {  # file_id <user> <workspace> <name>
  as "$1" GET "/workspaces/$2/files" | tail -n +2 | python3 -c '
import sys, json
for f in json.load(sys.stdin):
    if f.get("name") == sys.argv[1]: print(f["id"]); break
' "$3"
}
file_names() {
  as "$1" GET "/workspaces/$2/files" | tail -n +2 \
    | python3 -c 'import sys,json;print(",".join(sorted(f["name"] for f in json.load(sys.stdin))))'
}
# Submit the caller's private copy for review; echoes the collaboration object id.
submit() {  # submit <user> <shared> <title>
  # Built into a variable first: nesting a payload with escaped quotes inside
  # $( $( ) ) mangles it, which is why this returned nothing.
  local payload created oid
  payload="{\"type\":\"sticky_note\",\"visibility\":\"workspace_audience\",\"title\":\"$3\",\"body\":\"$3\"}"
  created="$(as "$1" POST "/workspaces/$2/collaboration/objects" "$payload")"
  oid="$(jqr "$created" "id")"
  as "$1" POST "/workspaces/$2/collaboration/objects/$oid/proposal" '{}' >/dev/null
  echo "$oid"
}

step "0. One shared workspace, two contributors, one seed file"
WS="$(jqr "$(as "$OWNER" POST /workspaces "{\"name\":\"Rebase probe $STAMP\"}")" "id")"
# Registers each contributor. Their first authenticated call is what creates the
# user row, and the directory lookup below needs it to already be there.
as "$ALICE" GET /workspaces >/dev/null; as "$BOB" GET /workspaces >/dev/null
AID="$(user_id rebase-alice)"; BID="$(user_id rebase-bob)"
[ -z "$WS" ] || [ -z "$AID" ] || [ -z "$BID" ] && { echo "  setup failed"; exit 1; }
printf '# shared doc\noriginal\n' > /tmp/rb-seed.md
curl -sS -o /dev/null -X POST "$API/workspaces/$WS/files" -H "x-user-id: $OWNER" \
  -F "file=@/tmp/rb-seed.md;type=text/markdown" -F "path=doc.md"
SHARE_BODY="{\"userIds\":[\"$AID\",\"$BID\"],\"role\":\"contributor\",\"editingPolicy\":\"review\"}"
r="$(as "$OWNER" POST "/workspaces/$WS/share" "$SHARE_BODY")"
check "shared with both contributors" 201 "$(status "$r")"
echo "  workspace: $WS"

step "1. Both take a copy at the same revision, and change different things"
CA="$(jqr "$(as "$ALICE" POST "/workspaces/$WS/private-copy" '{}')" "id")"
CB="$(jqr "$(as "$BOB" POST "/workspaces/$WS/private-copy" '{}')" "id")"
AF="$(file_id "$ALICE" "$CA" doc.md)"
r="$(as "$ALICE" PUT "/workspaces/$CA/files/$AF/content" '{"content":"# shared doc\nALICE EDIT\n"}')"
check "alice edits doc.md" 200 "$(status "$r")"
printf 'bob only\n' > /tmp/rb-bob.md
check "bob adds bob.md" 201 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/workspaces/$CB/files" \
    -H "x-user-id: $BOB" -F "file=@/tmp/rb-bob.md;type=text/markdown" -F "path=bob.md")"

step "2. Both submit; two proposals are open at once"
OA="$(submit "$ALICE" "$WS" "Alice change")"
OB="$(submit "$BOB" "$WS" "Bob change")"
check "alice's proposal exists" 1 "$([ -n "$OA" ] && echo 1 || echo 0)"
check "bob's proposal exists"   1 "$([ -n "$OB" ] && echo 1 || echo 0)"

step "3. Apply both in turn — the second used to fail as PROPOSAL_STALE"
check "apply alice" 200 "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects/$OA/apply" '{}')")"
check "apply bob (auto-rebased)" 200 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects/$OB/apply" '{}')")"

step "4. Neither contributor's work was lost"
check "both files present" "bob.md,doc.md" "$(file_names "$OWNER" "$WS")"
DF="$(file_id "$OWNER" "$WS" doc.md)"
as "$OWNER" GET "/workspaces/$WS/files/$DF/content" >/dev/null
check "alice's edit survived bob's apply" 1 \
  "$(as "$OWNER" GET "/workspaces/$WS/files/$DF/content" | tail -n +2 | grep -c 'ALICE EDIT' || true)"

step "5. NEGATIVE CONTROL — overlapping edits still stop for a person"
# Both change the SAME file differently. A rebase must not silently pick a side.
CTRL="$(jqr "$(as "$OWNER" POST /workspaces "{\"name\":\"Rebase conflict $STAMP\"}")" "id")"
curl -sS -o /dev/null -X POST "$API/workspaces/$CTRL/files" -H "x-user-id: $OWNER" \
  -F "file=@/tmp/rb-seed.md;type=text/markdown" -F "path=doc.md"
as "$OWNER" POST "/workspaces/$CTRL/share" "$SHARE_BODY" >/dev/null
CA2="$(jqr "$(as "$ALICE" POST "/workspaces/$CTRL/private-copy" '{}')" "id")"
CB2="$(jqr "$(as "$BOB" POST "/workspaces/$CTRL/private-copy" '{}')" "id")"
AF2="$(file_id "$ALICE" "$CA2" doc.md)"; BF2="$(file_id "$BOB" "$CB2" doc.md)"
as "$ALICE" PUT "/workspaces/$CA2/files/$AF2/content" '{"content":"# shared doc\nALICE VERSION\n"}' >/dev/null
as "$BOB"   PUT "/workspaces/$CB2/files/$BF2/content" '{"content":"# shared doc\nBOB VERSION\n"}' >/dev/null
OA2="$(submit "$ALICE" "$CTRL" "Alice conflicting")"
OB2="$(submit "$BOB" "$CTRL" "Bob conflicting")"
check "apply alice" 200 "$(status "$(as "$OWNER" POST "/workspaces/$CTRL/collaboration/objects/$OA2/apply" '{}')")"
r="$(as "$OWNER" POST "/workspaces/$CTRL/collaboration/objects/$OB2/apply" '{}')"
check "apply bob is refused, not silently merged" 409 "$(status "$r")"
check "  and says why" "PROPOSAL_CONFLICT" "$(jqr "$r" "details.code")"
check "alice's version still stands" 1 \
  "$(as "$OWNER" GET "/workspaces/$CTRL/files/$(file_id "$OWNER" "$CTRL" doc.md)/content" \
     | tail -n +2 | grep -c 'ALICE VERSION' || true)"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspaces left for inspection: $WS  $CTRL"
[ "$fail" -eq 0 ]
