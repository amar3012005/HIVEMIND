-- Reconcile two additive production columns with the canonical Prisma model.
-- Existing production installations already carry these columns; fresh and
-- restored installations must receive the same contract idempotently.
ALTER TABLE "hivemind"."memories"
  ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMPTZ(6);

ALTER TABLE "hivemind"."canonical_entities"
  ADD COLUMN IF NOT EXISTS "identity_key" VARCHAR(500);
