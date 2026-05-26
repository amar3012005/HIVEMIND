-- CreateTable
CREATE TABLE "hivemind"."cognition_status" (
    "org_id" UUID NOT NULL,
    "last_tick_at" TIMESTAMPTZ(6),
    "last_run_ms" INTEGER,
    "last_synth_count" INTEGER NOT NULL DEFAULT 0,
    "last_compact_count" INTEGER NOT NULL DEFAULT 0,
    "next_tick_at" TIMESTAMPTZ(6),
    "total_ticks" INTEGER NOT NULL DEFAULT 0,
    "total_synth" INTEGER NOT NULL DEFAULT 0,
    "total_compact" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cognition_status_pkey" PRIMARY KEY ("org_id")
);

-- CreateIndex
CREATE INDEX "cognition_status_last_tick_at_idx" ON "hivemind"."cognition_status"("last_tick_at" DESC);
