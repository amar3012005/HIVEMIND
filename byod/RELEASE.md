# Governed Memory Box Release

Memory Box releases have two trust stages. GitHub Actions builds and tests an unsigned,
multi-architecture agent candidate. A protected signing host approves that immutable digest,
signs manifest v2 with an offline Ed25519 key, and promotes the signed artifacts to R2. The
private key must never be copied into GitHub, Cloudflare, a customer box, or this repository.

## One-time infrastructure

1. Make the GHCR package public once with package-admin authority. CI deliberately does not mutate
   package visibility. Confirm a clean Docker configuration can inspect the image by digest.
2. Create the `singulance-memory-box-releases` R2 bucket and deploy
   `byod/release-channel/wrangler.toml` with the narrow R2 publishing token.
3. Keep the Ed25519 private key on the protected signing host. Publish only its public key.
4. Point `get.singulancelabs.com/memory-box*` at the release Worker.

## Candidate and signing

The `publish-memory-box-agent` workflow records the source SHA and manifest-list digest. Stage the
customer bundle with `scripts/stage-byod-bundle.sh`, archive it immutably, and calculate its SHA-256.
On the signing host, create manifest v2:

```bash
BYOD_RELEASE_PRIVATE_KEY=/protected/offline/release.key \
BYOD_RELEASE_SOURCE_SHA="$SOURCE_SHA" \
BYOD_RELEASE_KEY_ID="$KEY_ID" \
BYOD_RELEASE_CHANNEL=canary \
node byod/sign-release.mjs \
  "$IMAGE_AT_DIGEST" "$RELEASE_ID" "$IMMUTABLE_BUNDLE_URL" "$BUNDLE_SHA256" ./signed
```

The public key fingerprint is embedded into the served bootstrap during promotion. Key rotation is
prepared by a new `key_id`, but requires publishing a bootstrap trusted through the current release
process before the old key is retired.

## Promotion

First run the signed release restore drill against a disposable real backup. Its JSON receipt must
contain `ok: true` plus the exact `release`, `image`, and `source_sha`. Promote canary:

```bash
BYOD_RESTORE_DRILL_RECEIPT=./restore-receipt.json \
CLOUDFLARE_ENV_FILE=/root/.config/cloudflare/wrangler.env \
scripts/publish-memory-box-release.sh canary signed/release.json signed/release.sig \
  bundle.tar.gz release.pub
```

After the company-controlled old box passes ingestion, inventory, graph, recall, telemetry, and
rollback checks, record a canary receipt with `ok: true`, `release`, and `image`. Promote the same
digest to stable with `BYOD_CANARY_RECEIPT` and a stable-channel manifest signed over the same image
and bundle. Immutable objects are uploaded first; the channel pointer is written last.

Customers install and update without inbound access:

```bash
curl -fsSL https://get.singulancelabs.com/memory-box | sudo bash
sudo hivemind-memory-box update
```

Do not remove Core's bounded compatibility path until the stable capability set has been available
for at least 30 days and at least 99 percent of active boxes report it.
