-- Operating Rooms reuse the durable hyper_rooms envelope. The application
-- already writes room_mode='operating'; keep the database contract aligned
-- while preserving the existing Work Room and Runtime modes.
ALTER TABLE "hivemind"."hyper_rooms"
  DROP CONSTRAINT IF EXISTS "hyper_rooms_room_mode_check";

ALTER TABLE "hivemind"."hyper_rooms"
  ADD CONSTRAINT "hyper_rooms_room_mode_check"
  CHECK ("room_mode" IN ('work', 'runtime', 'operating'));
