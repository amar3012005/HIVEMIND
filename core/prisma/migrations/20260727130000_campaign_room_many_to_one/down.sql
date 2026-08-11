DROP INDEX IF EXISTS "hivemind"."campaigns_room_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_room_id_key"
  ON "hivemind"."campaigns" ("room_id")
  WHERE "room_id" IS NOT NULL;
