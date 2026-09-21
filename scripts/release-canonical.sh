#!/usr/bin/env bash
# release-canonical.sh — immutable, single-SHA production release.
#
#   release-canonical.sh --sha <merged-singulance-main-sha> \
#                        --services core,tara-grok,tara-deepgram,control-plane,employees \
#                        [--canary-url https://next.singulancelabs.com/hivemind/app] \
#                        [--skip-canary] [--skip-migrations] [--dry-run]
#                        [--service-scoped] [--allow-divergence]
#
# Enforces the canonical parallel workflow:
#   * one deploy = one canonical SHA = one release manifest
#   * --sha MUST be an ancestor of origin/singulance-main (no unmerged code)
#   * detached immutable worktree at /root/releases/builds/<full-sha>
#   * manifests and generated Compose overrides live outside the source tree
#   * compose validation before deploy
#   * immutable image build tags (sha-<sha>) ONLY, from that worktree
#   * deploy only named services with --no-deps
#   * rollback tag preserved before replace
#   * health + image-SHA-label verify + optional signed-in canary
#   * manifest artifact written for traceability
set -euo pipefail

SHA=""; SERVICES=""; CANARY_URL=""; SKIP_CANARY=0; SKIP_MIGRATIONS=0; DRY=0; SERVICE_SCOPED=0; ALLOW_DIVERGENCE=0; HARNESS_IMAGE=""; HARNESS_IMAGE_PRELOADED=0; HARNESS_IMAGE_PRELOADED_REF=""; HARNESS_IMAGE_EXPECTED_ID=""; HARNESS_DEPLOY_IMAGE=""
while [ $# -gt 0 ]; do case "$1" in
  --sha) SHA="$2"; shift 2;;
  --services) SERVICES="$2"; shift 2;;
  --canary-url) CANARY_URL="$2"; shift 2;;
  --skip-canary) SKIP_CANARY=1; shift;;
  --skip-migrations) SKIP_MIGRATIONS=1; shift;;
  --dry-run) DRY=1; shift;;
  --service-scoped) SERVICE_SCOPED=1; shift;;
  --allow-divergence) ALLOW_DIVERGENCE=1; shift;;
  --harness-image) HARNESS_IMAGE="$2"; shift 2;;
  --harness-image-preloaded) HARNESS_IMAGE_PRELOADED=1; shift;;
  --harness-image-preloaded-ref) HARNESS_IMAGE_PRELOADED_REF="$2"; shift 2;;
  --harness-image-expected-id) HARNESS_IMAGE_EXPECTED_ID="$2"; shift 2;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done
[ -n "$SHA" ] || { echo "FATAL: --sha required"; exit 2; }
[ -n "$SERVICES" ] || { echo "FATAL: --services required"; exit 2; }

CANON=/root/hivemind-main
HDIR=/root/hivemind
ENVF="$HDIR/.env"
PRESENCE="$HDIR/scripts/release-presence.sh"
RELEASE_SESSION_ID="${RELEASE_SESSION_ID:-codex-$$}"

# service → container / image-name / build recipe (run from the release worktree root)
declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [byod-broker]=hm-byod-broker [playwright]=hm-playwright [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [hm-extract]=hm-extract [harness-runner]=hivemind-harness-runner-1 [harness-tunnel]=hivemind-harness-tunnel-1 )
declare -A IMG=( [core]=core-api [control-plane]=control-plane [employees]=employees [byod-broker]=byod-broker [playwright]=hm-playwright [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [hm-extract]=hm-extract [harness-runner]=harness-chat )
COMPOSE_PROJECT=$(docker inspect "${CONTAINER[core]}" \
  --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
# A fresh host has no Core label yet; otherwise preserve the live project name
# (Enigma uses `enigma`, production uses `hivemind`) so Compose recreates the
# intended named containers instead of attempting a duplicate project.
COMPOSE_PROJECT="${COMPOSE_PROJECT:-hivemind}"
build_cmd() { local s="$1" tag="$2"; case "$s" in
  core)          docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=core -t "$tag" -f Dockerfile.production . ;;
  control-plane) docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=control-plane -t "$tag" -f Dockerfile.control-plane . ;;
  employees)     docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=employees -t "$tag" ./employees-service ;;
  byod-broker)   docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=byod-broker -t "$tag" ./byod/broker ;;
  playwright)    docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=playwright -t "$tag" ./services/hm-playwright ;;
  tara-grok)     docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=tara-grok -t "$tag" ./services/tara-grok ;;
  tara-deepgram) docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=tara-deepgram -t "$tag" ./services/tara-deepgram ;;
  hm-extract)    docker build -q "${IMAGE_LABELS[@]}" --label com.singulance.service=hm-extract -t "$tag" ./hm-extract ;;
esac; }

IFS=',' read -ra SVCS <<< "$SERVICES"
for s in "${SVCS[@]}"; do [ -n "${CONTAINER[$s]:-}" ] || { echo "FATAL: unknown service '$s'"; exit 2; }; done
if [[ ",${SERVICES}," == *,harness-runner,* ]]; then
  HARNESS_IMAGE="${HARNESS_IMAGE:-${HIVEMIND_HARNESS_IMAGE:-}}"
  [[ "$HARNESS_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] \
    || { echo "FATAL: harness-runner requires --harness-image (or HIVEMIND_HARNESS_IMAGE) pinned by @sha256"; exit 2; }
  # A native runner is not a valid production artifact without the secrets and
  # receipt boundary it needs to preserve tenant-scoped connected-app state.
  # Read only whether each value is populated; never source or print .env.
  for required_env in HIVE_HARNESS_TICKET_SECRET HIVE_HARNESS_RUNNER_SERVICE_SECRET HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY COMPOSIO_API_KEY HIVE_HARNESS_TUNNEL_TOKEN; do
    if ! awk -F= -v key="$required_env" '$1 == key && length(substr($0, length(key) + 2)) > 0 { found=1 } END { exit found ? 0 : 1 }' "$ENVF"; then
      echo "FATAL: harness-runner requires non-empty $required_env in the managed production environment"
      exit 1
    fi
  done
fi
[ "$HARNESS_IMAGE_PRELOADED" = 0 ] || [[ ",${SERVICES}," == *,harness-runner,* ]] \
  || { echo "FATAL: --harness-image-preloaded requires harness-runner"; exit 2; }
if [ "$HARNESS_IMAGE_PRELOADED" = 1 ]; then
  [ -n "$HARNESS_IMAGE_PRELOADED_REF" ] && [ -n "$HARNESS_IMAGE_EXPECTED_ID" ] \
    || { echo "FATAL: preloaded Harness image requires --harness-image-preloaded-ref and --harness-image-expected-id"; exit 2; }
  HARNESS_DEPLOY_IMAGE="$HARNESS_IMAGE_PRELOADED_REF"
else
  HARNESS_DEPLOY_IMAGE="$HARNESS_IMAGE"
fi

# Publish intent before building. A conflicting claim fails before consuming
# disk or producing an image that would supersede another session's release.
"$PRESENCE" claim --session "$RELEASE_SESSION_ID" --services "$SERVICES" --sha "$SHA" --phase planning --summary "canonical release requested"
trap '"$PRESENCE" complete --session "$RELEASE_SESSION_ID" --result failed --summary "release exited before completion" || true' EXIT

# ── one host-wide release lock and disk floor ─────────────────────────────
LOCK_FILE="${RELEASE_LOCK_FILE:-/var/lock/hivemind-release.lock}"
LOCK_WAIT="${RELEASE_LOCK_WAIT:-1800}"
AVAILABLE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
MIN_GB="${RELEASE_MIN_DISK_GB:-25}"
[ "${AVAILABLE_GB:-0}" -ge "$MIN_GB" ] || { echo "FATAL: only ${AVAILABLE_GB:-0}GB free; need ${MIN_GB}GB"; exit 1; }
exec 9>"$LOCK_FILE"
flock -w "$LOCK_WAIT" 9 || { echo "FATAL: another SINGULANCE deployment holds the canonical lock"; exit 1; }
echo "[lock] acquired"
"$PRESENCE" heartbeat --session "$RELEASE_SESSION_ID" --phase locked

# ── fetch + ancestor gate ──────────────────────────────────────────────────
# /root/hivemind-main can retain a Compose-era local `origin`; production
# releases always follow the authoritative GitHub canonical branch when it is
# configured there.
CANON_REMOTE=origin
if git -C "$CANON" remote get-url github >/dev/null 2>&1; then
  CANON_REMOTE=github
fi
# Fetch into the exact tracking ref used by the ancestor gate.  A named fetch
# can update only FETCH_HEAD when an operator's remote refspec is restrictive,
# which made a newly merged canonical SHA look unmerged and safely blocked a
# valid release.  Keeping the target explicit preserves the fail-closed gate.
git -C "$CANON" -c fetch.recurseSubmodules=false fetch "$CANON_REMOTE" \
  "+refs/heads/singulance-main:refs/remotes/$CANON_REMOTE/singulance-main" -q
FULLSHA=$(git -C "$CANON" rev-parse "$SHA^{commit}" 2>/dev/null) || { echo "FATAL: sha $SHA not found"; exit 1; }
git -C "$CANON" merge-base --is-ancestor "$FULLSHA" "$CANON_REMOTE/singulance-main" \
  || { echo "FATAL: $SHA is NOT an ancestor of origin/singulance-main — refusing (unmerged code)"; exit 1; }
SHORT=$(git -C "$CANON" rev-parse --short "$FULLSHA")
SHA="$FULLSHA"
echo "[gate] $SHORT is on canonical ✓"

# Core, Control Plane, and Employees share Runtime/Room contracts. A
# partial release is safe only when every omitted member is already running the
# exact target revision. An ancestor check is insufficient here: an older
# ancestor can still speak an incompatible envelope. The explicit override is
# reserved for incident response and leaves a conspicuous release-log record.
COUPLED=(core control-plane employees)
declare -A REQUESTED=()
for s in "${SVCS[@]}"; do REQUESTED[$s]=1; done
coupled_requested=0
for s in "${COUPLED[@]}"; do [ -n "${REQUESTED[$s]:-}" ] && coupled_requested=1; done
if [ "$coupled_requested" = 1 ] && [ "$SERVICE_SCOPED" = 1 ]; then
  echo "[gate] explicit service-scoped release: only $SERVICES will be built and replaced"
elif [ "$coupled_requested" = 1 ] && [ "$ALLOW_DIVERGENCE" != 1 ]; then
  for s in "${COUPLED[@]}"; do
    [ -n "${REQUESTED[$s]:-}" ] && continue
    c="${CONTAINER[$s]}"
    live_sha=$(docker inspect "$c" --format '{{ index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
    if [ -z "$live_sha" ]; then
      live_image=$(docker inspect "$c" --format '{{.Config.Image}}' 2>/dev/null || true)
      live_short=$(printf '%s' "$live_image" | sed -n 's/.*:sha-\([0-9a-fA-F]\{7,40\}\).*/\1/p')
      [ -n "$live_short" ] && live_sha=$(git -C "$CANON" rev-parse "$live_short^{commit}" 2>/dev/null || true)
    fi
    [ "$live_sha" = "$FULLSHA" ] || {
      echo "FATAL: contract-coupled service '$s' runs ${live_sha:-unknown}, target is $FULLSHA; include core,control-plane,employees or pass --allow-divergence for incident response"
      exit 1
    }
  done
  echo "[gate] omitted contract-coupled services already run $SHORT ✓"
elif [ "$coupled_requested" = 1 ]; then
  echo "WARNING: --allow-divergence bypassed the Runtime contract atomicity gate"
fi

# ── detached immutable worktree ────────────────────────────────────────────
REL="/root/releases/builds/$FULLSHA"
if [ ! -d "$REL/.git" ] && [ ! -f "$REL/.git" ]; then
  mkdir -p "$(dirname "$REL")"
  git -C "$CANON" worktree add --detach --force "$REL" "$FULLSHA" >/dev/null
fi
[ "$(git -C "$REL" rev-parse HEAD)" = "$FULLSHA" ] || { echo "FATAL: release worktree SHA drift"; exit 1; }
[ -z "$(git -C "$REL" status --porcelain --ignore-submodules=none)" ] || { echo "FATAL: release worktree is dirty"; exit 1; }
echo "[worktree] $REL @ $(git -C "$REL" rev-parse --short HEAD)"

# ── compose validation ─────────────────────────────────────────────────────
TS=$(date -u +%Y%m%dT%H%M%SZ)
IMAGE_LABELS=(--label "org.opencontainers.image.revision=$SHA" --label "org.opencontainers.image.created=$TS")
STATE_ROOT="${RELEASE_STATE_ROOT:-/root/releases/manifests/$SHORT/$TS}"
mkdir -p "$STATE_ROOT"
MANIFEST="$STATE_ROOT/RELEASE_MANIFEST.json"
OVERRIDE="$STATE_ROOT/deploy-override.yml"
# Deploy configuration must come from the same immutable SHA as the images.
# The mutable /root/hivemind checkout can legitimately contain operator work
# and may lag canonical; using its Compose file silently drops new environment
# contracts or selects stale image defaults on a later service recreation.
# Materialize the canonical Compose file outside the worktree so it stays clean,
# make the shared env_file absolute, and preserve canonical relative contexts via
# --project-directory. No secret value is copied into this artifact.
HETZNER="$STATE_ROOT/docker-compose.hetzner.yml"
sed "s#env_file: \[../.env\]#env_file: [$ENVF]#g" "$REL/infra/docker-compose.hetzner.yml" > "$HETZNER"
docker compose --project-name "$COMPOSE_PROJECT" --project-directory "$REL/infra" -f "$HETZNER" --env-file "$ENVF" config -q \
  && echo "[compose] canonical hetzner valid"
declare -A ROLLBACK=()

if [ "$DRY" = 1 ]; then
  "$PRESENCE" complete --session "$RELEASE_SESSION_ID" --result dry_run --summary "release validation passed; no deployment"
  trap - EXIT
  echo "[dry-run] validated sha+worktree+compose; skipping build/deploy"
  exit 0
fi

# ── build immutable sha images + preserve rollback ─────────────────────────
echo "services:" > "$OVERRIDE.tmp"
for s in "${SVCS[@]}"; do
  if [ "$s" = harness-runner ]; then
    CUR=$(docker inspect "${CONTAINER[$s]}" --format '{{.Config.Image}}' 2>/dev/null || true)
    if [ -n "$CUR" ]; then docker tag "$CUR" "hivemind/${IMG[$s]}:rollback" && ROLLBACK[$s]="$CUR"; fi
    if [ "$HARNESS_IMAGE_PRELOADED" = 1 ]; then
      echo "[image] $s uses verified preloaded immutable artifact → $HARNESS_IMAGE"
      docker image inspect "$HARNESS_IMAGE_EXPECTED_ID" >/dev/null \
        || { echo "FATAL: expected preloaded Harness image is absent: $HARNESS_IMAGE_EXPECTED_ID"; exit 1; }
      actual_id=$(docker image inspect "$HARNESS_IMAGE_EXPECTED_ID" --format '{{.Id}}')
      [ "$actual_id" = "$HARNESS_IMAGE_EXPECTED_ID" ] \
        || { echo "FATAL: preloaded Harness image ID drift: $actual_id≠$HARNESS_IMAGE_EXPECTED_ID"; exit 1; }
      docker tag "$HARNESS_IMAGE_EXPECTED_ID" "$HARNESS_DEPLOY_IMAGE"
    else
      echo "[pull] $s → $HARNESS_IMAGE"
      docker pull "$HARNESS_IMAGE" >/dev/null
    fi
    printf '  %s:\n    image: %s\n' "$s" "$HARNESS_DEPLOY_IMAGE" >> "$OVERRIDE.tmp"
    continue
  fi
  TAG="hivemind/${IMG[$s]}:sha-$SHORT"
  # rollback: retag the currently-live image of this service
  CUR=$(docker inspect "${CONTAINER[$s]}" --format '{{.Config.Image}}' 2>/dev/null || true)
  if [ -n "$CUR" ]; then docker tag "$CUR" "hivemind/${IMG[$s]}:rollback" && ROLLBACK[$s]="$CUR"; fi
  echo "[build] $s → $TAG"
  "$PRESENCE" heartbeat --session "$RELEASE_SESSION_ID" --phase "building:$s"
  ( cd "$REL" && build_cmd "$s" "$TAG" ) >/dev/null
  printf '  %s:\n    image: %s\n' "$s" "$TAG" >> "$OVERRIDE.tmp"
done
mv "$OVERRIDE.tmp" "$OVERRIDE"

# Database migrations are a pre-deploy gate for Core, not an implicit startup
# side effect. Run the guarded migrator from the newly built immutable image
# before replacing the healthy container. If it fails, set -e aborts here and
# production remains on the previous Core image.
if [ -n "${REQUESTED[core]:-}" ]; then
  CORE_TAG="hivemind/${IMG[core]}:sha-$SHORT"
  if [ "$SKIP_MIGRATIONS" = 1 ]; then
    LIVE_CORE_SHA=$(docker inspect "${CONTAINER[core]}" --format '{{ index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
    [ -n "$LIVE_CORE_SHA" ] || { echo "FATAL: cannot prove the live Core revision for --skip-migrations"; exit 1; }
    git -C "$REL" cat-file -e "$LIVE_CORE_SHA^{commit}" 2>/dev/null \
      || { echo "FATAL: live Core revision $LIVE_CORE_SHA is unavailable for schema comparison"; exit 1; }
    git -C "$REL" diff --quiet "$LIVE_CORE_SHA" "$FULLSHA" -- core/prisma \
      || { echo "FATAL: core/prisma changed since live Core $LIVE_CORE_SHA; migrations cannot be skipped"; exit 1; }
    echo "[migrate] skipped after proving core/prisma unchanged since live Core ${LIVE_CORE_SHA:0:12}"
  else
    echo "[migrate] guarded Prisma deploy via $CORE_TAG"
    "$PRESENCE" heartbeat --session "$RELEASE_SESSION_ID" --phase migrating:core
    # The Compose project name differs between environments (for example,
    # `enigma_default` versus `hivemind_default`).  Derive the live Core's
    # attached network instead of assuming a production-only network name.
    MIGRATION_NETWORK_ID=$(docker inspect "${CONTAINER[core]}" \
      --format '{{range .NetworkSettings.Networks}}{{println .NetworkID}}{{end}}' 2>/dev/null | head -n 1)
    MIGRATION_NETWORK=$(docker network inspect "$MIGRATION_NETWORK_ID" --format '{{.Name}}' 2>/dev/null || true)
    [ -n "$MIGRATION_NETWORK" ] || {
      echo "FATAL: cannot resolve the live Core Docker network for migrations"
      exit 1
    }
    # Docker's --env-file does not evaluate Compose interpolation.  Core's
    # Compose service derives DATABASE_URL from the Postgres credentials, so
    # reproduce that derivation inside the immutable migration container rather
    # than requiring a duplicate DATABASE_URL secret in the host env file.
    docker run --rm \
      --network "$MIGRATION_NETWORK" \
      --env-file "$ENVF" \
      "$CORE_TAG" sh -ec '
        : "${POSTGRES_USER:=hivemind_user}"
        : "${POSTGRES_DB:=hivemind}"
        : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required for migrations}"
        export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=hivemind&connection_limit=20&pool_timeout=30"
        exec node scripts/prisma-migrate-deploy.mjs
      '
  fi
fi

# A runner recreation must not interrupt an active user turn. The live runner
# exposes an authenticated, process-local count; require two consecutive idle
# observations to close the race with a just-admitted turn. The one-time legacy
# bootstrap flag exists only for upgrading a runner that predates this endpoint.
if [ -n "${REQUESTED[harness-runner]:-}" ]; then
  echo "[drain] waiting for active Harness turns"
  HARNESS_DRAIN_SECRET=$(awk -F= '$1 == "HIVE_HARNESS_RUNNER_SERVICE_SECRET" { print substr($0, length($1) + 2); exit }' "$ENVF")
  [ -n "$HARNESS_DRAIN_SECRET" ] || { echo "FATAL: Harness drain secret unavailable"; exit 1; }
  idle_observations=0
  drain_deadline=$((SECONDS + ${HARNESS_DRAIN_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$drain_deadline" ]; do
    response=$(curl -sS --max-time 5 -w '\n%{http_code}' \
      -H "Authorization: Bearer $HARNESS_DRAIN_SECRET" \
      http://127.0.0.1:${HIVE_HARNESS_PORT:-3080}/api/hivemind/runner-drain-status || true)
    status=${response##*$'\n'}
    body=${response%$'\n'*}
    if [ "$status" = 404 ] && [ "${HARNESS_DRAIN_LEGACY_BOOTSTRAP:-0}" = 1 ]; then
      echo "[drain] legacy runner has no drain endpoint; one-time bootstrap override accepted"
      idle_observations=2
      break
    fi
    [ "$status" = 200 ] || { sleep 2; continue; }
    active=$(node -e 'const v=JSON.parse(process.argv[1]); if(!Number.isInteger(v.active_turns)) process.exit(2); process.stdout.write(String(v.active_turns))' "$body") \
      || { echo "FATAL: invalid Harness drain response"; exit 1; }
    if [ "$active" = 0 ]; then idle_observations=$((idle_observations + 1)); else idle_observations=0; fi
    [ "$idle_observations" -ge 2 ] && break
    sleep 2
  done
  unset HARNESS_DRAIN_SECRET response body
  [ "$idle_observations" -ge 2 ] || { echo "FATAL: Harness still has active turns after drain timeout"; exit 1; }
  echo "[drain] runner is quiescent"
fi

# ── deploy named hetzner services (--no-deps, override pins the sha image) ──
for s in "${SVCS[@]}"; do
  echo "[deploy] $s"
  "$PRESENCE" heartbeat --session "$RELEASE_SESSION_ID" --phase "deploying:$s"
  docker compose --project-name "$COMPOSE_PROJECT" --profile harness-chat --project-directory "$REL/infra" -f "$HETZNER" -f "$OVERRIDE" \
    --env-file "$ENVF" up -d --no-deps --force-recreate "$s" >/dev/null
  if [ "$s" = harness-runner ]; then
    # The tunnel is a profile-bound companion: it is never deployed without
    # the runner and has no independent image or persistence lifecycle.
    echo "[deploy] harness-tunnel"
    "$PRESENCE" heartbeat --session "$RELEASE_SESSION_ID" --phase deploying:harness-tunnel
    docker compose --project-name "$COMPOSE_PROJECT" --profile harness-chat --project-directory "$REL/infra" -f "$HETZNER" -f "$OVERRIDE" \
      --env-file "$ENVF" up -d --no-deps --force-recreate harness-tunnel >/dev/null
  fi
done

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
  if [ "$s" = harness-runner ]; then
    live_image=$(docker inspect "$c" --format '{{.Config.Image}}' 2>/dev/null || true)
    [ "$live_image" = "$HARNESS_DEPLOY_IMAGE" ] || { ok="$ok ✗ image=$live_image≠requested-artifact"; FAIL=1; }
    tunnel_status=$(docker inspect "${CONTAINER[harness-tunnel]}" --format '{{.State.Status}}' 2>/dev/null || echo missing)
    [ "$tunnel_status" = running ] || { ok="$ok ✗ tunnel=$tunnel_status"; FAIL=1; }
    echo "[verify] $s $c → $st  image=$live_image  $ok"
    continue
  fi
  [ "$rev" = "$SHA" ] || { ok="$ok ✗ label=$rev≠$SHA"; FAIL=1; }
  echo "[verify] $s $c → $st  rev=${rev:0:12}  $ok"
done
if [ "$SKIP_CANARY" = 0 ] && [ -n "$CANARY_URL" ]; then
  code=""; for i in $(seq 1 12); do code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$CANARY_URL" || true); case "$code" in 2*|3*|401|403) break;; esac; sleep 3; done
  echo "[canary] $CANARY_URL → $code"; case "$code" in 2*|3*|401|403);; *) FAIL=1;; esac
fi
VERIFY_SERVICES=()
for s in "${SVCS[@]}"; do
  [ "$s" = harness-runner ] || VERIFY_SERVICES+=("$s")
done
if [ "${#VERIFY_SERVICES[@]}" -gt 0 ]; then
  "$REL/scripts/verify-deployed.sh" --sha "$SHA" --services "$(IFS=,; echo "${VERIFY_SERVICES[*]}")" --source-root "$REL" || FAIL=1
fi

# ── manifest ───────────────────────────────────────────────────────────────
{
  echo "{"; echo "  \"sha\": \"$SHA\","; echo "  \"short\": \"$SHORT\","; echo "  \"ts\": \"$TS\","
  echo "  \"services\": \"$SERVICES\","; [ -z "$HARNESS_IMAGE" ] || echo "  \"harness_image\": \"$HARNESS_IMAGE\","; [ -z "$HARNESS_IMAGE_EXPECTED_ID" ] || echo "  \"harness_image_id\": \"$HARNESS_IMAGE_EXPECTED_ID\","; echo "  \"worktree\": \"$REL\","
  echo -n "  \"rollback\": {"; first=1; for s in "${!ROLLBACK[@]}"; do [ $first = 1 ] || echo -n ","; first=0; echo -n "\"$s\":\"${ROLLBACK[$s]}\""; done; echo "},"
  echo "  \"result\": \"$([ $FAIL = 0 ] && echo ok || echo FAILED)\""; echo "}"
} > "$MANIFEST"
echo "[manifest] $MANIFEST"
if [ "$FAIL" = 0 ]; then
  "$PRESENCE" complete --session "$RELEASE_SESSION_ID" --result ok --summary "release verified"
  trap - EXIT
  echo "RELEASE OK — $SHORT"
else
  echo "RELEASE FAILED — rollback: hivemind/<img>:rollback"
  exit 1
fi
