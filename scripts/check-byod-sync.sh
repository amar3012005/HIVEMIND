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
# Compares git blob hashes (content-addressed → exact), so it is robust to line
# endings / binary files (the .node addons). Exit 0 if in sync, 1 on drift.
#
# Usage: scripts/check-byod-sync.sh [SRC_REF] [PUB_REF]
#   SRC_REF  ref whose byod/ subtree is the source of truth (default: HEAD)
#   PUB_REF  the published setup branch ref          (default: origin/byod)
set -euo pipefail

SRC_REF="${1:-HEAD}"
PUB_REF="${2:-origin/byod}"

cd "$(git rev-parse --show-toplevel)"
git fetch -q origin byod 2>/dev/null || true

# Manifest = "<blobhash> <relpath>" per file, sorted. For the source we strip the
# leading "byod/" so paths line up with the branch root.
src="$(git ls-tree -r "$SRC_REF" -- byod/ | awk '{ p=$4; sub(/^byod\//,"",p); print $3, p }' | sort)"
pub="$(git ls-tree -r "$PUB_REF"          | awk '{ print $3, $4 }' | sort)"

if [ "$src" = "$pub" ]; then
  echo "✅ byod setup branch in sync with byod/ ($(printf '%s\n' "$src" | grep -c . ) files)"
  exit 0
fi

echo "❌ byod setup branch DRIFTED from byod/ — a fresh self-host install would ship a stale agent."
echo "--- < byod/ (source of truth)   > $PUB_REF (published) ---"
diff <(printf '%s\n' "$src") <(printf '%s\n' "$pub") || true
echo ""
echo "Fix: run  scripts/publish-byod.sh  (or: make publish-byod)"
exit 1
