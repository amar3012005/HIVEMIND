# HIVEMIND Cloudflare Edge Control Plane

This Worker is deliberately **not** the HIVEMIND data plane. PostgreSQL, Qdrant,
Redis, user profiles, documents, memories, prompts, recall results, chat, MCP,
RBAC, billing, and audit remain on Singulance.

It has only two responsibilities:

1. store offline-signed, organization-scoped capability entitlements in one
   Durable Object per organization; and
2. accept strictly content-free lifecycle telemetry into a Queue.

All capabilities default to `false`. The server must verify the signature again
before it enables any capability. A Worker response alone is never authority to
route tenant content, start a tunnel, enable support, or enable remote inference.

## Secrets

Set these through `wrangler secret put`; do not commit them:

- `CONTROL_PLANE_ADMIN_TOKEN`
- `CONTROL_PLANE_READ_TOKEN` — read-only token used by Core to fetch a signed entitlement
- `CONTROL_PLANE_INSTALLATION_TOKEN`
- `ENTITLEMENT_PUBLIC_KEY` — base64 of the 32-byte offline Ed25519 public key

## Signed entitlement payload

```json
{
  "version": 1,
  "organization_id": "uuid",
  "issued_at": "2026-09-06T00:00:00.000Z",
  "expires_at": "2026-10-06T00:00:00.000Z",
  "nonce": "at-least-16-characters",
  "flags": {
    "cloudflare_edge": false,
    "cloudflare_tunnel": false,
    "cloudflare_telemetry": false,
    "cloudflare_ai_gateway": false,
    "cloudflare_updates": false,
    "cloudflare_support_session": false
  }
}
```

The signing bytes are the lexicographically key-sorted JSON serialization from
`src/contract.js`. Production deployment is intentionally manual until Cloudflare
account, Queue, Worker and secret bindings are provisioned through reviewed IaC.
