-- HyperAgents CSI artifact layer: durable, queryable claim/trial/relation graph.
-- Additive only. Populated by the control-plane turn-event callback sink.

CREATE TABLE "hyper_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turn_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ref_id" VARCHAR(120) NOT NULL,
    "agent_slug" VARCHAR(120),
    "agent_name" VARCHAR(120),
    "lane" VARCHAR(40),
    "kind" VARCHAR(40) NOT NULL DEFAULT 'hypothesis',
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "round" INTEGER NOT NULL DEFAULT 0,
    "evidence_memory_ids" UUID[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "hyper_claims_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hyper_claims_room_id_idx" ON "hyper_claims"("room_id");
CREATE INDEX "hyper_claims_turn_id_idx" ON "hyper_claims"("turn_id");
CREATE INDEX "hyper_claims_org_id_idx"  ON "hyper_claims"("org_id");

CREATE TABLE "hyper_trials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turn_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "trial_kind" VARCHAR(40) NOT NULL,
    "reviewer_slug" VARCHAR(120),
    "reviewer_name" VARCHAR(120),
    "target_ref" VARCHAR(120),
    "verdict" VARCHAR(40),
    "confidence" DOUBLE PRECISION,
    "content" TEXT,
    "round" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "hyper_trials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hyper_trials_room_id_idx" ON "hyper_trials"("room_id");
CREATE INDEX "hyper_trials_turn_id_idx" ON "hyper_trials"("turn_id");
CREATE INDEX "hyper_trials_org_id_idx"  ON "hyper_trials"("org_id");

CREATE TABLE "hyper_relations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turn_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "relation_type" VARCHAR(40) NOT NULL,
    "from_ref" VARCHAR(120) NOT NULL,
    "to_ref" VARCHAR(120) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "hyper_relations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hyper_relations_room_id_idx" ON "hyper_relations"("room_id");
CREATE INDEX "hyper_relations_turn_id_idx" ON "hyper_relations"("turn_id");
