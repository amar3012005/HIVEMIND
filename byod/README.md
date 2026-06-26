# HIVEMIND BYOD — keep your memory on your own server

Run HIVEMIND with your memory data hosted on **your** hardware. The engine, dashboard, and all
features stay on HIVEMIND's side; only your `.amr` memory file (and, optionally, your Postgres) live
on this box. The connection is **outbound-only** (no inbound ports) and your data never leaves the
box — only ranked recall results / requested rows traverse the encrypted link.

## Setup (one command)
```bash
git clone --branch byod --single-branch <repo-url> hivemind-byod
cd hivemind-byod
./setup.sh
```
`setup.sh` asks for your **API key** (dashboard → Settings → BYOD), starts the local data plane +
an outbound tunnel, and connects it to HIVEMIND. Then just use the dashboard normally.

## What runs here
| container | what |
|-----------|------|
| `hm-agent` | serves your local `.amr` (recall/write/edge/hydrate), Bearer-authed |
| `hm-agent-tunnel` | cloudflared — dials OUT, gives the agent a public https URL, no inbound port |
| `postgres` *(optional)* | your own Postgres for content hydrate — `docker compose --profile pg up -d` |

Your `.amr` lives in `./data/mneme/`. **Back it up** — it is the sole copy of your memory.

## How it connects
```
HIVEMIND core (their box) ──► broker ──► [outbound tunnel] ──► hm-agent (your box) ──► ./data/*.amr
        recall/ingest/dashboard                                     your memory, never leaves
```
The API key authenticates the agent and binds it to your org. From then on, HIVEMIND routes only
your org's memory traffic to this box (per-org — other tenants are unaffected).

## Security
- Outbound-only; no inbound firewall changes.
- Per-agent Bearer token (generated locally, never shared).
- The agent serves ONLY its own org; the broker pins the tunnel to your tenant.
- Rotate: delete `.env` + re-run `./setup.sh`. Disconnect: `curl -X POST $BROKER_URL/v1/byod/disenroll -d '{"apiKey":"…"}'`.

## Operate
```bash
docker compose -f docker-compose.byod.yml logs -f agent     # agent logs
docker compose -f docker-compose.byod.yml down              # stop
./setup.sh                                                  # reconnect (idempotent)
```

## Updating
This bundle is a self-contained branch; `git pull` to get a newer agent, then `./setup.sh`.
The HIVEMIND engine/features upgrade independently on their side — this bundle is unaffected.
