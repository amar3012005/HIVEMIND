-- P2: per-segment Stage-1 extraction (entities/decisions/actions) computed during
-- the meeting so Stop is fast. Additive.
ALTER TABLE "hivemind"."meeting_segments" ADD COLUMN IF NOT EXISTS "extraction" jsonb;
ALTER TABLE "hivemind"."meeting_segments" ADD COLUMN IF NOT EXISTS "extraction_status" varchar(16) NOT NULL DEFAULT 'pending';
