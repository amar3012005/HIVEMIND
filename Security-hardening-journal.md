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

### Next Phase
- Map BYOD broker authentication/TLS and expose it only through a named Caddy route.
- Enable a restrictive host firewall after confirming SSH access and the complete public ingress inventory.
