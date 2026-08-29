# Engine Box v1 security and GDPR baseline

## Trust boundaries

1. Customer local network and encrypted volumes hold all content-bearing data.
2. The local Engine Box API is protected by customer OIDC/RBAC or scoped local
   credentials.
3. The Cloudflare control plane receives only signed-release metadata and
   content-free lifecycle telemetry over an outbound tunnel.
4. Optional remote model routes are separate processors. They require explicit,
   versioned administrator consent before the router can send content.

## Mandatory controls

- Verify offline-signed release manifests, checksums and OCI digests before
  images are pulled or started. A corrupt or unsigned artifact fails closed.
- Run application containers non-root, with dropped capabilities, a private
  internal data-plane network and no public PostgreSQL/Qdrant/Redis port.
- Enforce organisation/user scopes in PostgreSQL, Qdrant filters, graph writes,
  cache keys and MCP credentials. PostgreSQL RLS is a release gate.
- Store API-key hashes, not raw keys; issue revocable, expiring scoped keys.
- Preserve a sealed break-glass administrator, rotate it on use, and audit use.
- Encrypt transport using TLS 1.3. Customer-controlled volume/backup keys are
  required for certified deployments.
- GDPR export contains source documents, evidence, memories, graph and
  provenance, not embeddings. Erasure removes active rows, vectors, graph,
  queues, cache and credentials; backup retention/key destruction is recorded.
- Audit logs are append-only and content-free, with a default two-year policy.

## Required certification evidence

Fresh-install and rerun proof on amd64 and arm64; an interrupted-install repair
matrix; authenticated no-leak tenant tests; signed update rejection/rollback;
bare-host restore; Cloudflare disconnect operation; and consent revoke before a
remote model route is called. Security scans, penetration testing, DPA/DPIA,
RoPA inputs, subprocessors and retention schedule ship before stable release.
