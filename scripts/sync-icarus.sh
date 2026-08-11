#!/usr/bin/env bash
# sync-icarus.sh — publish the mneme/ engine from this monorepo to the OPEN-SOURCE
# ICARUS repo (https://github.com/amar3012005/ICARUS.git).
#
# WHY THIS EXISTS
#   mneme/ (the .amr engine: Rust core + Node binding) lives inside HIVEMIND, but is
#   open-sourced as ICARUS. ICARUS keeps its OWN curated history — it is NOT a subtree
#   mirror, so we publish snapshot-sync commits rather than replaying monorepo history.
#   Replaying history would also risk publishing anything a past monorepo commit held.
#
# SAFETY (this script refuses to publish rather than leak)
#   1. Syncs ONLY git-TRACKED files under mneme/ — never build artifacts, never
#      untracked local junk (target/, node_modules, *.node binaries, scratch files).
#   2. Runs a secret + internal-reference scan and ABORTS on any hit (keys, .env/.pem,
#      internal hostnames, org UUIDs, infra paths).
#   3. Never force-pushes. Never rewrites ICARUS history.
#
# USAGE
#   scripts/sync-icarus.sh              # scan + stage + show the diff, DO NOT push
#   scripts/sync-icarus.sh --push       # same, then commit + push to ICARUS main
#   ICARUS_DIR=/path/to/clone scripts/sync-icarus.sh --push
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MNEME_DIR="$REPO_ROOT/mneme"
ICARUS_DIR="${ICARUS_DIR:-$HOME/ICARUS}"
ICARUS_URL="https://github.com/amar3012005/ICARUS.git"
DO_PUSH="${1:-}"

[ -d "$MNEME_DIR" ] || { echo "FATAL: no mneme/ at $MNEME_DIR"; exit 1; }

# ── 1. secret / internal-reference gate ──────────────────────────────────────────
echo "[icarus-sync] scanning mneme/ before publish..."
SECRET_RE='(hmk_live_|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xoxb-|ghp_[a-zA-Z0-9]{30,})'
INTERNAL_RE='(singulancelabs\.com|davinciai|hm-core|hm-postgres|/root/hivemind|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
# Reviewed allowlist — INTERNAL_RE only (the secret check below is absolute and applies
# to every file). These bench harnesses document, in comments, that they were run inside
# the production container; the container name is not a credential and these files were
# already public before this script existed. Reviewed 2026-08-05.
ALLOW_RE='mneme/bench/(shadow_qdrant_search\.cjs|shadow_scroll\.js|shadow_mneme\.cjs|shadow_compare\.cjs)'
HITS="$(grep -rInE "$SECRET_RE|$INTERNAL_RE" "$MNEME_DIR" 2>/dev/null \
        | grep -vE '\.lock:|example|placeholder|YOUR_|<your|dummy' \
        | grep -vE "$ALLOW_RE" || true)"
# Secrets are NEVER allowlisted — re-check every file, ignoring ALLOW_RE.
SECRET_HITS="$(grep -rInE "$SECRET_RE" "$MNEME_DIR" 2>/dev/null | grep -vE 'example|placeholder|YOUR_|<your|dummy' || true)"
if [ -n "$SECRET_HITS" ]; then
  echo "ABORT: credential-shaped string in mneme/ — refusing to publish:"; echo "$SECRET_HITS" | head -10; exit 1
fi
if [ -n "$HITS" ]; then
  echo "ABORT: secret / internal reference found in mneme/ — refusing to publish:"
  echo "$HITS" | head -20
  exit 1
fi
CREDS="$(find "$MNEME_DIR" -type f \( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name 'credentials*' \) 2>/dev/null || true)"
if [ -n "$CREDS" ]; then echo "ABORT: credential file(s) under mneme/:"; echo "$CREDS"; exit 1; fi
echo "[icarus-sync] scan clean."

# ── 2. working clone of ICARUS ───────────────────────────────────────────────────
if [ -d "$ICARUS_DIR/.git" ]; then
  git -C "$ICARUS_DIR" fetch origin --quiet
  git -C "$ICARUS_DIR" checkout --quiet main
  git -C "$ICARUS_DIR" reset --hard --quiet origin/main
else
  git clone --quiet "$ICARUS_URL" "$ICARUS_DIR"
fi

# ── 3. copy TRACKED files only ───────────────────────────────────────────────────
COUNT=0
while IFS= read -r rel; do
  f="${rel#mneme/}"
  mkdir -p "$ICARUS_DIR/$(dirname "$f")"
  cp "$REPO_ROOT/$rel" "$ICARUS_DIR/$f"
  COUNT=$((COUNT + 1))
done < <(git -C "$REPO_ROOT" ls-files mneme)
echo "[icarus-sync] synced $COUNT tracked file(s) from mneme/ (source SHA $(git -C "$REPO_ROOT" rev-parse --short HEAD))"

# ── 4. stage + report ────────────────────────────────────────────────────────────
git -C "$ICARUS_DIR" add -A
if git -C "$ICARUS_DIR" diff --cached --quiet; then
  echo "[icarus-sync] ICARUS already up to date — nothing to publish."
  exit 0
fi
git -C "$ICARUS_DIR" diff --cached --stat | tail -20

if [ "$DO_PUSH" != "--push" ]; then
  echo "[icarus-sync] DRY RUN — staged in $ICARUS_DIR but NOT pushed. Re-run with --push to publish."
  exit 0
fi

# ── 5. publish (never force) ─────────────────────────────────────────────────────
git -C "$ICARUS_DIR" commit -q -m "sync: engine update from monorepo $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$ICARUS_DIR" push origin main
echo "[icarus-sync] published: $(git -C "$ICARUS_DIR" rev-parse --short HEAD) -> ICARUS main"
