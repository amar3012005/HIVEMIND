-- Phase A: tiered memory cache + WorkingSet (rolling spotlight)
-- Up

-- Memory tier column. Default 2 = hot (full content) so existing rows behave as before.
-- Tier 1 = thin index (title + entities + summary, full content optional).
ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS tier              integer     NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS last_accessed_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS promoted_at       timestamptz NULL;

CREATE INDEX IF NOT EXISTS memories_tier_idx
  ON hivemind.memories (tier);

CREATE INDEX IF NOT EXISTS memories_user_tier_lastaccess_idx
  ON hivemind.memories (user_id, tier, last_accessed_at DESC);

-- WorkingSet table — one row per user, rolling 7d window of active context.
CREATE TABLE IF NOT EXISTS hivemind.working_sets (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid          NOT NULL UNIQUE,
  org_id              uuid          NULL,
  active_entities     text[]        NOT NULL DEFAULT '{}',
  active_threads      text[]        NOT NULL DEFAULT '{}',
  active_projects     text[]        NOT NULL DEFAULT '{}',
  pinned_memory_ids   uuid[]        NOT NULL DEFAULT '{}',
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS working_sets_org_idx
  ON hivemind.working_sets (org_id);
