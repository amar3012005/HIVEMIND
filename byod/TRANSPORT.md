# BYOD Agent Transport

The central engine talks only to the authenticated `hm-agent` HTTP API. It does
not connect directly to customer PostgreSQL or Qdrant.

The default one-command installation receives a remotely managed Cloudflare
tunnel from the broker. It requires no inbound firewall rule, public IP, DNS,
or customer Cloudflare account. The agent remains bound to `127.0.0.1` on the host.

For customer-managed HTTPS, set `AGENT_PUBLIC_URL` before running `./setup.sh`:

```text
https://agent.customer.example
```

An HTTPS reverse proxy is the normal deployment. Plain `http://` is accepted
only for private RFC1918 or Tailscale endpoints that are reachable from the
central engine. Public cleartext HTTP is rejected during registration.

The agent token authenticates every write, recall, hydrate, and graph request.
It is generated on the Box and stored in both the customer `.env` file and the
Engine's protected per-organization registry. The health endpoint is unauthenticated
and intentionally returns no memory content.

## Token rotation

Call `POST /v1/selfhost/rotate-agent-token` on the control plane with the
organization API key. It returns a new `agentToken`; replace `AGENT_TOKEN` in
the Box `.env` and restart only the `agent` service within 15 minutes. During
that window the Engine tries the new token first, then the old token only if
the Box returns `401`. After the Box restarts, the old credential is rejected.
Never put either credential in a URL, browser storage, log, or support ticket.

The bundled Tailscale container shares the agent network namespace, making the
agent's port 8787 reachable on the container's tailnet IP. The installer resolves
that IP before registration and still requires a successful central probe.

Data at rest is local PostgreSQL plus local Qdrant. Back up both directories:

```text
data/pg/
data/qdrant/
```
