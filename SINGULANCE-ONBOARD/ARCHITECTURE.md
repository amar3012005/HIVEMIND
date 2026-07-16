# Architecture

## One Platform, Stable Engine Boundary

The frontend calls the same central engine for every tenant. The organization
and authenticated identity determine authorization, entitlements, and storage
resolution. Deployment mode must not fork the product API.

```text
Browser
  -> frontend (next.singulancelabs.com)
  -> control plane (api.singulancelabs.com): identity, orgs, billing, keys,
     onboarding, permissions, self-host enrollment
  -> core engine (core.singulancelabs.com): memories, ingestion, recall,
     graph, connectors, privileged product APIs
  -> tenant storage resolution:
       personal: .amr
       managed enterprise: central PostgreSQL + Qdrant
       self-host enterprise: customer Box PostgreSQL + Qdrant / supported .amr
```

Supporting services include PostgreSQL, Qdrant, Redis, Nango/connectors,
employees-service, document processing, Caddy, and TARA voice sidecars. Exact
container inventory is live state; inspect it before changing it.

## Ownership Boundaries

| Layer | Primary responsibility | Entry points |
| --- | --- | --- |
| Frontend | User experience and display of backend truth | `frontend/Da-vinci/.../HiveMindApp.jsx`, `AppShell.jsx` |
| Control plane | Identity/session, org lifecycle, members/roles, billing, usage, API keys, self-host enrollment | `core/src/control-plane-server.js` |
| Core engine | Memory write/recall, ingestion, graph, connectors, privileged APIs | `core/src/server.js` |
| Memory storage driver | Per-org managed/self-host resolution | `core/src/vector/mneme/remote-backend.js` |
| HyperAgents sidecar | Room orchestration and digital employee behavior | `employees-service/` |
| BYOD Box/broker | Customer memory stores and constrained registration/transport | `byod/agent/server.mjs`, `byod/broker/server.mjs` |

## Storage and Residency

Central PostgreSQL holds global identity, organizations, billing, settings,
API-key metadata, and control-plane data. Memory content/vectors can be
tenant-local by storage mode. See
[`docs/architecture/README.md`](../docs/architecture/README.md) and
[`docs/architecture/03-byod-data-residency.md`](../docs/architecture/03-byod-data-residency.md).

For BYOD, prefer Tailscale/WireGuard with outbound-only customer setup. The
engine reaches only registered customer data endpoints for that organization. A
dedicated public subdomain is not a substitute for authorization, transport
policy, TLS, or network ACLs.

## Invariants To Preserve

- Derive organization scope from authenticated server state, never request-body
  claims or frontend state.
- Apply resolved tenant scope to relational, vector, graph, connector, usage,
  and audit operations.
- Enforce authorization and quotas before expensive work.
- Keep managed and self-host public APIs behaviorally compatible; branch only in
  the storage driver.
- Validate self-host URLs at registration and use. Public agents require HTTPS;
  cleartext is limited to approved private Tailscale transport.
- Treat the browser as untrusted. It may request an action but cannot decide
  plan, role, organization, or usage truth.
