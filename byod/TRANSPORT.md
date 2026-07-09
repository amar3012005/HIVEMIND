# BYOD Agent Transport

The central engine talks only to the authenticated `hm-agent` HTTP API. It does
not connect directly to customer PostgreSQL or Qdrant.

Set `AGENT_PUBLIC_URL` before running `./setup.sh`:

```text
https://agent.customer.example
```

An HTTPS reverse proxy is the normal deployment. Plain `http://` is accepted
only for private RFC1918 or Tailscale endpoints that are reachable from the
central engine. Public cleartext HTTP is rejected during registration.

The agent token authenticates every write, recall, hydrate, and graph request.
Keep it only in the customer `.env` file. The health endpoint is unauthenticated
and intentionally returns no memory content.

The bundled Tailscale container establishes membership only; operators must
still provide a reachable private agent endpoint. Do not assume it publishes the
agent port automatically. Validate from the central network before registering.

Data at rest is local PostgreSQL plus local Qdrant. Back up both directories:

```text
data/pg/
data/qdrant/
```
