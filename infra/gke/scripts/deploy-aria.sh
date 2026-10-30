#!/usr/bin/env bash
# Deploy a built release to a client ARIA cluster (asia-southeast1-gke-{dev,prd}-aria-01).
#
# Why this is not infra/cloudbuild.yaml:
# - The ARIA clusters were set up by hand with their own manifests: Gateway API routing
#   (aria-gateway + HTTPRoutes), pinned pip versions, no seed init containers, and (prd)
#   Workload Identity plus a private release registry. Applying infra/gke/k8s/ overwrites
#   all of that, and its BackendConfig annotation on helpudoc-caddy breaks aria-gateway.
#   This script changes image references only and leaves every other field as it is.
# - Binary Authorization on these clusters is ALWAYS_DENY with a digest allowlist. Images
#   must be referenced by digest, and each digest must be allowlisted (or the cluster rule
#   set to dry-run) before a pod can start. `check` verifies this before anything changes.
# - One build serves both clusters. Images are built once in the dev project; prd gets a
#   byte-identical copy in its own registry (`push`), so the digest the client allowlists
#   is the digest that was tested on dev. Nothing environment-specific is baked into the
#   images: sign-in, project IDs and domains come from each cluster's helpudoc-config.
#
# Usage:
#   infra/gke/scripts/deploy-aria.sh <dev|prd> check  <BUILD_ID> [GIT_REF]   # read-only
#   infra/gke/scripts/deploy-aria.sh <dev|prd> push   <BUILD_ID> [GIT_REF]   # prd: copy images
#   infra/gke/scripts/deploy-aria.sh <dev|prd> deploy <BUILD_ID> [GIT_REF]
#
#   BUILD_ID  Cloud Build ID whose images to deploy (from infra/cloudbuild-images.yaml,
#             always built in ccob-my-ai-engine-dev).
#   GIT_REF   Commit the images were built from (default HEAD). skills/, plugins/ and
#             agent/config/runtime.yaml are synced from this commit, never from the
#             working tree, so uncommitted or untracked files are not shipped.
set -euo pipefail

TARGET="${1:-}"
MODE="${2:-}"
BUILD_ID="${3:-}"
GIT_REF="${4:-HEAD}"
usage() { sed -n '18,27p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ "${MODE}" =~ ^(check|push|deploy)$ && -n "${BUILD_ID}" ]] || usage

SRC_REG="gcr.io/ccob-my-ai-engine-dev"
case "${TARGET}" in
  dev)
    PROJECT_ID=ccob-my-ai-engine-dev
    CLUSTER=asia-southeast1-gke-dev-aria-01
    DOMAIN=aria-dev.skp.gov.my
    RUNTIME_REWRITE=''
    # dev pulls straight from the build registry; no copy.
    tgt_repo() { case "$1" in reflection) echo "${SRC_REG}/helpudoc-backend" ;; *) echo "${SRC_REG}/helpudoc-$1" ;; esac; }
    ;;
  prd)
    PROJECT_ID=ccob-my-ai-engine-prd
    CLUSTER=asia-southeast1-gke-prd-aria-01
    DOMAIN=aria.skp.gov.my
    # runtime.yaml in git carries the dev project IDs, because every cluster syncs the
    # same file. prd gets its own IDs here, next to its other settings, so a prd value
    # never lands in git and points the dev clusters at prd data.
    RUNTIME_REWRITE='s/ccob-my-cdlp-dev/ccob-my-cdlp-prd/g; s/ccob-my-ai-engine-dev/ccob-my-ai-engine-prd/g'
    # prd nodes are private and pull only from the prd release registry. The CronJob has
    # its own image name there, so it is allowlisted separately from the backend.
    tgt_repo() {
      local base="asia-southeast1-docker.pkg.dev/ccob-my-ai-engine-prd/aria-releases"
      case "$1" in reflection) echo "${base}/reflection-job" ;; *) echo "${base}/$1" ;; esac
    }
    ;;
  *) usage ;;
esac
LOCATION=asia-southeast1
NS=helpudoc

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-aria.XXXXXX")"
BACKUP_DIR="${REPO_ROOT}/backups/${CLUSTER}-${STAMP}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- images
log "Source commit"
COMMIT="$(git rev-parse --verify "${GIT_REF}^{commit}")" || die "Unknown GIT_REF ${GIT_REF}"
git log -1 --format='%h %s (%ci)' "${COMMIT}"
for p in skills/research/SKILL.md plugins/data-analytics/plugin.yaml agent/config/runtime.yaml; do
  git cat-file -e "${COMMIT}:${p}" || die "${p} missing at ${COMMIT}"
done

# runtime.yaml exactly as this cluster will receive it.
runtime_yaml() {
  if [[ -n "${RUNTIME_REWRITE}" ]]; then git show "${COMMIT}:agent/config/runtime.yaml" | sed "${RUNTIME_REWRITE}"
  else git show "${COMMIT}:agent/config/runtime.yaml"; fi
}

log "Image digests for build ${BUILD_ID}"
src_digest() {
  gcloud container images describe "${SRC_REG}/helpudoc-$1:${BUILD_ID}" \
    --format='value(image_summary.digest)' 2>/dev/null
}
# Plain variables, not associative arrays: macOS ships bash 3.2.
DG_BACKEND="$(src_digest backend)"
DG_FRONTEND="$(src_digest frontend)"
DG_AGENT="$(src_digest agent)"
dg() { case "$1" in backend|reflection) echo "${DG_BACKEND}" ;; frontend) echo "${DG_FRONTEND}" ;; agent) echo "${DG_AGENT}" ;; esac; }
src_repo() { case "$1" in reflection) echo "${SRC_REG}/helpudoc-backend" ;; *) echo "${SRC_REG}/helpudoc-$1" ;; esac; }
ref() { echo "$(tgt_repo "$1")@$(dg "$1")"; }
for n in backend frontend agent; do
  [[ "$(dg "$n")" == sha256:* ]] || die "Could not resolve ${SRC_REG}/helpudoc-${n}:${BUILD_ID}"
done
for n in backend frontend agent reflection; do
  printf '  %-10s %s\n' "$n" "$(ref "$n")"
done

if [[ "${TARGET}" == "prd" ]]; then
  log "prd release registry"
  NEED_PUSH=0
  for n in backend frontend agent reflection; do
    if crane digest "$(ref "$n")" >/dev/null 2>&1; then
      echo "  present  ${n}"
    elif [[ "${MODE}" == "push" ]]; then
      # Byte-for-byte copy: the digest is unchanged, so the dev-tested image is the one
      # prd runs. The tag follows the registry's existing approved-<digest> convention.
      D="$(dg "$n")"; TAG="approved-${D#sha256:}"; TAG="${TAG:0:25}"
      crane copy "$(src_repo "$n")@${D}" "$(tgt_repo "$n"):${TAG}"
      [[ "$(crane digest "$(ref "$n")")" == "${D}" ]] || die "Digest changed while copying ${n}"
      echo "  copied   ${n} -> $(tgt_repo "$n"):${TAG}"
    else
      echo "  MISSING  ${n}"; NEED_PUSH=1
    fi
  done
  if [[ "${MODE}" == "deploy" && "${NEED_PUSH}" == 1 ]]; then
    die "Copy the images first: $0 prd push ${BUILD_ID} ${GIT_REF}"
  fi
  if [[ "${MODE}" == "check" && "${NEED_PUSH}" == 1 ]]; then
    echo "  Run '$0 prd push ${BUILD_ID} ${GIT_REF}' to copy them (the client may want to review them there first)."
  fi
fi
if [[ "${MODE}" == "push" ]]; then
  [[ "${TARGET}" == "dev" ]] && log "dev pulls from the build registry; nothing to copy." || log "Push done. Allowlist the refs above, then run check."
  exit 0
fi

# ---------------------------------------------------------------- preflight (read-only)
# Own kubeconfig, so this never acts on whatever context the shell happens to point at
# (helpudoc-cluster lives in the dev project).
export KUBECONFIG="${WORK}/kubeconfig"
log "Cluster credentials: ${CLUSTER} (${LOCATION}, ${PROJECT_ID})"
gcloud container clusters get-credentials "${CLUSTER}" --location "${LOCATION}" --project "${PROJECT_ID}" >/dev/null
k() { kubectl -n "${NS}" "$@"; }
app_pod() { k get pods -l app=helpudoc-app --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'; }

log "Binary Authorization (${PROJECT_ID})"
gcloud container binauthz policy export --project "${PROJECT_ID}" > "${WORK}/policy.yaml"
RULE_KEY="${LOCATION}.${CLUSTER}"
ENFORCEMENT="$(awk -v key="  ${RULE_KEY}:" '$0==key{f=1;next} f&&/enforcementMode:/{print $2;exit}' "${WORK}/policy.yaml")"
echo "  rule ${RULE_KEY}: ${ENFORCEMENT:-<none>}"
MISSING=()
for n in backend frontend agent reflection; do
  grep -qF "namePattern: $(ref "$n")" "${WORK}/policy.yaml" || MISSING+=("$(ref "$n")")
done
if (( ${#MISSING[@]} > 0 )); then
  echo "  Not on the allowlist:"; printf '    %s\n' "${MISSING[@]}"
  if [[ "${ENFORCEMENT}" == "ENFORCED_BLOCK_AND_AUDIT_LOG" ]]; then
    die "The cluster will reject these images. Get them allowlisted, or the rule set to dry-run, first."
  fi
  echo "  Rule is ${ENFORCEMENT}: pods will be admitted. Allowlist these before enforcement returns."
else
  echo "  All digests are allowlisted."
fi

if [[ "${TARGET}" == "prd" ]]; then
  log "runtime.yaml at ${COMMIT:0:8}, as rewritten for prd, must not name dev projects"
  runtime_yaml | diff <(git show "${COMMIT}:agent/config/runtime.yaml") - | grep '^>' | sed 's/^>/  /' || true
  DEV_REFS="$(runtime_yaml | grep -nE -- '-dev([^[:alnum:]-]|$)' || true)"
  if [[ -n "${DEV_REFS}" ]]; then
    echo "${DEV_REFS}" | sed 's/^/  /'
    [[ "${ALLOW_DEV_REFS:-0}" == 1 ]] || die "runtime.yaml names dev projects. Fix it, or set ALLOW_DEV_REFS=1 to ship it anyway."
    echo "  ALLOW_DEV_REFS=1: shipping anyway."
  else
    echo "  none"
  fi

  # prd's manifests were written by hand from dev's. A literal env value in a pod spec
  # overrides helpudoc-config, so one dev leftover (GOOGLE_CLOUD_PROJECT on the agent)
  # sent every prd model call to the dev project. Image swaps carry such values forward.
  log "Workload specs and helpudoc-config must not name dev projects or hosts"
  DEV_ENV="$(kubectl -n "${NS}" get deploy,cronjob,configmap -o json | python3 -c '
import json, re, sys
dev = re.compile(r"-dev\b|aria-dev[.]|aiengine-dev[.]|aiobs-dev[.]")
for item in json.load(sys.stdin)["items"]:
    name = item["kind"] + "/" + item["metadata"]["name"]
    if item["kind"] == "ConfigMap":
        if item["metadata"]["name"] != "helpudoc-config":
            continue
        for key, value in (item.get("data") or {}).items():
            if dev.search(str(value)):
                print("  %s  %s=%s" % (name, key, value))
        continue
    spec = item["spec"]
    pod = spec.get("jobTemplate", {}).get("spec", spec)["template"]["spec"]
    for c in pod.get("initContainers", []) + pod.get("containers", []):
        for e in c.get("env", []):
            if "value" in e and dev.search(e["value"]):
                print("  %s [%s]  %s=%s" % (name, c["name"], e["name"], e["value"]))
')"
  if [[ -n "${DEV_ENV}" ]]; then
    echo "${DEV_ENV}"
    die "prd workloads carry dev values. Fix them on the cluster (kubectl set env / patch cm) first."
  fi
  echo "  none"

  log "Nightly backup state (aria-ops scales workloads down around 03:00 MYT)"
  PHASE="$(k get cm aria-backup-runtime-state -o jsonpath='{.data.state\.json}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("phase",""))')"
  echo "  phase=${PHASE}"
  [[ "${PHASE}" == "RECOVERED" ]] || die "A backup is in progress or did not recover. Wait for phase=RECOVERED."
  HOUR_MYT="$(TZ=Asia/Kuala_Lumpur date +%H)"
  [[ "${HOUR_MYT}" != "02" && "${HOUR_MYT}" != "03" ]] || die "Inside the 02:00-04:00 MYT backup window. Deploy outside it."
fi

log "Gateway and current workloads"
GW="$(k get gateway aria-gateway -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}')"
echo "  aria-gateway Programmed=${GW}"
[[ "${GW}" == "True" ]] || die "aria-gateway is not Programmed; fix routing before deploying."
k get deploy helpudoc-app helpudoc-frontend \
  -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,IMAGES:.spec.template.spec.containers[*].image'
APP_CONTAINERS="$(k get deploy helpudoc-app -o jsonpath='{.spec.template.spec.containers[*].name}')"
for c in backend knowledge-worker agent; do
  [[ " ${APP_CONTAINERS} " == *" ${c} "* ]] || die "helpudoc-app has no container '${c}' (has: ${APP_CONTAINERS})"
done
[[ -n "$(app_pod)" ]] || die "No running helpudoc-app pod (needed for backup and sync)."

# The agent only reads skills, plugins and runtime.yaml; the backend container owns those
# writes. Writable mounts let a chat change the shared catalog if a tool route regresses
# (an agent write_file added ten skills on aiengine-dev on 2026-10-12). Warn, not fail:
# the fix is a one-off patch on these hand-built clusters.
log "Agent container: shared volumes should be read-only"
WRITABLE="$(k get deploy helpudoc-app -o json | python3 -c '
import json, sys
spec = json.load(sys.stdin)["spec"]["template"]["spec"]
shared = {"/app/skills", "/skills", "/app/plugins", "/plugins", "/agent/config"}
for container in spec["containers"]:
    if container["name"] != "agent":
        continue
    for index, mount in enumerate(container.get("volumeMounts", [])):
        if mount["mountPath"] in shared and not mount.get("readOnly"):
            print(index, mount["mountPath"])
')"
if [[ -n "${WRITABLE}" ]]; then
  echo "  WARNING: writable on the agent container:"; echo "${WRITABLE}" | sed 's/^[0-9]* /    /'
  AGENT_INDEX="$(k get deploy helpudoc-app -o jsonpath='{.spec.template.spec.containers[*].name}' | tr ' ' '\n' | grep -n '^agent$' | cut -d: -f1)"
  OPS="$(echo "${WRITABLE}" | awk -v c=$((AGENT_INDEX-1)) '{printf "%s{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/%d/volumeMounts/%d/readOnly\",\"value\":true}", (NR>1?",":""), c, $1}')"
  echo "  Fix (restarts the app):"
  echo "    kubectl -n ${NS} patch deploy helpudoc-app --type json -p '[${OPS}]'"
else
  echo "  all read-only"
fi

if [[ "${MODE}" == "check" ]]; then
  log "Preflight passed. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------- deploy
read -r -p $'\nDeploy build '"${BUILD_ID}"' ('"${COMMIT:0:8}"') to '"${CLUSTER}"'? Type the cluster name to confirm: ' ANSWER
[[ "${ANSWER}" == "${CLUSTER}" ]] || die "Not confirmed."

log "Backup to ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"
k get deploy helpudoc-app helpudoc-frontend -o yaml > "${BACKUP_DIR}/deployments.yaml"
k get cronjob helpudoc-daily-reflection -o yaml > "${BACKUP_DIR}/cronjob.yaml"
POD="$(app_pod)"
# The skills tar includes .governed-versions/: the only copy of governed skill bytes.
k exec "${POD}" -c backend -- tar -C /app/skills -cf - . > "${BACKUP_DIR}/skills.tar"
k exec "${POD}" -c backend -- tar -C /app/plugins -cf - . > "${BACKUP_DIR}/plugins.tar"
k exec "${POD}" -c backend -- tar -C /agent/config -cf - . > "${BACKUP_DIR}/agent-config.tar"
ls -lh "${BACKUP_DIR}"
# prd runs skill scripts in separate sandbox pods whose image is pinned in
# helpudoc-config. Left alone, scripts keep running on the previous agent image
# while the agent itself runs the new one.
OLD_SANDBOX_IMAGE="$(k get cm helpudoc-config -o jsonpath='{.data.HELPUDOC_SANDBOX_IMAGE}')"
echo "${OLD_SANDBOX_IMAGE}" > "${BACKUP_DIR}/sandbox-image.txt"

set_sandbox_image() {
  k patch cm helpudoc-config --type merge -p "{\"data\":{\"HELPUDOC_SANDBOX_IMAGE\":\"$1\"}}" >/dev/null
}

rollback() {
  log "Rolling back images"
  [[ -n "${OLD_SANDBOX_IMAGE}" ]] && { set_sandbox_image "${OLD_SANDBOX_IMAGE}" || true; }
  k rollout undo deploy/helpudoc-app || true
  k rollout undo deploy/helpudoc-frontend || true
  k apply -f "${BACKUP_DIR}/cronjob.yaml" || true
  echo "PVC contents are in ${BACKUP_DIR}/*.tar if they also need restoring (see the runbook)."
}

if [[ -n "${OLD_SANDBOX_IMAGE}" ]]; then
  log "Sandbox image (read by the agent at start, so set before the rollout)"
  set_sandbox_image "$(ref agent)"
  echo "  ${OLD_SANDBOX_IMAGE}"
  echo "  -> $(ref agent)"
fi

log "Set images"
k set image deploy/helpudoc-app backend="$(ref backend)" knowledge-worker="$(ref backend)" agent="$(ref agent)"
k set image deploy/helpudoc-frontend frontend="$(ref frontend)"
k set image cronjob/helpudoc-daily-reflection reflection-job="$(ref reflection)"

log "Wait for rollout (helpudoc-app uses Recreate: the old pod is already gone)"
if ! k rollout status deploy/helpudoc-app --timeout=15m || ! k rollout status deploy/helpudoc-frontend --timeout=5m; then
  k get events --sort-by=.lastTimestamp | tail -15
  rollback
  die "Rollout failed; images were rolled back."
fi

log "Langfuse database (idempotent)"
KUBECTL_NAMESPACE="${NS}" infra/gke/scripts/bootstrap-langfuse-db.sh --wait-rollout

log "Sync skills/, plugins/ and runtime.yaml from ${COMMIT:0:8}"
mkdir -p "${WORK}/src"
git archive "${COMMIT}" skills plugins agent/config/runtime.yaml | tar -x -C "${WORK}/src"
runtime_yaml > "${WORK}/src/agent/config/runtime.yaml"
POD="$(app_pod)"
k exec "${POD}" -c backend -- sh -lc "set -eu; mkdir -p /app/skills; find /app/skills -mindepth 1 -maxdepth 1 ! -name '.governed-versions' -exec rm -rf {} +"
tar -C "${WORK}/src/skills" -cf - . | k exec -i "${POD}" -c backend -- sh -lc "tar -xf - -C /app/skills"
k exec "${POD}" -c backend -- sh -lc "test -f /app/skills/research/SKILL.md"
k exec "${POD}" -c backend -- sh -lc "set -eu; mkdir -p /app/plugins; find /app/plugins -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
tar -C "${WORK}/src/plugins" -cf - . | k exec -i "${POD}" -c backend -- sh -lc "tar -xf - -C /app/plugins"
k exec "${POD}" -c backend -- sh -lc "test -f /app/plugins/data-analytics/plugin.yaml"
k exec "${POD}" -c backend -- sh -lc "set -eu; mkdir -p /agent/config; rm -f /agent/config/runtime.yaml"
tar -C "${WORK}/src/agent/config" -cf - runtime.yaml | k exec -i "${POD}" -c backend -- sh -lc "tar -xf - -C /agent/config"
k exec "${POD}" -c backend -- sh -lc "test -f /agent/config/runtime.yaml"

log "Restart app so the agent reloads runtime.yaml"
k rollout restart deploy/helpudoc-app
k rollout status deploy/helpudoc-app --timeout=10m

log "Drift guard (same checks as cloudbuild.yaml step 8)"
POD="$(app_pod)"
ax() { k exec "${POD}" -c agent -- "$@"; }
ax sh -lc "grep -q 'request_plan_approval' /agent/config/runtime.yaml"
ax sh -lc "grep -q 'name: aws-pricing' /agent/config/runtime.yaml"
ax sh -lc "grep -q 'request_plan_approval' /app/skills/research/SKILL.md"
ax sh -lc "grep -q 'bigquery-managed' /app/plugins/data-analytics/plugin.yaml"
ax python -c "import requests; t=requests.get('http://localhost:8001/agents', timeout=10).json()['agents'][0]['tools']; assert 'request_plan_approval' in t, t; print('request_plan_approval available in /agents')"
ax python -c "from langchain_mcp_adapters.client import MultiServerMCPClient; print('langchain-mcp-adapters import ok')"

log "Public checks"
GW="$(k get gateway aria-gateway -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}')"
echo "  aria-gateway Programmed=${GW}"
for path in / /api/health; do
  printf '  https://%s%s -> ' "${DOMAIN}" "${path}"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 "https://${DOMAIN}${path}" || echo "unreachable"
done

log "Done. Build ${BUILD_ID} (${COMMIT:0:8}) is live on ${CLUSTER}."
cat <<EOF
Backup:   ${BACKUP_DIR}
Rollback: KUBECONFIG=${KUBECONFIG} kubectl -n ${NS} rollout undo deploy/helpudoc-app
          KUBECONFIG=${KUBECONFIG} kubectl -n ${NS} rollout undo deploy/helpudoc-frontend
          KUBECONFIG=${KUBECONFIG} kubectl -n ${NS} apply -f ${BACKUP_DIR}/cronjob.yaml
EOF
if (( ${#MISSING[@]} > 0 )); then
  echo; echo "Before enforcement is switched back on, allowlist:"; printf '  %s\n' "${MISSING[@]}"
fi
