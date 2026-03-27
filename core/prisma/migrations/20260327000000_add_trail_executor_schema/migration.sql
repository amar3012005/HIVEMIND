-- Trail Executor: Operational Cognition (op/*) and Control & Learning (meta/*) tables
-- Part of the cognitive runtime that adds motor function to the HIVEMIND memory engine

-- ==========================================
-- OPERATIONAL COGNITION (op/*)
-- ==========================================

-- Registered agents with role, model version, and skill manifest
CREATE TABLE IF NOT EXISTS "op_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "skills" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "op_agents_agent_id_key" ON "op_agents"("agent_id");

-- Goals assigned to agents, supporting hierarchical decomposition
CREATE TABLE IF NOT EXISTS "op_goals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_text" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "agent_id" TEXT NOT NULL,
    "parent_goal_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_goals_pkey" PRIMARY KEY ("id")
);

-- Executable trails: weighted plans attached to a goal, with decay and confidence
CREATE TABLE IF NOT EXISTS "op_trails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "next_action" JSONB,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "execution_event_ids" JSONB NOT NULL DEFAULT '[]',
    "success_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "decay_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_executed_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_trails_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "op_trails_goal_id_idx" ON "op_trails"("goal_id");
CREATE INDEX IF NOT EXISTS "op_trails_agent_id_idx" ON "op_trails"("agent_id");
CREATE INDEX IF NOT EXISTS "op_trails_weight_idx" ON "op_trails"("weight");
CREATE INDEX IF NOT EXISTS "op_trails_status_idx" ON "op_trails"("status");

-- Immutable execution events recording each step outcome
CREATE TABLE IF NOT EXISTS "op_execution_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trail_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "action_name" TEXT NOT NULL,
    "bound_params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "tokens_used" INTEGER,
    "estimated_cost_usd" DOUBLE PRECISION,
    "routing" JSONB,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_execution_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "op_execution_events_trail_id_idx" ON "op_execution_events"("trail_id");
CREATE INDEX IF NOT EXISTS "op_execution_events_agent_id_idx" ON "op_execution_events"("agent_id");
CREATE INDEX IF NOT EXISTS "op_execution_events_created_at_idx" ON "op_execution_events"("created_at");

-- Distributed lease for exclusive trail execution (prevents double-work)
CREATE TABLE IF NOT EXISTS "op_trail_leases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trail_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_trail_leases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "op_trail_leases_trail_id_key" ON "op_trail_leases"("trail_id");
CREATE INDEX IF NOT EXISTS "op_trail_leases_expires_at_idx" ON "op_trail_leases"("expires_at");

-- Agent observations: sensory inputs, inferences, environment signals
CREATE TABLE IF NOT EXISTS "op_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "certainty" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source_event_id" TEXT,
    "related_to_trail" TEXT,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_observations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "op_observations_agent_id_idx" ON "op_observations"("agent_id");

-- ==========================================
-- CONTROL & LEARNING (meta/*)
-- ==========================================

-- Post-execution evaluations by meta-evaluator agents
CREATE TABLE IF NOT EXISTS "meta_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trail_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "correctness_score" DOUBLE PRECISION NOT NULL,
    "efficiency_score" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "meta_evaluations_trail_id_idx" ON "meta_evaluations"("trail_id");

-- Materialized composite weight for each trail (precomputed for routing)
CREATE TABLE IF NOT EXISTS "meta_trail_weights" (
    "trail_id" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_decay_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "meta_trail_weights_pkey" PRIMARY KEY ("trail_id")
);

-- Per-agent reputation scores for trust-weighted routing
CREATE TABLE IF NOT EXISTS "meta_reputation" (
    "agent_id" TEXT NOT NULL,
    "success_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "skill_scores" JSONB NOT NULL DEFAULT '{}',
    "recent_attempts" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_reputation_pkey" PRIMARY KEY ("agent_id")
);

-- Candidates for observation-to-memory promotion (gated pipeline)
CREATE TABLE IF NOT EXISTS "meta_promotion_candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_event_id" TEXT NOT NULL,
    "trail_id" TEXT NOT NULL,
    "promotion_rule_id" TEXT NOT NULL,
    "observations" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "meta_promotion_candidates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_promotion_candidates_dedupe_key_key" ON "meta_promotion_candidates"("dedupe_key");
CREATE INDEX IF NOT EXISTS "meta_promotion_candidates_status_idx" ON "meta_promotion_candidates"("status");
CREATE INDEX IF NOT EXISTS "meta_promotion_candidates_created_at_idx" ON "meta_promotion_candidates"("created_at");

-- Configurable decay schedules for trails and observations
CREATE TABLE IF NOT EXISTS "meta_decay_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_type" TEXT NOT NULL,
    "half_life_days" INTEGER NOT NULL,
    "min_weight" DOUBLE PRECISION NOT NULL,
    "applies_to" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_decay_schedules_pkey" PRIMARY KEY ("id")
);
