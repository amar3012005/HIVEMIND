#!/usr/bin/env bash
# preflight-deploy.sh — refuse to build or deploy anything that is not a clean,
# named commit. Source or call this FIRST from every deploy path.
#
# Why this exists: on 2026-08-01 production was found running code that existed in
# no committed branch anywhere. The driver.js md5 inside hm-core matched the DIRTY
# working tree of /root/hivemind-main (on codex/tara-grok, 46 uncommitted files)
# and did not match origin/singulance-main, which was itself 7 commits ahead of
# what was live. The running build was unreproducible — cleaning that tree would
# have destroyed the only copy of what was serving traffic.
#
# One check would have prevented all of it, so it is now a hard gate.
#
# Usage:
#   scripts/preflight-deploy.sh                  # build tree, default ref
#   TREE=/root/hivemind-main scripts/preflight-deploy.sh
#   ALLOW_DIRTY=1 ... scripts/preflight-deploy.sh # explicit, logged, emergencies only
#
# Prints the SHA to stdout on success so callers can tag the image by it:
#   SHA=$(scripts/preflight-deploy.sh) || exit 1
#   docker build -t "hivemind/core-api:sha-${SHA}" .

set -euo pipefail

TREE="${TREE:-/root/hivemind-main}"
DEPLOY_REF="${DEPLOY_REF:-singulance-main}"

cd "$TREE"

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

# ── 1. The tree must be clean ────────────────────────────────────────────────
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$DIRTY" != "0" ]; then
  if [ "${ALLOW_DIRTY:-}" = "1" ]; then
    echo "PREFLIGHT WARN: $DIRTY uncommitted path(s) — ALLOW_DIRTY=1 set." >&2
    echo "PREFLIGHT WARN: this build is NOT reproducible. Record why:" >&2
    git status --porcelain | head -20 >&2
  else
    echo "PREFLIGHT FAIL: $DIRTY uncommitted path(s) in $TREE." >&2
    git status --porcelain | head -20 >&2
    fail "commit or stash first. A working-tree build cannot be reproduced or rolled back to."
  fi
fi

# ── 2. We must be ON the deployable ref, not a feature branch ────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "$DEPLOY_REF" ]; then
  if [ "${ALLOW_BRANCH:-}" = "1" ]; then
    echo "PREFLIGHT WARN: on '$BRANCH', not '$DEPLOY_REF' — ALLOW_BRANCH=1 set." >&2
  else
    fail "on '$BRANCH'; only '$DEPLOY_REF' is deployable. Merge via PR, then deploy."
  fi
fi

# ── 3. The ref must not be behind its remote ─────────────────────────────────
git fetch origin "$DEPLOY_REF" --quiet 2>/dev/null || true
BEHIND="$(git rev-list --count "HEAD..origin/${DEPLOY_REF}" 2>/dev/null || echo 0)"
if [ "$BEHIND" != "0" ]; then
  fail "$BEHIND commit(s) behind origin/$DEPLOY_REF — pull first, or you ship a regression."
fi

# ── 4. Emit the SHA so the image can be tagged by it ─────────────────────────
SHA="$(git rev-parse --short=9 HEAD)"
echo "PREFLIGHT OK: $TREE @ $BRANCH clean, up to date with origin/$DEPLOY_REF" >&2
echo "PREFLIGHT: tag the image hivemind/<svc>:sha-${SHA}" >&2
echo "$SHA"
