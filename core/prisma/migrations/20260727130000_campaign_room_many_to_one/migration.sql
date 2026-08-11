DROP INDEX IF EXISTS "hivemind"."campaigns_room_id_key";

CREATE INDEX IF NOT EXISTS "campaigns_room_id_idx"
  ON "hivemind"."campaigns" ("room_id")
  WHERE "room_id" IS NOT NULL;
