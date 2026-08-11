CREATE SCHEMA IF NOT EXISTS hivemind;

CREATE TABLE IF NOT EXISTS hivemind.runtime_playbook_definitions (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope_key" VARCHAR(80) NOT NULL DEFAULT 'global',
    "organization_id" UUID,
    "playbook_id" VARCHAR(160) NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "runtime_playbook_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_playbook_definitions_scope_key_playbook_id_version_key"
    ON hivemind.runtime_playbook_definitions("scope_key", "playbook_id", "version");

CREATE INDEX IF NOT EXISTS "runtime_playbook_definitions_organization_id_idx"
    ON hivemind.runtime_playbook_definitions("organization_id");

CREATE INDEX IF NOT EXISTS "runtime_playbook_definitions_playbook_id_version_idx"
    ON hivemind.runtime_playbook_definitions("playbook_id", "version" DESC);

CREATE TABLE IF NOT EXISTS hivemind.runtime_playbook_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    room_id UUID,
    scope_key VARCHAR(80) NOT NULL DEFAULT 'global',
    playbook_id VARCHAR(160) NOT NULL,
    playbook_version INTEGER NOT NULL,
    idempotency_key VARCHAR(180) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    current_stage_id VARCHAR(120) NOT NULL,
    completed_stage_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    terminal_state VARCHAR(120),
    trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    stage_attempts JSONB NOT NULL DEFAULT '{}'::jsonb,
    waiting_for JSONB,
    last_verdict JSONB NOT NULL DEFAULT '{}'::jsonb,
    checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    lease_owner VARCHAR(160),
    lease_expires_at TIMESTAMPTZ(6),
    started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ(6),
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_playbook_runs_org_id_idempotency_key_key
    ON hivemind.runtime_playbook_runs(org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS runtime_playbook_runs_org_id_status_updated_at_idx
    ON hivemind.runtime_playbook_runs(org_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS runtime_playbook_runs_room_id_status_idx
    ON hivemind.runtime_playbook_runs(room_id, status);
CREATE INDEX IF NOT EXISTS runtime_playbook_runs_status_lease_expires_at_idx
    ON hivemind.runtime_playbook_runs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS hivemind.runtime_playbook_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES hivemind.runtime_playbook_runs(id) ON DELETE CASCADE,
    org_id UUID NOT NULL,
    stage_id VARCHAR(120) NOT NULL,
    artifact_id VARCHAR(180) NOT NULL,
    artifact_key VARCHAR(180) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'READY',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    external_ref VARCHAR(500),
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_playbook_artifacts_run_id_artifact_id_key
    ON hivemind.runtime_playbook_artifacts(run_id, artifact_id);
CREATE INDEX IF NOT EXISTS runtime_playbook_artifacts_org_id_artifact_key_created_at_idx
    ON hivemind.runtime_playbook_artifacts(org_id, artifact_key, created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_playbook_artifacts_run_id_stage_id_idx
    ON hivemind.runtime_playbook_artifacts(run_id, stage_id);

CREATE TABLE IF NOT EXISTS hivemind.runtime_playbook_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES hivemind.runtime_playbook_runs(id) ON DELETE CASCADE,
    org_id UUID NOT NULL,
    sequence INTEGER NOT NULL,
    stage_id VARCHAR(120),
    phase VARCHAR(40) NOT NULL,
    status VARCHAR(32) NOT NULL,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    verdict JSONB NOT NULL DEFAULT '{}'::jsonb,
    artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_playbook_checkpoints_run_id_sequence_key
    ON hivemind.runtime_playbook_checkpoints(run_id, sequence);
CREATE INDEX IF NOT EXISTS runtime_playbook_checkpoints_org_id_created_at_idx
    ON hivemind.runtime_playbook_checkpoints(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_playbook_checkpoints_run_id_stage_id_sequence_idx
    ON hivemind.runtime_playbook_checkpoints(run_id, stage_id, sequence);

CREATE TABLE IF NOT EXISTS hivemind.runtime_playbook_authorities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES hivemind.runtime_playbook_runs(id) ON DELETE CASCADE,
    org_id UUID NOT NULL,
    gate VARCHAR(120) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'GRANTED',
    granted_by UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    granted_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ(6)
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_playbook_authorities_run_id_gate_key
    ON hivemind.runtime_playbook_authorities(run_id, gate);
CREATE INDEX IF NOT EXISTS runtime_playbook_authorities_org_id_status_idx
    ON hivemind.runtime_playbook_authorities(org_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS outbound_actions_runtime_playbook_draft_key
    ON hivemind.outbound_actions
    (org_id, (meta->>'runtime_playbook_run_id'), (meta->>'draft_ref'))
    WHERE channel = 'email'
      AND meta ? 'runtime_playbook_run_id'
      AND meta ? 'draft_ref';
