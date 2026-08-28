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
RESTORE_RECEIPT="${BYOD_RESTORE_DRILL_RECEIPT:-}"
CANARY_RECEIPT="${BYOD_CANARY_RECEIPT:-}"

[[ "$CHANNEL" == stable || "$CHANNEL" == canary ]] || { echo "channel must be stable or canary" >&2; exit 2; }
for file in "$MANIFEST" "$SIGNATURE" "$BUNDLE" "$PUBLIC_KEY" "$INSTALLER"; do
  [[ -f "$file" ]] || { echo "missing release input: $file" >&2; exit 2; }
done

VERIFIED="$(node "$ROOT/byod/verify-release.mjs" "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY")"
RELEASE="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.release)')"
MANIFEST_CHANNEL="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.channel||"")')"
EXPECTED_BUNDLE_SHA="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.bundle_sha256||"")')"
IMAGE="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.image)')"
SOURCE_SHA="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.source_sha)')"
PUBLIC_KEY_SHA="$(VERIFIED="$VERIFIED" node -e 'const m=JSON.parse(process.env.VERIFIED);process.stdout.write(m.public_key_sha256)')"
[[ "$MANIFEST_CHANNEL" == "$CHANNEL" ]] || { echo "manifest channel does not match promotion channel" >&2; exit 1; }
[[ "$(sha256sum "$BUNDLE" | awk '{print $1}')" == "$EXPECTED_BUNDLE_SHA" ]] || { echo "bundle digest mismatch" >&2; exit 1; }
for required in setup.sh hivemind-memory-box memory-box-common.sh doctor.sh backup.sh storage-manifest.mjs storage-restore-drill.sh; do
  tar -tzf "$BUNDLE" | sed 's#^\./##' | grep -Fxq "$required" \
    || { echo "signed bundle is missing required runtime file: $required" >&2; exit 1; }
done
[[ -f "$RESTORE_RECEIPT" ]] || { echo "BYOD_RESTORE_DRILL_RECEIPT must name a successful restore-drill receipt" >&2; exit 1; }
RELEASE="$RELEASE" IMAGE="$IMAGE" SOURCE_SHA="$SOURCE_SHA" node -e '
  const fs=require("fs"),r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(r.ok!==true||r.release!==process.env.RELEASE||r.image!==process.env.IMAGE||r.source_sha!==process.env.SOURCE_SHA) process.exit(1);
' "$RESTORE_RECEIPT" || { echo "restore-drill receipt does not match the signed release" >&2; exit 1; }
if [[ "$CHANNEL" == stable ]]; then
  [[ -f "$CANARY_RECEIPT" ]] || { echo "BYOD_CANARY_RECEIPT is required for stable promotion" >&2; exit 1; }
  RELEASE="$RELEASE" IMAGE="$IMAGE" node -e '
    const fs=require("fs"),r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(r.ok!==true||r.release!==process.env.RELEASE||r.image!==process.env.IMAGE) process.exit(1);
  ' "$CANARY_RECEIPT" || { echo "canary receipt does not match the signed release" >&2; exit 1; }
fi

# Wrangler v4 parses --env-file as a global flag only after the command. Keep
# command and environment arguments separate so both local and production
# promotions use the same invocation shape.
WRANGLER=(npx wrangler)
WRANGLER_ENV_ARGS=()
[[ -z "$ENV_FILE" ]] || WRANGLER_ENV_ARGS+=(--env-file "$ENV_FILE")
put() {
  local key="$1" file="$2"
  if [[ "$DRY_RUN" == true ]]; then printf 'DRY RUN put %s/%s <- %s\n' "$BUCKET" "$key" "$file"; return; fi
  "${WRANGLER[@]}" r2 object put "$BUCKET/$key" "${WRANGLER_ENV_ARGS[@]}" --file "$file" --remote >/dev/null
}

# Anonymous pull is the actual customer contract. A package that CI can push
# but a clean customer host cannot pull must never reach a signed channel.
ANON_DOCKER_CONFIG="$(mktemp -d)"
RENDERED_INSTALLER="$(mktemp)"
sed "s/__HIVEMIND_RELEASE_PUBLIC_KEY_SHA256__/$PUBLIC_KEY_SHA/g" "$INSTALLER" > "$RENDERED_INSTALLER"
chmod 755 "$RENDERED_INSTALLER"
if grep -q '__HIVEMIND_RELEASE_PUBLIC_KEY_SHA256__' "$RENDERED_INSTALLER"; then echo "installer public-key pin was not rendered" >&2; exit 1; fi
if [[ "$DRY_RUN" != true ]]; then DOCKER_CONFIG="$ANON_DOCKER_CONFIG" docker pull "$IMAGE" >/dev/null; fi

POINTER="$(mktemp)"
trap 'rm -f "$POINTER" "$RENDERED_INSTALLER"; rm -rf "$ANON_DOCKER_CONFIG"' EXIT
printf '{"version":1,"release":"%s","promoted_at":"%s"}\n' "$RELEASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$POINTER"

# Immutable objects first. The channel pointer is the single atomic commit;
# the Worker resolves both release.json and release.sig through that pointer.
put "releases/$RELEASE/release.json" "$MANIFEST"
put "releases/$RELEASE/release.sig" "$SIGNATURE"
put "releases/$RELEASE/bundle.tar.gz" "$BUNDLE"
put "bootstrap/release.pub" "$PUBLIC_KEY"
put "bootstrap/memory-box" "$RENDERED_INSTALLER"
put "channels/$CHANNEL.json" "$POINTER"

printf 'Published Memory Box release=%s channel=%s image=%s\n' "$RELEASE" "$CHANNEL" "$IMAGE"
