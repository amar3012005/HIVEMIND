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
