#!/usr/bin/env bash
# quick-deploy.sh — fast single-branch deploy. Run ON the singulance box.
#
#   bash scripts/quick-deploy.sh [branch]      # default: singulance-main
#
# Model (per operator request, replaces the heavy immutable-release dance):
#   • ONE live branch. Box pulls it (push from your laptop, pull here) and hard-
#     resets the deploy checkout to FETCH_HEAD — live is ALWAYS latest, no merge
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

# Exactly one production release may mutate images/containers at a time.
exec 9>/run/lock/singulance-quick-deploy.lock
flock -n 9 || { echo "another SINGULANCE deployment is already running"; exit 1; }

REPO=/root/hivemind-next
ENV=/root/hivemind/.env
NEXTENV=/root/hivemind-next/.env.embedding-canary-runtime
HETZNER=infra/docker-compose.hetzner.yml
NEXT=infra/docker-compose.next.yml

# container + build recipe per service
declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [tara-deepgram]=tara-deepgram [fe]=hivemind-next-frontend-1 )
build_one() { case "$1" in
  core)          docker build --label "org.opencontainers.image.revision=$NOW" -t "hivemind/core-api:latest" -f Dockerfile.production . ;;
  control-plane) docker build --label "org.opencontainers.image.revision=$NOW" -t "hivemind/control-plane:latest" -f Dockerfile.control-plane . ;;
  employees)     docker build --label "org.opencontainers.image.revision=$NOW" -t "hivemind/employees:latest" ./employees-service ;;
  tara-deepgram) docker build --label "org.opencontainers.image.revision=$NOW" -t "hivemind/tara-deepgram:latest" ./services/tara-deepgram ;;
  fe)            docker build --label "org.opencontainers.image.revision=$NOW" -t "hivemind/fe:latest-single" ./frontend/Da-vinci ;;
esac; }
img_of() { case "$1" in
  core) echo core-api;; control-plane) echo control-plane;; employees) echo employees;;
  tara-deepgram) echo tara-deepgram;; fe) echo fe;; esac; }
recreate_one() { case "$1" in
  fe)  cd /root/hivemind-next; docker compose -p hivemind-next -f "$NEXT" --env-file "$NEXTENV" --profile single up -d --no-deps --force-recreate frontend >/dev/null ;;
  *)   cd /root/hivemind;      docker compose -f "$HETZNER" --env-file "$ENV" up -d --no-deps --force-recreate "$1" >/dev/null ;;
esac; }
health_gate() { local c="$1"; for i in $(seq 1 45); do
  s=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
  [ "$s" = healthy ] || [ "$s" = running ] && { echo "  $c → $s"; return 0; }; sleep 4; done
  echo "  FATAL: $c never became healthy ($s)"; return 1; }
smoke_url() {
  local u="$1" c=""
  for i in $(seq 1 12); do
    c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$u" || true)
    case "$c" in 2*|3*|401|403) echo "$u → $c"; return 0;; esac
    sleep 3
  done
  echo "$u → $c"
  return 1
}

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
LASTSHA=/root/.quickdeploy-last-sha
cd "$REPO"
# Last SUCCESSFULLY-DEPLOYED sha (not the box's current branch HEAD — the deploy
# checkout may sit on an unrelated/dirty branch from another session). Empty on
# the very first run → rebuild everything.
PREV=$(cat "$LASTSHA" 2>/dev/null || true)
git -c submodule.recurse=false -c fetch.recurseSubmodules=false fetch origin "$BRANCH" -q
# Reset to FETCH_HEAD, NOT origin/$BRANCH: this box's remote-tracking ref lags
# (fetch updates FETCH_HEAD but not refs/remotes/origin/$BRANCH), which silently
# rebuilt ancient code. FETCH_HEAD is always the tip we just fetched. -f discards
# any local drift so live == canonical ("no overwrites").
git checkout -qf -B "$BRANCH" FETCH_HEAD
git -c submodule.recurse=false submodule update --init --force -q frontend/Da-vinci
NOW=$(git rev-parse HEAD)
if [ -n "$PREV" ] && [ "$PREV" = "$NOW" ]; then echo "already at $(git rev-parse --short HEAD) — nothing to deploy"; exit 0; fi
echo "== deploy ${PREV:0:8}${PREV:+ → }$(git rev-parse --short $NOW) on $BRANCH"

# which services changed since last deploy. If PREV is empty/unknown (first run
# or the marker was lost), rebuild ALL — safe, just slower.
if [ -z "$PREV" ] || ! git cat-file -e "$PREV^{commit}" 2>/dev/null; then
  echo "no valid last-deploy marker → rebuilding all services"
  SVCS=(control-plane core employees tara-deepgram fe)
else
  chg() { ! git diff --quiet "$PREV" "$NOW" -- "$@"; }
  SVCS=()
  chg Dockerfile.control-plane core/package.json core/package-lock.json core/prisma core/config core/src/control-plane-server.js core/src/outreach core/src/security core/src/billing && SVCS+=(control-plane)
  chg Dockerfile.production core/package.json core/package-lock.json core/prisma core/config core/scripts core/src extensions && SVCS+=(core)
  chg employees-service && SVCS+=(employees)
  chg services/tara-aaas services/tara-deepgram && SVCS+=(tara-deepgram)
  chg frontend/Da-vinci frontend/Da-vinci/Dockerfile frontend/Da-vinci/package.json frontend/Da-vinci/package-lock.json && SVCS+=(fe)
fi
# de-dup
SVCS=($(printf '%s\n' "${SVCS[@]}" | awk '!seen[$0]++'))
[ ${#SVCS[@]} -gt 0 ] || { echo "no service dirs changed — nothing to rebuild"; exit 0; }
echo "changed services: ${SVCS[*]}"

# Pin live to the moving :latest tag once (compose reads ${VERSION}/${NEXT_VERSION}).
# After this, every deploy just rebuilds :latest and recreates — no env churn.
grep -q '^VERSION=latest$' "$ENV" || { cp "$ENV" "$ENV.bak-quickdeploy"; sed -i 's/^VERSION=.*/VERSION=latest/' "$ENV"; echo "pinned VERSION=latest"; }
grep -q '^NEXT_VERSION=latest$' "$NEXTENV" || { cp "$NEXTENV" "$NEXTENV.bak-quickdeploy"; sed -i 's/^NEXT_VERSION=.*/NEXT_VERSION=latest/' "$NEXTENV"; echo "pinned NEXT_VERSION=latest"; }

# pending migrations (new folders since PREV) → backup + apply idempotent SQL
# Only diff migrations when we have a valid PREV; a rebuild-all (empty PREV)
# means the box is already at/ahead of these migrations — don't re-diff from ''.
if [ -n "$PREV" ] && git cat-file -e "$PREV^{commit}" 2>/dev/null; then
  NEWMIG=$(git diff --name-only --diff-filter=A "$PREV" "$NOW" -- core/prisma/migrations | sed -nE 's#core/prisma/migrations/([^/]+)/migration.sql#\1#p')
else
  NEWMIG=""
fi
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
  cd "$REPO"            # build context must be the worktree
  build_one "$s"
  built_revision=$(docker image inspect "hivemind/$i:$tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [ "$built_revision" = "$NOW" ] || { echo "FATAL: $s image revision $built_revision != fetched $NOW"; exit 1; }
  echo "  image revision verified: ${built_revision:0:12}"
  recreate_one "$s"; health_gate "${CONTAINER[$s]}" || { echo "FATAL — roll back with: quick-deploy.sh --rollback $s"; exit 1; }
done

# public smoke
for u in https://singulancelabs.com https://next.singulancelabs.com/hivemind https://api.singulancelabs.com/health https://core.singulancelabs.com/health; do
  smoke_url "$u"
done
# Cache and image cleanup is deliberately excluded from deployment. It is a
# separately scheduled maintenance concern; releases must keep warm layers and
# must never delete rollback material.
echo "$NOW" > "$LASTSHA"   # record what's now live for the next deploy's diff
echo "== deployed $(git rev-parse --short $NOW). free: $(df -h / | awk 'NR==2{print $4}'). rollback: quick-deploy.sh --rollback <svc>"
