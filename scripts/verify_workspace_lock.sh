#!/usr/bin/env bash
#
# Live verification for "locking a Shared workspace makes it read-only".
#
# Unit tests here run against fakes, and LEARNINGS.md §11 is explicit that fakes
# miss this class of bug — the last time status propagation "passed every test"
# it did nothing in production. This drives the real API instead.
#
# Requires AUTH_MODE=headers (env/local/dev.env sets it) and a backend built
# from the current source — see LEARNINGS.md §8: rebuild, or you are testing the
# old image.
#
# Usage:  ./scripts/verify_workspace_lock.sh [API_BASE]
# Default API_BASE is http://localhost:3000/api

set -uo pipefail

API="${1:-http://localhost:3000/api}"
OWNER="lockcheck-owner@local.com"
CONTRIB="lockcheck-contrib@local.com"
STAMP="$(date +%s)"

pass=0; fail=0

# ── helpers ──────────────────────────────────────────────────────────────────

# as <user> <METHOD> <path> [json-body]  -> prints "<http_status>\n<body>"
as() {
  local user="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/lockcheck.body -w '%{http_code}' \
      -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -o /tmp/lockcheck.body -w '%{http_code}' \
      -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user"
  fi
  echo
  cat /tmp/lockcheck.body
}

status() { echo "$1" | head -1; }
body()   { echo "$1" | tail -n +2; }
# jqr <response> <dotted.path>  — e.g. "id", "details.code", "0.id"
# Walks the parsed JSON rather than eval-ing a built-up expression, which is
# what quietly turned every lookup into an empty string on the first run.
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

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1))
  else
    printf '  \033[31mFAIL\033[0m  %s  (expected %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail+1))
  fi
}

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 0. preflight ─────────────────────────────────────────────────────────────

step "0. Preflight"
health="$(as "$OWNER" GET /workspaces)"
if [ "$(status "$health")" != "200" ]; then
  echo "  Backend not reachable at $API (status $(status "$health")). Is the stack up?"
  exit 1
fi
echo "  Backend reachable, header auth accepted."

# ── 1. set up an owner + contributor on one Shared workspace ─────────────────

step "1. Create a Shared workspace with a contributor"
r="$(as "$OWNER" POST /workspaces "{\"name\":\"Lock check $STAMP\"}")"
WS="$(jqr "$r" "id")"
echo "  workspace: $WS"

# Register the contributor by making any authenticated call, then look them up.
as "$CONTRIB" GET /workspaces >/dev/null
r="$(as "$OWNER" GET "/workspaces/user-directory?q=lockcheck-contrib")"
CONTRIB_ID="$(jqr "$r" "users.0.id")"
if [ -z "$CONTRIB_ID" ]; then
  echo "  Could not resolve the contributor in the user directory; aborting."
  exit 1
fi
echo "  contributor id: $CONTRIB_ID"

printf '# Draft report\nOriginal line.\n' > /tmp/lockcheck-report.md
upload_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/workspaces/$WS/files" \
  -H "x-user-id: $OWNER" -H "x-user-name: $OWNER" -H "x-user-email: $OWNER" \
  -F "file=@/tmp/lockcheck-report.md;type=text/markdown" \
  -F "path=report.md")"
check "seed file uploads" 201 "$upload_status"
r="$(as "$OWNER" GET "/workspaces/$WS/files")"
FILE_ID="$(jqr "$r" "0.id")"
echo "  file: $FILE_ID"

r="$(as "$OWNER" POST "/workspaces/$WS/share" \
  "{\"userIds\":[\"$CONTRIB_ID\"],\"role\":\"contributor\",\"editingPolicy\":\"direct\"}")"
check "sharing the workspace succeeds" 201 "$(status "$r")"

# ── 2. unlocked Shared stays freely editable ─────────────────────────────────

step "2. Before locking: a Freeflow contributor can edit (unchanged behaviour)"
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$FILE_ID/content" \
  '{"content":"# Draft report\nEdited by the contributor."}')"
check "contributor edits an unlocked Shared workspace" 200 "$(status "$r")"

# ── 3. lock it ───────────────────────────────────────────────────────────────

step "3. Lock the workspace"
r="$(as "$OWNER" POST "/workspaces/$WS/publish" '{"note":"v1"}')"
check "owner locks current changes" 201 "$(status "$r")"

# ── 4. the core rule ─────────────────────────────────────────────────────────

step "4. Locked: nobody edits directly"
r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$FILE_ID/content" '{"content":"sneaky edit"}')"
check "contributor is refused" 409 "$(status "$r")"
check "  with the locked code" "WORKSPACE_CONTENT_LOCKED" "$(jqr "$r" "details.code")"

r="$(as "$OWNER" PUT "/workspaces/$WS/files/$FILE_ID/content" '{"content":"owner edit"}')"
check "OWNER is refused too (the decisive case)" 409 "$(status "$r")"
check "  with the locked code" "WORKSPACE_CONTENT_LOCKED" "$(jqr "$r" "details.code")"

r="$(as "$OWNER" POST "/workspaces/$WS/files/folders" '{"path":"new-folder"}')"
check "creating a folder is refused" 409 "$(status "$r")"

r="$(as "$OWNER" POST "/workspaces/$WS/files/$FILE_ID/status" '{"toStatus":"in_review"}')"
check "changing file review status is refused" 409 "$(status "$r")"

# ── 5. reads and metadata must NOT regress ───────────────────────────────────

step "5. Locked: reads and metadata still work"
r="$(as "$CONTRIB" GET "/workspaces/$WS/files")"
check "contributor can still list files" 200 "$(status "$r")"
r="$(as "$CONTRIB" GET "/workspaces/$WS/schedules")"
check "contributor can still list schedules" 200 "$(status "$r")"
r="$(as "$CONTRIB" GET "/workspaces/$WS/knowledge")"
check "contributor can still list knowledge sources" 200 "$(status "$r")"
r="$(as "$OWNER" PATCH "/workspaces/$WS" '{"name":"Lock check renamed"}')"
check "owner can still rename (name is not in the locked manifest)" 200 "$(status "$r")"

# ── 6. the sanctioned route in ───────────────────────────────────────────────

step "6. Locked: the private-copy route works end to end"
r="$(as "$CONTRIB" POST "/workspaces/$WS/private-copy" '{}')"
check "contributor can take a private copy" 201 "$(status "$r")"
COPY="$(jqr "$r" "id")"
echo "  private copy: $COPY"

r="$(as "$CONTRIB" GET "/workspaces/$COPY/files")"
COPY_FILE="$(jqr "$r" "0.id")"
r="$(as "$CONTRIB" PUT "/workspaces/$COPY/files/$COPY_FILE/content" \
  '{"content":"# Draft report\nProposed change from the private copy."}')"
check "contributor edits their private copy" 200 "$(status "$r")"

r="$(as "$CONTRIB" GET "/workspaces/$COPY/review-changes")"
check "review-changes is readable" 200 "$(status "$r")"
check "  and reports a real diff (this is what the greyed button needed)" \
  "True" "$(jqr "$r" "hasChanges")"

# ── 7. publisher applies, then re-locks ──────────────────────────────────────

step "7. Owner applies the proposal, and the locked workspace takes the change"
r="$(as "$CONTRIB" POST "/workspaces/$WS/collaboration/objects" \
  '{"type":"sticky_note","visibility":"workspace_audience","title":"Proposed","body":"from the copy"}')"
OBJ="$(jqr "$r" "id")"
r="$(as "$CONTRIB" POST "/workspaces/$WS/collaboration/objects/$OBJ/proposal" '{}')"
check "contributor submits it for review" 200 "$(status "$r")"

r="$(as "$OWNER" POST "/workspaces/$WS/collaboration/objects/$OBJ/apply" '{}')"
check "owner applies the proposal while still locked" 200 "$(status "$r")"

# The whole point: an approved proposal is the one way content reaches a locked
# workspace. Assert the bytes actually moved, not just that the call returned.
r="$(as "$OWNER" GET "/workspaces/$WS/files/$FILE_ID/content")"
applied="$(body "$r" | grep -c 'Proposed change from the private copy' || true)"
check "the Shared file now holds the proposed text" 1 "$applied"

# Approving now cuts the next version itself, so the publisher no longer has
# to lock again by hand. This used to expect 201 from a manual publish; that
# call is now refused because the auto-lock already consumed the changes.
check "approving cut v2 with no second step" 2 \
  "$(as "$OWNER" GET /workspaces | tail -n +2 | python3 -c '
import sys, json
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("workspaces", [])
for w in rows:
    if w.get("id") == sys.argv[1]:
        print(w.get("currentPublishedVersionNumber")); break
else:
    print("missing")
' "$WS")"
r="$(as "$OWNER" POST "/workspaces/$WS/publish" '{"note":"v2"}')"
check "  and a manual re-lock has nothing left to do" 409 "$(status "$r")"

r="$(as "$OWNER" PUT "/workspaces/$WS/files/$FILE_ID/content" '{"content":"still locked"}')"
check "still read-only after re-locking" 409 "$(status "$r")"

# ── 8. withdrawing the lock reopens editing ──────────────────────────────────

step "8. Withdraw the lock: editing reopens"
r="$(as "$OWNER" POST "/workspaces/$WS/publication/withdraw" '{}')"
check "owner can withdraw while locked (no deadlock)" 200 "$(status "$r")"

r="$(as "$CONTRIB" PUT "/workspaces/$WS/files/$FILE_ID/content" \
  '{"content":"# Draft report\nEditable again."}')"
check "contributor can edit again after withdrawal" 200 "$(status "$r")"

r="$(as "$OWNER" PUT "/workspaces/$WS/files/$FILE_ID/content" '{"content":"owner edit, unlocked"}')"
check "owner can edit again after withdrawal" 200 "$(status "$r")"

# ── summary ──────────────────────────────────────────────────────────────────

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspace left in place for inspection: $WS"
[ "$fail" -eq 0 ]
