-- Persona email thread state for HQ Runtime. Additive, nullable, no backfill
-- needed — existing runtimes simply have no thread yet until their first
-- persona email fires.
ALTER TABLE "hivemind"."hq_runtimes"
  ADD COLUMN IF NOT EXISTS "email_updates_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "email_thread_to" VARCHAR(320),
  ADD COLUMN IF NOT EXISTS "email_thread_subject" VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "email_thread_message_id" VARCHAR(998),
  ADD COLUMN IF NOT EXISTS "email_thread_sent_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "email_thread_last_sent_at" TIMESTAMPTZ(6);
