-- WS5 (evolving profile / dreaming): additive, backward-compatible.
-- evidence_memory_ids: per-fact grounding lineage (uuid[]), default empty.
-- last_dreamed_at: when the profile-dreamer last re-synthesized this user.
ALTER TABLE "hivemind"."user_profiles"
  ADD COLUMN IF NOT EXISTS "evidence_memory_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "last_dreamed_at" TIMESTAMP(3);

-- DOWN (manual, tested):
-- ALTER TABLE "hivemind"."user_profiles"
--   DROP COLUMN IF EXISTS "evidence_memory_ids",
--   DROP COLUMN IF EXISTS "last_dreamed_at";
