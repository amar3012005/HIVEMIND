-- WS5 (evolving profile / dreaming): additive, backward-compatible.
-- evidence_memory_ids: per-fact grounding lineage (uuid[]), default empty.
-- last_dreamed_at: when the profile-dreamer last re-synthesized this user.
--
-- Older installations created this table before this migration, but the
-- historical migration sequence did not include its creation. Keep the
-- bootstrap idempotent so a fresh application-schema install has the same
-- canonical table before applying the WS5 additions below.
CREATE TABLE IF NOT EXISTS hivemind.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  org_id UUID,
  category TEXT NOT NULL DEFAULT 'static',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  source_memory_id UUID,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP(3),
  CONSTRAINT user_profiles_user_id_key_key UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS user_profiles_user_id_idx
  ON hivemind.user_profiles (user_id);
CREATE INDEX IF NOT EXISTS user_profiles_user_id_category_idx
  ON hivemind.user_profiles (user_id, category);

ALTER TABLE "hivemind"."user_profiles"
  ADD COLUMN IF NOT EXISTS "evidence_memory_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "last_dreamed_at" TIMESTAMP(3);

-- DOWN (manual, tested):
-- ALTER TABLE "hivemind"."user_profiles"
--   DROP COLUMN IF EXISTS "evidence_memory_ids",
--   DROP COLUMN IF EXISTS "last_dreamed_at";
