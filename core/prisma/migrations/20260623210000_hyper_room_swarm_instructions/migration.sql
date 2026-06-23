-- Swarm Instructions: per-room free-form markdown the director must follow at HIGHEST priority
-- (overrides default format/content rules, e.g. "no Gaps to confirm", "no mermaid"). Additive + nullable.
ALTER TABLE "hivemind"."hyper_rooms" ADD COLUMN IF NOT EXISTS "swarm_instructions" TEXT;
