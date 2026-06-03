-- TARA call history + per-turn usage + per-call insights (org-scoped, real-time).
CREATE TABLE "tara_calls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "session_id" VARCHAR(120) NOT NULL,
  "mode" VARCHAR(20) NOT NULL DEFAULT 'external',
  "voice_id" VARCHAR(120), "language" VARCHAR(10) NOT NULL DEFAULT 'en',
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "turn_count" INTEGER NOT NULL DEFAULT 0, "duration_ms" INTEGER NOT NULL DEFAULT 0,
  "prompt_tokens" INTEGER NOT NULL DEFAULT 0, "completion_tokens" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "ended_at" TIMESTAMPTZ(6),
  CONSTRAINT "tara_calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tara_calls_session_id_key" ON "tara_calls"("session_id");
CREATE INDEX "tara_calls_org_id_idx" ON "tara_calls"("org_id");
CREATE INDEX "tara_calls_user_id_idx" ON "tara_calls"("user_id");
CREATE INDEX "tara_calls_org_id_started_at_idx" ON "tara_calls"("org_id","started_at");

CREATE TABLE "tara_turns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "call_id" UUID NOT NULL, "org_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL, "user_text" TEXT, "agent_text" TEXT,
  "stt_engine" VARCHAR(40), "stt_ms" INTEGER, "llm_ttfb_ms" INTEGER, "tts_ttfb_ms" INTEGER,
  "recall_count" INTEGER, "prompt_tokens" INTEGER, "completion_tokens" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tara_turns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tara_turns_call_id_idx" ON "tara_turns"("call_id");
CREATE INDEX "tara_turns_org_id_idx" ON "tara_turns"("org_id");

CREATE TABLE "tara_insights" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "call_id" UUID NOT NULL, "org_id" UUID NOT NULL, "user_id" UUID NOT NULL,
  "summary" TEXT, "data" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tara_insights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tara_insights_call_id_key" ON "tara_insights"("call_id");
CREATE INDEX "tara_insights_org_id_idx" ON "tara_insights"("org_id");
