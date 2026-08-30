# Phase 0 — Canonical Knowledge Foundation

## Contract

`relationships` remains memory lineage only: `Updates`, `Extends`, `Derives`,
`Contradicts`, and `PartOf`. Entity predicates are stored in
`canonical_claims`; their source support is stored in
`claim_evidence_links`. Existing memory request and response shapes remain
unchanged while the feature is off.

The multivariate Flagship flag is `canonical_knowledge_foundation_v1` with
`off`, `shadow`, `write`, `read`, and `full`. Core also requires
`CANONICAL_KNOWLEDGE_ENABLED=true`; `CANONICAL_KNOWLEDGE_KILL_SWITCH=true`
wins immediately. Evaluation is tenant-and-user scoped, fails closed, and the
selected variation is latched in `memory_projection_states`.

## Durable repair

Cloudflare Queue messages and Workflow parameters contain exactly:

```json
{
  "memory_id": "uuid",
  "org_id": "opaque uuid",
  "processing_version": 1,
  "required_projection": "shadow|write|read|full"
}
```

No memory content crosses Queue or Workflow state. The Workflow uses
`claim-{memory_id}-v{processing_version}` and checkpoints `load`,
`reconstruct`, `resolve`, `normalize`, `persist`, `reconcile`, and `complete`.
Core reloads the authorized memory and authenticates each callback with a
timestamped HMAC-SHA256 signature plus a durable nonce replay fence.

Semantic authority remains either central PostgreSQL or the tenant's Memory
Box. Embedded, hybrid, and BYOD stores expose the same canonical projection and
claim-read capabilities. A remote failure remains a repairable projection
state; it must not fall through to central semantic storage.

## Canary invariant

Memory `74fb72fc-08da-41cc-8c56-598eae67bfee` must yield exactly:

```text
Uwe Egly (person; subject, actor)
  -- teaches -->
Deep Learning (technology; object, technology)
valid_from: 2026-08-31 Europe/Berlin
assertion_status: user_asserted
evidence: exact original memory text
memory-lineage edges: 0 unless an explicit replacement exists
```

An explicit later statement containing a replacement cue such as “instead”
may supersede the prior active claim and create one `Updates` memory-lineage
edge to its source memory. Ordinary co-mention never creates a lineage edge.

## Local verification

```powershell
cd core
$env:DATABASE_URL='postgresql://...local...'
node --test tests/memory/canonical-knowledge.test.js
node scripts/verify-canonical-phase0.mjs

cd ../workers/canonical-projection
npm run check
npm test
npm run dry-run
```

The database verifier runs twice inside a rollback-only transaction and must
report one claim, two entities, one evidence link, and zero lineage edges.
The signed HTTP acceptance invokes all seven stages and verifies persisted
counts before deleting only its exact synthetic canary.

## Rollout and rollback

1. Back up PostgreSQL and verify its checksum.
2. Apply the additive Prisma migration.
3. Deploy Core, Memory Box agent, Worker, and frontend with the environment
   switch/Flagship default off.
4. Enable `write` only for the exact Uwe owner user and organization.
5. Backfill the one memory; verify claim, roles, evidence, replay counts, API,
   UI, recall/chat, and clean logs.
6. Advance the same pair through `read`, then `full`, only after central and
   BYOD parity passes. Everyone else remains on `off`.

Immediate semantic rollback is Flagship `off`; the environment kill switch is
the second guard. Schema rollback is not required because all new tables and
response fields are additive. Never delete claim history during rollback.
