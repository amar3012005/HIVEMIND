-- Compact episodic continuity for HyperAgent Rooms.
-- Down: ALTER TABLE "hivemind"."hyper_rooms" DROP COLUMN IF EXISTS "room_journal";
ALTER TABLE "hivemind"."hyper_rooms"
  ADD COLUMN IF NOT EXISTS "room_journal" JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hyper_rooms_room_journal_array'
  ) THEN
    ALTER TABLE "hivemind"."hyper_rooms"
      ADD CONSTRAINT "hyper_rooms_room_journal_array"
      CHECK (jsonb_typeof("room_journal") = 'array');
  END IF;
END $$;
