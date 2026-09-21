#!/usr/bin/env bash
#
# Live verification for sharing a workspace with several teams.
#
# The fake databases in the unit suite never execute SQL, and this change is
# almost entirely correlated SQL — a `json_agg` under `SELECT DISTINCT` throws at
# runtime and passes every fake. LEARNINGS.md §11 records the same lesson.
#
# Requires AUTH_MODE=headers and a backend built from current source
# (LEARNINGS.md §8: rebuild, or you are testing the old image).
#
# Usage:  ./scripts/verify_multi_team_sharing.sh [API_BASE]

set -uo pipefail

API="${1:-http://localhost:3000/api}"
OWNER="multiteam-owner@local.com"
STAMP="$(date +%s)"
PSQL=(docker exec helpudoc-postgres psql -U helpudoc -d helpudoc -tAc)

pass=0; fail=0

as() {
  local user="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -o /tmp/mt.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -o /tmp/mt.body -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-user-id: $user" -H "x-user-name: $user" -H "x-user-email: $user"
  fi
  echo
  cat /tmp/mt.body
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

# Rows for this workspace in a user's sidebar. `count`, never `any` — a fan-out
# bug shows the workspace twice, and `any` cannot see the difference.
rows_for() {
  as "$1" GET /workspaces | tail -n +2 | python3 -c '
import sys, json
try: ws = json.load(sys.stdin)
except Exception: ws = []
print(len([w for w in ws if w.get("id") == sys.argv[1]]))
' "$2"
}
field_for() {
  as "$1" GET /workspaces | tail -n +2 | python3 -c '
import sys, json
try: ws = json.load(sys.stdin)
except Exception: ws = []
for w in ws:
    if w.get("id") == sys.argv[1]:
        print(w.get(sys.argv[2])); break
' "$2" "$3"
}

step "0. Cast and teams"
LEGAL="$("${PSQL[@]}" "SELECT id FROM groups WHERE name='Legal' LIMIT 1;" | tr -d '[:space:]')"
ENG="$("${PSQL[@]}" "SELECT id FROM groups WHERE name='Engineering' LIMIT 1;" | tr -d '[:space:]')"
[ -z "$LEGAL" ] || [ -z "$ENG" ] && { echo "  Legal/Engineering teams not found"; exit 1; }
BOTH="dave@legal.test"     # Legal + Engineering
ENG_ONLY="erin@eng.test"   # Engineering only
LEGAL_ONLY="alice@sales.test"  # Legal, not Engineering
NEITHER="probe@local.com"
echo "  legal=$LEGAL eng=$ENG"

# The owner must belong to a team to share with it — the same rule the UI's
# team picker follows.
for TEAM in "$LEGAL" "$ENG"; do
  "${PSQL[@]}" "INSERT INTO group_members (\"groupId\",\"userId\") SELECT '$TEAM', id FROM users WHERE \"externalId\"='$OWNER' ON CONFLICT DO NOTHING;" >/dev/null
done

step "1. Share one workspace with TWO teams"
r="$(as "$OWNER" POST /workspaces "{\"name\":\"Multi team $STAMP\"}")"
WS="$(jqr "$r" "id")"
echo "  workspace: $WS"
r="$(as "$OWNER" POST "/workspaces/$WS/share" \
  "{\"teamIds\":[\"$LEGAL\",\"$ENG\"],\"role\":\"contributor\",\"editingPolicy\":\"direct\"}")"
check "sharing with two teams at once" 201 "$(status "$r")"
# Legal viewer, Engineering contributor — different roles, so 'strongest wins'
# is observable rather than trivially true.
r="$(as "$OWNER" POST "/workspaces/$WS/collaborators/teams" "{\"teamId\":\"$LEGAL\",\"role\":\"viewer\"}")"
check "re-granting Legal as viewer" 204 "$(status "$r")"
"${PSQL[@]}" "SELECT '  grant: '||g.name||' = '||tg.role FROM workspace_team_grants tg JOIN groups g ON g.id=tg.\"teamId\" WHERE tg.\"workspaceId\"='$WS';"

step "2. Each team reaches the workspace with its own role"
check "Engineering-only user gets in" 200 "$(status "$(as "$ENG_ONLY" GET "/workspaces/$WS/files")")"
check "  as contributor" "contributor" "$(field_for "$ENG_ONLY" "$WS" role)"
check "Legal-only user gets in" 200 "$(status "$(as "$LEGAL_ONLY" GET "/workspaces/$WS/files")")"
check "  as viewer" "viewer" "$(field_for "$LEGAL_ONLY" "$WS" role)"

step "3. Strongest wins, and the row appears once"
check "member of both teams is a contributor" "contributor" "$(field_for "$BOTH" "$WS" role)"
check "and the workspace is listed exactly once (fan-out control)" 1 "$(rows_for "$BOTH" "$WS")"

step "4. NEGATIVE CONTROL — a guard that admits everyone looks like one that works"
check "user in neither team is refused" 403 "$(status "$(as "$NEITHER" GET "/workspaces/$WS")")"
check "  and does not see it in their sidebar" 0 "$(rows_for "$NEITHER" "$WS")"
check "the Legal-only user was NOT promoted to contributor" "viewer" "$(field_for "$LEGAL_ONLY" "$WS" role)"

step "5. Both teams are reported"
r="$(as "$OWNER" GET "/workspaces/$WS/collaborators")"
check "manage-access lists two teams" 2 "$(body "$r" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("teams",[])))')"

step "6. Revoking one team leaves the other intact"
r="$(as "$OWNER" DELETE "/workspaces/$WS/collaborators/teams/$LEGAL")"
check "Legal access revoked" 204 "$(status "$r")"
check "Legal-only user now refused" 403 "$(status "$(as "$LEGAL_ONLY" GET "/workspaces/$WS")")"
check "Engineering-only user still in" 200 "$(status "$(as "$ENG_ONLY" GET "/workspaces/$WS/files")")"
check "member of both still contributor via Engineering" "contributor" "$(field_for "$BOTH" "$WS" role)"

step "7. canLeave answers per person, and the endpoint agrees"
# No direct grant at all: nothing to leave, so the refusal is 404 and not the
# team-managed 409. Clause order is preserved from before the change.
check "a team-only member cannot leave" "False" "$(field_for "$ENG_ONLY" "$WS" canLeave)"
check "  and the endpoint says there is nothing to leave" 404 \
  "$(status "$(as "$ENG_ONLY" POST "/workspaces/$WS/leave" '{}')")"

# Now give them a direct grant as well. They still cannot leave, but for the
# other reason — the team still governs the access.
CONTRIB_ID="$("${PSQL[@]}" "SELECT id FROM users WHERE \"externalId\"='$ENG_ONLY';" | tr -d '[:space:]')"
r="$(as "$OWNER" POST "/workspaces/$WS/collaborators" "{\"userId\":\"$CONTRIB_ID\",\"role\":\"contributor\"}")"
check "add the same person as a named collaborator" 204 "$(status "$r")"
check "still cannot leave, now because the team governs it" "False" "$(field_for "$ENG_ONLY" "$WS" canLeave)"
check "  and the endpoint refuses with a conflict" 409 \
  "$(status "$(as "$ENG_ONLY" POST "/workspaces/$WS/leave" '{}')")"

# Remove the team route and the same person can leave — the control proving the
# refusal is about reach, not a blanket denial.
r="$(as "$OWNER" DELETE "/workspaces/$WS/collaborators/teams/$ENG")"
check "revoke the remaining team" 204 "$(status "$r")"
check "now they can leave" "True" "$(field_for "$ENG_ONLY" "$WS" canLeave)"
check "  and the endpoint allows it" 200 \
  "$(status "$(as "$ENG_ONLY" POST "/workspaces/$WS/leave" '{}')")"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
echo "Workspace left in place for inspection: $WS"
[ "$fail" -eq 0 ]
