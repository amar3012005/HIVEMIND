#!/usr/bin/env bash
# Verify a signed immutable agent release, deploy only the Memory Box agent,
# and automatically restore the prior local image on any health/contract fault.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:-}"; SIGNATURE="${2:-}"
PUBLIC_KEY="${BYOD_RELEASE_PUBLIC_KEY:-}"
COMPOSE_FILE="${BYOD_COMPOSE_FILE:-$HERE/docker-compose.byod.yml}"
COMPOSE_PROJECT="${BYOD_COMPOSE_PROJECT_NAME:-}"
AGENT_CONTAINER="${BYOD_AGENT_CONTAINER:-hm-byod-agent}"
STATE="${BYOD_RELEASE_STATE_DIR:-$HERE/.releases}"
COMPOSE=(docker compose)
[[ -z "$COMPOSE_PROJECT" ]] || COMPOSE+=(-p "$COMPOSE_PROJECT")
COMPOSE+=(-f "$COMPOSE_FILE")
[[ -f "$MANIFEST" && -f "$SIGNATURE" && -f "$PUBLIC_KEY" ]] || {
  echo "usage: BYOD_RELEASE_PUBLIC_KEY=... ./upgrade.sh RELEASE.json RELEASE.sig" >&2
  exit 2
}

VERIFIED="$(node "$HERE/verify-release.mjs" "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY")"
IMAGE="$(VERIFIED="$VERIFIED" node -e 'process.stdout.write(JSON.parse(process.env.VERIFIED).image)')"
RELEASE="$(VERIFIED="$VERIFIED" node -e 'process.stdout.write(JSON.parse(process.env.VERIFIED).release)')"
if [[ "${BYOD_UPGRADE_DRY_RUN:-false}" == true ]]; then
  echo "Signed Memory Box release verified: $RELEASE"
  exit 0
fi

mkdir -p "$STATE"
chmod 700 "$STATE"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CURRENT_ID="$(docker inspect "$AGENT_CONTAINER" --format '{{.Image}}')"
CURRENT_RELEASE="$(docker inspect "$AGENT_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AGENT_RELEASE=//p' | tail -1)"
ROLLBACK_TAG="hivemind/hm-agent:rollback-$STAMP"
docker tag "$CURRENT_ID" "$ROLLBACK_TAG"
docker pull "$IMAGE" >/dev/null

OVERRIDE="$STATE/upgrade-$STAMP.yml"
printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$IMAGE" "$RELEASE" > "$OVERRIDE"
chmod 600 "$OVERRIDE"

rollback() {
  local rollback_override="$STATE/rollback-$STAMP.yml"
  printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$ROLLBACK_TAG" "$CURRENT_RELEASE" > "$rollback_override"
  "${COMPOSE[@]}" -f "$rollback_override" up -d --no-deps --force-recreate agent >/dev/null || true
}
trap rollback ERR
"${COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --force-recreate agent >/dev/null
for _ in $(seq 1 45); do
  HEALTH="$(docker inspect "$AGENT_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  [[ "$HEALTH" == healthy || "$HEALTH" == running ]] && break
  sleep 2
done
[[ "$HEALTH" == healthy || "$HEALTH" == running ]]
OBSERVED="$(docker exec "$AGENT_CONTAINER" node -e '
const h={authorization:`Bearer ${process.env.AGENT_TOKEN}`,"content-type":"application/json","x-org-id":process.env.ORG_ID};
fetch("http://127.0.0.1:8787/v1/capabilities",{method:"POST",headers:h,body:"{}"}).then(r=>r.json()).then(j=>process.stdout.write(String(j.agent_release||""))).catch(()=>process.exit(1));')"
[[ "$OBSERVED" == "$RELEASE" ]]

MANIFEST_SHA="$(sha256sum "$MANIFEST" | awk '{print $1}')"
RELEASE="$RELEASE" IMAGE="$IMAGE" MANIFEST_SHA="$MANIFEST_SHA" \
ROLLBACK_TAG="$ROLLBACK_TAG" PREVIOUS_RELEASE="$CURRENT_RELEASE" \
node -e 'process.stdout.write(JSON.stringify({version:1,complete:true,release:process.env.RELEASE,image:process.env.IMAGE,manifest_sha256:process.env.MANIFEST_SHA,rollback_image:process.env.ROLLBACK_TAG,previous_release:process.env.PREVIOUS_RELEASE,verified_at:new Date().toISOString()},null,2)+"\n")' \
  > "$STATE/CURRENT_RELEASE.json"
chmod 600 "$STATE/CURRENT_RELEASE.json"
trap - ERR
echo "Memory Box agent upgraded and verified: $RELEASE"
