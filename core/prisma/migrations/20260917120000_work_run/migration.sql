-- WorkRun — the durable unit of work hm-core hands down to the agent runtime.
--
-- Why a new table rather than reusing hyper_work_orders:
--   hyper_work_orders is the *intra-room* execution substrate. A Room Director
--   creates one per bounded step inside a turn, and it is scoped to a room and
--   a turn. A WorkRun is the *cross-system* seam: it is what hm-core owns and
--   what the AgentScope Agent Service executes. It outlives a browser session,
--   it is the thing that resumes after a disconnect, and it is the row the UI
--   renders progress from. Collapsing the two would put AgentScope session
--   state inside the room pipeline and room pipeline state inside the runtime.
--
-- The runtime never learns what a WorkRun is beyond the id it is handed; hm-core
-- never learns what an AgentScope session is beyond the id it stores here. That
-- is the whole point of the seam.

CREATE TABLE IF NOT EXISTS "hivemind"."work_runs" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                UUID NOT NULL,
  "user_id"               UUID NOT NULL,
  "employee_id"           UUID,
  "room_id"               UUID,
  -- The HyperTurn this run is the execution of. Required for the runtime's
  -- event-forwarding path: hm-core's inbound sink re-derives the execution
  -- identity from the persisted HyperTurn row and answers 409 on any mismatch.
  "turn_id"               UUID,
  "goal"                  TEXT NOT NULL,
  -- queued | starting | running | waiting_approval | paused | completed | failed | cancelled
  "status"                VARCHAR(32) NOT NULL DEFAULT 'queued',
  -- AgentScope coordinates. Null until the runtime answers POST /workrun/.
  "agentscope_session_id" VARCHAR(120),
  "workspace_id"          VARCHAR(160),
  "team_id"               VARCHAR(120),
  -- The selected HyperAgent persona + playbook, resolved by hm-core before the
  -- runtime is called. Stored as data so the runtime stays domain-agnostic.
  "hyperagent_slug"       VARCHAR(120),
  "playbook_id"           VARCHAR(120),
  "playbook_version"      VARCHAR(40),
  -- Free-form scope handed to the agent (company, project, filters). Data, not code.
  "scope"                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Normalized event vocabulary the UI renders. Append-only, capped by the writer.
  "events"                JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Artifact pointers registered back from the workspace. Pointers, not bytes.
  "result_artifact_ids"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "result"                JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error"                 TEXT,
  "started_at"            TIMESTAMPTZ(6),
  "heartbeat_at"          TIMESTAMPTZ(6),
  "completed_at"          TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The UI lists a user's runs newest-first; the org index backs admin views.
CREATE INDEX IF NOT EXISTS "work_runs_user_created_idx"
  ON "hivemind"."work_runs" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "work_runs_org_status_idx"
  ON "hivemind"."work_runs" ("org_id", "status");
-- Resume/reconcile: find runs that stopped heartbeating while non-terminal.
CREATE INDEX IF NOT EXISTS "work_runs_status_heartbeat_idx"
  ON "hivemind"."work_runs" ("status", "heartbeat_at");
-- One run per turn: a retried dispatch must not create a second run for the
-- same turn.
--
-- This is a FULL unique index, matching what Prisma generates for `@unique` on
-- a nullable column. A partial index (`WHERE turn_id IS NOT NULL`) would be
-- equivalent in effect — Postgres treats NULLs as distinct in a unique index,
-- so many NULL rows are allowed either way — but it would NOT match the schema,
-- and `prisma migrate` would report drift on every subsequent diff.
CREATE UNIQUE INDEX IF NOT EXISTS "work_runs_turn_id_key"
  ON "hivemind"."work_runs" ("turn_id");

-- FK to the turn, so a deleted turn cannot leave an orphaned run pointing at a
-- row the runtime's identity check would then fail to resolve.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_runs_turn_id_fkey'
  ) THEN
    ALTER TABLE "hivemind"."work_runs"
      ADD CONSTRAINT "work_runs_turn_id_fkey"
      FOREIGN KEY ("turn_id") REFERENCES "hivemind"."hyper_turns"("id")
      ON DELETE SET NULL;
  END IF;
END $$;
