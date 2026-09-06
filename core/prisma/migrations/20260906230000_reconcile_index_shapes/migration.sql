-- Historical migrations created partial indexes with the same names Prisma now
-- assigns to full indexes. PostgreSQL's IF NOT EXISTS checks only the name, so
-- the Day-1 reconciliation must replace those shapes explicitly.
DROP INDEX IF EXISTS "hivemind"."campaign_runs_turn_id_key";
DROP INDEX IF EXISTS "hivemind"."campaigns_room_id_idx";
DROP INDEX IF EXISTS "hivemind"."campaigns_legacy_source_key";
DROP INDEX IF EXISTS "hivemind"."campaigns_creation_key";
DROP INDEX IF EXISTS "hivemind"."canonical_entities_org_identity_key";
DROP INDEX IF EXISTS "hivemind"."governance_action_log_idempotent_idx";
DROP INDEX IF EXISTS "hivemind"."knowledge_documents_org_canonical_key_uq";
DROP INDEX IF EXISTS "hivemind"."memories_synthesis_cluster_hash_idx";
DROP INDEX IF EXISTS "hivemind"."memories_cognitive_layer_role_idx";
DROP INDEX IF EXISTS "hivemind"."memory_projection_attempt_workflow_key";
DROP INDEX IF EXISTS "hivemind"."tara_call_attempts_action_key_key";

CREATE UNIQUE INDEX "campaign_runs_turn_id_key" ON "campaign_runs"("turn_id");
CREATE INDEX "campaigns_room_id_idx" ON "campaigns"("room_id");
CREATE UNIQUE INDEX "campaigns_legacy_source_key" ON "campaigns"("org_id", "source_type", "source_id");
CREATE UNIQUE INDEX "campaigns_creation_key" ON "campaigns"("org_id", "owner_user_id", "creation_key");
CREATE UNIQUE INDEX "canonical_entities_org_identity_key" ON "canonical_entities"("organization_id", "identity_key");
CREATE UNIQUE INDEX "governance_action_log_idempotent_idx" ON "governance_action_log"("target_memory_id", "action_type", "batch_id");
CREATE UNIQUE INDEX "knowledge_documents_org_canonical_key_uq" ON "knowledge_documents"("org_id", "canonical_ingest_key");
CREATE INDEX "memories_synthesis_cluster_hash_idx" ON "memories"("synthesis_cluster_hash");
CREATE INDEX "memories_cognitive_layer_role_idx" ON "memories"("cognitive_layer_role");
CREATE UNIQUE INDEX "memory_projection_attempt_workflow_key" ON "memory_projection_attempts"("workflow_instance_id");
CREATE UNIQUE INDEX "tara_call_attempts_action_key_key" ON "tara_call_attempts"("action_key");
