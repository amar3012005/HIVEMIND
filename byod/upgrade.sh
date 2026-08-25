#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/memory-box-common.sh"
MANIFEST="${1:-}"; SIGNATURE="${2:-}"; PUBLIC_KEY="${BYOD_RELEASE_PUBLIC_KEY:-$HM_PUBLIC_KEY}"
AGENT_CONTAINER="${BYOD_AGENT_CONTAINER:-hm-byod-agent}"; STATE="${BYOD_RELEASE_STATE_DIR:-$HM_STATE_DIR}"
[[ "${HIVEMIND_MEMORY_BOX_LOCK_HELD:-false}" == true ]] || hm_lock
[[ -f "$MANIFEST" && -f "$SIGNATURE" && -f "$PUBLIC_KEY" ]] || { echo "usage: BYOD_RELEASE_PUBLIC_KEY=... $0 RELEASE.json RELEASE.sig" >&2; exit 2; }

VERIFIED="$(node "$HERE/verify-release.mjs" "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY")"
NORMALIZED="$(VERIFIED="$VERIFIED" node <<'NODE'
const m=JSON.parse(process.env.VERIFIED);
const image=typeof m.image==='string'?m.image:(m.agent_image?.image||m.agent_image?.reference||m.agent?.image);
const release=m.release_id||m.release, protocol=m.protocol_version||m.protocol?.version;
const schema=m.schema_version??m.schema?.version, capabilities=m.required_capabilities||m.capabilities?.required||[];
const bundleUrl=m.bundle_url||m.bundle?.url||null, bundleSha=m.bundle_sha256||m.bundle?.sha256||null;
if(!image||!release||!protocol) throw new Error('verified manifest is missing release, image, or protocol');
process.stdout.write(JSON.stringify({version:m.version,release,image,protocol,schema,capabilities,bundleUrl,bundleSha,
 channel:m.channel||null,sourceSha:m.source_sha||m.source?.sha||null,createdAt:m.created_at,expiresAt:m.expires_at||null}));
NODE
)"
read_field() { NORMALIZED="$NORMALIZED" node -e "const x=JSON.parse(process.env.NORMALIZED),v=x[process.argv[1]];if(v===null||v===undefined)process.exit(1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))" "$1"; }
IMAGE="$(read_field image)"; RELEASE="$(read_field release)"; PROTOCOL="$(read_field protocol)"; VERSION="$(read_field version)"
SCHEMA="$(read_field schema 2>/dev/null || true)"; CHANNEL="$(read_field channel 2>/dev/null || true)"
BUNDLE_URL="$(read_field bundleUrl 2>/dev/null || true)"; BUNDLE_SHA="$(read_field bundleSha 2>/dev/null || true)"
CAPABILITIES="$(read_field capabilities)"; CREATED_AT="$(read_field createdAt)"; EXPIRES_AT="$(read_field expiresAt 2>/dev/null || true)"

[[ "${BYOD_REQUIRE_MANIFEST_V2:-false}" != true || "$VERSION" == 2 ]] || hm_die 'governed channel requires manifest v2'
[[ -z "${BYOD_EXPECTED_CHANNEL:-}" || "$CHANNEL" == "$BYOD_EXPECTED_CHANNEL" ]] || hm_die "release channel mismatch (expected $BYOD_EXPECTED_CHANNEL, got ${CHANNEL:-unset})"
if [[ -n "$EXPIRES_AT" ]] && ! EXPIRES_AT="$EXPIRES_AT" node -e 'process.exit(Date.parse(process.env.EXPIRES_AT)>Date.now()?0:1)'; then hm_die 'release manifest has expired'; fi
if [[ "$VERSION" == 2 ]]; then
  [[ -n "$SCHEMA" ]] || hm_die 'manifest v2 is missing schema version'
  [[ "$CAPABILITIES" != '[]' ]] || hm_die 'manifest v2 has no required capabilities'
  [[ -n "$BUNDLE_URL" && "$BUNDLE_SHA" =~ ^[a-f0-9]{64}$ ]] || hm_die 'manifest v2 has an invalid bundle contract'
fi
if [[ -f "$HM_CURRENT_RECEIPT" ]]; then
  INSTALLED_RELEASE="$(hm_json_field "$HM_CURRENT_RECEIPT" 'x.release||null' 2>/dev/null || true)"
  INSTALLED_IMAGE="$(hm_json_field "$HM_CURRENT_RECEIPT" 'x.image||null' 2>/dev/null || true)"
  CURRENT_CREATED="$(hm_json_field "$HM_CURRENT_RECEIPT" 'x.created_at||null' 2>/dev/null || true)"
  if [[ -n "$CURRENT_CREATED" ]] && ! CURRENT_CREATED="$CURRENT_CREATED" NEXT_CREATED="$CREATED_AT" node -e 'process.exit(Date.parse(process.env.NEXT_CREATED)>=Date.parse(process.env.CURRENT_CREATED)?0:1)'; then hm_die 'release downgrade rejected'; fi
  if [[ "$CURRENT_CREATED" == "$CREATED_AT" && -n "$INSTALLED_RELEASE" && "$INSTALLED_RELEASE" != "$RELEASE" ]]; then hm_die 'conflicting release identity at current release time'; fi
  if [[ "$INSTALLED_RELEASE" == "$RELEASE" && "$INSTALLED_IMAGE" == "$IMAGE" ]]; then echo "Memory Box agent is current: $RELEASE"; exit 0; fi
fi

mkdir -p "$STATE/downloads"; chmod 700 "$STATE" "$STATE/downloads"
if [[ -n "$BUNDLE_URL" ]]; then
  BUNDLE="$STATE/downloads/${RELEASE}.tar.gz"; hm_download "$BUNDLE_URL" "$BUNDLE"
  printf '%s  %s\n' "$BUNDLE_SHA" "$BUNDLE" | sha256sum --check --status || hm_die 'release bundle digest mismatch'
fi
if [[ "${BYOD_UPGRADE_DRY_RUN:-false}" == true ]]; then echo "Signed Memory Box release verified: $RELEASE"; exit 0; fi

hm_compose_prefix
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CURRENT_ID="$(docker inspect "$AGENT_CONTAINER" --format '{{.Image}}')"
CURRENT_IMAGE="$(docker inspect "$AGENT_CONTAINER" --format '{{.Config.Image}}')"
CURRENT_RELEASE="$(docker inspect "$AGENT_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AGENT_RELEASE=//p' | tail -1)"
ROLLBACK_TAG="hivemind/hm-agent:rollback-$STAMP"; docker tag "$CURRENT_ID" "$ROLLBACK_TAG"; docker pull "$IMAGE" >/dev/null
OVERRIDE="$STATE/upgrade-$STAMP.yml"
printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$IMAGE" "$RELEASE" | hm_atomic_write "$OVERRIDE" 600

verify_agent() {
  local expected_release="$1" expected_protocol="$2" expected_schema="$3" required="$4" probe=""
  for _ in $(seq 1 "${BYOD_VERIFY_ATTEMPTS:-45}"); do
    probe="$(docker exec "$AGENT_CONTAINER" node -e '
const h={authorization:`Bearer ${process.env.AGENT_TOKEN}`,"content-type":"application/json","x-org-id":process.env.ORG_ID};
const post=(u,b={})=>fetch(`http://127.0.0.1:8787${u}`,{method:"POST",headers:h,body:JSON.stringify(b)}).then(async r=>{if(!r.ok)throw new Error(`${u}:${r.status}`);return r.json()});
Promise.all([fetch("http://127.0.0.1:8787/health").then(r=>r.json()),post("/v1/capabilities"),post("/v1/stats"),post("/v1/recall",{})])
 .then(([health,capabilities,inventory,recall])=>process.stdout.write(JSON.stringify({health,capabilities,inventory,recall}))).catch(()=>process.exit(1));' 2>/dev/null || true)"
    if [[ -n "$probe" ]] && PROBE="$probe" EXPECTED_RELEASE="$expected_release" EXPECTED_PROTOCOL="$expected_protocol" EXPECTED_SCHEMA="$expected_schema" REQUIRED="$required" node <<'NODE'
const p=JSON.parse(process.env.PROBE),c=p.capabilities||{},required=JSON.parse(process.env.REQUIRED||'[]'),offered=new Set(c.capabilities||[]);
const schemaOk=!process.env.EXPECTED_SCHEMA||String(c.schema_version)===String(process.env.EXPECTED_SCHEMA);
const inventoryOk=p.inventory&&['memories','evidence','documents'].every(k=>Number.isFinite(Number(p.inventory[k])));
process.exit(p.health?.ok===true&&c.agent_release===process.env.EXPECTED_RELEASE&&(!process.env.EXPECTED_PROTOCOL||c.protocol_version===process.env.EXPECTED_PROTOCOL)&&schemaOk&&required.every(x=>offered.has(x))&&inventoryOk&&Array.isArray(p.recall?.results)?0:1);
NODE
    then return 0; fi
    sleep "${BYOD_VERIFY_INTERVAL_SECONDS:-2}"
  done
  return 1
}
rollback_failed_upgrade() {
  trap - ERR; set +e
  local rollback_override="$STATE/rollback-$STAMP.yml"
  printf 'services:\n  agent:\n    image: %s\n    environment:\n      AGENT_RELEASE: %s\n' "$ROLLBACK_TAG" "$CURRENT_RELEASE" | hm_atomic_write "$rollback_override" 600
  "${HM_COMPOSE[@]}" -f "$rollback_override" up -d --no-deps --force-recreate agent >/dev/null
  verify_agent "$CURRENT_RELEASE" "" "" '[]'
  hm_log "upgrade failed; restored $CURRENT_IMAGE ($CURRENT_RELEASE)"
  exit 1
}
trap rollback_failed_upgrade ERR
"${HM_COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --force-recreate agent >/dev/null
verify_agent "$RELEASE" "$PROTOCOL" "$SCHEMA" "$CAPABILITIES"

MANIFEST_SHA="$(sha256sum "$MANIFEST" | awk '{print $1}')"
[[ ! -f "$HM_CURRENT_RECEIPT" ]] || cp -f "$HM_CURRENT_RECEIPT" "$HM_PREVIOUS_RECEIPT"
RELEASE="$RELEASE" IMAGE="$IMAGE" MANIFEST_SHA="$MANIFEST_SHA" ROLLBACK_TAG="$ROLLBACK_TAG" PREVIOUS_RELEASE="$CURRENT_RELEASE" PREVIOUS_IMAGE="$CURRENT_IMAGE" CREATED_AT="$CREATED_AT" CHANNEL="$CHANNEL" PROTOCOL="$PROTOCOL" SCHEMA="$SCHEMA" CAPABILITIES="$CAPABILITIES" node <<'NODE' | hm_atomic_write "$HM_CURRENT_RECEIPT" 600
const receipt={version:2,complete:true,release:process.env.RELEASE,image:process.env.IMAGE,manifest_sha256:process.env.MANIFEST_SHA,rollback_image:process.env.ROLLBACK_TAG,previous_release:process.env.PREVIOUS_RELEASE,previous_image:process.env.PREVIOUS_IMAGE,created_at:process.env.CREATED_AT,channel:process.env.CHANNEL||null,protocol_version:process.env.PROTOCOL,schema_version:process.env.SCHEMA||null,required_capabilities:JSON.parse(process.env.CAPABILITIES||'[]'),verified_at:new Date().toISOString()};process.stdout.write(JSON.stringify(receipt,null,2)+'\n');
NODE
cp -f "$MANIFEST" "$STATE/${RELEASE}.release.json"; cp -f "$SIGNATURE" "$STATE/${RELEASE}.release.sig"
chmod 600 "$STATE/${RELEASE}.release.json" "$STATE/${RELEASE}.release.sig"; trap - ERR
echo "Memory Box agent upgraded and verified: $RELEASE"
