#!/usr/bin/env bash
# Build the exact customer-facing BYOD branch tree from a monorepo checkout.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 REPOSITORY_ROOT DESTINATION" >&2
  exit 64
fi

SOURCE_ROOT="$(cd "$1" && pwd)"
DESTINATION="$2"

if [ ! -d "$SOURCE_ROOT/byod" ]; then
  echo "Missing BYOD source directory: $SOURCE_ROOT/byod" >&2
  exit 66
fi
for helper in storage-manifest.mjs storage-restore-drill.sh; do
  if [ ! -f "$SOURCE_ROOT/scripts/$helper" ]; then
    echo "Missing generated bundle helper: $SOURCE_ROOT/scripts/$helper" >&2
    exit 66
  fi
done

mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd)"
if [ "$DESTINATION" = "/" ] || [ "$DESTINATION" = "$SOURCE_ROOT" ]; then
  echo "Refusing unsafe staging destination: $DESTINATION" >&2
  exit 64
fi

# --delete makes this a complete bundle contract: removed source files and any
# unexpected destination files disappear from staging rather than being hidden.
rsync -a --delete "$SOURCE_ROOT/byod/" "$DESTINATION/"
install -m 0755 "$SOURCE_ROOT/scripts/storage-manifest.mjs" \
  "$DESTINATION/storage-manifest.mjs"
install -m 0755 "$SOURCE_ROOT/scripts/storage-restore-drill.sh" \
  "$DESTINATION/storage-restore-drill.sh"
