# Platform Registry D1 Handoff — 2026-09-02

## Verified state

- Branch: `codex/platform-registry-d1-v1`
- Worktree: `P:\HIVEMIND-worktrees\platform-registry-d1-v1`
- Latest commit: `abb27ad3`
- Remote D1: `hivemind-platform-registry-eu`, verified `jurisdiction=eu`, primary region `EEUR`.
- Remote D1 migration `0001_platform_registry.sql` applied.  The worker is **not deployed** and `PLATFORM_REGISTRY_MODE=off` remains the only configured production mode.
- No browser, login, invitation, onboarding, ingestion, memory, or BYOD request path has been redirected.

## Completed implementation

- `workers/platform-control`: private admission-secret Worker contract, D1 schema, generic workspace records, idempotent event application, and a reconciliation Workflow class.
- `core/src/control-plane/platform-registry-outbox.js`: ordered outbox with database-issued revision, fenced lease claim/recovery, and D1 event-id idempotency based on the outbox UUID.
- `core/prisma/migrations/20260902204000_platform_registry_outbox_leases/migration.sql`: additive lease fields/index.
- API-key lifecycle and workspace-notification creation now write redacted registry events. Existing behavior remains unchanged when registry mode is off.
- `core/src/control-plane-server.js` starts replay only when `PLATFORM_REGISTRY_MODE` is explicitly non-off and service credentials are configured.

## Verified commands

```text
node --test core/tests/control-plane/platform-registry-client.test.js core/tests/control-plane/platform-registry-outbox.test.js
7 pass, 0 fail

npx --prefix workers/platform-control vitest run tests/contract.test.ts
4 files pass, 25 tests pass

npx --yes wrangler d1 execute hivemind-platform-registry-eu --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" --config wrangler.jsonc --env production
registry tables present; served by EEUR/FRA; no customer records imported

npx --yes wrangler deploy --config wrangler.jsonc --env production --dry-run
binding resolves to hivemind-platform-registry-eu; PLATFORM_REGISTRY_MODE="off"
```

## Remaining acceptance work

1. Route user/org/bootstrap, membership/invite, team/project, onboarding/settings, entitlement/billing, and Memory Box mutations through the same atomic outbox contract; eliminate any non-durable direct mirror paths.
2. Add import, paginated reconciliation, parity, replay, and clean-server restore tests. Do not import customer records until this passes.
3. Provision the backup/export path and private Cloudflare Access service-token policy; secrets must be created only through the approved secret stores.
4. Merge a complete reviewed branch into `singulance-main`, apply the Core additive migration through the production governor, and deploy the Worker only with registry mode `off`.
5. Only then run `shadow`, `dual_write`, and the controlled `authoritative` cutover with a write freeze, exact checksum receipt, D1 Time Travel bookmark, and rollback evidence.

## Decisions

- The D1 resource was created using `wrangler d1 create ... --jurisdiction eu`; an EU location hint alone was rejected as insufficient.
- The worker is intentionally not deployed from this session branch. Production deployment must follow `docs/BRANCH_PROTOCOL.md`, `docs/PRODUCTION_RELEASE_PROTOCOL.md`, and `DEPLOY_GOVERNOR.md` from a clean `singulance-main` promotion.
- PostgreSQL remains the sole authority while mode is off; D1 contains schema only, not imported platform data.

## Exact next action

Implement transactionally outboxed organization-membership and invitation lifecycle mutations, with duplicate-delivery and token-digest regression tests.
