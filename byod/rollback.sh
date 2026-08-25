#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/memory-box-common.sh"
[[ "${HIVEMIND_MEMORY_BOX_LOCK_HELD:-false}" == true ]] || hm_lock
AGENT_CONTAINER="${BYOD_AGENT_CONTAINER:-hm-byod-agent}"; STATE_DIR="${BYOD_RELEASE_STATE_DIR:-$HM_STATE_DIR}"
RECEIPT="$STATE_DIR/CURRENT_RELEASE.json"
[[ -f "$RECEIPT" ]] || hm_die 'no verified rollback receipt'
ROLLBACK_IMAGE="$(hm_json_field "$RECEIPT" 'x.complete===true&&x.rollback_image')" || hm_die 'rollback receipt is incomplete'
PREVIOUS_RELEASE="$(hm_json_field "$RECEIPT" 'x.previous_release||"rollback"')"
docker image inspect "$ROLLBACK_IMAGE" >/dev/null || hm_die 'the previous image is no longer present locally'
hm_compose_prefix
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OVERRIDE="$STATE_DIR/manual-rollback-$STAMP.yml"
printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$ROLLBACK_IMAGE" "$PREVIOUS_RELEASE" | hm_atomic_write "$OVERRIDE" 600
"${HM_COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --force-recreate agent >/dev/null
OBSERVED=""
for _ in $(seq 1 "${BYOD_VERIFY_ATTEMPTS:-45}"); do
  OBSERVED="$(docker exec "$AGENT_CONTAINER" node -e '
const h={authorization:`Bearer ${process.env.AGENT_TOKEN}`,"content-type":"application/json","x-org-id":process.env.ORG_ID};
Promise.all([fetch("http://127.0.0.1:8787/health").then(r=>r.json()),fetch("http://127.0.0.1:8787/v1/capabilities",{method:"POST",headers:h,body:"{}"}).then(r=>r.json()),fetch("http://127.0.0.1:8787/v1/stats",{method:"POST",headers:h,body:"{}"}).then(r=>r.json())]).then(([h,c,s])=>{if(h.ok&&c.agent_release&&Number.isFinite(Number(s.memories))&&Number.isFinite(Number(s.evidence)))process.stdout.write(c.agent_release)}).catch(()=>process.exit(1));' 2>/dev/null || true)"
  [[ "$OBSERVED" != "$PREVIOUS_RELEASE" ]] || break
  sleep "${BYOD_VERIFY_INTERVAL_SECONDS:-2}"
done
[[ "$OBSERVED" == "$PREVIOUS_RELEASE" ]] || hm_die 'rollback image failed health, identity, or inventory verification'
cp -f "$RECEIPT" "$STATE_DIR/ROLLED_BACK_FROM-$STAMP.json"
if [[ -f "$HM_PREVIOUS_RECEIPT" ]]; then
  cp -f "$HM_PREVIOUS_RECEIPT" "$RECEIPT.tmp"; chmod 600 "$RECEIPT.tmp"; mv -f "$RECEIPT.tmp" "$RECEIPT"
else
  PREVIOUS_RELEASE="$PREVIOUS_RELEASE" ROLLBACK_IMAGE="$ROLLBACK_IMAGE" node <<'NODE' | hm_atomic_write "$RECEIPT" 600
process.stdout.write(JSON.stringify({version:2,complete:true,release:process.env.PREVIOUS_RELEASE,image:process.env.ROLLBACK_IMAGE,rollback_state:'manual',verified_at:new Date().toISOString()},null,2)+'\n');
NODE
fi
echo "Memory Box agent rolled back to $PREVIOUS_RELEASE"
