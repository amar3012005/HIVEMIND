# Memory Box / BYOD — Architecture, Release, Security, and Operations Record

Status: authoritative decision record as of 2026-08-27.

This document records the intended enterprise self-hosting experience, the implemented
architecture, the governed release system, the production work completed on 2026-08-27, key
custody, recovery procedures, acceptance evidence, and the remaining stable-promotion gate.
It intentionally contains no credential values or private signing material.

## 1. Product decision

An enterprise customer should need to perform only four actions:

1. Sign in to HIVEMIND and choose **Set up Memory Box**.
2. Copy the organization-bound installation command.
3. Run it with `sudo` on a supported Linux server.
4. Return to HIVEMIND and wait for **Connected**.

The installer owns dependency detection, signed artifact verification, container startup,
private Cloudflare Tunnel provisioning, central registration, health verification, update timer
installation, and status reporting. Customers must not manually create public firewall rules,
edit Compose files, paste long-lived agent credentials, or clone a mutable Git branch.

The automatic default transport is a private, broker-provisioned Cloudflare Tunnel. Existing
custom HTTPS and Tailscale deployments remain compatibility transports, but they use the same
signed installer and agent contract.

## 2. System boundaries

```text
HIVEMIND web application
  -> authenticated Control Plane session
  -> one-use, org-bound enrollment credential
  -> dedicated Memory Box broker
       -> PostgreSQL lifecycle authority
       -> Cloudflare Tunnel + DNS provisioning
       -> bounded compatibility projection for Core
  -> signed installer on the customer server
       -> PostgreSQL
       -> Qdrant
       -> Memory Box agent
       -> cloudflared connector
       -> backup, reconcile, update, and rollback timers
  -> Core reaches the box through its governed registered endpoint
```

Responsibilities are deliberately separated:

- The Control Plane authenticates the human administrator and issues the short-lived enrollment
  credential. It is not the Memory Box lifecycle writer.
- The broker owns enrollment, registered endpoint identity, tunnel identity, durable box
  credential state, heartbeat, rotation, revocation, and the compatibility projection.
- The release Worker serves only signed public bootstrap and release artifacts from R2.
- The customer box owns customer memory/evidence data and the local PostgreSQL/Qdrant services.
- Core consumes the registered route but must never silently widen into another tenant or central
  storage when a box is unavailable.

## 3. Canonical source and production topology

- Repository: `amar3012005/HIVEMIND`
- Deployable branch: `singulance-main`
- Production host alias: `ssh singulance`
- Production environment: `/root/hivemind/.env`
- Cloudflare CLI environment: `/root/.config/cloudflare/wrangler.env`
- Release origin: `https://get.singulancelabs.com/memory-box`
- R2 bucket: `singulance-memory-box-releases`
- Broker container: `hm-byod-broker`, loopback port `8790`
- Existing company-controlled box containers: `hm-byod-agent`, `hm-byod-postgres`,
  `hm-byod-qdrant`
- Existing company-controlled box organization:
  `0a1d5b33-a33c-49a6-8185-6d16370670a2`

The production Compose release is materialized from an immutable source checkout. Do not deploy
Memory Box changes by editing `/root/hivemind` in place or by restarting one container against a
different mutable Compose file.

## 4. Storage contract

The self-hosted box provides the same public storage behavior as managed and embedded modes:

- memory inventory and total inventory;
- evidence inventory;
- memory and evidence recall;
- lexical retrieval;
- hydration;
- provenance and relationship reads;
- vector pending/status/repair;
- document ingestion-mode persistence.

The release capability list is part of the signed manifest. An update is rejected if the new
agent cannot advertise every required capability. Memory and evidence are separate lanes and
must remain separately countable and recallable.

The customer bundle retains durable documents and provenance. A lexical-only document directory
is a degraded state, not proof that the Memory Box agent or semantic retrieval is ready.

## 5. Release trust model

The release system has four distinct stages:

1. GitHub Actions builds a multi-architecture agent image (`linux/amd64`, `linux/arm64`) and
   publishes it by immutable digest.
2. The exact customer bundle is generated from the same approved source SHA and assigned an
   immutable R2 URL and SHA-256.
3. A protected Ed25519 key signs canonical manifest-v2 bytes containing the source SHA, image
   digest, bundle URL/digest, channel, protocol, schema, capabilities, key identity, and public-key
   fingerprint.
4. Publication uploads immutable objects first and writes the channel pointer last. The pointer
   is the atomic channel commit.

`latest`, mutable image tags, unsigned bundles, mutable Git clones, and locally rebuilt customer
images are forbidden in a governed release.

### Channels

- `canary`: signed candidate used for restore, upgrade, rollback, tunnel, enrollment, ingestion,
  inventory, graph, recall, and telemetry canaries.
- `stable`: customer default. It requires a matching signed restore receipt and a matching real
  canary receipt. Until both exist, the stable endpoint deliberately returns HTTP 503.

Canary and stable manifests are separately signed because `channel` is included in the canonical
signed bytes. The image and bundle may remain identical.

## 6. Key and credential inventory

No secret value belongs in Git, this document, logs, tickets, HubSpot, Cloudflare R2, or a release
receipt.

| Material | Current location / authority | May be published? | Notes |
|---|---|---:|---|
| Ed25519 private release key | Amar's Mac: `~/MemoryBox-Signing/agent-6905aeb9/release.key` | No | Mode 0600. Never upload to production or Cloudflare. Move to protected offline hardware/HSM later. |
| Ed25519 public release key | Local signed directories, production signed-release directories, and R2 `bootstrap/release.pub` | Yes | Current fingerprint: `a3d3c7c54d17fa1918c4013d03b16ec97580b9b90a15614dbb02934dc335748d`. |
| Cloudflare Memory Box API token | Production `/root/hivemind/.env`, variable `CLOUDFLARE_MEMORY_BOX_API_TOKEN` | No | Scoped token; Tunnel and DNS permissions were live-verified. |
| Wrangler/R2 publication credentials | `/root/.config/cloudflare/wrangler.env` | No | Controlled server-only environment file. Do not `source` the general HIVEMIND `.env`; it is Compose dotenv, not shell. |
| Broker internal credential | Production environment, variable `BYOD_BROKER_INTERNAL_TOKEN` | No | Authenticates Control Plane-to-broker lifecycle requests and protects credential envelopes. |
| Enrollment credential | Persisted API-key authority; generated per setup | No | Org-bound, short-lived, single-purpose and single-use. |
| Durable box credential | Broker lifecycle authority / protected compatibility projection | No | Returned only through successful enrollment and used by that box. |
| Cloudflare connector credential | Encrypted broker metadata and customer `cloudflared` runtime | No | Issued for the broker-provisioned tunnel only. |
| Agent bearer token | Customer protected configuration | No | URL-safe high-entropy value; never place in query parameters or UI logs. |

### Key custody rules

1. Back up `release.key` encrypted to removable storage before stable promotion.
2. The production server receives only `release.json`, `release.sig`, and `release.pub`.
3. Losing the private key before publishing a stable trust root permits generating a replacement
   key and replacing the unpublished candidate. Losing it after stable publication requires a
   signed key-rotation release trusted through the current key.
4. Never put the private key in a Cloudflare secret merely for convenience. Cloudflare serves
   public artifacts; it is not the offline release signer.
5. The eventual preferred custody is a non-exportable hardware-backed Ed25519 signer or an
   offline encrypted device with a documented recovery copy.

## 7. Completed 2026-08-27 implementation

The following repairs were merged into `singulance-main`:

- PR #642 / merge `ce1eedb6`: isolated signed restore-drill state, config, install tree, and lock;
  required three consecutive PostgreSQL-ready observations; made upgrade and rollback use the
  same state-local receipts; prevented host-tool promotion during a disposable drill.
- PR #643 / merge `6905aeb9`: moved the registration security assertion to the broker, where
  strong-token and endpoint enforcement actually live.
- PR #644 / merge `42c0c3be`: bound the restore-drill receipt to the signed source SHA so the
  publisher can prove source, image, release, and receipt identity without weakening the gate.

Additional completed work:

- The Cloudflare token was reloaded into the canonical broker deployment and live-verified for
  token validity, Tunnel access, and DNS access.
- The old false global release receipt created by the first broken disposable drill was moved to
  `/var/lib/hivemind-memory-box/INCIDENT_FALSE_RECEIPT_20260827T171455Z.json`.
- The live legacy box remained on `hivemind/hm-agent:prod-20260825-0b7116e5`; its PostgreSQL,
  Qdrant, and agent health remained green.
- No drill container remained running after cleanup.

## 8. Current signed canary

The authoritative canary is:

| Field | Value |
|---|---|
| Release | `agent-42c0c3be` |
| Channel | `canary` |
| Source SHA | `42c0c3be7545ad6538776b7418660fa6a5515cb4` |
| Image | `ghcr.io/amar3012005/hivemind-hm-agent@sha256:80043956521ffae72f775f34b7fbfce71c79daf78b6fcbca003192e26b542da7` |
| Bundle SHA-256 | `b5db456cf24880f2970abd2a4dab127b65311ed427acc9da378bf334d6aa0a6e` |
| Public-key fingerprint | `a3d3c7c54d17fa1918c4013d03b16ec97580b9b90a15614dbb02934dc335748d` |
| Public bundle | `https://get.singulancelabs.com/memory-box/releases/agent-42c0c3be/bundle.tar.gz` |
| Canary manifest | `https://get.singulancelabs.com/memory-box/releases/canary/release.json` |

Production artifacts are under:

```text
/root/releases/memory-box/42c0c3be7545ad6538776b7418660fa6a5515cb4/
  signed/release.json
  signed/release.sig
  signed/release.pub
  drills/20260827T174731Z.json
```

The public canary signature was downloaded again from the Worker and verified independently.
The stable channel is intentionally not published yet.

### Restore-drill evidence

The drill restored a real company-controlled backup into isolated PostgreSQL and Qdrant
containers, added no data to the live box, upgraded the disposable agent to the signed digest,
verified capabilities and recall, rolled back to the exact original image, and cleaned up.

Observed parity:

| Stage | Memory hits | Evidence hits |
|---|---:|---:|
| Restored baseline | 5 | 1 |
| Signed canary | 5 | 1 |
| Rolled back | 5 | 1 |

Original image ID:
`sha256:945e5162058fec807edd0cdb68eb824ce8ef55b77e499ad39c3d3264701ecb67`.

Canary image ID:
`sha256:80043956521ffae72f775f34b7fbfce71c79daf78b6fcbca003192e26b542da7`.

## 9. Customer installation lifecycle

The intended one-command lifecycle is:

```text
admin session
  -> Control Plane confirms org admin + self_host mode
  -> broker readiness proves Cloudflare + signed stable release
  -> issue 30-minute org-bound enrollment credential
  -> customer downloads bootstrap over HTTPS
  -> bootstrap downloads stable manifest, signature, and public key
  -> verify public-key fingerprint + Ed25519 signature
  -> download bundle and verify SHA-256
  -> validate archive paths and reject links
  -> install versioned host tools atomically
  -> provision broker-owned Cloudflare Tunnel + DNS hostname
  -> start PostgreSQL, Qdrant, agent, and cloudflared
  -> verify local health, protocol, schema, capabilities, and inventory
  -> register exact broker-provisioned endpoint and durable credential
  -> prove central reachability
  -> install reconciliation, backup, and update timers
  -> report Connected
```

The UI must not report Connected merely because the upload/bootstrap request was accepted. It
must wait for registered endpoint identity and successful reachability.

## 10. Update and rollback lifecycle

Updates run through the signed channel and must:

1. download and verify the manifest, signature, key fingerprint, image digest, bundle digest,
   channel, time validity, schema, protocol, and capabilities;
2. preserve a local rollback image;
3. replace only the agent first, never PostgreSQL or Qdrant;
4. verify health, identity, inventory, capabilities, and recall;
5. promote host tools from the same verified bundle through a versioned/atomic installation;
6. commit the verified release receipt only after verification;
7. automatically restore the prior image and tools on failure.

The updater checks persistently through systemd timers. A transient provider or network failure
must leave the current verified version running. It must never turn a failed update into a partial
installation.

Rollback uses the state-local `CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json`. Tests and
disposable drills must set their own state/config/install/lock paths and set
`BYOD_SKIP_HOST_PROMOTION=true`.

## 11. Backup and disaster recovery

A valid backup contains PostgreSQL, Qdrant, a storage manifest, source/provenance material, image
identity, organization identity, checksums, and the storage mode. A backup is not accepted merely
because files exist; `storage-manifest.mjs verify` must pass.

Restore drills are always disposable:

- use unique container and network names;
- restore into `mktemp` storage;
- require three consecutive PostgreSQL readiness checks before `pg_restore`;
- verify at least one memory and one evidence vector;
- compare recall counts before upgrade, after upgrade, and after rollback;
- verify exact image IDs;
- emit a source-bound JSON receipt;
- remove all disposable containers and networks.

Never restore a release drill over a live customer box.

## 12. Security invariants

- Broker-managed Cloudflare registration is bound to the broker-provisioned hostname and tunnel.
- Custom HTTPS/Tailscale endpoints must pass transport-specific endpoint validation and must not
  resolve to metadata, loopback, link-local, control-plane, or unauthorized private targets.
- Bootstrap credentials cannot rotate, revoke, heartbeat, report, or disenroll a box.
- Lifecycle mutations require either the appropriate durable credential or an authenticated
  organization-admin facade.
- Installer configuration is parsed as data, never sourced as executable shell.
- Archive traversal, absolute paths, symbolic links, and hard links are rejected.
- Secrets never appear in installer command URLs, process arguments where avoidable, browser
  logs, release manifests, receipts, or Git.
- PostgreSQL is the broker's authority; the Core registry file is a compatibility projection, not
  a second lifecycle database.
- Tenant ID, authorization scope, endpoint identity, storage mode, and provenance remain bound at
  every request.

## 13. Verification commands

Public canary:

```bash
curl -fsSL https://get.singulancelabs.com/memory-box/releases/canary/release.json
curl -fsSL https://get.singulancelabs.com/memory-box/release.pub
curl -fsSL https://get.singulancelabs.com/memory-box/releases/agent-42c0c3be/bundle.tar.gz \
  | sha256sum
```

Expected bundle digest:
`b5db456cf24880f2970abd2a4dab127b65311ed427acc9da378bf334d6aa0a6e`.

Broker health:

```bash
ssh singulance 'curl -fsS http://127.0.0.1:8790/health'
```

Live legacy box health without exposing its bearer token:

```bash
ssh singulance \
  'docker exec hm-byod-agent node -e '\''fetch("http://127.0.0.1:8787/health").then(async r=>console.log(r.status,await r.text()))'\'''
```

Repository verification:

```bash
bash -n byod/install.sh byod/setup.sh byod/upgrade.sh byod/rollback.sh \
  byod/signed-release-restore-drill.sh
node --test byod/tests/*.test.mjs
node --test core/tests/storage/byod-release-contract.test.mjs
```

## 14. Remaining gate before stable

One intentional gate remains: run the actual one-command installation on a disposable supported
Linux host using a disposable self-hosted organization. The canary must prove:

1. org-admin bootstrap and one-use enrollment;
2. broker-created Tunnel and DNS ownership;
3. clean signed installation on both a supported x86-64 or ARM64 host;
4. reboot survival and automatic connector recovery;
5. evidence and memory ingestion;
6. exact inventory counts, provenance, graph reads, and both recall lanes;
7. central Core reachability through the tunnel;
8. update check and rollback;
9. credential rotation and disenrollment authority;
10. cleanup of the disposable tenant and Cloudflare resources.

After that canary, create a receipt containing `ok: true`, the exact release, image, tenant,
transport, tested operations, timestamps, and sanitized evidence. Then sign a separate
`channel=stable` manifest over the same approved image and bundle and run the canonical publisher
with both restore and canary receipts.

Stable must remain HTTP 503 until this receipt exists. This is a safety property, not an outage.

## 15. Deprecated and rejected paths

Do not reintroduce:

- cloning and executing the mutable `byod` Git branch;
- `curl | bash` without downloading and verifying the installer identity;
- manual API-key plus arbitrary URL registration as the default customer flow;
- unsigned or locally built customer agents;
- release keys on production or Cloudflare;
- global release receipts in disposable drills;
- treating documents/segments as proof that the engine is active;
- reporting Connected before central reachability;
- publishing stable from a restore receipt alone.

## 16. Operational ownership

- SINGULANCE owns release signing, release-channel publication, broker availability, installer
  compatibility, capability contracts, and rollback support.
- The enterprise owns its server, OS patching, disk capacity, outbound connectivity, encrypted
  backups, and recovery custody.
- The product must clearly distinguish `READY`, `DEGRADED`, and `UNAVAILABLE`; it must never label
  lexical fallback or stored documents as a healthy semantic Memory Box.

This record supersedes any earlier note that describes the old mutable-clone installer, manual URL
registration as the preferred flow, or the first `agent-cfbacbae` candidate as publishable.
