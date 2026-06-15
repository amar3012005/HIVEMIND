# HIVEMIND Migration Runbook — Expand / Contract (zero-downtime DB changes)

**Why this is non-negotiable:** the deploy pipeline (`DEPLOY_RUNBOOK.md`) makes the
*app* safe — immutable tags, health gate, rollback. It does **nothing** for the DB.
Postgres is shared by every replica AND every app version. A single breaking
migration sinks all of them at once — blue, green, old, new. Blue-green and canary
are worthless without migration discipline. This is the one rule that matters at
every scale, from today to $100M.

## The rule

**Never ship a migration the currently-running code can't tolerate.** During any
deploy there is a window where OLD code and NEW schema (or NEW code and OLD schema)
run together. Both must work. You get there with **expand → migrate → contract**,
split across *separate deploys*:

```
1. EXPAND   (deploy A)  Add the new thing, nullable/optional. Old code ignores it.
2. WRITE-BOTH (deploy A) New code writes BOTH old + new. Old code still reads old.
3. BACKFILL (job)       Populate the new column/table for existing rows. Idempotent, batched.
4. READ-NEW (deploy B)  New code reads the new thing. Old code (rolled back) still works on old.
5. CONTRACT (deploy C)  Once NO running code references the old thing, drop it.
```

Each step is independently deployable and independently rollback-safe. You can stop
or roll back between any two steps without breaking either version.

## Forbidden in a single deploy (these are the foot-guns)

- ❌ `DROP COLUMN` / `DROP TABLE` / rename — old code still selects it → 500s.
- ❌ `ALTER COLUMN ... NOT NULL` without a prior backfill → insert failures from old code.
- ❌ Renaming a column (= drop + add). Add new, dual-write, backfill, switch, drop.
- ❌ Changing a type in place. Add a new column of the new type, migrate, swap.
- ❌ A unique constraint that existing rows violate, or that the old write path violates.
- ❌ `CREATE INDEX` (non-concurrent) on a large hot table → write lock → stall.

## HIVEMIND-specific musts

- **Always `CREATE INDEX CONCURRENTLY`** on `memories` and other hot tables. It can't
  run inside a txn, so it's migration-only + applied out-of-band (see live examples below).
  Prisma can't express partial `WHERE` indexes — those are migration-only too, documented
  with a `// migration-only` comment in `schema.prisma`.
- **Two replicas + shared Redis/BullMQ**: a migration that changes a queue/job shape must
  tolerate in-flight jobs enqueued by the old code. Version the payload or drain first.
- **`prisma migrate deploy` runs on container start** (Dockerfile CMD). So a new image
  applies its migration as it boots — which means the migration must be safe for the OTHER
  still-running replica on the old code. Expand/contract guarantees that.
- **Migrations must be idempotent** (`IF NOT EXISTS` / `IF EXISTS`) — the box has historically
  applied SQL out-of-band, so `migrate deploy` may re-encounter an already-applied change.

## Worked examples from this codebase (good + bad)

**GOOD — additive, idempotent, concurrent (H8 GIN index):**
`20260615130000_synthesis_evidence_gin` →
`CREATE INDEX IF NOT EXISTS ... USING GIN (synthesis_evidence_ids)` — applied live with
`CREATE INDEX CONCURRENTLY`. Pure expand, zero risk to running code.

**GOOD — partial unique backstop (C1):**
`20260615150000_one_latest_synthesis_per_cluster` — `CREATE UNIQUE INDEX IF NOT EXISTS …
WHERE …`. Verified 0 existing violators FIRST, then created CONCURRENTLY. Safe because the
write path was already serialized (advisory lock) before the constraint landed.

**THE TRAP WE HIT — unique swap (M6):** changing `UserProfile` unique from `(userId,key)`
to `(userId,orgId,key)` required `DROP CONSTRAINT` + new index. This is a contract step
disguised as one migration. It only worked because: (a) 0 rows had null `org_id`, (b) the
new key was strictly *more permissive* (no row could collide), and (c) the new Prisma client
(`userId_orgId_key` accessor) was deployed in the SAME push. A stricter swap would have
needed: add new unique (expand) → deploy code using it (write-both/read-new) → drop old
(contract), across separate deploys. **Treat any constraint change as expand/contract by default.**

## Procedure

1. Write the migration as **expand-only** (additive, nullable, `IF NOT EXISTS`).
2. For hot-table indexes: apply `CONCURRENTLY` out-of-band on the box first, and put
   `CREATE INDEX IF NOT EXISTS` (no CONCURRENTLY) in the migration file so `migrate deploy`
   is a no-op replay.
3. Deploy code that dual-writes (if a column/table is being replaced).
4. Run the backfill as a batched, idempotent, resumable script (e.g. `core/scripts/*.mjs`),
   not inside the migration.
5. Deploy code that reads the new thing. **Verify a rollback to the prior image still works.**
6. Only after no running code references the old thing: ship the CONTRACT migration (drop).
7. Each step: deploy via `scripts/deploy-image.sh`, health-gated, rollback-ready.

## Pre-deploy checklist (every migration)

- [ ] Additive / nullable? If not, where's the prior backfill + dual-write?
- [ ] Old (current prod) code still works against this schema?
- [ ] New code still works if rolled back to the old schema?
- [ ] Indexes on hot tables `CONCURRENTLY` + `IF NOT EXISTS`?
- [ ] Idempotent on replay?
- [ ] No constraint that existing rows or the old write path violate?
- [ ] Backfill batched + resumable (not one giant `UPDATE`)?
