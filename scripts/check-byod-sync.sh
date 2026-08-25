#!/usr/bin/env bash
#
# check-byod-sync.sh — verify the published `byod` setup branch is an EXACT mirror
# of the byod/ directory on the main line.
#
# Why: fresh self-host installs run `git clone --branch byod … && ./setup.sh`, which
# builds the agent from `agent/server.mjs` ON THE byod BRANCH. If that branch drifts
# from byod/, a fresh install ships a stale/broken agent (this is exactly how the
# 322-line agent — missing the provenance-preservation fix — almost shipped).
#
# Builds the expected tree through scripts/stage-byod-bundle.sh, then compares it
# to every tracked file in the published ref. Extra published files are drift.
#
# Usage: scripts/check-byod-sync.sh [SRC_REF] [PUB_REF]
#   SRC_REF  ref whose byod/ subtree is the source of truth (default: HEAD)
#   PUB_REF  the published setup branch ref          (default: origin/byod)
set -euo pipefail

SRC_REF="${1:-HEAD}"
PUB_REF="${2:-origin/byod}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
git fetch -q origin byod 2>/dev/null || true

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/source" "$TMP/expected" "$TMP/published"
git archive "$SRC_REF" byod scripts/stage-byod-bundle.sh \
  scripts/storage-manifest.mjs scripts/storage-restore-drill.sh \
  | tar -x -C "$TMP/source"
git archive "$PUB_REF" | tar -x -C "$TMP/published"
"$TMP/source/scripts/stage-byod-bundle.sh" "$TMP/source" "$TMP/expected"

# Archive extraction contains tracked files only. rsync's itemized dry run checks
# content, type, executable mode, missing files, and unexpected published files.
drift="$(rsync -ainc --delete "$TMP/expected/" "$TMP/published/")"

if [ -z "$drift" ]; then
  count="$(find "$TMP/expected" -type f | wc -l)"
  echo "✅ byod setup branch in sync with staged bundle ($count files)"
  exit 0
fi

echo "❌ byod setup branch DRIFTED from the staged bundle — a fresh self-host install would be stale."
echo "--- rsync itemized changes required to make $PUB_REF match ---"
printf '%s\n' "$drift"
echo ""
echo "Fix: run  scripts/publish-byod.sh  (or: make publish-byod)"
exit 1
