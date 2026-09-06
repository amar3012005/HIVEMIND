CREATE TABLE IF NOT EXISTS "hivemind"."operating_room_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "room_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "speaker_user_id" UUID NOT NULL,
  "speaker_name" VARCHAR(120) NOT NULL,
  "speaker_role" VARCHAR(60) NOT NULL,
  "text" TEXT NOT NULL,
  "addressed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operating_room_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operating_room_events_room_fk" FOREIGN KEY ("room_id") REFERENCES "hivemind"."hyper_rooms"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "operating_room_events_room_time_idx"
  ON "hivemind"."operating_room_events" ("room_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "operating_room_events_tenant_speaker_idx"
  ON "hivemind"."operating_room_events" ("org_id", "speaker_user_id", "created_at");

CREATE TABLE IF NOT EXISTS "hivemind"."operating_room_participants" (
  "room_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "role" VARCHAR(60) NOT NULL,
  "realtime_participant_id" VARCHAR(120),
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operating_room_participants_pkey" PRIMARY KEY ("room_id", "user_id"),
  CONSTRAINT "operating_room_participants_room_fk" FOREIGN KEY ("room_id") REFERENCES "hivemind"."hyper_rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "operating_room_participants_user_fk" FOREIGN KEY ("user_id") REFERENCES "hivemind"."users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "operating_room_participants_tenant_user_idx"
  ON "hivemind"."operating_room_participants" ("org_id", "user_id");
