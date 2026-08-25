# HIVEMIND BYOD — keep your memory on your own server

Run HIVEMIND with your memory data hosted on **your** hardware. The engine and dashboard stay on
HIVEMIND's side; this bundle stores memory rows in local PostgreSQL and vectors in local Qdrant.
The central engine reaches the authenticated agent over HTTPS or a private network. Raw memory data
stays on the customer box; only ranked recall results and explicitly requested rows traverse the link.

## Setup (one command)
```bash
curl -fsSL https://get.singulancelabs.com/memory-box | sudo bash
```
The bootstrap verifies the signed stable release, installs governed host tools under
`/opt/hivemind-memory-box`, stores protected configuration in `/etc/hivemind-memory-box`, and stores
signed receipts in `/var/lib/hivemind-memory-box`. It then asks for your **API key** (dashboard →
Settings → BYOD), starts the local data plane, and registers it. Existing `.env`, data, and backups
are adopted in place; PostgreSQL and Qdrant are never recreated by an agent update.

## What runs here
| container | what |
|-----------|------|
| `hm-agent` | serves the local PostgreSQL + Qdrant data plane (recall/write/edge/hydrate), Bearer-authenticated |
| `postgres` | authoritative local memory rows and relational graph |
| `qdrant` | authoritative local vector index |

Your data lives in `./data/pg/` and `./data/qdrant/`. **Back up both** — they are the authoritative copies.

## How it connects
```
HIVEMIND core (their box) ──► authenticated HTTPS/private link ──► hm-agent (your box) ──► PostgreSQL + Qdrant
        recall/write/dashboard                                     customer-owned memory store
```
The API key authenticates the agent and binds it to your org. From then on, HIVEMIND routes only
your org's memory traffic to this box (per-org — other tenants are unaffected). Memory rows and
vectors persist on the customer box. The current agent protocol still receives finished memory
envelopes from the central engine; use a fully self-hosted processing stack when source-content
processing must also remain entirely on the customer network.

## Security
- Use HTTPS or a private network reachable by the central engine; public cleartext HTTP is rejected.
- Per-agent Bearer token, generated locally and shared only with the Engine so it can authenticate to this Box.
- The agent serves only its configured org; every request also requires its matching `x-org-id`.
- Rotate the token from the dashboard/control API, replace `AGENT_TOKEN` in `.env` with the returned value, then run `docker compose -f docker-compose.byod.yml up -d agent` within 15 minutes. The Engine uses the previous token only during that grace period.

## Operate
```bash
docker compose -f docker-compose.byod.yml logs -f agent     # agent logs
./backup.sh                                                  # verified PG + Qdrant recovery set
./doctor.sh                                                  # read-only health, backlog, disk and backup proof
./restore-drill.sh --backup ./backups/<timestamp> --org-id <org-uuid>  # disposable full restore + recall
docker compose -f docker-compose.byod.yml down              # stop
./setup.sh                                                  # reconnect (idempotent)
```

`backup.sh` publishes a backup directory only after PostgreSQL and Qdrant artifacts exist and
their SHA-256 manifest verifies. Copy the completed directory off the Memory Box. A local copy
does not protect against loss of the machine. The manifest contains a pseudonymous tenant
reference and never records database URLs, access tokens, or raw content.

`doctor.sh` fails closed when a container is missing/unhealthy, the authenticated protocol contract
is incomplete, disk headroom is unsafe, or the latest backup is missing, stale, or corrupt. Vector
repair backlog is reported without printing row content or credentials.

`restore-drill.sh` never restores over the live box. It creates isolated containers and temporary
storage, restores the exact PostgreSQL and Qdrant image IDs recorded in the manifest, exercises
memory and evidence recall through a restored agent, then removes the disposable environment.

## Governed updates

Stable signed updates are checked every six hours with up to 30 minutes of randomized delay. The
same transaction can be run manually:

```bash
sudo hivemind-memory-box update
```

The updater verifies the Ed25519 signature, channel, validity window, anti-downgrade order, bundle
hash, and digest-pinned image. It retains the current local image, replaces only `hm-agent` with
Compose `--no-deps`, then verifies health, release identity, protocol/schema versions, required
capabilities, exact memory/evidence inventory access, and authenticated recall. Any failure restores
the previous local image automatically and leaves the current receipt unchanged.

```bash
sudo hivemind-memory-box rollback
sudo hivemind-memory-box channel canary   # explicit opt-in
sudo hivemind-memory-box channel stable
hivemind-memory-box status
sudo hivemind-memory-box doctor
```

`install`, `update`, and `rollback` share a host lock and cannot overlap. The signing private key is
never distributed to a customer box; only the pinned public key is installed. The box requires only
outbound HTTPS to the release channel, GHCR, and the SINGULANCE registration API.
