# HIVEMIND Security Hardening Journal

## 2026-07-10 - Privileged AI authorization

### Scope

- Restricted all user-facing HyperAgents routes to organization owners/admins, project owners, and team leads.
- Applied the same authorization rule to all TARA API routes in core.
- Kept internal HyperAgents callbacks outside the user-role gate; they retain service-key authentication.
- Added a focused permission regression test for allowed and denied roles.

### Evidence

- `node --check` passed for `permissions.js`, `control-plane-server.js`, and `server.js`.
- `node --test tests/unit/privileged-agent-permissions.test.js` passed: 2/2.
- Frontend production build completed successfully.
- `git diff --check` passed.

### Existing Debt

- `core/tests/unit/billing.test.js` predates the current plan contract and fails on old field names, prices, and feature assumptions. Update it from `core/src/billing/plans.js`; do not alter production plans to satisfy stale tests.
- Referral entitlements and hardened internal-service authentication exist on `codex/production-hardening-runtime` but are not merged into `feat/mneme-foundation`. Reconcile branches before deployment instead of reimplementing them here.

### Next Phase

Merge or rebase onto `codex/production-hardening-runtime`, then verify referral onboarding, entitlement phase transitions, per-feature usage gates, and tenant-scoped project access end to end.

## 2026-07-11 - BYOD transport and customer-box containment

### Scope

- Bounded BYOD agent request bodies to 2 MiB by default and broker enrollment bodies to 64 KiB.
- Added per-source fixed-window rate limits to the agent and broker, returning `429` rather than allowing unbounded request work.
- Added no-store and content-type-sniffing protections to JSON responses.
- Changed broker registry writes to atomic replace with mode `0600`, reducing token exposure from partial writes and permissive files.
- Added customer-box Compose memory/PID ceilings, no-new-privileges, capability drop, and an agent health check.

### Evidence

- `node --check byod/agent/server.mjs` passed.
- `node --check byod/broker/server.mjs` passed.
- `docker compose -f byod/docker-compose.byod.yml config` passed with the new resource and health controls rendered.

### Remaining Work

- Enforce SSRF-safe agent URL policy consistently in the standalone broker, control plane, and core remote client without breaking Tailscale/private transport.
- Add authenticated audit events for enrollment, registration, rotation, and disenrollment without logging credentials.
- Add versioned PostgreSQL/Qdrant snapshot jobs, off-host delivery, restore verification, and alerting after measuring the live host and confirming the active Compose stack.

## 2026-07-11 - Production host resilience baseline

### Measured State

- The 16 GB host had 11 GB available memory and low CPU load during the check; there was no justification for disruptive cleanup.
- Root disk was 85% used (243 GB of 301 GB, 46 GB free). Disk exhaustion is therefore the immediate availability risk.
- Both the primary `hm-*` stack and the isolated `hivemind-next-*` B2B/B2C canary stack were running. The canary must be retired only after a documented route, rollback, and data-safety check.
- No application PostgreSQL/Qdrant backup timer was discovered; only the OS package database timer was scheduled. Existing backup/restore scripts and an encryption key file exist, but scheduled off-host backup and a restore drill are not yet evidenced.

### Next Phase

- Add a production-safe backup runner with explicit destination/secret configuration, health/freshness checks, and a restore verification procedure.
- Before changing Compose limits or removing canaries, capture `docker inspect` limits, active Caddy routes, image rollback tags, and data-volume ownership.
