#!/usr/bin/env bash
# release-canonical.sh — immutable, single-SHA production release.
#
#   release-canonical.sh --sha <merged-singulance-main-sha> \
#                        --services core,tara-grok,tara-deepgram,control-plane,employees,frontend \
#                        [--canary-url https://next.singulancelabs.com/hivemind/app] \
#                        [--skip-canary] [--dry-run]
#
# Enforces the canonical parallel workflow:
#   * one deploy = one canonical SHA = one release manifest
#   * --sha MUST be an ancestor of origin/singulance-main (no unmerged code)
#   * detached immutable worktree at /root/releases/<sha> (never a dirty tree)
#   * compose validation before deploy
#   * immutable image build tags (sha-<sha>) ONLY, from that worktree
#   * deploy only named services with --no-deps
#   * rollback tag preserved before replace
#   * health + image-SHA-label verify + optional signed-in canary
#   * manifest artifact written for traceability
set -euo pipefail

SHA=""; SERVICES=""; CANARY_URL=""; SKIP_CANARY=0; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --sha) SHA="$2"; shift 2;;
  --services) SERVICES="$2"; shift 2;;
  --canary-url) CANARY_URL="$2"; shift 2;;
  --skip-canary) SKIP_CANARY=1; shift;;
  --dry-run) DRY=1; shift;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done
[ -n "$SHA" ] || { echo "FATAL: --sha required"; exit 2; }
[ -n "$SERVICES" ] || { echo "FATAL: --services required"; exit 2; }

CANON=/root/hivemind-main
HDIR=/root/hivemind
HETZNER="$HDIR/infra/docker-compose.hetzner.yml"
ENVF="$HDIR/.env"
NEXT_REPO=/root/hivemind-next
NEXT="$NEXT_REPO/infra/docker-compose.next.yml"
NEXTENV="$NEXT_REPO/.env.embedding-canary-runtime"

# service → container / image-name / build recipe (run from the release worktree root)
declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [frontend]=hivemind-next-frontend-1 )
declare -A IMG=( [core]=core-api [control-plane]=control-plane [employees]=employees [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [frontend]=fe )
build_cmd() { local s="$1" tag="$2"; case "$s" in
  core)          docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" -f Dockerfile.production . ;;
  control-plane) docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" -f Dockerfile.control-plane . ;;
  employees)     docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" ./employees-service ;;
  tara-grok)     docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" ./services/tara-grok ;;
  tara-deepgram) docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" ./services/tara-deepgram ;;
  frontend)      docker build -q --label org.opencontainers.image.revision="$SHA" -t "$tag" ./frontend/Da-vinci ;;
esac; }

IFS=',' read -ra SVCS <<< "$SERVICES"
for s in "${SVCS[@]}"; do [ -n "${CONTAINER[$s]:-}" ] || { echo "FATAL: unknown service '$s'"; exit 2; }; done

# ── serialize with quick-deploy (same lock) ────────────────────────────────
exec 9>/run/lock/singulance-quick-deploy.lock
flock -n 9 || { echo "FATAL: another SINGULANCE deployment holds the lock"; exit 1; }
echo "[lock] acquired"

# ── fetch + ancestor gate ──────────────────────────────────────────────────
git -C "$CANON" -c fetch.recurseSubmodules=false fetch origin singulance-main -q
FULLSHA=$(git -C "$CANON" rev-parse "$SHA^{commit}" 2>/dev/null) || { echo "FATAL: sha $SHA not found"; exit 1; }
git -C "$CANON" merge-base --is-ancestor "$FULLSHA" origin/singulance-main \
  || { echo "FATAL: $SHA is NOT an ancestor of origin/singulance-main — refusing (unmerged code)"; exit 1; }
SHORT=$(git -C "$CANON" rev-parse --short "$FULLSHA")
echo "[gate] $SHORT is on canonical ✓"

# ── detached immutable worktree ────────────────────────────────────────────
REL="/root/releases/$SHORT"
if [ ! -d "$REL/.git" ] && [ ! -f "$REL/.git" ]; then
  git -C "$CANON" worktree add --detach --force "$REL" "$FULLSHA" >/dev/null
  git -C "$REL" -c submodule.recurse=false submodule update --init --force -q frontend/Da-vinci || true
fi
echo "[worktree] $REL @ $(git -C "$REL" rev-parse --short HEAD)"

# ── compose validation ─────────────────────────────────────────────────────
docker compose -f "$HETZNER" --env-file "$ENVF" config -q && echo "[compose] hetzner valid"

TS=$(date -u +%Y%m%dT%H%M%SZ)
MANIFEST="$REL/RELEASE_MANIFEST.$TS.json"
OVERRIDE="$REL/deploy-override.$TS.yml"
declare -A ROLLBACK=()

if [ "$DRY" = 1 ]; then echo "[dry-run] validated sha+worktree+compose; skipping build/deploy"; exit 0; fi

# ── build immutable sha images + preserve rollback ─────────────────────────
echo "services:" > "$OVERRIDE.tmp"
for s in "${SVCS[@]}"; do
  [ "$s" = frontend ] && continue   # FE handled on its own compose below
  TAG="hivemind/${IMG[$s]}:sha-$SHORT"
  # rollback: retag the currently-live image of this service
  CUR=$(docker inspect "${CONTAINER[$s]}" --format '{{.Config.Image}}' 2>/dev/null || true)
  if [ -n "$CUR" ]; then docker tag "$CUR" "hivemind/${IMG[$s]}:rollback" && ROLLBACK[$s]="$CUR"; fi
  echo "[build] $s → $TAG"
  ( cd "$REL" && build_cmd "$s" "$TAG" ) >/dev/null
  printf '  %s:\n    image: %s\n' "$s" "$TAG" >> "$OVERRIDE.tmp"
done
mv "$OVERRIDE.tmp" "$OVERRIDE"

# ── deploy named hetzner services (--no-deps, override pins the sha image) ──
for s in "${SVCS[@]}"; do
  [ "$s" = frontend ] && continue
  echo "[deploy] $s"
  ( cd "$HDIR" && docker compose -f "$HETZNER" -f "$OVERRIDE" --env-file "$ENVF" up -d --no-deps --force-recreate "$s" >/dev/null )
done

# ── frontend (separate compose/project) ────────────────────────────────────
if printf '%s\n' "${SVCS[@]}" | grep -qx frontend; then
  FTAG="hivemind/fe:sha-$SHORT"
  CUR=$(docker inspect hivemind-next-frontend-1 --format '{{.Config.Image}}' 2>/dev/null || true)
  [ -n "$CUR" ] && { docker tag "$CUR" hivemind/fe:rollback-single; ROLLBACK[frontend]="$CUR"; }
  echo "[build] frontend → $FTAG"; ( cd "$REL" && build_cmd frontend "$FTAG" ) >/dev/null
  docker tag "$FTAG" hivemind/fe:latest-single
  # docker-compose.next.yml's single-profile `frontend:` service pins a LITERAL
  # image tag (unlike frontend-b2b/b2c, which use ${NEXT_VERSION}) — bump it here
  # or every subsequent build is silently discarded and --force-recreate just
  # restarts the same stale image. Root-caused 2026-08-06 after two by-hand fixes
  # to this same line; fail loudly instead of leaving the next person to rediscover it.
  if grep -q 'image: hivemind/fe:sha-[0-9a-f]\+$' "$NEXT"; then
    sed -i "s#image: hivemind/fe:sha-[0-9a-f]\+#image: $FTAG#" "$NEXT"
    echo "[pin] $NEXT frontend → $FTAG"
  else
    echo "FATAL: expected 'image: hivemind/fe:sha-<hex>' under frontend: in $NEXT, not found — fix the pin by hand and re-run, do not deploy blind" >&2
    exit 1
  fi
  ( cd "$NEXT_REPO" && NEXT_VERSION=latest docker compose -p hivemind-next -f "$NEXT" --env-file "$NEXTENV" --profile single up -d --no-deps --force-recreate frontend >/dev/null )
fi

# ── verify: health + image-SHA label + optional canary ─────────────────────
FAIL=0
for s in "${SVCS[@]}"; do
  c="${CONTAINER[$s]}"
  for i in $(seq 1 45); do
    st=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
    { [ "$st" = healthy ] || [ "$st" = running ]; } && break; sleep 4
  done
  rev=$(docker inspect "$c" --format '{{ index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
  ok="✓"; { [ "$st" = healthy ] || [ "$st" = running ]; } || { ok="✗ UNHEALTHY"; FAIL=1; }
  [ "$rev" = "$SHA" ] || { ok="$ok ✗ label=$rev≠$SHA"; }
  echo "[verify] $s $c → $st  rev=${rev:0:12}  $ok"
done
if [ "$SKIP_CANARY" = 0 ] && [ -n "$CANARY_URL" ]; then
  code=""; for i in $(seq 1 12); do code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$CANARY_URL" || true); case "$code" in 2*|3*|401|403) break;; esac; sleep 3; done
  echo "[canary] $CANARY_URL → $code"; case "$code" in 2*|3*|401|403);; *) FAIL=1;; esac
fi

# ── manifest ───────────────────────────────────────────────────────────────
{
  echo "{"; echo "  \"sha\": \"$SHA\","; echo "  \"short\": \"$SHORT\","; echo "  \"ts\": \"$TS\","
  echo "  \"services\": \"$SERVICES\","; echo "  \"worktree\": \"$REL\","
  echo -n "  \"rollback\": {"; first=1; for s in "${!ROLLBACK[@]}"; do [ $first = 1 ] || echo -n ","; first=0; echo -n "\"$s\":\"${ROLLBACK[$s]}\""; done; echo "},"
  echo "  \"result\": \"$([ $FAIL = 0 ] && echo ok || echo FAILED)\""; echo "}"
} > "$MANIFEST"
echo "[manifest] $MANIFEST"
[ "$FAIL" = 0 ] && echo "RELEASE OK — $SHORT" || { echo "RELEASE FAILED — rollback: hivemind/<img>:rollback"; exit 1; }
