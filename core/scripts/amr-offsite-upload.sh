#!/usr/bin/env bash
# Encrypt one verified .amr snapshot, upload it with an operator-owned command,
# and write a receipt only after that command verifies remote durability.
set -euo pipefail

SNAPSHOT="${1:-}"
[[ -n "$SNAPSHOT" && -f "$SNAPSHOT/MANIFEST.json" ]] || {
  echo "usage: amr-offsite-upload.sh VERIFIED_SNAPSHOT" >&2
  exit 2
}
[[ -n "${AMR_EXPORT_PASSPHRASE:-}" ]] || { echo "AMR_EXPORT_PASSPHRASE is required" >&2; exit 2; }
[[ -n "${AMR_OFFSITE_UPLOAD_COMMAND:-}" ]] || { echo "AMR_OFFSITE_UPLOAD_COMMAND is required" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="${AMR_OFFSITE_BUNDLE_DIR:-$(dirname "$SNAPSHOT")/portable}"
mkdir -p -m 700 "$BUNDLE_ROOT"
BUNDLE="$BUNDLE_ROOT/$(basename "$(dirname "$SNAPSHOT")")-$(basename "$SNAPSHOT").hmamr"
PARTIAL_RECEIPT="$SNAPSHOT/.OFFSITE_RECEIPT.partial-$$"
trap 'rm -f -- "$PARTIAL_RECEIPT"' EXIT INT TERM

EXPORT_JSON="$(node "$HERE/amr-portable.mjs" export --snapshot "$SNAPSHOT" --output "$BUNDLE")"
BUNDLE_SHA256="$(EXPORT_JSON="$EXPORT_JSON" node -e '
const row=JSON.parse(process.env.EXPORT_JSON||"{}");
if(!/^[a-f0-9]{64}$/.test(row.sha256||"")||!(row.bytes>0))process.exit(1);
process.stdout.write(row.sha256);')"
SNAPSHOT_MANIFEST_SHA256="$(sha256sum "$SNAPSHOT/MANIFEST.json" | awk '{print $1}')"

# The remote command receives only an encrypted bundle and checksums. It must
# return zero only after the independently durable object has been read back or
# otherwise checksum-verified. Never expose the encryption passphrase to it.
unset AMR_EXPORT_PASSPHRASE
export BACKUP_PATH="$BUNDLE" BUNDLE_SHA256 SNAPSHOT_MANIFEST_SHA256
eval "$AMR_OFFSITE_UPLOAD_COMMAND"

UPLOADED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
TARGET_LABEL="${AMR_OFFSITE_TARGET_LABEL:-personal_amr_offsite}" \
BUNDLE_SHA256="$BUNDLE_SHA256" SNAPSHOT_MANIFEST_SHA256="$SNAPSHOT_MANIFEST_SHA256" \
node -e 'process.stdout.write(JSON.stringify({
  version:1, complete:true, uploaded_at:process.env.UPLOADED_AT,
  target:process.env.TARGET_LABEL, bundle_sha256:process.env.BUNDLE_SHA256,
  snapshot_manifest_sha256:process.env.SNAPSHOT_MANIFEST_SHA256,
},null,2)+"\n")' > "$PARTIAL_RECEIPT"
chmod 600 "$PARTIAL_RECEIPT"
mv "$PARTIAL_RECEIPT" "$SNAPSHOT/OFFSITE_RECEIPT.json"
trap - EXIT INT TERM
echo "Encrypted AMR backup uploaded and acknowledged: $SNAPSHOT"
