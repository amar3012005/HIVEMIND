-- Per-org opt-in for the profile-dream cron (auto-maintain evolving user profiles).
-- Durable DB toggle surfaced in the Cognition tab. Additive, backward-compatible.
ALTER TABLE "hivemind"."organizations" ADD COLUMN IF NOT EXISTS "profile_automaintain_enabled" boolean NOT NULL DEFAULT false;
