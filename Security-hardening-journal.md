# HIVEMIND Security Hardening Journal

## 2026-07-11 - Qdrant client/server compatibility pin

### Finding

- Private core smoke exposed `@qdrant/js-client-rest` `1.17.0` talking to the
  Compose-pinned Qdrant server `1.12.4`. The client reports that the minor gap
  exceeds its supported compatibility window.

### Change

- Replaced loose `^1.11.0` dependency resolution with exact client `1.13.0`,
  the newest published release within one minor of server `1.12`.
- Did not upgrade the stateful Qdrant server or touch tenant vector volumes.

### Evidence

- Manifest, lockfile, and installed client all resolve to `1.13.0`.
- Vector/recall tests passed; one external semantic-recall integration test is
  intentionally skipped without its external prerequisite.

## 2026-07-11 - Isolated memory-admission release artifact

### Evidence

- Built `hivemind/core-api:memory-admission-c9161abb` from clean detached
  checkout commit `3882d23b`; the live dirty checkout was not used.
- Parsed `src/server.js` inside the image successfully.
- The build briefly left duplicate BuildKit clients after image export; only
  those agent-started build processes were terminated after the image tag was
  confirmed. No application container was changed.
- Primary public core and control health remained `200`.

### Promotion Rule

- The artifact is ready for a controlled rollout, but must not replace public
  B2B/B2C canary services while those domains receive traffic. Create a private
  or explicitly scheduled rollout target first, retain the running image as a
  rollback tag, then verify core health, bootstrap, and an authenticated ingest
  smoke before primary promotion.

## 2026-07-11 - Host disk-pressure remediation

### Evidence

- Primary core, control, and production frontend endpoints returned `200` before
  and after the operation.
- The host had 29 active containers. B2B/B2C canary frontends had real recent
  requests, and their maintenance workers are active against canary data stores;
  no runtime containers or volumes were stopped or removed.
- The specific removable pressure was BuildKit cache: approximately 108.8 GB.
  Targeted cleanup removed only cache entries older than 24 hours; Docker images,
  rollback tags, containers, and data volumes were retained.
- Root disk use fell from 85% (46 GB free) to 80% (60 GB free).

### Follow-Through

- Keep image rollback tags until the documented service-retirement gate is met.
- Retire canary routes/services only after an explicit traffic cutover and a
  data/rollback review. Do not use generic Docker system prune on this host.

## 2026-07-11 - Memory ingestion admission and raw-ingest isolation

### Scope

- Bounded asynchronous core ingestion admission: six active jobs by default and
  48 queued jobs by default. Saturation now rejects new work with retryable
  `503` and `Retry-After` instead of accumulating an unbounded in-process queue.
- Preserved FIFO queueing and the existing safety release for hung jobs.
- Corrected `skipProcessing` so raw/bulk ingest skips relationship inference as
  well as fact extraction, while explicit caller-provided relationships still
  work.
- Updated temporal recall coverage to pin the current intentional wide-pool
  behavior and disable unrelated optional entity/query expansion in that unit.

### Evidence

- `node --check core/src/server.js` passed.
- Focused admission, ingestion, recall, tenant URL, and relationship semantics
  tests passed.

### Operational Finding

- Production primary core/control/frontend endpoints are healthy. B2B/B2C
  canary routes remain publicly configured in Caddy, so their containers are
  not safe to prune until route retirement, rollback, and data-volume checks
  are completed.

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

### Canary and Production Evidence

- Canary and production duplicate audits found zero conflicting four-column keys.
- Applied the index first to canary, then production, with explicit `hivemind` schema selection because these databases are not Prisma-baselined.
- On each database, two exact runtime-shaped upserts produced a single row with `tokens_processed=2` inside a transaction that was then rolled back.
- Production catalog confirms `uq_api_key_usage_org_key_month_model` exists. No containers or customer rows were modified by the verification transaction.

## 2026-07-11 - Audit-log immutability

### Root Cause

- Production protected PQC audit signatures and checkpoints, but `hivemind.audit_logs` itself had no update/delete guard.
- Three `ON DELETE SET NULL` foreign keys could rewrite historical actor, organization, and resource identifiers.
- Existing retention code only marked rows as archived; it did not perform the documented off-host upload, so those mutations were not valid archival evidence.

### Change

- Removed mutable audit foreign keys and added the existing owner-resistant append-only trigger to `audit_logs`.
- Cold-storage archival remains a separate open phase and must export immutable rows rather than update them.

### Canary and Production Evidence

- Applied first to canary, then production with explicit `hivemind` schema selection.
- In each database, a rollback-only transaction inserted a synthetic audit row and proved both UPDATE and DELETE raise the append-only guard.
- Production catalog exposes `audit_logs_append_only` for both UPDATE and DELETE.
- Verification left no synthetic audit rows and required no service restart.

## 2026-07-11 - PostgreSQL backup restore drill

### Evidence

- Production cron creates encrypted PostgreSQL backups daily at 03:30 and retains seven local copies.
- Latest backup decrypted and passed gzip integrity with the production PBKDF2 setting of 200,000 iterations.
- Restored into a disposable database and verified 102 `hivemind` tables, 9 users, 7 organizations, and 341 memories; the verification database was dropped automatically.

### Fix and Remaining Risk

- Repository backup/restore scripts previously hard-coded 100,000 iterations while production used 200,000; both now share configurable `BACKUP_PBKDF2_ITERATIONS` defaulting to 200,000.
- Restore no longer incorrectly requires `pg_restore` for a plain-SQL dump consumed by `psql`.
- Backups remain local-only and Qdrant snapshot scheduling/freshness alerting remains open; host loss would still remove local backups.

## 2026-07-11 - Qdrant encrypted snapshots

### Scope

- Added a locked native full-snapshot job covering every Qdrant collection.
- Verifies Qdrant's plaintext SHA-256 before encryption, encrypts with the shared PBKDF2 policy, verifies decryption against the server checksum, and retains seven copies.
- Removes the temporary plaintext snapshot from both backup directory and Qdrant after completion; only encrypted archives remain.

### Production Evidence

- Native full snapshot covered 15 collections and produced a 25 MB encrypted archive.
- Server checksum, encrypted-file checksum, and decrypt-to-server-checksum verification passed.
- No plaintext or partial snapshots remained; freshness marker exists.
- Scheduled daily at 04:15, after the 03:30 PostgreSQL backup.

### Remaining Risk

- PostgreSQL and Qdrant backups are still stored on the production host. Off-host object storage credentials/destination are not configured, so host-loss resilience remains incomplete.

### Freshness Monitoring

- Added one host check for PostgreSQL/Qdrant age and root-disk pressure: stale after 26 hours, disk warning at 80%, critical at 90%.
- Security Center status now distinguishes verified local backup/restore controls from the still-open off-host requirement.

## 2026-07-11 - Production secret fail-closed startup

### Root Cause

- Control-plane source contained repeated fallback use of a committed master API key.
- Session signing could start in production with the literal fallback `change-me`.

### Change and Evidence

- Centralized internal master-key use on one runtime-only value and removed every source fallback in the control plane.
- Production now refuses startup when the master API key is absent or the session secret is absent/default.
- Focused process tests proved each missing-secret condition exits with the expected failure; syntax and diff checks passed.

### Rotation Requirement

- Credential-shaped values remain in tracked docs/examples and Git history. Removing current-tree copies is not rotation; the live master key must be replaced after all consumers are inventoried and updated atomically.

### Current-Tree Remediation

- Replaced the committed master-key value in tracked instructions, journals, setup docs, and frontend references with a non-secret placeholder.
- Executable probes, SDK examples, phase-zero tests, and local Compose now require environment-provided credentials instead of silently using a fallback.
- Current root and frontend tracked trees no longer match the leaked master-key pattern. Git history still contains it, so live rotation remains mandatory.

### Production Rotation Evidence

- Generated a new random `hm_live_` master key on the production host without printing or transferring it.
- Atomically recreated core, control, employees, TARA AaaS, and TARA Deepgram with the new credential.
- Core/control/TARA/Deepgram health returned `200`; the new key authenticated to the protected PQC endpoint and the revoked key returned `401`.
- Removed stopped rollback containers and 18 host files containing the revoked key; no running container retains it.
- Git history still contains the revoked value, but it no longer grants runtime access. Remaining rotation drills: Stripe webhook secret, BYOD agent token, and PQC signing keys.
