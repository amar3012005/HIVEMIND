#!/usr/bin/env bash
# Run only on the protected signing/promotion host. The private signing key is
# consumed by sign-release.mjs before this command and is never sent to R2.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
CHANNEL="${1:-}"
MANIFEST="${2:-}"
SIGNATURE="${3:-}"
BUNDLE="${4:-}"
PUBLIC_KEY="${5:-}"
INSTALLER="${6:-$ROOT/byod/install.sh}"
BUCKET="${BYOD_RELEASE_R2_BUCKET:-singulance-memory-box-releases}"
ENV_FILE="${CLOUDFLARE_ENV_FILE:-}"
DRY_RUN="${BYOD_RELEASE_DRY_RUN:-false}"

[[ "$CHANNEL" == stable || "$CHANNEL" == canary ]] || { echo "channel must be stable or canary" >&2; exit 2; }
for file in "$MANIFEST" "$SIGNATURE" "$BUNDLE" "$PUBLIC_KEY" "$INSTALLER"; do
  [[ -f "$file" ]] || { echo "missing release input: $file" >&2; exit 2; }
done

VERIFIED="$(node "$ROOT/byod/verify-release.mjs" "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY")"
RELEASE="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.release)')"
MANIFEST_CHANNEL="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.channel||"")')"
EXPECTED_BUNDLE_SHA="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.bundle_sha256||"")')"
IMAGE="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.image)')"
[[ "$MANIFEST_CHANNEL" == "$CHANNEL" ]] || { echo "manifest channel does not match promotion channel" >&2; exit 1; }
[[ "$(sha256sum "$BUNDLE" | awk '{print $1}')" == "$EXPECTED_BUNDLE_SHA" ]] || { echo "bundle digest mismatch" >&2; exit 1; }

WRANGLER=(npx wrangler)
[[ -z "$ENV_FILE" ]] || WRANGLER+=(--env-file "$ENV_FILE")
put() {
  local key="$1" file="$2"
  if [[ "$DRY_RUN" == true ]]; then printf 'DRY RUN put %s/%s <- %s\n' "$BUCKET" "$key" "$file"; return; fi
  "${WRANGLER[@]}" r2 object put "$BUCKET/$key" --file "$file" --remote >/dev/null
}

# Anonymous pull is the actual customer contract. A package that CI can push
# but a clean customer host cannot pull must never reach a signed channel.
if [[ "$DRY_RUN" != true ]]; then docker pull "$IMAGE" >/dev/null; fi

POINTER="$(mktemp)"
trap 'rm -f "$POINTER"' EXIT
printf '{"version":1,"release":"%s","promoted_at":"%s"}\n' "$RELEASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$POINTER"

# Immutable objects first. The channel pointer is the single atomic commit;
# the Worker resolves both release.json and release.sig through that pointer.
put "releases/$RELEASE/release.json" "$MANIFEST"
put "releases/$RELEASE/release.sig" "$SIGNATURE"
put "releases/$RELEASE/bundle.tar.gz" "$BUNDLE"
put "bootstrap/release.pub" "$PUBLIC_KEY"
put "bootstrap/memory-box" "$INSTALLER"
put "channels/$CHANNEL.json" "$POINTER"

printf 'Published Memory Box release=%s channel=%s image=%s\n' "$RELEASE" "$CHANNEL" "$IMAGE"
