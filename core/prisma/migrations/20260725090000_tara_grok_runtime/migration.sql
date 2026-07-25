-- Additive TARA Grok provider support. Existing Deepgram records retain defaults.
ALTER TABLE "hivemind"."tara_calls"
  ADD COLUMN IF NOT EXISTS "provider" varchar(32) NOT NULL DEFAULT 'deepgram',
  ADD COLUMN IF NOT EXISTS "provider_model" varchar(120),
  ADD COLUMN IF NOT EXISTS "config_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "skill_id" uuid,
  ADD COLUMN IF NOT EXISTS "goal" text,
  ADD COLUMN IF NOT EXISTS "input_audio_ms" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "output_audio_ms" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "billable_messages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tool_usage" jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "estimated_cost_micros" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_code" varchar(120);

ALTER TABLE "hivemind"."tara_calls" DROP CONSTRAINT IF EXISTS "tara_calls_session_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "tara_calls_org_id_session_id_key" ON "hivemind"."tara_calls"("org_id", "session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tara_turns_call_id_seq_key" ON "hivemind"."tara_turns"("call_id", "seq");

CREATE TABLE IF NOT EXISTS "hivemind"."tara_runtime_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" uuid NOT NULL UNIQUE,
  "default_provider" varchar(32) NOT NULL DEFAULT 'deepgram', "revision" integer NOT NULL DEFAULT 1,
  "deepgram_config" jsonb NOT NULL DEFAULT '{}', "grok_config" jsonb NOT NULL DEFAULT '{}',
  "updated_by" uuid, "created_at" timestamptz(6) NOT NULL DEFAULT now(), "updated_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "hivemind"."tara_voice_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" uuid NOT NULL, "user_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL, "mode" varchar(20) NOT NULL DEFAULT 'external',
  "capability_jti" varchar(96) NOT NULL UNIQUE, "config_snapshot" jsonb NOT NULL DEFAULT '{}',
  "expires_at" timestamptz(6) NOT NULL, "consumed_at" timestamptz(6), "created_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tara_voice_sessions_org_id_expires_at_idx" ON "hivemind"."tara_voice_sessions"("org_id", "expires_at");
CREATE TABLE IF NOT EXISTS "hivemind"."tara_provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "provider" varchar(32) NOT NULL,
  "provider_event_id" varchar(160) NOT NULL, "session_id" varchar(120), "org_id" uuid,
  "event_type" varchar(80) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE("provider", "provider_event_id")
);
CREATE INDEX IF NOT EXISTS "tara_provider_events_org_id_session_id_idx" ON "hivemind"."tara_provider_events"("org_id", "session_id");

ALTER TABLE "hivemind"."tara_campaigns"
  ADD COLUMN IF NOT EXISTS "provider" varchar(32) NOT NULL DEFAULT 'deepgram',
  ADD COLUMN IF NOT EXISTS "config_snapshot" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "hivemind"."tara_call_attempts"
  ADD COLUMN IF NOT EXISTS "provider" varchar(32) NOT NULL DEFAULT 'deepgram',
  ADD COLUMN IF NOT EXISTS "config_snapshot" jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "action_key" varchar(120);
CREATE UNIQUE INDEX IF NOT EXISTS "tara_call_attempts_action_key_key" ON "hivemind"."tara_call_attempts"("action_key") WHERE "action_key" IS NOT NULL;

ALTER TABLE "hivemind"."outreach_campaigns"
  ADD COLUMN IF NOT EXISTS "voice_provider" varchar(32),
  ADD COLUMN IF NOT EXISTS "voice_config_snapshot" jsonb NOT NULL DEFAULT '{}';
