#!/usr/bin/env bash
# Read-only Memory Box readiness and recoverability check.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_TOOL="$HERE/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || MANIFEST_TOOL="$HERE/../scripts/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || { echo "storage-manifest.mjs is missing; reinstall the Memory Box bundle" >&2; exit 1; }
BACKUP_ROOT="${BYOD_BACKUP_DIR:-$HERE/backups}"
MAX_BACKUP_AGE_HOURS="${BYOD_BACKUP_MAX_AGE_HOURS:-26}"
MIN_FREE_GIB="${BYOD_MIN_FREE_GIB:-5}"
REQUIRE_OFFSITE="${BYOD_REQUIRE_OFFSITE:-false}"
FAILURES=0

fail() { echo "FAIL  $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS  $*"; }
warn() { echo "WARN  $*" >&2; }

for container in hm-byod-postgres hm-byod-qdrant hm-byod-agent; do
  state="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)"
  health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [[ "$state" != "running" || "$health" == "unhealthy" ]]; then
    fail "$container state=${state:-missing} health=${health:-unknown}"
  else
    pass "$container state=$state health=$health"
  fi
done

FREE_KIB="$(df -Pk "$HERE" | awk 'NR==2 {print $4}')"
MIN_KIB="$((MIN_FREE_GIB * 1024 * 1024))"
if [[ -z "$FREE_KIB" || "$FREE_KIB" -lt "$MIN_KIB" ]]; then
  fail "disk headroom below ${MIN_FREE_GIB} GiB"
else
  pass "disk headroom $((FREE_KIB / 1024 / 1024)) GiB"
fi

PROBE="$(docker exec hm-byod-agent node -e '
const headers={"content-type":"application/json",authorization:`Bearer ${process.env.AGENT_TOKEN}`,"x-org-id":process.env.ORG_ID};
Promise.all([
  fetch("http://127.0.0.1:8787/health").then(r=>r.json()),
  fetch("http://127.0.0.1:8787/v1/capabilities",{method:"POST",headers,body:"{}"}).then(r=>r.json()),
  fetch("http://127.0.0.1:8787/v1/vector-status",{method:"POST",headers,body:"{}"}).then(r=>r.json()),
]).then(([health,capabilities,vectors])=>process.stdout.write(JSON.stringify({health,capabilities,vectors})))
  .catch(e=>{console.error(e.message);process.exit(1)});
' 2>/dev/null || true)"
if [[ -z "$PROBE" ]]; then
  fail "authenticated agent probe failed"
else
  PROBE_RESULT="$(PROBE_JSON="$PROBE" node -e '
const p=JSON.parse(process.env.PROBE_JSON);
const required=["memory.recall","evidence.recall","vector.status","vector.pending","vector.repair"];
const offered=new Set(p.capabilities?.capabilities||[]);
const pending=Number(p.vectors?.memories?.pending||0)+Number(p.vectors?.evidence?.pending||0);
const ok=p.health?.ok===true && p.capabilities?.protocol_version==="memory-box.v1" && required.every(x=>offered.has(x));
process.stdout.write(JSON.stringify({ok,pending,protocol:p.capabilities?.protocol_version||null,release:p.capabilities?.agent_release||null,storage:p.capabilities?.storage_mode||null}));
' 2>/dev/null || true)"
  if [[ -z "$PROBE_RESULT" ]] || ! PROBE_RESULT="$PROBE_RESULT" node -e 'process.exit(JSON.parse(process.env.PROBE_RESULT).ok?0:1)'; then
    fail "agent health/capability contract incomplete"
  else
    pass "agent contract $PROBE_RESULT"
    PENDING="$(PROBE_RESULT="$PROBE_RESULT" node -e 'process.stdout.write(String(JSON.parse(process.env.PROBE_RESULT).pending))')"
    if [[ "$PENDING" -gt 0 ]]; then warn "$PENDING vector item(s) pending durable repair"; fi
  fi
fi

LATEST="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.*.partial' -print 2>/dev/null | sort | tail -1)"
if [[ -z "$LATEST" ]]; then
  fail "no completed Memory Box backup found under $BACKUP_ROOT"
elif ! node "$MANIFEST_TOOL" verify "$LATEST" >/dev/null; then
  fail "latest backup manifest failed verification: $LATEST"
else
  NOW="$(date +%s)"
  MTIME="$(stat -c %Y "$LATEST/STORAGE_MANIFEST.json" 2>/dev/null || stat -f %m "$LATEST/STORAGE_MANIFEST.json")"
  AGE_HOURS="$(((NOW - MTIME) / 3600))"
  if [[ "$AGE_HOURS" -gt "$MAX_BACKUP_AGE_HOURS" ]]; then
    fail "latest verified backup is ${AGE_HOURS}h old (max ${MAX_BACKUP_AGE_HOURS}h)"
  else
    pass "latest backup verified (${AGE_HOURS}h old): $LATEST"
    if [[ -f "$LATEST/OFFSITE_RECEIPT.json" ]]; then
      pass "latest backup has an off-host upload receipt"
    elif [[ "$REQUIRE_OFFSITE" == true ]]; then
      fail "latest backup has no off-host upload receipt"
    else
      warn "latest backup is local-only (set BYOD_REQUIRE_OFFSITE=true to enforce disaster recovery)"
    fi
  fi
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "Memory Box doctor: $FAILURES failure(s)" >&2
  exit 1
fi
echo "Memory Box doctor: ready"
