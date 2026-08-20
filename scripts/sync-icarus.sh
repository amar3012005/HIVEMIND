#!/usr/bin/env bash
# sync-icarus.sh — publish the mneme/ engine from this monorepo to the OPEN-SOURCE
# ICARUS repo (https://github.com/amar3012005/ICARUS.git).
#
# ── AUTHORITY MODEL (changed in Phase 0 of HARNESS_V1_PLAN.md) ──────────────────
#   The PUBLIC repo (github.com/amar3012005/ICARUS) is now CANONICAL for ICARUS
#   development. This script is no longer the source-authority mechanism; it is a
#   guarded publish path for engine changes that still originate in the monorepo.
#
#   What changed, and why (each fixes a REAL observed data-loss event):
#     1. NO MORE `reset --hard origin/main`. That discarded uncommitted work in the
#        public clone every run. Now: fetch + fast-forward only, and abort if the
#        public clone is dirty (the operator decides, not the script).
#     2. NO MORE blanket `git add -A`. That swept unrelated PUBLIC-ONLY files into
#        sync commits — it really happened: a local-only DEV_NOTES/ folder got
#        committed and pushed because `add -A` staged it after the copy replaced
#        .gitignore with the monorepo's version. Now only the exact paths this
#        script copied are staged, by explicit pathspec.
#     3. DIVERGENCE DETECTION. Every publish writes .icarus-sync-state.json (a
#        sha256 per published file). On the next run, a file whose PUBLIC content no
#        longer matches the recorded digest was edited in public — real upstream
#        work. Overwriting it silently is exactly the authority bug Phase 0 exists
#        to kill, so the script ABORTS and tells the operator to pull public first
#        (scripts/pull-icarus.sh). --force-monorepo overrides, deliberately loudly.
#
#   The secret/internal-reference scanner below is PRESERVED verbatim in intent: it
#   remains a mandatory pre-publish security gate.
#
# USAGE
#   scripts/sync-icarus.sh                    # scan + stage + show diff, DO NOT push
#   scripts/sync-icarus.sh --push             # same, then commit + push to ICARUS main
#   scripts/sync-icarus.sh --push --force-monorepo   # overwrite diverged public files
#   ICARUS_DIR=/path/to/clone scripts/sync-icarus.sh --push
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MNEME_DIR="$REPO_ROOT/mneme"
ICARUS_DIR="${ICARUS_DIR:-$HOME/ICARUS}"
ICARUS_URL="https://github.com/amar3012005/ICARUS.git"
STATE_FILE_NAME=".icarus-sync-state.json"

DO_PUSH=""
FORCE_MONOREPO=""
for arg in "$@"; do
  case "$arg" in
    --push) DO_PUSH="1" ;;
    --force-monorepo) FORCE_MONOREPO="1" ;;
    *) echo "FATAL: unknown argument '$arg'"; exit 2 ;;
  esac
done

[ -d "$MNEME_DIR" ] || { echo "FATAL: no mneme/ at $MNEME_DIR"; exit 1; }

# Portable sha256: macOS ships `shasum`, most Linux distros ship `sha256sum`, and CI runs
# on both. Also deliberately avoiding `mapfile`/`readarray` below — those are bash 4+, and
# stock macOS still ships bash 3.2 at /bin/bash.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "FATAL: neither shasum nor sha256sum available" >&2; exit 1; fi
}

# ── 1. secret / internal-reference gate (PRESERVED — mandatory security check) ────
echo "[icarus-sync] scanning mneme/ before publish..."
SECRET_RE='(hmk_live_|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xoxb-|ghp_[a-zA-Z0-9]{30,})'
INTERNAL_RE='(singulancelabs\.com|davinciai|hm-core|hm-postgres|/root/hivemind|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
# Reviewed allowlist — INTERNAL_RE only (the secret check below is absolute and applies
# to every file). These bench harnesses document, in comments, that they were run inside
# the production container; the container name is not a credential and these files were
# already public before this script existed. Reviewed 2026-08-05.
#
# mneme-cli.js/cli-lib.js/install.sh: `api.singulancelabs.com` is a DELIBERATE, explicitly
# user-approved default HIVEMIND server (the real, live-verified host exposing /auth/cli/start —
# confirmed by direct curl: 400 with no params, 302 to the branded login page with valid ones;
# core.singulancelabs.com is a DIFFERENT service and 404s on this route, do not confuse the two)
# — not an accidental leak. Reviewed + approved 2026-08-19: ICARUS defaults to it so `icarus
# connect` needs zero typing for the common case ("just like claude does it"), same reasoning as
# any CLI shipping a default endpoint, still fully overridable via HIVEMIND_URL/--api-url.
#
# HARNESS_V1_PLAN.md / DEV_NOTES: the harness roadmap names HIVE-MIND as the optional
# organizational-authority component by design (it is the documented product architecture,
# reviewed 2026-08-20), and DEV_NOTES/ is local-only and never published by this script.
ALLOW_RE='mneme/bench/(shadow_qdrant_search\.cjs|shadow_scroll\.js|shadow_mneme\.cjs|shadow_compare\.cjs)|mneme/crate/mneme-node/(mneme-cli|cli-lib)\.js|mneme/install\.sh|mneme/HARNESS_V1_PLAN\.md|mneme/DEV_NOTES/'

# Scan EXACTLY the set of files this script will publish — i.e. git-tracked files under
# mneme/ — not the whole directory tree.
#
# The tree-wide `grep -r "$MNEME_DIR"` this replaces was a real, recurring false-positive
# generator: it walked crate/mneme-node/node_modules/, where jose/ carries the literal
# string "-----BEGIN PRIVATE KEY-----" in a type check and sql.js/ embeds a large base64
# blob that trips the `sk-` heuristic. Neither is ever published (step 4 copies tracked
# files only), so the abort was always spurious — and the workaround became "temporarily
# move node_modules aside before every sync", a manual step that is itself a hazard (forget
# to move it back and the next `napi build` silently reinstalls). Scanning the real publish
# set is both correct and faster.
TRACKED_LIST="$(mktemp)"
trap 'rm -f "$TRACKED_LIST"' EXIT
git -C "$REPO_ROOT" ls-files -z mneme > "$TRACKED_LIST"

scan_tracked() { # scan_tracked <regex>
  # -I skips binary files; -z/--null-data pairing keeps paths with spaces intact.
  xargs -0 -a "$TRACKED_LIST" grep -InE "$1" /dev/null 2>/dev/null || true
}

# Secrets are NEVER allowlisted — checked first, across every published file.
SECRET_HITS="$(scan_tracked "$SECRET_RE" | grep -vE 'example|placeholder|YOUR_|<your|dummy' || true)"
if [ -n "$SECRET_HITS" ]; then
  echo "ABORT: credential-shaped string in a published file — refusing to publish:"; echo "$SECRET_HITS" | head -10; exit 1
fi
HITS="$(scan_tracked "$SECRET_RE|$INTERNAL_RE" \
        | grep -vE '\.lock:|example|placeholder|YOUR_|<your|dummy' \
        | grep -vE "$ALLOW_RE" || true)"
if [ -n "$HITS" ]; then
  echo "ABORT: secret / internal reference in a published file — refusing to publish:"
  echo "$HITS" | head -20
  exit 1
fi
# Credential FILES: also restricted to the tracked publish set, same reasoning.
CREDS="$(git -C "$REPO_ROOT" ls-files mneme \
         | grep -E '(^|/)\.env|\.pem$|\.key$|(^|/)credentials' || true)"
if [ -n "$CREDS" ]; then echo "ABORT: credential file(s) tracked under mneme/:"; echo "$CREDS"; exit 1; fi
echo "[icarus-sync] scan clean ($(tr -cd '\0' < "$TRACKED_LIST" | wc -c | tr -d ' ') tracked files scanned)."

# ── 2. working clone of ICARUS — fast-forward only, never destructive ────────────
if [ -d "$ICARUS_DIR/.git" ]; then
  git -C "$ICARUS_DIR" fetch origin --quiet
  # A dirty public clone can mean somebody has real work in flight; the old script's
  # `reset --hard` silently destroyed exactly that. But the guard has to be PRECISE, or it
  # blocks its own normal workflow — a plain dry run stages files by design, which made a
  # naive "any dirt aborts" check reject the very next `--push` (observed in testing), and
  # would also abort for anyone merely keeping local untracked notes in their clone.
  #
  # So: abort only on modified/deleted TRACKED files that this sync would NOT itself touch.
  #   - Files inside the publish set: already protected by the digest divergence check below,
  #     which compares working-tree content and so catches uncommitted public edits too.
  #   - Untracked files: never overwritten (step 5 stages by explicit pathspec), so harmless.
  # The state file itself is script-managed, not upstream work — a previous dry run legitimately
  # leaves it staged, so it belongs in the managed set alongside the published paths.
  PUBLISH_SET="$(git -C "$REPO_ROOT" ls-files mneme | sed 's|^mneme/||'; echo "$STATE_FILE_NAME")"
  FOREIGN_DIRT="$(git -C "$ICARUS_DIR" status --porcelain --untracked-files=no \
    | awk '{ $1=""; sub(/^ +/, ""); print }' \
    | grep -vxF "$PUBLISH_SET" || true)"
  if [ -n "$FOREIGN_DIRT" ]; then
    echo "ABORT: $ICARUS_DIR has uncommitted changes to files this sync does not manage."
    echo "       Commit, stash, or discard them yourself — this script will not decide that for"
    echo "       you (it used to, via reset --hard, and lost real work)."
    echo "$FOREIGN_DIRT" | sed 's/^/  /' | head -20
    exit 1
  fi
  git -C "$ICARUS_DIR" checkout --quiet main
  # --ff-only: if public main has diverged from what we can fast-forward to, that is real
  # upstream history and must be integrated deliberately, not steamrolled.
  if ! git -C "$ICARUS_DIR" merge --ff-only --quiet origin/main 2>/dev/null; then
    echo "ABORT: local main in $ICARUS_DIR cannot fast-forward to origin/main."
    echo "       Public history diverged — reconcile it explicitly, then re-run."
    exit 1
  fi
else
  git clone --quiet "$ICARUS_URL" "$ICARUS_DIR"
fi

# ── 3. divergence check against the last published digests ──────────────────────
# Any file whose PUBLIC content differs from the digest recorded at last publish was
# edited in the public repo. That is canonical upstream work now (see AUTHORITY MODEL
# above) — publishing over it is the exact bug Phase 0 removes.
STATE_PATH="$ICARUS_DIR/$STATE_FILE_NAME"
# One python invocation, not one per file: with ~165 tracked files, a per-file `python3 -c`
# meant 165 interpreter startups (~10s of pure overhead) AND interpolated shell variables
# straight into python source, which breaks on any path containing a quote. Paths go through
# argv here instead, and the whole comparison happens in-process.
DIVERGED=""
if [ -f "$STATE_PATH" ]; then
  # The tracked-file list is passed as a FILE PATH in argv, never piped on stdin: `python3 -`
  # reads its own program text from stdin, so a heredoc-supplied script and a piped data
  # stream cannot coexist. Doing both silently consumed the heredoc as the script, left
  # sys.stdin empty (so the check found nothing while appearing to run), and killed the
  # upstream `git ls-files` with SIGPIPE — caught by a real divergence test that should have
  # aborted and instead exited 141 with an empty result.
  CLASSIFIED="$(python3 - "$STATE_PATH" "$ICARUS_DIR" "$REPO_ROOT" "$TRACKED_LIST" <<'PYEOF'
import hashlib, json, os, sys

state_path, icarus_dir, repo_root, list_path = sys.argv[1:5]
try:
    with open(state_path) as fh:
        recorded = json.load(fh).get('files', {})
except Exception:
    recorded = {}

def digest(path):
    try:
        with open(path, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None

with open(list_path, 'rb') as fh:
    entries = [p.decode('utf-8', 'surrogateescape') for p in fh.read().split(b'\0') if p]

for rel in entries:
    f = rel[len('mneme/'):] if rel.startswith('mneme/') else rel
    was = recorded.get(f)
    if not was:
        continue                        # never published before — nothing to compare against
    pub = digest(os.path.join(icarus_dir, f))
    if pub is None or pub == was:
        continue                        # public unchanged since last publish
    mono = digest(os.path.join(repo_root, rel))
    if mono is None:
        continue
    if mono == was:
        # ONLY the public side moved. The public repo is canonical, so this edit is newer and
        # authoritative — emit it as KEEP so step 4 skips it instead of copying over it.
        print('KEEP\t' + f)
    elif mono != pub:
        # Both sides moved to different content — a real conflict a human must resolve.
        print('CONFLICT\t' + f)
PYEOF
)"
  DIVERGED="$(printf '%s\n' "$CLASSIFIED" | sed -n 's/^CONFLICT\t//p')"
  KEEP_PUBLIC="$(printf '%s\n' "$CLASSIFIED" | sed -n 's/^KEEP\t//p')"
  if [ -n "$KEEP_PUBLIC" ]; then
    echo "[icarus-sync] keeping PUBLIC version (edited upstream, unchanged here):"
    echo "$KEEP_PUBLIC" | sed 's/^/    /'
  fi
fi
if [ -n "$DIVERGED" ] && [ -z "$FORCE_MONOREPO" ]; then
  echo "ABORT: these files changed in BOTH the public repo and this monorepo:"
  echo "$DIVERGED" | sed 's/^/  /'
  echo "       The public repo is canonical (HARNESS_V1_PLAN.md Phase 0). Pull public first:"
  echo "         scripts/pull-icarus.sh --apply"
  echo "       Or, to deliberately overwrite the public edits: --force-monorepo"
  exit 1
fi

# ── 4. copy TRACKED files only, and remember exactly which paths we touched ──────
# Files classified KEEP above (edited in public, unchanged here) are SKIPPED, not copied:
# the public repo is canonical, so overwriting an upstream-only edit would be the exact
# authority bug this phase removes. Their PUBLIC content is what gets digested below, so
# the state file records reality rather than what we would have written.
COUNT=0
SKIPPED=0
COPIED_PATHS=()
while IFS= read -r rel; do
  f="${rel#mneme/}"
  if [ -n "${KEEP_PUBLIC:-}" ] && printf '%s\n' "$KEEP_PUBLIC" | grep -qxF "$f"; then
    COPIED_PATHS+=("$f")   # still digested + staged, just not overwritten
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  mkdir -p "$ICARUS_DIR/$(dirname "$f")"
  cp "$REPO_ROOT/$rel" "$ICARUS_DIR/$f"
  COPIED_PATHS+=("$f")
  COUNT=$((COUNT + 1))
done < <(git -C "$REPO_ROOT" ls-files mneme)
echo "[icarus-sync] synced $COUNT tracked file(s) from mneme/ (source SHA $(git -C "$REPO_ROOT" rev-parse --short HEAD))${SKIPPED:+, kept $SKIPPED public-side edit(s)}"

# Record the digests we are about to publish, so the NEXT run can detect public edits.
python3 - "$STATE_PATH" "$(git -C "$REPO_ROOT" rev-parse HEAD)" "${COPIED_PATHS[@]}" <<'PYEOF'
import hashlib, json, os, sys
state_path, source_sha, *paths = sys.argv[1:]
root = os.path.dirname(state_path)
files = {}
for rel in paths:
    p = os.path.join(root, rel)
    if os.path.isfile(p):
        with open(p, 'rb') as fh:
            files[rel] = hashlib.sha256(fh.read()).hexdigest()
with open(state_path, 'w') as fh:
    json.dump({
        'note': 'Digests of files published by scripts/sync-icarus.sh. Used to detect public-side edits. Do not hand-edit.',
        'source_monorepo_sha': source_sha,
        'files': files,
    }, fh, indent=2, sort_keys=True)
    fh.write('\n')
PYEOF
COPIED_PATHS+=("$STATE_FILE_NAME")

# ── 5. stage ONLY what we copied (never `add -A`) ────────────────────────────────
git -C "$ICARUS_DIR" add -- "${COPIED_PATHS[@]}"
if git -C "$ICARUS_DIR" diff --cached --quiet; then
  echo "[icarus-sync] ICARUS already up to date — nothing to publish."
  exit 0
fi
git -C "$ICARUS_DIR" diff --cached --stat | tail -20

if [ -z "$DO_PUSH" ]; then
  echo "[icarus-sync] DRY RUN — staged in $ICARUS_DIR but NOT pushed. Re-run with --push to publish."
  exit 0
fi

# ── 6. publish (never force) ─────────────────────────────────────────────────────
git -C "$ICARUS_DIR" commit -q -m "sync: engine update from monorepo $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$ICARUS_DIR" push origin main
echo "[icarus-sync] published: $(git -C "$ICARUS_DIR" rev-parse --short HEAD) -> ICARUS main"
