-- A4 agent_trust — per-org meritocracy signal. display-only first;
-- _pick_lead weight wiring is phase-2 (observe 50-100 turns first).
CREATE TABLE IF NOT EXISTS "agent_trust" (
  "org_id"       uuid    NOT NULL REFERENCES "organizations"(id) ON DELETE CASCADE,
  "employee_id"  uuid    NOT NULL,
  "trust_score"  double precision NOT NULL DEFAULT 0.5,
  "wins"         integer NOT NULL DEFAULT 0,
  "losses"       integer NOT NULL DEFAULT 0,
  "updated_at"   timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "employee_id")
);
CREATE INDEX IF NOT EXISTS "agent_trust_org_score_idx"
  ON "agent_trust" ("org_id", "trust_score" DESC);

-- B1 hyper_rooms.template — drive phase sequence. Default 'debate' keeps
-- current behaviour for existing rooms. 'decision' opt-in for DACI flow.
ALTER TABLE "hyper_rooms"
  ADD COLUMN IF NOT EXISTS "template" varchar(40) NOT NULL DEFAULT 'debate';
