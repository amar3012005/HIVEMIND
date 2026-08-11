# Cognition v2 — entity dreaming on the org's own daily quota

Status: **design only, not built.** Reconstructed 2026-08-07 after the original
plan file (`/Users/amar/.claude/plans/so-make-me-a-expressive-lemur.md`) was
overwritten by a later, unrelated plan in the same session before being copied
here. If this drifts from that turn's original wording, this version is the one
to trust — it was re-derived from the same exploration findings, re-verified.

## Context

Dreaming is the phase that turns indexed chunks into graph facts. On
2026-08-06 it broke visibly in production:
`[gov-cycle] shared token pool exhausted (spent=1014339/1000000)` stopped
dreaming for **two orgs at once** — 29 and 50 hot clusters skipped.

The pool is one row, `agent_name='__pool__'`, in `governance_agent_state`. That
table **has no `org_id` column** (`core/prisma/schema.prisma:4081-4095`), so
every row in it is global. One tenant's dreaming consumes the platform's
budget and every other tenant stops until the daily reset. The cycle lock has
the same defect: a single `agent_name='governance-cycle'` row
(`run-manager.js:845-866`), so orgs serialise against each other
platform-wide, not just share a budget.

`PHASE_E_BUDGET_POOL=false` was applied to production the same day to remove
the unfair cap. That leaves **no cap at all**: the legacy fallback queries
`agent_name IN ('faraday','feynman','turing')`, rows that do not exist, so it
can never fire, and `affordTier()` returns true unconditionally when the pool
is disabled.

Meanwhile the org **already has** a real per-tenant daily budget in billing —
`llmTokensPerDay` per plan (100k / 1M / 10M / -1,
`core/src/billing/plans.js:56,94,131,173`), real daily spend in
`OrgUsageDaily.tokensProcessed`, and a ready-made check,
`PlanEnforcer.checkLimit(orgId, 'tokens', amount)`
(`core/src/billing/plan-enforcer.js:173`), returning
`{allowed, limit, current, plan}`.

**Outcome:** dreaming stops being a platform-wide shared resource and becomes
each org spending its own leftover daily allowance, at end of day, on the
entities that actually changed — with the dead governance-budget machinery
deleted rather than left as decoration.

## Decisions already taken (from the user, that session)

- Dream tokens **count fully against** the org's `llmTokensPerDay` (not a
  separate free allowance).
- Entity dreaming **replaces** tag-bucket clustering as the dream unit.
- Dead paths are **deleted outright**, not left disabled-but-present.

## Current behaviour worth knowing before editing

- **Two dreaming systems, and the wrong one is wired to the signal.**
  `runFullCycle()` (`run-manager.js:804`) runs the Faraday→Feynman→Turing
  swarm. `cognitionLoop.runOnce()` (`cognition-loop.js:540`) runs the actual
  synthesis (`synthesizeForOrg` → compact → principles → reweight). Scheduler
  lane C (scheduled deep dream) calls `runOnce` — correct. Lane B (WS1 early
  dream) calls `runFullCycle` — the swarm — so the dirty-cluster signal it
  just computed is **discarded**: `hot` at `scheduler.js:280` is used as a
  boolean and never passed on.
- **A "cluster" is a topic tag bucket**, `cognition-loop.js:930-945`: every
  non-system tag becomes a bucket, a memory joins one bucket per tag,
  `hash = clusterHash('canonical:' + tag)` (`cluster-hash.js:15`).
  `cluster_index.entity_keys` is derived from tag prefixes
  (`deriveEntityKeysFromTags`, `cognition-loop.js:252-269`) — **not** from the
  `MemoryEntityLink` registry. The two linkage systems are independent today.
- **The pool is always debited a flat 15,000** — `spendPool` is called with
  `tierTokenEstimate ?? totalCycleTokens` (`run-manager.js:1346`) and no
  caller ever passes `tierTokenEstimate`; Feynman/Turing usage is never
  measured (`GOV_FALLBACK_TOKENS_PER_RUN`, 5000 × 3). Today's accounting is
  fiction in both directions.
- Scheduler real cadence is **30 min**, not the 1h/4h/12h its own comments
  claim (`server.js:1420` passes `GOVERNANCE_INTERVAL_MS` default 30 min).

## Design

### 1. Budget = the org's own remaining daily quota

New module `core/src/resident/dream-budget.js`:

```
remainingDailyTokens(orgId) -> { limit, used, remaining, unlimited, plan }
```

Built on `PlanEnforcer.checkLimit(orgId, 'tokens', 0)` and
`usageTracker.getDailySnapshot(orgId)` — both already exist; do not
re-implement either. `llmTokensPerDay === -1` ⇒ `unlimited: true`.

Gate every dream on it, and **cap the run** to what is left. Meter real dream
spend with the existing `meterTokens(orgId, n, null, model, 'cognition')`
(`core/src/billing/usage-tracker.js:30`) so it counts against the same quota
and is attributable by feature — this also closes the existing
`[enterprise-extract] LLM call with no org context` attribution gap for this
path.

Fail **closed** when the quota read fails: skip with a recorded reason. The
old `affordTier` failed open, which is how unbounded spend became possible in
the first place.

### 2. End-of-day, on the remainder

Keep the three existing schedule modes on `organizations.cognition_schedule_mode`
(nightmode / interval / continuous) — no new settings columns for scheduling.
Change what the scheduled lane *does*: at the org's window it computes
`remainingDailyTokens(orgId)` and dreams **within that envelope**, dirtiest
entities first, stopping when the envelope is spent. A day where the org used
its whole allowance simply gets no dream — visible in the UI, not silent.

### 3. Entity as the dream unit

`cluster_index` already has `entity_keys` (GIN-indexed) and a unique
`(organization_id, user_id, cluster_hash)`. Reuse the table; change what a
row means:

- `cluster_type = 'entity'`, `cluster_hash = clusterHash('entity:' + <canonical entity id>)`.
- Membership comes from `MemoryEntityLink` (the registry), not tag buckets.
- `bumpDirty` continues to be called at ingest (`graph-engine.js:499`) but
  keyed by entity, so "Solvis changed" is what marks work, and untouched
  entities cost nothing.

Selection order for a run: `getDirtyClusters({minDirty, limit})` (already
exists, `cluster-index.js:94`) → per entity, fetch members → synthesize →
`upsertOnSynthesis` resets `dirty_count`.

**Two schema gaps must close first**, found during exploration:
- `memory_entity_links.memory_id` has no index and no FK — reverse lookup is
  a seq-scan. Add an index.
- `canonical_entities` has **no unique constraint**; dedup is
  application-only, which is what caused earlier fragmentation and a
  2026-08-03 merge backfill. Add
  `@@unique([organizationId, normalizedName, entityKind])` behind a dedupe
  migration.

**Coverage risk, stated plainly:** memories with no entity link would stop
being dreamt. Two mitigations, both required: call `persistCanonicalLinks` on
the plain memory-save path (today only called from three places in
`document-first-ingestion.js` — `:1305`, `:1788`, `:3497` — so chat/connector
memories never register entities at all), and keep one
`cluster_type='untagged'` sweep for entity-less memories using the leftover
envelope.

### 4. Per-org locking

Change the cycle lock from the single `governance-cycle` row to
`agent_name = 'governance-cycle:<orgId>'` — same table, same mechanism, same
`circuit_breaker_until` expiry, no migration. Matches the pattern the
early-dream claim already uses (`scheduler.js:318`).

### 5. Wire the signal that already exists

Lane B must call
`cognitionLoop.runOnce(orgId, { entityHashes, trigger:'early_dream' })` and
pass the dirty entities it computed, instead of `runFullCycle`. Highest
value-to-effort change in the plan: it makes early dreaming actually targeted
for close to zero new code.

## Phases

Each phase is independently shippable and verifiable. No phase leaves the
tree half-migrated.

**P1 — Budget truth (no behaviour change to what is dreamt)**
- Add `core/src/resident/dream-budget.js`.
- `run-manager.js`: replace the pool block (`:872-924`) with the per-org
  check; make the cycle lock per-org (`:845-866`).
- Meter real dream spend via `meterTokens(..., 'cognition')`; remove the
  flat-15k fiction.
- **Delete**: `core/src/resident/budget-pool.js` entirely, the
  `faraday/feynman/turing` exhausted branch, `tierTokenEstimate` (never
  supplied), `PHASE_E_*` env vars.
- Keep `PHASE_E_BUDGET_POOL` recognised for one release **only**, to log a
  loud "ignored, superseded by per-org quota" if still set, then remove.

**P2 — Schema + entity linkage**
- Migration: index on `memory_entity_links.memory_id`; unique on
  `canonical_entities (organization_id, normalized_name, entity_kind)`
  preceded by a dedupe/merge step reusing `entity-resolver.js:331 mergeEntities`.
- Call `persistCanonicalLinks` from the plain memory-save path.

**P3 — Entity dreaming**
- `cognition-loop.js`: entity-keyed selection replaces the tag-bucket loop
  (`:930-945`); bridges and narrative passes key off entity pairs.
- `graph-engine.js:499`: `bumpDirty` by entity.
- Retain a single `untagged` sweep for entity-less memories.

**P4 — Wire lane B + delete dead code**
- Lane B calls `runOnce` with the dirty entity set.
- **Delete**: `cognition-pilot.js:53 cognitionOrgScopeEnabled`, `:92
  selfEvolveEnabledForProject` (both zero callers); `cognition-loop.js:180
  isPrinciplesEnabled`, `:183 isDreamRetentionEnabled` (zero importers); the
  dead standalone timer path `cognition-loop.js:757-816` plus
  `ENABLE_COGNITION_LOOP_TIMER`, `COGNITION_MAX_ORGS_PER_TICK`,
  `COGNITION_TIMER_ALLOW_COMPACTION`; `cluster_index.last_recall_at` /
  `recall_count_30d` (written, never read).
- Fix the stale comments that contradict behaviour: `budget-pool.js:15-20`
  (pool default), `cognition-loop.js:171` (principles default),
  `scheduler.js:32-34,202-206` (1h/4h/12h vs real 30 min).

**P5 — FE: make it legible**
- `CognitionSettings.jsx` already renders settings, run history and "Dream
  now". Add the telemetry the API **already returns and the UI ignores**
  (`server.js:13040` run rows carry `compact_count`, `principle_count`,
  `reweighted_count`): tokens spent today vs remaining quota, entities
  dreamt, and the reason when a run is skipped (`quota_exhausted` reads very
  differently from "nothing happened").
- Extend `governance-routes.js:44-168` GET with the budget snapshot. No new
  write fields.

## Files

| File | Change |
|---|---|
| `core/src/resident/dream-budget.js` | **new** — the only new module |
| `core/src/resident/budget-pool.js` | **delete** |
| `core/src/resident/run-manager.js` | per-org budget + per-org lock; drop pool/legacy branch |
| `core/src/resident/scheduler.js` | lane B → `runOnce` with entities; lane C envelope |
| `core/src/memory/cognition-loop.js` | entity-keyed selection; delete dead timer path |
| `core/src/memory/cluster-index.js` | entity cluster_type; drop unread recall columns |
| `core/src/memory/graph-engine.js` | `bumpDirty` by entity |
| `core/src/memory/canonical-entity-persister.js` | call from plain save path |
| `core/src/resident/cognition-pilot.js` | delete two dead exports |
| `core/src/resident/governance-routes.js` | GET returns budget snapshot |
| `core/prisma/migrations/<new>` | link index + entity unique (with dedupe) |
| `frontend/Da-vinci/.../CognitionSettings.jsx` | budget + entity telemetry |

Reuse, do not rebuild: `PlanEnforcer.checkLimit`, `usageTracker.getDailySnapshot`,
`meterTokens`, `ClusterIndex.getDirtyClusters/bumpDirty/upsertOnSynthesis`,
`clusterHash`, `EntityResolver.mergeEntities`, `withGovernanceLock`,
`normalizeEntity`/`entityMatchVariants`.

## Verification

Existing tests to keep green: `core/tests/unit/scheduled-dream.test.js`,
`dream-retention.test.js`, `workspace-cognition-contract.test.js`.

Per phase, on SINGULANCE — verify the **running container**, not the deploy
log (`KB_PIPELINE_ARCHITECTURE.md` §9.1):

- **P1** — set a test org's plan to a small `llmTokensPerDay`, burn most of
  it, trigger "Dream now": the run must skip with `quota_exhausted` and
  record it in `cognition_run`. A second org must dream **in the same
  window** (proves the global lock is gone) — this is the exact failure from
  2026-08-06 and is the regression test for the whole plan. Confirm
  `OrgUsageDaily.tokensProcessed` rises by roughly the dream's real usage,
  not 15,000.
- **P2** — migration up **and down**; assert no duplicate
  `(org, normalized_name, kind)` survives the dedupe; `EXPLAIN` the
  entity→memories query shows an index scan.
- **P3** — ingest two documents about one entity, confirm exactly one entity
  cluster goes dirty and only that entity is dreamt; confirm an entity-less
  memory is still covered by the untagged sweep.
- **P4** — grep the running container for each deleted symbol: zero hits.
- **P5** — screenshot the tab showing remaining quota and a skipped-for-quota
  run.

End-to-end acceptance: on a real org with `nightmode`, one dream fires in the
window, spends ≤ the remaining quota, produces entity-scoped memories, and
the tab shows what it cost.

## Out of scope

Per-entity user controls ("dream this customer nightly"), cross-org entity
resolution, and changing the Faraday/Feynman/Turing swarm itself — it stays
as the proposal engine; only its budget and lock change.

## Since this plan was written

- `PHASE_E_BUDGET_POOL=false` is live in production (2026-08-06) — the global
  cap is already off. P1's per-org replacement has not been built, so
  dreaming currently runs with no ceiling at all.
- The `Extends`/`Contradicts` misclassification investigation
  (`KB_PIPELINE_ARCHITECTURE.md` §5.4, if present, else see the 2026-08-06/07
  session) is a related but separate defect in `cognition-loop.js`'s
  contradiction reconciler, not in this plan's scope, but touches the same
  file (§3's entity-keyed selection) — sequence P3 and that fix carefully so
  one does not silently undo the other's edge-type logic.
