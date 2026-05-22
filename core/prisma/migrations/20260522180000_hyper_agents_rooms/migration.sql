-- Hyper Agents: WhatsApp/Slack-style multi-agent workspace backed by
-- Cognitive Swarm Intelligence on HIVEMIND.
-- Three new tables. Per-user rooms (v1); org_id kept so we can scope
-- to teams later without migration. roleArchetype on digital_employees
-- already exists -- reusing it as the CSI role lane (no new column).

CREATE TABLE IF NOT EXISTS "hyper_rooms" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            uuid NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  "org_id"             uuid NOT NULL REFERENCES "organizations"(id) ON DELETE CASCADE,
  "name"               varchar(120) NOT NULL,
  "participant_ids"    uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "created_at"         timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at"         timestamptz(6) NOT NULL DEFAULT now(),
  "archived_at"        timestamptz(6),
  "summary_memory_id"  uuid
);
CREATE INDEX IF NOT EXISTS "hyper_rooms_user_org_idx" ON "hyper_rooms" ("user_id","org_id");
CREATE INDEX IF NOT EXISTS "hyper_rooms_archived_idx" ON "hyper_rooms" ("archived_at");

CREATE TABLE IF NOT EXISTS "hyper_turns" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id"          uuid NOT NULL REFERENCES "hyper_rooms"(id) ON DELETE CASCADE,
  "seq"              integer NOT NULL,
  "user_message"     text NOT NULL,
  "status"           varchar(20) NOT NULL DEFAULT 'live',
  "lines"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  "cost_tokens"      integer NOT NULL DEFAULT 0,
  "started_at"       timestamptz(6) NOT NULL DEFAULT now(),
  "sealed_at"        timestamptz(6),
  "idempotency_key"  varchar(64) NOT NULL UNIQUE,
  UNIQUE ("room_id", "seq")
);
CREATE INDEX IF NOT EXISTS "hyper_turns_room_idx"   ON "hyper_turns" ("room_id");
CREATE INDEX IF NOT EXISTS "hyper_turns_status_idx" ON "hyper_turns" ("status");

CREATE TABLE IF NOT EXISTS "agent_evals" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"             uuid NOT NULL,
  "turn_id"              uuid NOT NULL REFERENCES "hyper_turns"(id) ON DELETE CASCADE,
  "scores"               jsonb NOT NULL,
  "total"                double precision NOT NULL,
  "created_at"           timestamptz(6) NOT NULL DEFAULT now(),
  "used_for_tuning_at"   timestamptz(6)
);
CREATE INDEX IF NOT EXISTS "agent_evals_agent_tuning_idx" ON "agent_evals" ("agent_id","used_for_tuning_at");
CREATE INDEX IF NOT EXISTS "agent_evals_turn_idx"         ON "agent_evals" ("turn_id");
