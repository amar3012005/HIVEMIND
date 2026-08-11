#!/usr/bin/env bash
# Back up the .amr files (the hivemind-data volume). In dual mode .amr is rebuildable from Postgres,
# but in sole/BYOD mode it is the SOLE COPY — schedule this. Atomic: copies under the running flock is
# fine (mmap reads are consistent; we tar the whole dir). Keeps the last N archives.
#   ./infra/backup-amr.sh [dest_dir] [keep]
#   cron: 17 3 * * *  /opt/HIVEMIND/infra/backup-amr.sh /opt/HIVEMIND/backups 14
set -euo pipefail

DEST="${1:-/opt/HIVEMIND/backups}"
KEEP="${2:-14}"
VOL="${MNEME_VOLUME:-hivemind_hivemind-data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/amr-$STAMP.tgz"

mkdir -p "$DEST"
docker run --rm -v "$VOL":/data:ro -v "$DEST":/out alpine \
  tar czf "/out/$(basename "$OUT")" -C /data ./mneme 2>/dev/null || \
  docker run --rm -v "$VOL":/data:ro -v "$DEST":/out alpine tar czf "/out/$(basename "$OUT")" -C /data .

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup-amr] wrote $OUT ($SIZE)"

# prune: keep newest $KEEP
ls -1t "$DEST"/amr-*.tgz 2>/dev/null | tail -n +"$((KEEP+1))" | while read -r old; do
  rm -f "$old" && echo "[backup-amr] pruned $old"
done

# integrity: archive must be a readable gzip
gzip -t "$OUT" && echo "[backup-amr] ✅ integrity OK" || { echo "[backup-amr] ❌ CORRUPT archive"; exit 1; }
