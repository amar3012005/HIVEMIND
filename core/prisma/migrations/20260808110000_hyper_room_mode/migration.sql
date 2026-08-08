-- Explicitly separates human Director workspaces from Runtime-owned specialist
-- rooms. Existing domain homes retain their current Runtime semantics; ordinary
-- rooms become human Work Rooms by default.
ALTER TABLE "hivemind"."hyper_rooms"
  ADD COLUMN IF NOT EXISTS "room_mode" VARCHAR(16) NOT NULL DEFAULT 'work';

UPDATE "hivemind"."hyper_rooms"
SET "room_mode" = 'runtime'
WHERE "agent_connectors"->>'_domain_home' = 'true'
   OR "room_tag" <> 'general';

CREATE INDEX IF NOT EXISTS "hyper_rooms_org_room_mode_idx"
  ON "hivemind"."hyper_rooms" ("org_id", "room_mode");

ALTER TABLE "hivemind"."hyper_rooms"
  DROP CONSTRAINT IF EXISTS "hyper_rooms_room_mode_check";

ALTER TABLE "hivemind"."hyper_rooms"
  ADD CONSTRAINT "hyper_rooms_room_mode_check"
  CHECK ("room_mode" IN ('work', 'runtime'));
