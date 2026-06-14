-- Per-run audit log of cognition/dream runs. Additive, backward-compatible.
CREATE TABLE IF NOT EXISTS "hivemind"."cognition_run" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"              UUID         NOT NULL,
  "trigger"             VARCHAR(32)  NOT NULL DEFAULT 'manual',
  "status"              VARCHAR(16)  NOT NULL DEFAULT 'running',
  "skipped_reason"      TEXT,
  "lookback_hours"      INTEGER,
  "synth_count"         INTEGER      NOT NULL DEFAULT 0,
  "compact_count"       INTEGER      NOT NULL DEFAULT 0,
  "principle_count"     INTEGER      NOT NULL DEFAULT 0,
  "reweighted_count"    INTEGER      NOT NULL DEFAULT 0,
  "produced_memory_ids" UUID[]       NOT NULL DEFAULT '{}',
  "run_ms"              INTEGER,
  "error"               TEXT,
  "triggered_by"        UUID,
  "started_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at"         TIMESTAMPTZ(6),
  CONSTRAINT "cognition_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cognition_run_org_id_started_at_idx"
  ON "hivemind"."cognition_run" ("org_id", "started_at" DESC);

-- DOWN (manual, tested):
-- DROP TABLE IF EXISTS "hivemind"."cognition_run";
