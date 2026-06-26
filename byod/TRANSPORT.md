# BYOD transport — how our engine reaches your data box

The customer box exposes **only** Postgres:5432 + Qdrant:6333, **outbound-only** (no inbound ports).
Our central engine connects to them for that org. Two supported transports.

## Recommended: Tailscale (WireGuard mesh) — in the bundle
Both boxes join one private tailnet; our engine reaches your stores by their stable tailnet hostname.
End-to-end encrypted, no exposed ports, raw TCP (works for Postgres).

### Customer side (the bundle does this)
1. Get a Tailscale auth key: https://login.tailscale.com/admin/settings/keys (tag `tag:hivemind-byod`).
2. Put it in `.env` as `TS_AUTHKEY=...`, run `./setup.sh`.
3. The `tunnel` container joins the tailnet → the box gets a hostname like
   `hivemind-byod.<tailnet>.ts.net`. Postgres + Qdrant are reachable on it (tailnet-internal only).

### Our side (one-time, per tailnet)
The **central engine host must be a node on the same tailnet** (or a shared tailnet with an ACL that
lets central → `tag:hivemind-byod` on 5432/6333). Either:
- install Tailscale on the central host and `tailscale up`, OR
- run a Tailscale subnet-router / the engine in a container with Tailscale.
ACL example (Tailscale admin → Access Controls):
```jsonc
{ "acls": [
  { "action": "accept", "src": ["tag:hivemind-central"], "dst": ["tag:hivemind-byod:5432","tag:hivemind-byod:6333"] }
]}
```

### Registration
`setup.sh` registers `pgUrl`/`qdrantUrl` using the **tailnet hostname**:
```
pgUrl     = postgresql://hivemind:<pw>@hivemind-byod.<tailnet>.ts.net:5432/hivemind?sslmode=disable
qdrantUrl = http://hivemind-byod.<tailnet>.ts.net:6333
```
sslmode can be `disable` because WireGuard already encrypts the link.

## Ordering (important)
`/v1/selfhost/register` **applies the memory schema over this link**, so the tunnel must be **up and
reachable from central before register**. `setup.sh` order: up tunnel → wait for tailnet host → register.
If central isn't on the tailnet yet, register's schema step fails (the registry entry is still written;
re-trigger register once central can reach the box, or run the schema manually with `byod/memory-schema.sql`).

## Alternative: public TLS endpoint (no tailnet)
If you can't put central on the tailnet, expose the stores publicly with TLS and register those URLs:
- Postgres: a public host + `sslmode=require` (Postgres server cert).
- Qdrant: behind Caddy/Traefik with TLS + the `QDRANT_API_KEY`.
Less private than the mesh (ports are reachable from the internet, gated by TLS + credentials) — use
the tailnet unless you have a reason not to.

## What never leaves the box
Only **query results** and the requested rows traverse the link (encrypted). Your full corpus —
Postgres rows + Qdrant vectors — stays on your disk. Global identity/billing info lives in HIVEMIND's
central Postgres, never on your box.
