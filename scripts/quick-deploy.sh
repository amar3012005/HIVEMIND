#!/usr/bin/env bash
# quick-deploy.sh — fast single-branch deploy. Run ON the singulance box.
#
#   bash scripts/quick-deploy.sh [branch]      # default: hivemind-main
#
# Model (per operator request, replaces the heavy immutable-release dance):
#   • ONE live branch. Box pulls it (push from your laptop, pull here) and hard-
#     resets the deploy checkout to origin — live is ALWAYS latest, no merge
#     conflicts, no worktrees, no per-SHA tags.
#   • Exactly ONE rollback per service: the image that was live is retagged
#     `:stable` right before it's replaced. `:stable` is SAVED, never run as a
#     second container. Each deploy overwrites it, so you always keep precisely
#     the last-known-good — nothing accumulates.
#   • Live containers always run `:latest`. Only services whose files changed
#     since the last deploy are rebuilt; the rest are untouched.
#   • Pending DB migrations (new folders since last deploy) are backed up then
#     applied (idempotent SQL) before recreate.
#
# Rollback (one command):  bash scripts/quick-deploy.sh --rollback <service...>
set -euo pipefail

REPO=/root/hivemind-next
ENV=/root/hivemind/.env
NEXTENV=/root/hivemind-next/.env.embedding-canary-runtime
HETZNER=infra/docker-compose.hetzner.yml
NEXT=infra/docker-compose.next.yml

# container + build recipe per service
declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [tara-deepgram]=tara-deepgram [fe]=hivemind-next-frontend-1 )
build_one() { case "$1" in
  core)          docker build -t "hivemind/core-api:latest" -f Dockerfile.production . ;;
  control-plane) docker build -t "hivemind/control-plane:latest" -f Dockerfile.control-plane . ;;
  employees)     docker build -t "hivemind/employees:latest" ./employees-service ;;
  tara-deepgram) docker build -t "hivemind/tara-deepgram:latest" ./services/tara-deepgram ;;
  fe)            docker build -t "hivemind/fe:latest-single" ./frontend/Da-vinci ;;
esac; }
img_of() { case "$1" in
  core) echo core-api;; control-plane) echo control-plane;; employees) echo employees;;
  tara-deepgram) echo tara-deepgram;; fe) echo fe;; esac; }
recreate_one() { case "$1" in
  fe)  cd "$REPO"; docker compose -p hivemind-next -f "$NEXT" --env-file "$NEXTENV" --profile single up -d --no-deps --force-recreate frontend >/dev/null ;;
  *)   cd /root/hivemind; docker compose -f "$REPO/$HETZNER" --env-file "$ENV" up -d --no-deps --force-recreate "$1" >/dev/null ;;
esac; }
health_gate() { local c="$1"; for i in $(seq 1 45); do
  s=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
  [ "$s" = healthy ] || [ "$s" = running ] && { echo "  $c → $s"; return 0; }; sleep 4; done
  echo "  FATAL: $c never became healthy ($s)"; return 1; }

# ── rollback path ──────────────────────────────────────────────────────────
if [ "${1:-}" = "--rollback" ]; then
  shift; [ $# -gt 0 ] || { echo "usage: quick-deploy.sh --rollback <service...>"; exit 1; }
  for s in "$@"; do i=$(img_of "$s"); tag=$([ "$s" = fe ] && echo "latest-single" || echo latest); stag=$([ "$s" = fe ] && echo "stable-single" || echo stable)
    docker image inspect "hivemind/$i:$stag" >/dev/null 2>&1 || { echo "no :stable for $i — cannot roll back"; exit 1; }
    docker tag "hivemind/$i:$stag" "hivemind/$i:$tag"; recreate_one "$s"; health_gate "${CONTAINER[$s]}"
    echo "rolled $s back to :$stag"; done
  exit 0
fi

# ── deploy path ────────────────────────────────────────────────────────────
BRANCH="${1:-singulance-main}"
cd "$REPO"
PREV=$(git rev-parse HEAD)
git fetch origin "$BRANCH" -q
git checkout -q "$BRANCH" 2>/dev/null || git checkout -qb "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH" -q            # live = latest, always clean
git submodule update --init frontend/Da-vinci -q
NOW=$(git rev-parse HEAD)
if [ "$PREV" = "$NOW" ]; then echo "already at $(git rev-parse --short HEAD) — nothing to deploy"; exit 0; fi
echo "== deploy $(git rev-parse --short $PREV) → $(git rev-parse --short $NOW) on $BRANCH"

# which services changed
chg() { ! git diff --quiet "$PREV" "$NOW" -- "$@"; }
SVCS=()
chg core/src/control-plane-server.js core/src/outreach core/src/security core/src/billing && SVCS+=(control-plane)
chg core/src core/prisma && SVCS+=(core)
chg employees-service && SVCS+=(employees)
chg services/tara-aaas services/tara-deepgram && SVCS+=(tara-deepgram)
chg frontend/Da-vinci && SVCS+=(fe)
# de-dup
SVCS=($(printf '%s\n' "${SVCS[@]}" | awk '!seen[$0]++'))
[ ${#SVCS[@]} -gt 0 ] || { echo "no service dirs changed — nothing to rebuild"; exit 0; }
echo "changed services: ${SVCS[*]}"

# Pin live to the moving :latest tag once (compose reads ${VERSION}/${NEXT_VERSION}).
# After this, every deploy just rebuilds :latest and recreates — no env churn.
grep -q '^VERSION=latest$' "$ENV" || { cp "$ENV" "$ENV.bak-quickdeploy"; sed -i 's/^VERSION=.*/VERSION=latest/' "$ENV"; echo "pinned VERSION=latest"; }
grep -q '^NEXT_VERSION=latest$' "$NEXTENV" || { cp "$NEXTENV" "$NEXTENV.bak-quickdeploy"; sed -i 's/^NEXT_VERSION=.*/NEXT_VERSION=latest/' "$NEXTENV"; echo "pinned NEXT_VERSION=latest"; }

# pending migrations (new folders since PREV) → backup + apply idempotent SQL
NEWMIG=$(git diff --name-only --diff-filter=A "$PREV" "$NOW" -- core/prisma/migrations | sed -nE 's#core/prisma/migrations/([^/]+)/migration.sql#\1#p')
if [ -n "$NEWMIG" ]; then
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  echo "== new migrations: $NEWMIG — backing up first"
  docker exec hm-postgres pg_dump -U hivemind_user -d hivemind -Fc -f /tmp/bk.dump
  docker cp hm-postgres:/tmp/bk.dump "/root/backups/hivemind/pre-$(git rev-parse --short $NOW)-$TS.dump"; docker exec hm-postgres rm -f /tmp/bk.dump
  for m in $NEWMIG; do echo "  apply $m"; docker exec -i hm-postgres psql -U hivemind_user -d hivemind -v ON_ERROR_STOP=1 < "$REPO/core/prisma/migrations/$m/migration.sql"; done
fi

# build → save ONE stable rollback (the outgoing live image) → run :latest
for s in "${SVCS[@]}"; do
  i=$(img_of "$s"); tag=$([ "$s" = fe ] && echo "latest-single" || echo latest); stag=$([ "$s" = fe ] && echo "stable-single" || echo stable)
  echo "== $s: save current :$tag → :$stag (rollback), build new :$tag"
  docker image inspect "hivemind/$i:$tag" >/dev/null 2>&1 && docker tag "hivemind/$i:$tag" "hivemind/$i:$stag" || echo "  (no prior :$tag — first deploy, no rollback saved)"
  build_one "$s"
  recreate_one "$s"; health_gate "${CONTAINER[$s]}" || { echo "FATAL — roll back with: quick-deploy.sh --rollback $s"; exit 1; }
done

# public smoke
for u in https://singulancelabs.com https://next.singulancelabs.com/hivemind https://api.singulancelabs.com/health https://core.singulancelabs.com/health; do
  c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$u"); echo "$u → $c"; done
# Keep the box lean: drop build cache + images no longer referenced by a
# container or a kept tag (:latest/:stable/running stay — they're referenced).
docker builder prune -af >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
echo "== deployed $(git rev-parse --short $NOW). free: $(df -h / | awk 'NR==2{print $4}'). rollback: quick-deploy.sh --rollback <svc>"
