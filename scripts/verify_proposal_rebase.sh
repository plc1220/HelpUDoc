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
# The locked version number, or "None" while the workspace is on Working.
locked_version() {  # locked_version <user> <workspace>
  as "$1" GET /workspaces | tail -n +2 | python3 -c '
import sys, json
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("workspaces", [])
for w in rows:
    if w.get("id") == sys.argv[1]:
        print(w.get("currentPublishedVersionNumber")); break
else:
    print("missing")
' "$2"
}

# pendingProposalCount as the sidebar and the workspace banner read it.
pending_count() {  # pending_count <user> <workspace>
  as "$1" GET /workspaces | tail -n +2 | python3 -c '
import sys, json
d = json.load(sys.stdin)
# The route returns a bare array; a dict would have no .get on a list.
rows = d if isinstance(d, list) else d.get("workspaces", [])
for w in rows:
    if w.get("id") == sys.argv[1]:
        print(int(w.get("pendingProposalCount") or 0)); break
else:
    print(-1)
' "$2"
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

step "3. A publisher can see what is in a proposal before approving it"
# The review queue shows "N files · +A −R" for the selected proposal. It gets
# that from this endpoint, called against someone else's private copy, so the
# whole feature rests on this authorisation path.
check "the count the sidebar and banner read" 2 "$(pending_count "$OWNER" "$WS")"
r="$(as "$OWNER" GET "/workspaces/$CA/review-changes")"
check "publisher reads alice's diff" 200 "$(status "$r")"
check "  and it lists the changed files" 1 \
  "$(body "$r" | python3 -c 'import sys,json;print(1 if json.load(sys.stdin).get("files") else 0)' 2>/dev/null || echo 0)"
check "  and reports staleness" 1 \
  "$(body "$r" | python3 -c 'import sys,json;print(1 if "isStale" in json.load(sys.stdin) else 0)' 2>/dev/null || echo 0)"
# NEGATIVE CONTROL. A gate that lets everyone through looks exactly like one
# that works (LEARNINGS.md §14). Bob is a contributor on the same Shared
# workspace but does not own Alice's copy, so he must be refused.
check "another contributor is refused" 403 \
  "$(status "$(as "$BOB" GET "/workspaces/$CA/review-changes")")"

step "4. Apply both in turn — the second used to fail as PROPOSAL_STALE"
check "apply alice" 200 "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects/$OA/apply" '{}')")"
check "apply bob (auto-rebased)" 200 \
  "$(status "$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects/$OB/apply" '{}')")"

step "5. Neither contributor's work was lost"
check "both files present" "bob.md,doc.md" "$(file_names "$OWNER" "$WS")"
DF="$(file_id "$OWNER" "$WS" doc.md)"
as "$OWNER" GET "/workspaces/$WS/files/$DF/content" >/dev/null
check "alice's edit survived bob's apply" 1 \
  "$(as "$OWNER" GET "/workspaces/$WS/files/$DF/content" | tail -n +2 | grep -c 'ALICE EDIT' || true)"

check "the review count clears once both are applied" 0 "$(pending_count "$OWNER" "$WS")"

step "6. NEGATIVE CONTROL — overlapping edits still stop for a person"
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

step "7. Approving cuts the next locked version by itself"
# The publisher used to have to lock again by hand, and until they did the
# workspace reported changes against the version it had just absorbed.
LK="$(jqr "$(as "$OWNER" POST /workspaces "{\"name\":\"Rebase autolock $STAMP\"}")" "id")"
curl -sS -o /dev/null -X POST "$API/workspaces/$LK/files" -H "x-user-id: $OWNER" \
  -F "file=@/tmp/rb-seed.md;type=text/markdown" -F "path=doc.md"
as "$OWNER" POST "/workspaces/$LK/share" "$SHARE_BODY" >/dev/null
as "$OWNER" POST "/workspaces/$LK/publish" '{}' >/dev/null
check "locked at v1" 1 "$(locked_version "$OWNER" "$LK")"
CA3="$(jqr "$(as "$ALICE" POST "/workspaces/$LK/private-copy" '{}')" "id")"
AF3="$(file_id "$ALICE" "$CA3" doc.md)"
as "$ALICE" PUT "/workspaces/$CA3/files/$AF3/content" '{"content":"# shared doc\nAPPROVED EDIT\n"}' >/dev/null
OA3="$(submit "$ALICE" "$LK" "Alice for autolock")"
as "$OWNER" POST "/workspaces/$LK/collaboration/objects/$OA3/apply" '{}' >/dev/null
check "approving advanced it to v2" 2 "$(locked_version "$OWNER" "$LK")"
check "  and nothing is left pending" 0 "$(pending_count "$OWNER" "$LK")"

step "8. NEGATIVE CONTROL — a Working version is not given a lock"
# Minting one here would switch the workspace into a mode nobody chose.
WV="$(jqr "$(as "$OWNER" POST /workspaces "{\"name\":\"Rebase working $STAMP\"}")" "id")"
curl -sS -o /dev/null -X POST "$API/workspaces/$WV/files" -H "x-user-id: $OWNER" \
  -F "file=@/tmp/rb-seed.md;type=text/markdown" -F "path=doc.md"
as "$OWNER" POST "/workspaces/$WV/share" "$SHARE_BODY" >/dev/null
check "starts with no locked version" "None" "$(locked_version "$OWNER" "$WV")"
CA4="$(jqr "$(as "$ALICE" POST "/workspaces/$WV/private-copy" '{}')" "id")"
AF4="$(file_id "$ALICE" "$CA4" doc.md)"
as "$ALICE" PUT "/workspaces/$CA4/files/$AF4/content" '{"content":"# shared doc\nWORKING EDIT\n"}' >/dev/null
OA4="$(submit "$ALICE" "$WV" "Alice on working")"
as "$OWNER" POST "/workspaces/$WV/collaboration/objects/$OA4/apply" '{}' >/dev/null
check "still has no locked version" "None" "$(locked_version "$OWNER" "$WV")"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspaces left for inspection: $WS  $CTRL"
[ "$fail" -eq 0 ]
