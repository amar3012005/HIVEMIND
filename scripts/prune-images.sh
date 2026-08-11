#!/usr/bin/env bash
# Image retention cron. Deploys on this box tag every build (prod-<date>-<sha>, sha-<sha>,
# rollback-<timestamp>) and NOTHING deletes the old ones — 2026-08-06 the disk went from 93GB
# free to 11GB free in under an hour from a single session's build loop, twice in one day.
# This runs hourly and keeps disk bounded without ever touching a tag a rollback might need.
#
# KEEP, unconditionally, for every repo:
#   - any image ID currently backing a running container (checked by ID, never by tag — a
#     tag can be stale on an image that is still the one running; matching by name once
#     already almost deleted a live core-api image in this session)
#   - :stable :rollback :latest :current  (explicit, human-meaningful anchors)
#   - the exact tag recorded in each .last-*-rollback pointer file — those are the ONE
#     schema-verified promise this repo makes about "what do I roll back to"
#   - the newest KEEP_N tags per repo by creation time (below), so a same-day rollback two
#     or three deploys back still has its image
#
# Everything else: deleted. Then dangling layers + build cache are pruned.
#
# Cron (hourly, offset from the existing :05 backup jobs):
#   35 * * * * /root/hivemind/scripts/prune-images.sh >> /root/hivemind/logs/prune-images.log 2>&1
set -uo pipefail   # NOT -e: one repo/tag failing to inspect must not abort the whole run

KEEP_N="${PRUNE_KEEP_N:-5}"
REPOS=(hivemind/core-api hivemind/control-plane hivemind/employees hivemind/fe hivemind/tara-deepgram hivemind/tara-grok)
ROLLBACK_FILES=(/root/hivemind/.last-core-rollback /root/hivemind/.last-control-rollback /root/hivemind/.last-next-fe-rollback)
PINNED_TAGS='^(stable|rollback|latest|current)$'

echo "=== prune-images $(date -u +%FT%TZ) (keep last $KEEP_N per repo) ==="

# Running image IDs — the one check that must never be wrong. Matched by ID (docker inspect),
# not by name/tag, so a tag pointing at a still-running image is protected even if the tag
# itself looks like a stale build.
RUNNING_IDS="$(docker ps --format '{{.Image}}' | xargs -I{} docker inspect {} --format '{{.Id}}' 2>/dev/null | sort -u)"

# Rollback-pointer targets: the tag substrings recorded in .last-*-rollback. A substring match
# (grep -F) rather than equality because the pointer file sometimes holds the bare sha/date
# fragment rather than the full `repo:tag`.
ROLLBACK_TARGETS=""
for f in "${ROLLBACK_FILES[@]}"; do
  [ -f "$f" ] && ROLLBACK_TARGETS="$ROLLBACK_TARGETS $(cat "$f" 2>/dev/null)"
done

TOTAL_DELETED=0
TOTAL_KEPT=0

for repo in "${REPOS[@]}"; do
  # Newest-first by creation time so KEEP_N means "the N most recent", not an arbitrary N.
  mapfile -t TAGS < <(docker images "$repo" --format '{{.CreatedAt}}|{{.Tag}}' 2>/dev/null | sort -r | cut -d'|' -f2)
  [ "${#TAGS[@]}" -eq 0 ] && continue

  kept_count=0
  for tag in "${TAGS[@]}"; do
    full="$repo:$tag"
    imgid="$(docker inspect "$full" --format '{{.Id}}' 2>/dev/null)"
    [ -z "$imgid" ] && continue   # already gone (e.g. shared tag removed by an earlier iteration)

    is_running=no
    echo "$RUNNING_IDS" | grep -qx "$imgid" && is_running=yes

    is_pinned=no
    echo "$tag" | grep -qE "$PINNED_TAGS" && is_pinned=yes

    is_target=no
    if [ -n "$ROLLBACK_TARGETS" ]; then
      for rt in $ROLLBACK_TARGETS; do
        echo "$tag" | grep -qF "$rt" && is_target=yes
      done
    fi

    is_recent=no
    [ "$kept_count" -lt "$KEEP_N" ] && is_recent=yes

    if [ "$is_running" = yes ] || [ "$is_pinned" = yes ] || [ "$is_target" = yes ] || [ "$is_recent" = yes ]; then
      kept_count=$((kept_count + 1))
      TOTAL_KEPT=$((TOTAL_KEPT + 1))
      continue
    fi

    # Re-verify by ID immediately before deleting — running containers change between the
    # snapshot above and this line on a box with concurrent deploys.
    still_running="$(docker ps --format '{{.Image}}' | xargs -I{} docker inspect {} --format '{{.Id}}' 2>/dev/null | grep -qx "$imgid" && echo yes || echo no)"
    if [ "$still_running" = yes ]; then
      echo "  SKIP (started running since snapshot): $full"
      TOTAL_KEPT=$((TOTAL_KEPT + 1))
      continue
    fi

    if docker rmi "$full" >/dev/null 2>&1; then
      echo "  deleted: $full"
      TOTAL_DELETED=$((TOTAL_DELETED + 1))
    fi
    # A failed rmi (still referenced elsewhere) is not an error worth aborting the run for —
    # move on, it will be re-evaluated next hour.
  done
done

echo "kept=$TOTAL_KEPT deleted=$TOTAL_DELETED"

docker image prune -f >/dev/null 2>&1
docker builder prune -f --filter until=24h >/dev/null 2>&1

df -h / | tail -1
echo "=== end $(date -u +%FT%TZ) ==="
