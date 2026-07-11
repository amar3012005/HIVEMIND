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

## 2026-07-11 - BYOD PQC verification

### Result

- Central `hm-core` has both ML-DSA memory and SLH-DSA audit keypairs configured; central PQC integrity is active.
- The central Caddy runtime is v2.11.4, but the BYOD bundle does not include a Caddy/TLS terminator or PQC signer.
- One externally registered self-host Box uses `http` transport. It is bearer-authenticated, but it does not inherit hybrid PQC TLS and its local records are not independently ML-DSA signed.

### Required Remediation

- Do not describe BYOD as PQC protected until the Box transport is migrated to Tailscale/WireGuard or a public HTTPS edge with a verified hybrid-PQC-capable TLS stack.
- Add an optional Box signing keypair and signature verification protocol for write/audit envelopes, with key rotation and backward-compatible staged rollout.

## 2026-07-11 - Control-plane request containment

### Scope

- Added one shared JSON body reader with a 2 MiB default ceiling, configurable through `CONTROL_PLANE_MAX_BODY_BYTES`.
- Malformed JSON now fails explicitly with `400`; oversized bodies fail with `413`.
- Added a single top-level request error boundary so parser errors cannot become unhandled promise rejections or blank connections.
- Stripe raw-body verification uses the same byte ceiling while preserving exact bytes for signature validation.

### Evidence

- `node --check core/src/control-plane-server.js` passed.
- `node --test core/tests/unit/read-json-body.test.js` passed: valid JSON, malformed JSON, and oversized payload coverage.
- `git diff --check` passed.

### Canary Correction

- The first canary probe found ten legacy route-local `.catch()` handlers swallowing parser errors, causing oversized requests to fall through as empty bodies and return route-level `400` responses.
- Removed those local catches so the global request boundary is authoritative and `413` cannot be downgraded or hidden.
- The initial canary image remains isolated from production until rebuilt and re-probed.

### Canary and Production Evidence

- Corrected image `hivemind/control-plane:security-565b6fda` passed on both isolated B2B/B2C control planes: health `200`, malformed JSON `400`, oversized JSON `413`.
- The same immutable image was promoted to `hm-control`; public health and bootstrap returned `200`, malformed JSON returned `400`, and a 3 MiB request returned `413`.
- Production rollback image: `hivemind/control-plane:rollback-request-limits-20260711-093837`.

## 2026-07-11 - BYOD SSRF boundary

### Scope

- Centralized agent URL validation for self-host registration and every remote agent call.
- Public agents require HTTPS; cleartext HTTP is limited to Tailscale CGNAT or `.ts.net` endpoints.
- Rejected loopback, RFC1918 LAN, link-local metadata, embedded credentials, fragments, paths, queries, and unsupported schemes.
- Existing production Box endpoint (`100.109.148.14:8787`) remains valid as Tailscale transport.

### Evidence

- `node --check` passed for control-plane and remote backend modules.
- `node --test core/tests/unit/agent-url-policy.test.js` passed for public HTTPS, Tailscale, loopback, metadata, and credential cases.

### Canary and Production Evidence

- Both isolated B2B/B2C core and control services were healthy on immutable images tagged `security-428929ba`.
- The same images were promoted together; public core health, control health, and bootstrap returned `200`.
- The registered self-host Box remained reachable through its Tailscale URL: authenticated `/v1/stats` returned `200` with numeric memory and relationship counts.
- Rollback images: `hivemind/core-api:rollback-ssrf-20260711-094600` and `hivemind/control-plane:rollback-ssrf-20260711-094600`.

### New Finding

- Core logs show usage-tracker upserts failing with PostgreSQL `42P10` because the deployed table lacks the unique/exclusion constraint required by its `ON CONFLICT` target. This is a separate metering-integrity risk and must be fixed with an additive, production-baselined migration before claiming quota accounting complete.

## 2026-07-11 - API-key metering upsert integrity

### Root Cause

- Production and canary had only `uq_api_key_usage_org_key_month_model_feature`; runtime aggregates on `org_id, api_key_id, month, model` and PostgreSQL could not infer that five-column index.
- Both databases had zero duplicate four-column keys, so the missing unique index can be added without destructive deduplication.

### Change

- Added an idempotent, additive four-column unique index matching the runtime `ON CONFLICT` target exactly.
