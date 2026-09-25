#!/usr/bin/env bash
#
# Reset knowledge bases and the skill catalog for a client handover.
#
# Leaves the instance with no knowledge bases and only the skills this repo
# ships. Workspaces, files, conversations, users and teams are NOT touched.
#
# Why this is safe to point at those two families and nothing else: no table
# outside them holds a foreign key into them. The script proves that again at
# run time (see `assert_cascade_contained`) rather than trusting this comment,
# because a new table could add one.
#
# The reset has two phases, because the grants cannot be replayed until the
# backend has restarted and re-registered the skills with new ids:
#
#   1. reset    -- save grants, truncate, wipe the skills PVC
#   2. restore  -- replay the saved grants against the re-registered skills
#
# Between them you restart the app and wait for it to come up. The script tells
# you when.
#
# Usage:
#   scripts/reset-for-handover.sh reset             # dry run, changes nothing
#   scripts/reset-for-handover.sh reset --confirm
#   scripts/reset-for-handover.sh restore --confirm
#   scripts/reset-for-handover.sh verify
#
#   --target gke|local   default gke
#   --namespace NAME     default helpudoc
#
# Never run this while a deploy is in flight. The truncate assumes no writer.

set -euo pipefail

PHASE="${1:-}"
shift || true

TARGET="gke"
NAMESPACE="helpudoc"
CONFIRM="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --confirm) CONFIRM="yes"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$PHASE" in
  reset|restore|verify) ;;
  *) echo "Usage: $0 reset|restore|verify [--target gke|local] [--namespace NAME] [--confirm]" >&2; exit 2 ;;
esac

case "$TARGET" in
  gke|local) ;;
  *) echo "--target must be gke or local" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${REPO_ROOT}/backups/handover-reset-${STAMP}"

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Target plumbing
# ---------------------------------------------------------------------------

resolve_targets() {
  if [ "$TARGET" = "gke" ]; then
    command -v kubectl >/dev/null || die "kubectl not found"
    KUBE_CONTEXT="$(kubectl config current-context)"
    PG_POD="$(kubectl -n "$NAMESPACE" get pods -l app=helpudoc-postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [ -n "$PG_POD" ] || die "No postgres pod in namespace ${NAMESPACE}"
    APP_POD="$(kubectl -n "$NAMESPACE" get pods -l app=helpudoc-app -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    TARGET_LABEL="${KUBE_CONTEXT} / ${NAMESPACE}"
  else
    command -v docker >/dev/null || die "docker not found"
    PG_POD="helpudoc-postgres"
    APP_POD="infra-backend-1"
    docker inspect "$PG_POD" >/dev/null 2>&1 || die "Container ${PG_POD} is not present"
    TARGET_LABEL="local docker (${PG_POD})"
  fi
}

# Runs SQL read from stdin. ON_ERROR_STOP so a failed statement aborts the run
# instead of leaving the database half-truncated.
run_psql() {
  if [ "$TARGET" = "gke" ]; then
    kubectl -n "$NAMESPACE" exec -i "$PG_POD" -- \
      sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
  else
    docker exec -i "$PG_POD" \
      sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
  fi
}

# One scalar, no headers. Uses -t -A rather than \pset, because \pset writes its
# own status line to stdout and that lands in whatever the caller is parsing.
psql_value() {
  if [ "$TARGET" = "gke" ]; then
    kubectl -n "$NAMESPACE" exec -i "$PG_POD" -- \
      sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -v ON_ERROR_STOP=1'
  else
    docker exec -i "$PG_POD" \
      sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -v ON_ERROR_STOP=1'
  fi
}

# Tab-separated rows, no headers.
psql_tsv() {
  if [ "$TARGET" = "gke" ]; then
    kubectl -n "$NAMESPACE" exec -i "$PG_POD" -- \
      sh -lc "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -t -A -F '$(printf '\t')' -v ON_ERROR_STOP=1"
  else
    docker exec -i "$PG_POD" \
      sh -lc "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -t -A -F '$(printf '\t')' -v ON_ERROR_STOP=1"
  fi
}

# ---------------------------------------------------------------------------
# The two families
#
# Written out rather than matched by pattern, so adding a table is a deliberate
# edit here. `assert_table_list_current` fails the run when the database holds a
# matching table this list does not, which is the drift that would otherwise
# leave rows behind silently.
# ---------------------------------------------------------------------------

KNOWLEDGE_TABLES="
knowledge_assertions knowledge_base_group_grants knowledge_base_versions
knowledge_bases knowledge_candidate_concepts knowledge_communities
knowledge_concepts knowledge_embeddings knowledge_evidence_spans
knowledge_ingestion_jobs knowledge_ingestion_tasks knowledge_processing_windows
knowledge_relationships knowledge_snapshots knowledge_source_blocks
knowledge_source_group_grants knowledge_sources knowledge_structure_nodes
knowledge_upload_sessions knowledge_usage_events
"

SKILL_TABLES="
content_blobs private_skill_drafts private_workspace_skill_draft_exclusions
private_workspace_skill_draft_pins published_version_skill_pins
skill_candidate_policy_results skill_draft_revision_files skill_draft_revisions
skill_evolution_suggestions skill_grants skill_review_candidate_files
skill_review_candidates skill_review_decisions skill_review_requests
skill_version_files skill_versions skills team_skill_disables
team_skill_grants user_skill_grants workspace_skill_pins
"

all_tables() { echo "$KNOWLEDGE_TABLES $SKILL_TABLES" | tr -s ' \n' '\n' | sed '/^$/d' | sort; }
sql_table_list() { all_tables | paste -sd, - ; }
sql_quoted_list() { all_tables | sed "s/^/'/; s/$/'/" | paste -sd, - ; }

# ---------------------------------------------------------------------------
# Safety checks
# ---------------------------------------------------------------------------

# Fails when the database holds a knowledge/skill table this script does not
# list. Missing one leaves orphan rows that the backfill will not clean up.
assert_table_list_current() {
  local missing
  missing="$(psql_value <<SQL
SELECT string_agg(tablename, ' ' ORDER BY tablename)
FROM pg_tables
WHERE schemaname = 'public'
  AND (tablename LIKE 'knowledge%' OR tablename LIKE '%skill%' OR tablename = 'content_blobs')
  AND tablename NOT IN ($(sql_quoted_list));
SQL
)"
  missing="$(echo "$missing" | tr -d '[:space:]')"
  [ -z "$missing" ] || die "These tables match the reset families but are not in this script's list: ${missing}. Add them deliberately, then re-run."
}

# Fails when any table outside the two families holds a foreign key into them.
# If one did, TRUNCATE ... CASCADE would reach workspaces, files or users.
assert_cascade_contained() {
  local escapees
  escapees="$(psql_value <<SQL
SELECT string_agg(DISTINCT tc.table_name, ' ')
FROM information_schema.table_constraints tc
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name IN ($(sql_quoted_list))
  AND tc.table_name NOT IN ($(sql_quoted_list));
SQL
)"
  escapees="$(echo "$escapees" | tr -d '[:space:]')"
  [ -z "$escapees" ] || die "CASCADE would reach outside the reset families, into: ${escapees}. Stopping."
}

# The truncate assumes nothing is writing. A running backend re-registers skills
# mid-reset and leaves a half-built catalog.
assert_app_stopped() {
  if [ "$TARGET" = "gke" ]; then
    local replicas
    replicas="$(kubectl -n "$NAMESPACE" get deploy helpudoc-app -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")"
    [ "$replicas" = "0" ] || die "helpudoc-app has ${replicas:-unknown} replicas. Run: kubectl -n ${NAMESPACE} scale deploy/helpudoc-app --replicas=0"
  else
    if docker inspect -f '{{.State.Running}}' "$APP_POD" 2>/dev/null | grep -q true; then
      die "${APP_POD} is running. Run: docker stop ${APP_POD}"
    fi
  fi
}

# Untracked skill trees are copied into the image by agent/Dockerfile.gke, and
# .gcloudignore excludes .git/, so `gcloud builds submit .` uploads the working
# tree rather than the commit. Anything left here ships to the client.
warn_untracked_skills() {
  local untracked
  untracked="$(cd "$REPO_ROOT" && git ls-files --others --exclude-standard -- skills/ 2>/dev/null | cut -d/ -f1-2 | sort -u || true)"
  if [ -n "$untracked" ]; then
    say "WARNING: untracked skill trees in the working tree"
    echo "$untracked" | sed 's/^/   /'
    note "These are baked into the handover image. Remove them before building."
  fi
}

require_typed_confirmation() {
  say "Target: ${TARGET_LABEL}"
  note "This permanently deletes all knowledge bases and the whole skill catalog."
  note "Workspaces, files, conversations, users and teams are not touched."
  printf '\n   Type the target to continue: '
  local typed
  read -r typed
  [ "$typed" = "$TARGET_LABEL" ] || die "Confirmation did not match. Nothing changed."
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

show_counts() {
  run_psql <<'SQL'
SELECT
  (SELECT count(*) FROM knowledge_bases)    AS knowledge_bases,
  (SELECT count(*) FROM knowledge_sources)  AS knowledge_sources,
  (SELECT count(*) FROM skills)             AS skills,
  (SELECT count(*) FROM skills WHERE status = 'active') AS active_skills,
  (SELECT count(*) FROM team_skill_grants)  AS team_grants,
  (SELECT count(*) FROM user_skill_grants)  AS user_grants,
  (SELECT count(*) FROM private_skill_drafts) AS skill_drafts,
  (SELECT count(*) FROM workspaces)         AS workspaces_kept,
  (SELECT count(*) FROM users)              AS users_kept,
  (SELECT count(*) FROM groups)             AS teams_kept;
SQL
}

backup_database() {
  mkdir -p "$OUT_DIR"
  say "Backing up the database to ${OUT_DIR}/postgres.sql.gz"
  if [ "$TARGET" = "gke" ]; then
    kubectl -n "$NAMESPACE" exec "$PG_POD" -- \
      sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "${OUT_DIR}/postgres.sql.gz"
  else
    docker exec "$PG_POD" \
      sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "${OUT_DIR}/postgres.sql.gz"
  fi
  # A truncated dump is worse than none, because it looks like a backup.
  [ -s "${OUT_DIR}/postgres.sql.gz" ] || die "The dump is empty. Stopping before any deletion."
  note "$(du -h "${OUT_DIR}/postgres.sql.gz" | cut -f1) written"
}

# Grants are the reason this is two phases. `effectiveSkillAccess` reads only
# user_skill_grants and team_skill_grants; owning a skill's team gives catalog
# visibility, not the right to run it. Re-registration mints new skill ids, so
# the grants must be carried across by skillKey and team name, which survive.
save_grants() {
  say "Saving skill grants"
  run_psql <<'SQL'
DROP TABLE IF EXISTS handover_grant_backup;
CREATE TABLE handover_grant_backup AS
SELECT g.name AS team_name, s."skillKey" AS skill_key, tg.effect AS effect, 'team' AS kind
FROM team_skill_grants tg
JOIN skills s  ON s.id = tg."skillId"
JOIN groups g  ON g.id = tg."teamId"
UNION ALL
SELECT u."externalId", s."skillKey", ug.effect, 'user'
FROM user_skill_grants ug
JOIN skills s ON s.id = ug."skillId"
JOIN users u  ON u.id = ug."userId";
SQL
  # Also written to a file, because the table lives in the database this script
  # is about to rewrite.
  psql_tsv <<'SQL' > "${OUT_DIR}/grants.tsv"
SELECT kind, team_name, skill_key, effect FROM handover_grant_backup ORDER BY 1,2,3;
SQL
  note "$(grep -c . "${OUT_DIR}/grants.tsv" || true) grants saved to ${OUT_DIR}/grants.tsv"
}

truncate_families() {
  say "Truncating knowledge bases and the skill catalog"
  run_psql <<SQL
BEGIN;
TRUNCATE $(sql_table_list) CASCADE;
COMMIT;
SQL
  note "done"
}

# Only on GKE. Locally /app/skills is a bind mount onto the repo's own skills/
# directory, so wiping it would delete the source tree, not a PVC.
wipe_skills_pvc() {
  if [ "$TARGET" = "local" ]; then
    say "Skipping the skills wipe on the local target"
    note "/app/skills is bind-mounted from ${REPO_ROOT}/skills. Wiping it would delete your source."
    note "The local catalog already matches the repo, so there is nothing to wipe."
    return 0
  fi
  [ -n "$APP_POD" ] || die "No helpudoc-app pod found. Scale it to 1, wipe, then back to 0, or wipe from another pod mounting skills-pvc."
  say "Emptying /app/skills on skills-pvc"
  kubectl -n "$NAMESPACE" exec "$APP_POD" -c backend -- sh -lc '
    set -eu
    test -d /app/skills || { echo "no /app/skills"; exit 1; }
    find /app/skills -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    ls -A /app/skills | head
  '
  note "seed-skills will re-copy the image tree on next start, because the guard file is gone"
}

phase_reset() {
  resolve_targets
  say "Current state"
  show_counts
  assert_table_list_current
  assert_cascade_contained
  note "Checked: no table outside these families holds a foreign key into them."
  warn_untracked_skills

  say "Tables to truncate ($(all_tables | wc -l | tr -d ' '))"
  all_tables | paste -sd' ' - | fold -s -w 78 | sed 's/^/   /'

  if [ "$CONFIRM" != "yes" ]; then
    say "Dry run. Nothing changed."
    note "Re-run with --confirm to apply."
    return 0
  fi

  assert_app_stopped
  require_typed_confirmation
  backup_database
  save_grants
  truncate_families
  wipe_skills_pvc

  say "Reset done. Now restart the app and wait for it to be ready."
  if [ "$TARGET" = "gke" ]; then
    note "kubectl -n ${NAMESPACE} scale deploy/helpudoc-app --replicas=1"
    note "kubectl -n ${NAMESPACE} rollout status deploy/helpudoc-app"
  else
    note "docker start ${APP_POD}"
  fi
  note "Then: $0 restore --target ${TARGET} --namespace ${NAMESPACE} --confirm"
  note "Backup and grants: ${OUT_DIR}"
}

# Replays the saved grants once the backend has re-registered the skills.
# Grants whose skill is no longer in the repo simply find no match and are
# dropped, which is the pruning doing itself.
phase_restore() {
  resolve_targets
  local registered
  local has_backup
  has_backup="$(psql_value <<<"SELECT to_regclass('public.handover_grant_backup') IS NOT NULL;" | tr -d '[:space:]')"
  [ "$has_backup" = "t" ] || die "No handover_grant_backup table. Run the reset phase first, or reload the grants from a previous run's grants.tsv."

  registered="$(psql_value <<<'SELECT count(*) FROM skills;' | tr -d '[:space:]')"
  [ "${registered:-0}" -gt 0 ] || die "No skills registered yet. Start the app and wait for it to finish backfilling, then re-run."
  note "${registered} skills registered"

  if [ "$CONFIRM" != "yes" ]; then
    say "Dry run: grants that would be restored"
    run_psql <<'SQL'
SELECT b.kind, b.team_name AS principal, b.skill_key,
       CASE WHEN s.id IS NULL THEN 'skipped (skill not in repo)' ELSE 'restore' END AS action
FROM handover_grant_backup b
LEFT JOIN skills s ON s."skillKey" = b.skill_key
ORDER BY 4, 1, 2, 3;
SQL
    note "Re-run with --confirm to apply."
    return 0
  fi

  say "Restoring grants"
  run_psql <<'SQL'
BEGIN;
INSERT INTO team_skill_grants ("teamId", "skillId", effect, "grantedByUserId")
SELECT g.id, s.id, b.effect, NULL
FROM handover_grant_backup b
JOIN groups g ON g.name = b.team_name
JOIN skills s ON s."skillKey" = b.skill_key
WHERE b.kind = 'team'
ON CONFLICT ("teamId", "skillId") DO NOTHING;

INSERT INTO user_skill_grants ("userId", "skillId", effect, "grantedByUserId")
SELECT u.id, s.id, b.effect, NULL
FROM handover_grant_backup b
JOIN users u  ON u."externalId" = b.team_name
JOIN skills s ON s."skillKey" = b.skill_key
WHERE b.kind = 'user'
ON CONFLICT ("userId", "skillId") DO NOTHING;
COMMIT;
SQL
  run_psql <<'SQL'
SELECT
  (SELECT count(*) FROM team_skill_grants) AS team_grants,
  (SELECT count(*) FROM user_skill_grants) AS user_grants,
  (SELECT count(*) FROM handover_grant_backup) AS saved;
SQL
  note "Drop handover_grant_backup once you are satisfied: DROP TABLE handover_grant_backup;"
}

phase_verify() {
  resolve_targets
  say "State"
  show_counts
  say "Active skills"
  run_psql <<'SQL'
SELECT "skillKey", status FROM skills ORDER BY status, "skillKey";
SQL
  say "Notifications left pointing at deleted skills"
  run_psql <<'SQL'
SELECT "resourceType", count(*) FROM notifications
WHERE "resourceType" IN ('skill', 'skill_review_request')
GROUP BY 1;
SQL
  note "These carry no foreign key, so they survive the reset. Clear them if the"
  note "client should not see them: DELETE FROM notifications WHERE \"resourceType\" IN ('skill','skill_review_request');"
}

case "$PHASE" in
  reset) phase_reset ;;
  restore) phase_restore ;;
  verify) phase_verify ;;
esac
