# Platform Registry D1 continuation

Current branch: `codex/platform-registry-d1-v1` at `c931872ed556539ac596c84f32aca93d85425820`.

## Verified work

- `0b104e7e`: disabled-by-default Platform Registry Worker foundation, D1 schema, Core client, API-key mirror seam.
- `c931872e`: additive PostgreSQL `platform_registry_outbox` migration with BIGSERIAL revisions; Core dispatch helpers; D1 generic workspace control-record support.
- Focused Core tests: 6/6; Worker contract tests: 3/3; generated Wrangler types and TypeScript check pass; Worker production dry-run passed before the second commit.
- No Cloudflare production D1, R2, Worker secret, Access application, feature flag, database migration, or Core deployment has occurred.

## Exact next action

Implement transactional outbox writes for the Control Plane mutation families in this order: users/organizations/bootstrap, memberships/invites, teams/projects, organization settings/onboarding, entitlements/billing, Memory Box connections, and workspace notifications; add matching replay/import/reconciliation tests before provisioning Cloudflare resources.

## Constraints

- Existing Core has roughly 260 direct Prisma accesses across global control-plane models. Do not replace them wholesale. Keep PostgreSQL as a compatibility projection and migrate only bounded mutation/read families through the adapter.
- Use `PlatformRegistryOutbox.revision` as the only replication ordering source. Never create revisions from timestamps.
- D1 receives hashes/references only for API keys and invitation tokens. Never put raw keys, raw invite tokens, OAuth tokens, or encryption material in D1 or logs.
- Production authority must remain `off` until import, reconciliation, shadow parity, restore-drill, and governed release gates pass.
