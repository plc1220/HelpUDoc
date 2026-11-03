#!/usr/bin/env bash
# Put a cluster behind a maintenance page, and take it off again.
#
#   infra/gke/scripts/maintenance.sh <aiengine-dev|aria-dev|aria-prd> on       # users get a 503 maintenance page
#   infra/gke/scripts/maintenance.sh <aiengine-dev|aria-dev|aria-prd> off      # restore the normal site
#   infra/gke/scripts/maintenance.sh <aiengine-dev|aria-dev|aria-prd> status
#
# How: all three clusters send app traffic through helpudoc-caddy (an Ingress on
# aiengine-dev, Gateway HTTPRoute `aria` on the ARIA clusters). `on` saves the live
# Caddyfile into ConfigMap helpudoc-caddy-config-backup, swaps in a Caddyfile that answers
# 503, and rolls Caddy (RollingUpdate, so there is no gap). `off` puts the saved file back,
# byte for byte, so each cluster keeps its own Caddyfile.
#
# Health checks stay green, or Google replaces this page with its own 502:
#   - aiengine-dev's Ingress checks GET / with User-Agent GoogleHC.
#   - The ARIA Gateways check /gateway-healthz (HealthCheckPolicy helpudoc-caddy-health).
#
# Binary Authorization (ARIA clusters): rolling Caddy creates a new pod, and a pod whose
# image digest is not allowlisted is refused. That took aria-dev down on 2026-10-30, so
# the script checks the allowlist before every restart.
#
# The app keeps running, so kubectl exec (migration export/import) still works.
# Ends maintenance too: a cloudbuild.yaml deploy on aiengine-dev re-applies 70-caddy.yaml.
# deploy-aria.sh does not touch Caddy.
set -euo pipefail

TARGET="${1:-}"
ACTION="${2:-}"
usage() { sed -n '4,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
case "${TARGET}" in
  aiengine-dev) PROJECT=ccob-my-ai-engine-dev; CLUSTER=helpudoc-cluster; LOCATION=asia-southeast1-a; URL=https://aiengine-dev.skp.gov.my/ ;;
  aria-dev)     PROJECT=ccob-my-ai-engine-dev; CLUSTER=asia-southeast1-gke-dev-aria-01; LOCATION=asia-southeast1; URL=https://aria-dev.skp.gov.my/ ;;
  aria-prd)     PROJECT=ccob-my-ai-engine-prd; CLUSTER=asia-southeast1-gke-prd-aria-01; LOCATION=asia-southeast1; URL=https://aria.skp.gov.my/ ;;
  *) usage ;;
esac
[[ "${ACTION}" =~ ^(on|off|status)$ ]] || usage

NS=helpudoc
CM=helpudoc-caddy-config
BACKUP_CM=helpudoc-caddy-config-backup
die() { echo "ERROR: $*" >&2; exit 1; }

# Own kubeconfig: the shell's current context cannot redirect this to another cluster.
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
export KUBECONFIG="${WORK}/kubeconfig"
gcloud container clusters get-credentials "${CLUSTER}" --location "${LOCATION}" --project "${PROJECT}" >/dev/null 2>&1 \
  || die "could not get credentials for ${CLUSTER} (${PROJECT})"
k() { kubectl -n "${NS}" "$@"; }
echo "Cluster: ${TARGET} (${CLUSTER})"

maintenance_caddyfile() {
  cat <<'CADDY'
{
  auto_https off
}

# MAINTENANCE MODE (infra/gke/scripts/maintenance.sh)
:80 {
  # `route` keeps the written order. Without it Caddy sorts directives itself and
  # the health-check exemptions below never run.
  route {
    @healthcheck {
      header User-Agent GoogleHC*
    }
    @gatewayhealth path /gateway-healthz
    respond @healthcheck "ok" 200
    respond @gatewayhealth "ok" 200

    header Retry-After "3600"
    header Cache-Control "no-store"

    @api path /api* /helpudoc*
    header @api Content-Type "application/json"
    respond @api `{"error":"maintenance","message":"ARIA is down for scheduled maintenance."}` 503

    header Content-Type "text/html; charset=utf-8"
    respond <<HTML
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>ARIA maintenance</title>
        <style>
          body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
                 font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f7f6; color: #1d2b28; }
          main { max-width: 32rem; padding: 2.5rem; margin: 1rem; background: #fff; border-radius: 16px;
                 box-shadow: 0 10px 30px rgba(0, 0, 0, 0.06); text-align: center; }
          h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
          p { line-height: 1.6; color: #4a5a56; margin: 0.5rem 0; }
          .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em;
                   text-transform: uppercase; color: #0f766e; background: #e6f4f1; padding: 0.3rem 0.7rem;
                   border-radius: 999px; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <main>
          <span class="badge">Scheduled maintenance</span>
          <h1>ARIA is temporarily unavailable</h1>
          <p>We are carrying out scheduled maintenance. Your workspaces and files are safe.</p>
          <p>Please check back later.</p>
        </main>
      </body>
      </html>
      HTML 503
  }
}
CADDY
}

# Refuse to roll Caddy when Binary Authorization would refuse its new pod.
check_admission() {
  local mode image policy
  mode="$(gcloud container clusters describe "${CLUSTER}" --location "${LOCATION}" --project "${PROJECT}" \
    --format='value(binaryAuthorization.evaluationMode)' 2>/dev/null || true)"
  image="$(k get deploy helpudoc-caddy -o jsonpath='{.spec.template.spec.containers[0].image}')"
  if [[ -z "${mode}" || "${mode}" == "DISABLED" ]]; then
    echo "  Binary Authorization: off"; return
  fi
  [[ "${image}" == *@sha256:* ]] || die "Caddy image '${image}' is not pinned by digest; Binary Authorization (${mode}) would refuse a new pod"
  policy="$(gcloud container binauthz policy export --project "${PROJECT}" 2>/dev/null)" \
    || die "could not read the Binary Authorization policy for ${PROJECT}; not restarting Caddy"
  if grep -qF "namePattern: ${image}" <<<"${policy}"; then
    echo "  Binary Authorization: ${mode}; Caddy image is allowlisted"
  else
    die "Caddy image ${image} is NOT in the ${PROJECT} allowlist. Restarting Caddy would leave ${TARGET} with no Caddy pod. Allowlist it first."
  fi
}

roll() {
  check_admission
  k rollout restart deploy/helpudoc-caddy >/dev/null
  k rollout status deploy/helpudoc-caddy --timeout=180s
}

probe() {
  local user health
  user="$(curl -s -o /dev/null -w '%{http_code}' "${URL}" || true)"
  health="$(curl -s -o /dev/null -w '%{http_code}' -A 'GoogleHC/1.0' "${URL}gateway-healthz" || true)"
  echo "  ${URL} -> ${user} for users; health check -> ${health}"
}

case "${ACTION}" in
  on)
    if k get cm "${BACKUP_CM}" >/dev/null 2>&1; then
      die "${BACKUP_CM} already exists, so maintenance looks active. Run 'status', or 'off' first."
    fi
    LIVE="$(k get cm "${CM}" -o jsonpath='{.data.Caddyfile}')"
    [[ -n "${LIVE}" ]] || die "ConfigMap ${CM} has no Caddyfile"
    [[ "${LIVE}" != *"MAINTENANCE MODE"* ]] || die "the live Caddyfile is already the maintenance one"
    check_admission # before changing anything
    echo "==> Saving the live Caddyfile to ConfigMap ${BACKUP_CM}"
    k create configmap "${BACKUP_CM}" --from-literal=Caddyfile="${LIVE}" >/dev/null
    echo "==> Switching Caddy to the maintenance page"
    k create configmap "${CM}" --from-literal=Caddyfile="$(maintenance_caddyfile)" --dry-run=client -o yaml | k apply -f - >/dev/null
    roll
    sleep 5; probe
    echo "Maintenance is ON for ${TARGET}. Expect 503 for users and 200 for the health check (allow a minute)."
    ;;
  off)
    k get cm "${BACKUP_CM}" >/dev/null 2>&1 || die "no ${BACKUP_CM} on ${TARGET}; nothing to restore"
    SAVED="$(k get cm "${BACKUP_CM}" -o jsonpath='{.data.Caddyfile}')"
    [[ -n "${SAVED}" && "${SAVED}" != *"MAINTENANCE MODE"* ]] || die "${BACKUP_CM} does not hold a normal Caddyfile"
    echo "==> Restoring the saved Caddyfile"
    k create configmap "${CM}" --from-literal=Caddyfile="${SAVED}" --dry-run=client -o yaml | k apply -f - >/dev/null
    roll
    k delete cm "${BACKUP_CM}" >/dev/null
    sleep 5; probe
    echo "Maintenance is OFF for ${TARGET}. Expect 200."
    ;;
  status)
    if k get cm "${CM}" -o jsonpath='{.data.Caddyfile}' | grep -q "MAINTENANCE MODE"; then echo "  Maintenance: ON"; else echo "  Maintenance: OFF"; fi
    if k get cm "${BACKUP_CM}" >/dev/null 2>&1; then echo "  Backup ConfigMap ${BACKUP_CM} present"; fi
    check_admission
    probe
    ;;
esac
