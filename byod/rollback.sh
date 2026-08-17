#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${BYOD_COMPOSE_FILE:-$HERE/docker-compose.byod.yml}"
COMPOSE_PROJECT="${BYOD_COMPOSE_PROJECT_NAME:-}"
AGENT_CONTAINER="${BYOD_AGENT_CONTAINER:-hm-byod-agent}"
STATE_DIR="${BYOD_RELEASE_STATE_DIR:-$HERE/.releases}"
[[ -d "$STATE_DIR" ]] || { echo "no verified release state directory" >&2; exit 2; }
COMPOSE=(docker compose)
[[ -z "$COMPOSE_PROJECT" ]] || COMPOSE+=(-p "$COMPOSE_PROJECT")
COMPOSE+=(-f "$COMPOSE_FILE")
RECEIPT="$STATE_DIR/CURRENT_RELEASE.json"
[[ -f "$RECEIPT" ]] || { echo "no verified rollback receipt" >&2; exit 2; }
ROLLBACK_IMAGE="$(node -e 'const r=require(process.argv[1]);if(r.complete!==true||!r.rollback_image)process.exit(1);process.stdout.write(r.rollback_image)' "$RECEIPT")"
PREVIOUS_RELEASE="$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.previous_release||"rollback"))' "$RECEIPT")"
docker image inspect "$ROLLBACK_IMAGE" >/dev/null
OVERRIDE="$STATE_DIR/manual-rollback-$(date -u +%Y%m%dT%H%M%SZ).yml"
printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$ROLLBACK_IMAGE" "$PREVIOUS_RELEASE" > "$OVERRIDE"
"${COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --force-recreate agent >/dev/null
for _ in $(seq 1 45); do
  STATE="$(docker inspect "$AGENT_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)"
  [[ "$STATE" == running ]] && break
  sleep 2
done
[[ "$STATE" == running ]]
OBSERVED="$(docker exec "$AGENT_CONTAINER" node -e '
const h={authorization:`Bearer ${process.env.AGENT_TOKEN}`,"content-type":"application/json","x-org-id":process.env.ORG_ID};
fetch("http://127.0.0.1:8787/v1/capabilities",{method:"POST",headers:h,body:"{}"}).then(r=>r.json()).then(j=>process.stdout.write(String(j.agent_release||""))).catch(()=>process.exit(1));')"
[[ "$OBSERVED" == "$PREVIOUS_RELEASE" ]]
echo "Memory Box agent rolled back to $PREVIOUS_RELEASE"
