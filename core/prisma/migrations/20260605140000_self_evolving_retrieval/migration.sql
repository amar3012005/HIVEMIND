-- Phase 2+3: self-evolving retrieval loop.
-- Accessed via raw SQL (not Prisma client) so the loop never blocks on a
-- client regen lag. All idempotent.

-- B2 — per-org RetrievalConfig: the EvolveMem "action space" the loop tunes.
-- Recall reads this with fallback to env/constants. NULL row → defaults.
CREATE TABLE IF NOT EXISTS hivemind.retrieval_config (
    org_id            UUID PRIMARY KEY REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
    deliver_limit     INTEGER  DEFAULT 5,
    score_threshold   REAL     DEFAULT 0.15,
    hnsw_ef           INTEGER  DEFAULT 128,
    similarity_weight REAL     DEFAULT 0.45,
    recency_weight    REAL     DEFAULT 0.15,
    vector_weight     REAL     DEFAULT 0.20,
    importance_weight REAL     DEFAULT 0.10,
    graph_weight      REAL     DEFAULT 0.05,
    revision          INTEGER  DEFAULT 1,
    updated_by        VARCHAR(40) DEFAULT 'default',
    updated_at        TIMESTAMPTZ DEFAULT now()
);

-- B3 — TaskOutcome log: the feedback signal the diagnose step reads (0-token stats).
CREATE TABLE IF NOT EXISTS hivemind.task_outcome (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID,
    user_id      UUID,
    query        TEXT,
    returned_n   INTEGER DEFAULT 0,
    top_score    REAL,
    outcome      VARCHAR(20) DEFAULT 'retrieved', -- retrieved|hit|miss|override|feedback_pos|feedback_neg
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_outcome_org_time ON hivemind.task_outcome(org_id, created_at DESC);

-- B5 — evolution audit (EVOLUTION.md as rows). Also the rejected-seen-set source.
CREATE TABLE IF NOT EXISTS hivemind.retrieval_evolution (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID,
    batch_id       UUID,
    diagnosis      TEXT,
    proposed_delta JSONB,
    delta_hash     VARCHAR(64),     -- dedupe: never re-propose the same delta
    recall_before  REAL,
    recall_after   REAL,
    p95_before     INTEGER,
    p95_after      INTEGER,
    decision       VARCHAR(20),     -- committed|reverted|no_signal|no_proposal|error
    created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_retrieval_evolution_org_time ON hivemind.retrieval_evolution(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_evolution_delta ON hivemind.retrieval_evolution(org_id, delta_hash);
