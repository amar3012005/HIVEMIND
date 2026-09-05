# Cloudflare Edge Control Plane

## Boundary

This is an opt-in control plane. It is not a proxy or replacement for the
HIVEMIND data plane.

| Remains on Singulance | Optional Cloudflare control plane |
| --- | --- |
| Postgres, Qdrant, Redis, profiles, documents, memories, graph, audit, API keys, RBAC, chat, recall, MCP, ingestion, HyperAgents and voice | signed capability envelopes, release metadata, outbound installation lifecycle telemetry, edge protection and explicitly consented tunnels/AI routing |

User profiles are expressly excluded. Do not add D1, KV, Vectorize, user
content, prompts, answers, documents, embeddings, citations, transcripts, or
profile records to this package.

## Runtime safety

Core begins with `CLOUDFLARE_EDGE_CONTROL_ENABLED=false`. That is the local kill
switch. Even when it is true, a capability remains disabled unless Core fetches
an envelope for the organization and validates its offline Ed25519 signature,
organization, nonce, validity period, and exact capability allow-list.

Network failure, a malformed envelope, expiry, a bad signature, or an unknown
capability all resolve to six disabled capabilities. Core does not use the
Worker as an authorization source for memory, profile, identity, or billing
operations.

## Delivery sequence

1. Provision `hivemind-control-events` and the Worker binding through reviewed
   Terraform.
2. Store `CONTROL_PLANE_ADMIN_TOKEN`, `CONTROL_PLANE_INSTALLATION_TOKEN`, and
   `ENTITLEMENT_PUBLIC_KEY` as Worker secrets.
3. Publish the Worker only after an offline-signed entitlement test fixture
   validates against its public key.
4. Set `CLOUDFLARE_EDGE_CONTROL_URL`,
   `CLOUDFLARE_EDGE_CONTROL_TOKEN`, and
   `CLOUDFLARE_EDGE_ENTITLEMENT_PUBLIC_KEY` on a non-production canary Core.
5. Keep `CLOUDFLARE_EDGE_CONTROL_ENABLED=false`; verify no request is made.
6. Enable it only for a canary organization with every individual capability
   still `false`. Then turn on one capability at a time, verify a real request,
   and retain the local flag as immediate rollback.

No Cloudflare deployment, organization flag enablement, DNS change, tunnel, or
data-plane routing is included in this code change.
