-- Per-organization default language: the language of team-wide messages (digests, administrator emails)
-- for a person who has not chosen their own. NULL means English. Additive and backward-compatible.
ALTER TABLE "hivemind"."organizations" ADD COLUMN IF NOT EXISTS "default_locale" varchar(10);
