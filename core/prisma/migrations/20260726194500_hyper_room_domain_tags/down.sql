DROP INDEX IF EXISTS "hivemind"."hyper_rooms_org_room_tag_idx";
ALTER TABLE "hivemind"."hyper_rooms" DROP COLUMN IF EXISTS "room_tag";
