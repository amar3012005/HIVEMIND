ALTER TABLE "hivemind"."hyper_rooms"
  ADD COLUMN IF NOT EXISTS "room_tag" VARCHAR(40) NOT NULL DEFAULT 'general';

UPDATE "hivemind"."hyper_rooms"
SET "room_tag" = 'general'
WHERE "room_tag" IS NULL OR BTRIM("room_tag") = '';

CREATE INDEX IF NOT EXISTS "hyper_rooms_org_room_tag_idx"
  ON "hivemind"."hyper_rooms" ("org_id", "room_tag")
  WHERE "archived_at" IS NULL;
