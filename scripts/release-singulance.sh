#!/usr/bin/env bash
# ONE-COMMAND SINGULANCE RELEASE — codifies RELEASING.md + the Production Release Protocol.
# Run ON the singulance box:  bash scripts/release-singulance.sh <parent-sha> [services...]
#   services: any of core control-plane employees tara-deepgram fe (default: fe)
# Does: descendant-of-canon check → clean detached worktree → rollback tags →
# build ONLY named services (others retag from running release) → env VERSION bump
# (backed up) → recreate one-at-a-time with health gates → acceptance smoke.
# It does NOT: push git, apply migrations (run those consciously first), or ff canon
# (do that after YOU accept). Fails loudly at the first broken gate.
set -euo pipefail

# Every production release entry point uses the same host-wide lock. This
# prevents concurrent sessions from moving Compose pins or mutable aliases.
RELEASE_LOCK=/run/lock/singulance-production-release.lock
exec 9>"$RELEASE_LOCK"
flock -n 9 || { echo "FATAL: another SINGULANCE production release is active"; exit 1; }

SHA="${1:?usage: release-singulance.sh <parent-sha> [services...]}"; shift || true
SERVICES=("${@:-fe}")
RID="prod-$(date +%Y%m%d)-${SHA:0:12}"
REPO=/root/hivemind-main ENV=/root/hivemind/.env NEXTENV=/root/hivemind-next/.env.embedding-canary-runtime
cd "$REPO"; git fetch origin --quiet
git fetch origin +refs/heads/singulance-main:refs/remotes/origin/singulance-main --quiet
# Gate 1 — no stale-branch releases: the commit must descend from canon.
git merge-base --is-ancestor origin/singulance-main "$SHA" \
  || { echo "FATAL: $SHA is not a descendant of singulance-main — rebase first (RELEASING.md rule 4)"; exit 1; }
OLD=$(grep -m1 '^VERSION=' "$ENV" | cut -d= -f2)
echo "== release $RID (previous: $OLD) services: ${SERVICES[*]}"
# Gate 2 — clean detached worktree at the exact commit.
git worktree add --detach "/root/builds/$RID" "$SHA"
cd "/root/builds/$RID"; git submodule update --init frontend/Da-vinci
[ -z "$(git status --short)" ] || { echo "FATAL: build worktree dirty"; exit 1; }
[ "$(git rev-parse HEAD)" = "$SHA" ] || { echo "FATAL: build SHA drifted"; exit 1; }
[ -z "$(git -C frontend/Da-vinci status --short)" ] || { echo "FATAL: frontend submodule dirty"; exit 1; }
# Rollback tags for everything currently pinned.
TS=$(date +%Y%m%d-%H%M%S)
for img in employees control-plane core-api tara-deepgram; do
  docker tag "hivemind/$img:$OLD" "hivemind/$img:rollback-$TS" 2>/dev/null || true; done
docker tag "hivemind/fe:$OLD-single" "hivemind/fe:rollback-$TS-single" 2>/dev/null || true
echo "rollback tags: rollback-$TS"
# Preserve exactly one conventional rollback alias for each service being
# replaced. Immutable rollback-$TS remains useful for this release's audit.
tag_running_as_stable() {
  local container="$1" target="$2" image_id
  image_id=$(docker inspect "$container" --format '{{.Image}}')
  docker tag "$image_id" "$target"
}
for s in "${SERVICES[@]}"; do case "$s" in
  core)          tag_running_as_stable hm-core hivemind/core-api:stable ;;
  control-plane) tag_running_as_stable hm-control hivemind/control-plane:stable ;;
  employees)     tag_running_as_stable hm-employees hivemind/employees:stable ;;
  tara-deepgram) tag_running_as_stable tara-deepgram hivemind/tara-deepgram:stable ;;
  fe)            tag_running_as_stable hivemind-next-frontend-1 hivemind/fe:stable ;;
esac; done
# Build only what changed; retag the rest under the new RID.
for s in "${SERVICES[@]}"; do case "$s" in
  core)          docker build -t "hivemind/core-api:$RID" -f Dockerfile.production . ;;
  control-plane) docker build -t "hivemind/control-plane:$RID" -f Dockerfile.control-plane . ;;
  employees)     docker build -t "hivemind/employees:$RID" ./employees-service ;;
  tara-deepgram) docker build -t "hivemind/tara-deepgram:$RID" ./services/tara-deepgram ;;
  fe)            docker build -t "hivemind/fe:$RID-single" ./frontend/Da-vinci ;;
  *) echo "unknown service $s"; exit 1 ;;
esac; done
for img in employees control-plane core-api tara-deepgram byod-broker hm-playwright; do
  docker image inspect "hivemind/$img:$RID" >/dev/null 2>&1 || docker tag "hivemind/$img:$OLD" "hivemind/$img:$RID" 2>/dev/null || true; done
docker image inspect "hivemind/fe:$RID-single" >/dev/null 2>&1 || docker tag "hivemind/fe:$OLD-single" "hivemind/fe:$RID-single"
# Compose is the runtime source of truth. Pin only the selected service image,
# under the shared release lock, before its named --no-deps recreation.
RUNTIME_COMPOSE=/root/hivemind/infra/docker-compose.hetzner.yml
cp "$RUNTIME_COMPOSE" "$RUNTIME_COMPOSE.bak-$RID"
pin_runtime_image() {
  local service="$1" image="$2"
  sed -i "/^  ${service}:/,/^  [a-zA-Z0-9_-]*:/ s|^    image:.*|    image: ${image}|" "$RUNTIME_COMPOSE"
  grep -A3 "^  ${service}:" "$RUNTIME_COMPOSE" | grep -Fq "image: ${image}" \
    || { echo "FATAL: failed to pin ${service} to ${image}"; exit 1; }
}
for s in "${SERVICES[@]}"; do case "$s" in
  core)          pin_runtime_image core "hivemind/core-api:$RID" ;;
  control-plane) pin_runtime_image control-plane "hivemind/control-plane:$RID" ;;
  employees)     pin_runtime_image employees "hivemind/employees:$RID" ;;
esac; done

# Env bump (backed up) + one-at-a-time recreates with health gates.
cp "$ENV" "$ENV.bak-$RID"; cp "$NEXTENV" "$NEXTENV.bak-$RID"
sed -i "s/^VERSION=.*/VERSION=$RID/" "$ENV"; sed -i "s/^NEXT_VERSION=.*/NEXT_VERSION=$RID/" "$NEXTENV"
recreate() { # svc composefile project envfile container profile
  docker compose ${6:+--profile $6} ${2:+-f $2} ${3:+-p $3} --env-file "$4" config -q
  docker compose ${6:+--profile $6} ${2:+-f $2} ${3:+-p $3} --env-file "$4" up -d --no-deps --force-recreate "$1" >/dev/null
  for i in $(seq 1 45); do S=$(docker inspect "$5" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null); [ "$S" = healthy ] && break; sleep 4; done
  echo "$1 → ${S:-unknown}"; [ "${S:-}" = healthy ] || { echo "FATAL: $1 unhealthy — restore $ENV.bak-$RID + rollback-$TS"; exit 1; }
}
cd /root/hivemind
for s in "${SERVICES[@]}"; do case "$s" in
  core)          recreate core infra/docker-compose.hetzner.yml "" "$ENV" hm-core ;;
  control-plane) recreate control-plane infra/docker-compose.hetzner.yml "" "$ENV" hm-control ;;
  employees)     recreate employees infra/docker-compose.hetzner.yml "" "$ENV" hm-employees ;;
  tara-deepgram) recreate tara-deepgram infra/docker-compose.hetzner.yml "" "$ENV" tara-deepgram ;;
  fe) cd /root/hivemind-next
      docker compose -p hivemind-next -f infra/docker-compose.next.yml --env-file "$NEXTENV" --profile single config -q
      docker compose -p hivemind-next -f infra/docker-compose.next.yml --env-file "$NEXTENV" --profile single up -d --no-deps --force-recreate frontend >/dev/null
      sleep 4; docker ps --format '{{.Image}}' | grep -q "fe:$RID-single" && echo "frontend → running $RID" || { echo FATAL: frontend not on $RID; exit 1; }
      cd /root/hivemind ;;
esac; done
# Mutable discovery aliases move only after all named-service health gates pass.
for s in "${SERVICES[@]}"; do case "$s" in
  core)          docker tag "hivemind/core-api:$RID" hivemind/core-api:current; docker tag "hivemind/core-api:$RID" hivemind/core-api:latest ;;
  control-plane) docker tag "hivemind/control-plane:$RID" hivemind/control-plane:current; docker tag "hivemind/control-plane:$RID" hivemind/control-plane:latest ;;
  employees)     docker tag "hivemind/employees:$RID" hivemind/employees:current; docker tag "hivemind/employees:$RID" hivemind/employees:latest ;;
  tara-deepgram) docker tag "hivemind/tara-deepgram:$RID" hivemind/tara-deepgram:current; docker tag "hivemind/tara-deepgram:$RID" hivemind/tara-deepgram:latest ;;
  fe)            docker tag "hivemind/fe:$RID-single" hivemind/fe:current; docker tag "hivemind/fe:$RID-single" hivemind/fe:latest ;;
esac; done
# Acceptance smoke.
for u in https://singulancelabs.com https://next.singulancelabs.com/hivemind https://api.singulancelabs.com/health https://core.singulancelabs.com/health; do
  C=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$u"); echo "$u → $C"; [ "$C" = 200 ] || { echo "FATAL: public check failed"; exit 1; }; done
git -C "$REPO" worktree remove --force "/root/builds/$RID"; git -C "$REPO" worktree prune
echo "== $RID PROMOTED. Now: exercise the changed feature, then fast-forward singulance-main (both repos) and append PRODUCTION_RELEASE.md."
