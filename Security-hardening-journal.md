# Security Hardening Journal

## Phase 1 - Edge and Network Exposure (2026-07-10)

### Context
- Production is a single Hetzner host behind Caddy, with public B2C and B2B traffic.
- Prior work hardened runtime dependencies, removed disabled TLS verification, and added rollback images/snapshots.

### Findings
- `hm-core` (2026), `hm-control` (2027), and Nango (3003) were Docker-published on all interfaces despite Caddy being their intended public gateway.
- UFW is inactive. Docker-published ports can bypass host firewall rules, so binding internal services to loopback is the first reliable control.
- The BYOD broker port 8790 is publicly bound. It is intentionally not changed in this phase until its remote-agent ingress contract is verified.

### Change
- Bound Core, Control Plane, and Nango host ports to `127.0.0.1` in production Compose.
- Caddy continues to proxy the existing public domains to these loopback ports.

### Validation Required After Deploy
- `core.singulancelabs.com`, `api.singulancelabs.com`, and `nango.singulancelabs.com` remain reachable through Caddy.
- Ports 2026, 2027, and 3003 are no longer listening on `0.0.0.0` or `[::]`.

### Follow-up
- Nango listens on container port 8080. Corrected the host mapping from 3003:3003 to 127.0.0.1:3003:8080 after the hardened recreation exposed the mismatch.
- Nango migrations required `public.uuid_generate_v4()` while `uuid-ossp` is installed in the shared `hivemind` schema. Added a compatibility wrapper that delegates to `hivemind.uuid_generate_v4()`; the extension itself was not moved.

### Next Phase
- Map BYOD broker authentication/TLS and expose it only through a named Caddy route.
- Enable a restrictive host firewall after confirming SSH access and the complete public ingress inventory.

## Phase 2 - BYOD Broker Boundary (2026-07-10)

### Change
- Restricted broker enrollment keys to organizations with `hosting_mode = self_host`.
- Rejected public cleartext agent and instance URLs; HTTPS is required unless the address is loopback, private LAN, or Tailscale.
- Bound the broker host port to loopback. Public enrollment must be routed through Caddy over HTTPS.

### Deployment Validation
- Caddy now routes `https://api.singulancelabs.com/v1/byod/*` to the loopback broker.
- The enrollment endpoint returns `401` without an API key; direct host port 8790 is no longer public.
- Caddy required a container restart after the host Caddyfile was atomically replaced, because the bind mount retained the prior inode.

## Phase 3 - Broker Least Privilege (2026-07-10)

### Change
- Broker database configuration is separated from the application database credential via `BROKER_DATABASE_URL`.
- Role scope: connect to the shared database, use `hivemind` schema, and read only the API-key hash/revocation/org fields needed for self-host enrollment.

### Validation
- Broker runs as `hivemind_broker`; unauthenticated HTTPS enrollment returns `401`.
- A query for the `memories` table from inside the broker container is denied.

## Phase 4 - Standalone Edge Service Exposure (2026-07-10)

### Finding
- Four legacy standalone containers are still published directly on all interfaces: frontend `8088`, TARA AAAS `8090`, TARA Deepgram `8091`, and waitlist relay `8095`.
- Caddy is host-networked and is the intended public ingress for each service.

### Attempt and Rollback
- Rebinding the four Docker ports to `127.0.0.1` was attempted with preserved rollback containers.
- The frontend became unavailable through Caddy (`502`). The replacement frontend mapping also targeted container port `8088`, while its embedded Caddy listens on `80`; host-networked Caddy traffic to Docker's loopback-published proxy reset rather than reaching the service.
- All four containers were restored from their preserved rollback copies. Public verification after rollback: main frontend `200`, core health `200`, and unauthenticated BYOD enrollment `401`.

### Required Design Before Retrying
- Do not repeat the direct loopback port remap on this host topology.
- Migrate the Caddy ingress and these services to a shared Docker network, then proxy by service name, or move each standalone service to host networking with an explicit loopback listener.
- Keep the existing direct port exposure until that migration is tested atomically with a rollback plan. Do not rely on UFW alone because Docker-published ports bypass ordinary host firewall policy.
