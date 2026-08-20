#!/usr/bin/env bash
# pull-icarus.sh — bring ICARUS development FROM the public repo INTO this monorepo's mneme/.
#
# This is the direction that makes the public repository canonical (HARNESS_V1_PLAN.md,
# Phase 0). ICARUS development happens at github.com/amar3012005/ICARUS; the monorepo
# CONSUMES it. sync-icarus.sh (the outbound direction) still exists for engine changes
# that originate here, but it now aborts rather than overwriting public edits — so this
# script is how you clear that abort.
#
# What it does NOT do, deliberately:
#   - It never touches anything outside mneme/. HIVEMIND's own code is not in scope.
#   - It never deletes monorepo-only files under mneme/ unless --prune is passed, because
#     a file missing upstream is ambiguous: it may be genuinely deleted upstream, or it
#     may be monorepo-only by design. Ambiguity gets reported, not guessed.
#   - It never commits. You review `git diff` and commit yourself. A script that
#     auto-commits an inbound sync is how unreviewed upstream changes reach production.
#
# USAGE
#   scripts/pull-icarus.sh                 # report what would change (default: dry run)
#   scripts/pull-icarus.sh --apply         # actually copy public -> mneme/
#   scripts/pull-icarus.sh --apply --prune # also delete mneme/ files absent upstream
#   ICARUS_DIR=/path/to/clone scripts/pull-icarus.sh --apply
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MNEME_DIR="$REPO_ROOT/mneme"
ICARUS_DIR="${ICARUS_DIR:-$HOME/ICARUS}"
ICARUS_URL="https://github.com/amar3012005/ICARUS.git"

APPLY=""
PRUNE=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY="1" ;;
    --prune) PRUNE="1" ;;
    *) echo "FATAL: unknown argument '$arg'"; exit 2 ;;
  esac
done

[ -d "$MNEME_DIR" ] || { echo "FATAL: no mneme/ at $MNEME_DIR"; exit 1; }

# Deliberately NOT using `mapfile`/`readarray` anywhere below: those are bash 4+, and stock
# macOS still ships bash 3.2 at /bin/bash, so `#!/usr/bin/env bash` resolves to 3.2 on any
# machine without a newer bash earlier in PATH. Plain while-read loops work on both.

# ── 1. get a clean, current public clone ─────────────────────────────────────────
if [ -d "$ICARUS_DIR/.git" ]; then
  git -C "$ICARUS_DIR" fetch origin --quiet
  if ! git -C "$ICARUS_DIR" diff --quiet || ! git -C "$ICARUS_DIR" diff --cached --quiet; then
    echo "ABORT: $ICARUS_DIR has uncommitted changes — pulling from a dirty clone would"
    echo "       import work that is not actually published. Commit or stash there first."
    git -C "$ICARUS_DIR" status --short | head -20
    exit 1
  fi
  git -C "$ICARUS_DIR" checkout --quiet main
  git -C "$ICARUS_DIR" merge --ff-only --quiet origin/main
else
  git clone --quiet "$ICARUS_URL" "$ICARUS_DIR"
fi
PUBLIC_SHA="$(git -C "$ICARUS_DIR" rev-parse --short HEAD)"
echo "[icarus-pull] public ICARUS at $PUBLIC_SHA"

# ── 2. compute the change set (tracked public files only) ────────────────────────
CHANGED=0
ADDED=0
while IFS= read -r f; do
  src="$ICARUS_DIR/$f"
  dst="$MNEME_DIR/$f"
  if [ ! -f "$dst" ]; then
    echo "  + $f"
    ADDED=$((ADDED + 1))
    [ -n "$APPLY" ] && { mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; }
  elif ! cmp -s "$src" "$dst"; then
    echo "  M $f"
    CHANGED=$((CHANGED + 1))
    [ -n "$APPLY" ] && cp "$src" "$dst"
  fi
done < <(git -C "$ICARUS_DIR" ls-files)

# ── 3. report monorepo-only files (never silently delete) ────────────────────────
ONLY_LOCAL=0
while IFS= read -r rel; do
  f="${rel#mneme/}"
  if [ ! -f "$ICARUS_DIR/$f" ]; then
    echo "  ! monorepo-only (absent upstream): $f"
    ONLY_LOCAL=$((ONLY_LOCAL + 1))
    if [ -n "$APPLY" ] && [ -n "$PRUNE" ]; then
      rm -f "$MNEME_DIR/$f"
      echo "    pruned"
    fi
  fi
done < <(git -C "$REPO_ROOT" ls-files mneme)

echo "[icarus-pull] $ADDED added, $CHANGED modified, $ONLY_LOCAL monorepo-only"
if [ -z "$APPLY" ]; then
  echo "[icarus-pull] DRY RUN — nothing written. Re-run with --apply to copy public -> mneme/."
  exit 0
fi
if [ "$ONLY_LOCAL" -gt 0 ] && [ -z "$PRUNE" ]; then
  echo "[icarus-pull] NOTE: monorepo-only files were left in place. Use --prune to delete them"
  echo "              (only after confirming they were genuinely removed upstream, not just never published)."
fi
echo "[icarus-pull] applied. Review with: git -C $REPO_ROOT diff -- mneme/   then commit yourself."
