-- AlterEnum
ALTER TYPE "RelationshipType" ADD VALUE 'Contradicts';

-- DropForeignKey
ALTER TABLE "PageIndexNode" DROP CONSTRAINT "PageIndexNode_org_id_fkey";

-- DropForeignKey
ALTER TABLE "PageIndexNode" DROP CONSTRAINT "PageIndexNode_parent_id_fkey";

-- DropForeignKey
ALTER TABLE "PageIndexNode" DROP CONSTRAINT "PageIndexNode_user_id_fkey";

-- DropForeignKey
ALTER TABLE "action_intents" DROP CONSTRAINT "action_intents_employee_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_evals" DROP CONSTRAINT "agent_evals_turn_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_trust" DROP CONSTRAINT "agent_trust_org_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_api_key_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_action_attempts" DROP CONSTRAINT "campaign_action_attempts_action_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_actions" DROP CONSTRAINT "campaign_actions_audience_member_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_actions" DROP CONSTRAINT "campaign_actions_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_actions" DROP CONSTRAINT "campaign_actions_plan_version_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_approvals" DROP CONSTRAINT "campaign_approvals_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_approvals" DROP CONSTRAINT "campaign_approvals_plan_version_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_assets" DROP CONSTRAINT "campaign_assets_action_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_assets" DROP CONSTRAINT "campaign_assets_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_audience_members" DROP CONSTRAINT "campaign_audience_members_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_audience_members" DROP CONSTRAINT "campaign_audience_members_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_channels" DROP CONSTRAINT "campaign_channels_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_events" DROP CONSTRAINT "campaign_events_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_metric_snapshots" DROP CONSTRAINT "campaign_metric_snapshots_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_plan_versions" DROP CONSTRAINT "campaign_plan_versions_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_runs" DROP CONSTRAINT "campaign_runs_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "canonical_claims" DROP CONSTRAINT "canonical_claims_object_entity_id_fkey";

-- DropForeignKey
ALTER TABLE "canonical_claims" DROP CONSTRAINT "canonical_claims_predicate_id_fkey";

-- DropForeignKey
ALTER TABLE "canonical_claims" DROP CONSTRAINT "canonical_claims_subject_entity_id_fkey";

-- DropForeignKey
ALTER TABLE "canonical_claims" DROP CONSTRAINT "canonical_claims_supersedes_claim_id_fkey";

-- DropForeignKey
ALTER TABLE "claim_evidence_links" DROP CONSTRAINT "claim_evidence_links_claim_id_fkey";

-- DropForeignKey
ALTER TABLE "claim_evidence_links" DROP CONSTRAINT "claim_evidence_links_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "cluster_index" DROP CONSTRAINT "cluster_index_latest_synthesis_id_fkey";

-- DropForeignKey
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_source_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "digital_employees" DROP CONSTRAINT "digital_employees_created_by_fkey";

-- DropForeignKey
ALTER TABLE "digital_employees" DROP CONSTRAINT "digital_employees_hivemind_api_key_id_fkey";

-- DropForeignKey
ALTER TABLE "digital_employees" DROP CONSTRAINT "digital_employees_org_id_fkey";

-- DropForeignKey
ALTER TABLE "digital_employees" DROP CONSTRAINT "digital_employees_team_id_fkey";

-- DropForeignKey
ALTER TABLE "enterprise_invitations" DROP CONSTRAINT "enterprise_invitations_org_id_fkey";

-- DropForeignKey
ALTER TABLE "entitlement_grants" DROP CONSTRAINT "entitlement_grants_org_id_fkey";

-- DropForeignKey
ALTER TABLE "entitlement_grants" DROP CONSTRAINT "entitlement_grants_promotion_id_fkey";

-- DropForeignKey
ALTER TABLE "entitlement_versions" DROP CONSTRAINT "entitlement_versions_grant_id_fkey";

-- DropForeignKey
ALTER TABLE "entity_mentions" DROP CONSTRAINT "entity_mentions_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "external_refs" DROP CONSTRAINT "external_refs_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "governed_agent_events" DROP CONSTRAINT "governed_agent_events_run_id_fkey";

-- DropForeignKey
ALTER TABLE "hq_workflow_artifacts" DROP CONSTRAINT "hq_workflow_artifacts_step_id_fkey";

-- DropForeignKey
ALTER TABLE "hq_workflow_artifacts" DROP CONSTRAINT "hq_workflow_artifacts_workflow_id_fkey";

-- DropForeignKey
ALTER TABLE "hq_workflow_steps" DROP CONSTRAINT "hq_workflow_steps_workflow_id_fkey";

-- DropForeignKey
ALTER TABLE "hyper_rooms" DROP CONSTRAINT "hyper_rooms_org_id_fkey";

-- DropForeignKey
ALTER TABLE "hyper_rooms" DROP CONSTRAINT "hyper_rooms_user_id_fkey";

-- DropForeignKey
ALTER TABLE "hyper_turns" DROP CONSTRAINT "hyper_turns_room_id_fkey";

-- DropForeignKey
ALTER TABLE "hyper_work_orders" DROP CONSTRAINT "hyper_work_orders_room_fk";

-- DropForeignKey
ALTER TABLE "hyper_work_orders" DROP CONSTRAINT "hyper_work_orders_turn_fk";

-- DropForeignKey
ALTER TABLE "hyper_work_results" DROP CONSTRAINT "hyper_work_results_work_order_id_fkey";

-- DropForeignKey
ALTER TABLE "knowledge_ingest_steps" DROP CONSTRAINT "knowledge_ingest_steps_job_id_fkey";

-- DropForeignKey
ALTER TABLE "meeting_segments" DROP CONSTRAINT "meeting_segments_meeting_id_fkey";

-- DropForeignKey
ALTER TABLE "memories" DROP CONSTRAINT "memories_primary_team_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_entity_links" DROP CONSTRAINT "memory_entity_links_entity_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_entity_links" DROP CONSTRAINT "memory_entity_links_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_projection_states" DROP CONSTRAINT "memory_projection_states_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_projects" DROP CONSTRAINT "memory_projects_added_by_fkey";

-- DropForeignKey
ALTER TABLE "memory_projects" DROP CONSTRAINT "memory_projects_memory_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_projects" DROP CONSTRAINT "memory_projects_project_id_fkey";

-- DropForeignKey
ALTER TABLE "operating_room_events" DROP CONSTRAINT "operating_room_events_room_fk";

-- DropForeignKey
ALTER TABLE "operating_room_participants" DROP CONSTRAINT "operating_room_participants_room_fk";

-- DropForeignKey
ALTER TABLE "operating_room_participants" DROP CONSTRAINT "operating_room_participants_user_fk";

-- DropForeignKey
ALTER TABLE "org_sso_configs" DROP CONSTRAINT "org_sso_configs_org_fkey";

-- DropForeignKey
ALTER TABLE "platform_integrations" DROP CONSTRAINT "platform_integrations_team_id_fkey";

-- DropForeignKey
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_project_id_fkey";

-- DropForeignKey
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_user_id_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_team_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_eligibilities" DROP CONSTRAINT "promotion_eligibilities_promotion_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_redemptions" DROP CONSTRAINT "promotion_redemptions_entitlement_grant_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_redemptions" DROP CONSTRAINT "promotion_redemptions_org_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_redemptions" DROP CONSTRAINT "promotion_redemptions_promotion_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_redemptions" DROP CONSTRAINT "promotion_redemptions_promotion_version_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_versions" DROP CONSTRAINT "promotion_versions_promotion_id_fkey";

-- DropForeignKey
ALTER TABLE "promotions" DROP CONSTRAINT "promotions_legacy_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "referral_redemptions" DROP CONSTRAINT "referral_redemptions_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "runtime_playbook_artifacts" DROP CONSTRAINT "runtime_playbook_artifacts_run_id_fkey";

-- DropForeignKey
ALTER TABLE "runtime_playbook_authorities" DROP CONSTRAINT "runtime_playbook_authorities_run_id_fkey";

-- DropForeignKey
ALTER TABLE "runtime_playbook_checkpoints" DROP CONSTRAINT "runtime_playbook_checkpoints_run_id_fkey";

-- DropForeignKey
ALTER TABLE "seo_search_console_properties" DROP CONSTRAINT "seo_gsc_properties_integration_fkey";

-- DropForeignKey
ALTER TABLE "seo_search_console_properties" DROP CONSTRAINT "seo_gsc_properties_org_fkey";

-- DropForeignKey
ALTER TABLE "seo_search_console_properties" DROP CONSTRAINT "seo_gsc_properties_user_fkey";

-- DropForeignKey
ALTER TABLE "seo_search_console_snapshots" DROP CONSTRAINT "seo_gsc_snapshots_org_fkey";

-- DropForeignKey
ALTER TABLE "seo_search_console_snapshots" DROP CONSTRAINT "seo_gsc_snapshots_property_fkey";

-- DropForeignKey
ALTER TABLE "slack_events" DROP CONSTRAINT "slack_events_routed_to_employee_id_fkey";

-- DropForeignKey
ALTER TABLE "tara_call_attempts" DROP CONSTRAINT "tara_call_attempts_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "tara_call_attempts" DROP CONSTRAINT "tara_call_attempts_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "tara_campaign_contacts" DROP CONSTRAINT "tara_campaign_contacts_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_team_id_fkey";

-- DropForeignKey
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_user_id_fkey";

-- DropForeignKey
ALTER TABLE "team_task_messages" DROP CONSTRAINT "team_task_messages_task_id_fkey";

-- DropForeignKey
ALTER TABLE "team_tasks" DROP CONSTRAINT "team_tasks_org_id_fkey";

-- DropForeignKey
ALTER TABLE "team_tasks" DROP CONSTRAINT "team_tasks_requested_by_fkey";

-- DropForeignKey
ALTER TABLE "team_tasks" DROP CONSTRAINT "team_tasks_team_id_fkey";

-- DropForeignKey
ALTER TABLE "teams" DROP CONSTRAINT "teams_org_id_fkey";

-- DropForeignKey
ALTER TABLE "visual_intelligence_steps" DROP CONSTRAINT "visual_intelligence_steps_run_id_fkey";

-- DropForeignKey
ALTER TABLE "x_ads_campaign_steps" DROP CONSTRAINT "x_ads_campaign_steps_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "zernio_org_profiles" DROP CONSTRAINT "zernio_org_profiles_org_id_fkey";

-- DropForeignKey
ALTER TABLE "zernio_webhook_events" DROP CONSTRAINT "zernio_webhook_events_org_id_fkey";

-- DropIndex
DROP INDEX "access_applications_type_status_created_idx";

-- DropIndex
DROP INDEX "agent_trust_org_score_idx";

-- DropIndex
DROP INDEX "idx_api_keys_project";

-- DropIndex
DROP INDEX "idx_api_keys_team";

-- DropIndex
DROP INDEX "billing_checkouts_org_status_created_idx";

-- DropIndex
DROP INDEX "billing_checkouts_user_created_idx";

-- DropIndex
DROP INDEX "cluster_index_org_idx";

-- DropIndex
DROP INDEX "cluster_index_recall_age_idx";

-- DropIndex
DROP INDEX "idx_connector_sync_jobs_org";

-- DropIndex
DROP INDEX "entitlement_grants_org_active_idx";

-- DropIndex
DROP INDEX "entitlement_versions_effective_idx";

-- DropIndex
DROP INDEX "hyper_rooms_lead_idx";

-- DropIndex
DROP INDEX "hyper_rooms_skeptic_idx";

-- DropIndex
DROP INDEX "memories_valid_window_idx";

-- DropIndex
DROP INDEX "idx_org_invites_project_ids";

-- DropIndex
DROP INDEX "org_invites_revoked_at_idx";

-- DropIndex
DROP INDEX "org_sso_configs_enabled_idx";

-- DropIndex
DROP INDEX "organization_entitlements_active_idx";

-- DropIndex
DROP INDEX "plan_catalog_versions_plan_created_idx";

-- DropIndex
DROP INDEX "promotion_redemptions_org_idx";

-- AlterTable
ALTER TABLE "OrgUsage" ALTER COLUMN "webIntelDay" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PageIndexNode" ALTER COLUMN "memory_ids" SET DATA TYPE TEXT[],
ALTER COLUMN "last_pruned_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "summary_updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "canonical_entities" ADD COLUMN     "normalized_name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "external_refs" ALTER COLUMN "metadata" DROP NOT NULL;

-- AlterTable
ALTER TABLE "governance_action_log" ALTER COLUMN "evidence_ids" DROP DEFAULT,
ALTER COLUMN "confidence" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "hyper_rooms" ADD COLUMN     "evo_mode" TEXT DEFAULT 'off',
ALTER COLUMN "quality_mode" SET NOT NULL,
ALTER COLUMN "sim_mode" SET NOT NULL,
ALTER COLUMN "sim_agents" SET NOT NULL;

-- AlterTable
ALTER TABLE "memories" ALTER COLUMN "synthesis_evidence_ids" DROP DEFAULT,
ALTER COLUMN "synthesis_cluster_hash" SET DATA TYPE VARCHAR(128);

-- AlterTable
ALTER TABLE "memory_box_connections" ALTER COLUMN "box_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "org_invites" ALTER COLUMN "project_ids" SET DATA TYPE TEXT[];

-- AlterTable
ALTER TABLE "org_sso_configs" ALTER COLUMN "default_role" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "organization_profiles" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "cognition_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "commercial_terms" JSONB,
ADD COLUMN     "company_profile" JSONB,
ADD COLUMN     "hosting_mode" VARCHAR(20) DEFAULT 'managed',
ADD COLUMN     "plan" VARCHAR(50) DEFAULT 'free',
ADD COLUMN     "promotion_code_id" UUID;

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "working_sets" ALTER COLUMN "active_entities" DROP DEFAULT,
ALTER COLUMN "active_threads" DROP DEFAULT,
ALTER COLUMN "active_projects" DROP DEFAULT,
ALTER COLUMN "pinned_memory_ids" DROP DEFAULT;

-- CreateTable
CREATE TABLE "nango_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider_key" VARCHAR(100) NOT NULL,
    "connection_id" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "nango_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "op" VARCHAR(20) NOT NULL,
    "payload" JSONB NOT NULL,
    "seq" BIGINT NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ(6),

    CONSTRAINT "memory_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_onboarding_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code_hash" CHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "hosting_mode" VARCHAR(20),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprise_onboarding_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code_hash" CHAR(64) NOT NULL,
    "code_hint" VARCHAR(12) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "audience" VARCHAR(20) NOT NULL,
    "offer" JSONB NOT NULL,
    "stripe_coupon_id" VARCHAR(64),
    "max_redemptions" INTEGER,
    "redemption_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_migrations_applied" (
    "migration_name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" TEXT NOT NULL,
    "release_id" TEXT,

    CONSTRAINT "schema_migrations_applied_pkey" PRIMARY KEY ("migration_name")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "nango_connections_user_id_provider_key_idx" ON "nango_connections"("user_id", "provider_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "nango_connections_org_id_idx" ON "nango_connections"("org_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "nango_connections_status_idx" ON "nango_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "nango_connections_user_id_provider_key_org_id_key" ON "nango_connections"("user_id", "provider_key", "org_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memory_outbox_org_status_next_idx" ON "memory_outbox"("org_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memory_outbox_record_seq_idx" ON "memory_outbox"("record_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "enterprise_onboarding_codes_code_hash_key" ON "enterprise_onboarding_codes"("code_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "enterprise_onboarding_codes_expires_at_idx" ON "enterprise_onboarding_codes"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "enterprise_onboarding_codes_used_at_idx" ON "enterprise_onboarding_codes"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_codes_code_hash_key" ON "promotion_codes"("code_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "promotion_codes_audience_idx" ON "promotion_codes"("audience");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "promotion_codes_expires_at_idx" ON "promotion_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PageIndexNode_user_id_path_key" ON "PageIndexNode"("user_id", "path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "access_applications_account_type_status_created_at_idx" ON "access_applications"("account_type", "status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "activation_lifecycles_stage_next_reminder_at_idx" ON "activation_lifecycles"("stage", "next_reminder_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "activation_lifecycles_email_hash_created_at_idx" ON "activation_lifecycles"("email_hash", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "agent_trust_org_id_trust_score_idx" ON "agent_trust"("org_id", "trust_score");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_runs_turn_id_key" ON "campaign_runs"("turn_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaigns_room_id_idx" ON "campaigns"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_legacy_source_key" ON "campaigns"("org_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_creation_key" ON "campaigns"("org_id", "owner_user_id", "creation_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "canonical_entities_org_kind_normalized_idx" ON "canonical_entities"("organization_id", "entity_kind", "normalized_name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_entities_org_identity_key" ON "canonical_entities"("organization_id", "identity_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cluster_index_organization_id_dirty_count_idx" ON "cluster_index"("organization_id", "dirty_count" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_connector_sync_jobs_org" ON "connector_sync_jobs"("org_id", "connector_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "contacts_org_id_idx" ON "contacts"("org_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "decisions_outcome_tracked_outcome_resolves_at_idx" ON "decisions"("outcome_tracked", "outcome_resolves_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "entitlement_grants_org_id_status_starts_at_idx" ON "entitlement_grants"("org_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "entitlement_versions_grant_id_effective_from_idx" ON "entitlement_versions"("grant_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "governance_action_log_idempotent_idx" ON "governance_action_log"("target_memory_id", "action_type", "batch_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_delegations_org_id_status_idx" ON "growth_delegations"("org_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_delegations_room_id_idx" ON "growth_delegations"("room_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_goals_owner_user_id_created_at_idx" ON "growth_goals"("owner_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_hypotheses_org_id_status_idx" ON "growth_hypotheses"("org_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_journal_growth_stage_id_created_at_idx" ON "growth_journal"("growth_stage_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "growth_stages_growth_goal_id_created_at_idx" ON "growth_stages"("growth_goal_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "hyper_work_orders_hq_cycle_id_order_key_key" ON "hyper_work_orders"("hq_cycle_id", "order_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_org_canonical_key_uq" ON "knowledge_documents"("org_id", "canonical_ingest_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memories_synthesis_cluster_hash_idx" ON "memories"("synthesis_cluster_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "memories_cognitive_layer_role_idx" ON "memories"("cognitive_layer_role");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "memory_projection_attempt_workflow_key" ON "memory_projection_attempts"("workflow_instance_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "organization_entitlements_org_id_effective_from_effective_u_idx" ON "organization_entitlements"("org_id", "effective_from", "effective_until");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_customer_id_key" ON "organizations"("stripe_customer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plan_catalog_versions_plan_id_created_at_idx" ON "plan_catalog_versions"("plan_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "promotion_redemptions_org_id_redeemed_at_idx" ON "promotion_redemptions"("org_id", "redeemed_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tara_call_attempts_action_key_key" ON "tara_call_attempts"("action_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "team_tasks_slack_channel_slack_thread_ts_idx" ON "team_tasks"("slack_channel", "slack_thread_ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "web_intel_jobs_org_id_user_id_idempotency_key_idx" ON "web_intel_jobs"("org_id", "user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "x_ads_campaigns_org_id_x_campaign_id_key" ON "x_ads_campaigns"("org_id", "x_campaign_id");

-- RenameForeignKey
ALTER TABLE "durable_chat_checkpoints" RENAME CONSTRAINT "durable_chat_checkpoints_turn_fkey" TO "durable_chat_checkpoints_turn_id_fkey";

-- RenameForeignKey
ALTER TABLE "durable_chat_events" RENAME CONSTRAINT "durable_chat_events_turn_fkey" TO "durable_chat_events_turn_id_fkey";

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_search_console_properties" ADD CONSTRAINT "seo_search_console_properties_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_search_console_properties" ADD CONSTRAINT "seo_search_console_properties_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_search_console_properties" ADD CONSTRAINT "seo_search_console_properties_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "platform_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_search_console_snapshots" ADD CONSTRAINT "seo_search_console_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_search_console_snapshots" ADD CONSTRAINT "seo_search_console_snapshots_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "seo_search_console_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governed_agent_events" ADD CONSTRAINT "governed_agent_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_org_profiles" ADD CONSTRAINT "zernio_org_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_webhook_events" ADD CONSTRAINT "zernio_webhook_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_channels" ADD CONSTRAINT "campaign_channels_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plan_versions" ADD CONSTRAINT "campaign_plan_versions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_members" ADD CONSTRAINT "campaign_audience_members_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_members" ADD CONSTRAINT "campaign_audience_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "audience_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "campaign_plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_audience_member_id_fkey" FOREIGN KEY ("audience_member_id") REFERENCES "campaign_audience_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_action_attempts" ADD CONSTRAINT "campaign_action_attempts_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "campaign_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_approvals" ADD CONSTRAINT "campaign_approvals_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_approvals" ADD CONSTRAINT "campaign_approvals_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "campaign_plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "campaign_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_metric_snapshots" ADD CONSTRAINT "campaign_metric_snapshots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x_ads_campaign_steps" ADD CONSTRAINT "x_ads_campaign_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "x_ads_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_primary_team_id_fkey" FOREIGN KEY ("primary_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hq_workflow_steps" ADD CONSTRAINT "hq_workflow_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "hq_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hq_workflow_artifacts" ADD CONSTRAINT "hq_workflow_artifacts_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "hq_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hq_workflow_artifacts" ADD CONSTRAINT "hq_workflow_artifacts_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "hq_workflow_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_ingest_steps" ADD CONSTRAINT "knowledge_ingest_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "knowledge_ingest_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "referral_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_invitations" ADD CONSTRAINT "enterprise_invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_sso_configs" ADD CONSTRAINT "org_sso_configs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_employees" ADD CONSTRAINT "digital_employees_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_employees" ADD CONSTRAINT "digital_employees_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digital_employees" ADD CONSTRAINT "digital_employees_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hyper_rooms" ADD CONSTRAINT "hyper_rooms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hyper_rooms" ADD CONSTRAINT "hyper_rooms_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hyper_turns" ADD CONSTRAINT "hyper_turns_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "hyper_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tara_campaign_contacts" ADD CONSTRAINT "tara_campaign_contacts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "tara_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tara_call_attempts" ADD CONSTRAINT "tara_call_attempts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "tara_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tara_call_attempts" ADD CONSTRAINT "tara_call_attempts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "tara_campaign_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_evals" ADD CONSTRAINT "agent_evals_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "hyper_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_events" ADD CONSTRAINT "slack_events_routed_to_employee_id_fkey" FOREIGN KEY ("routed_to_employee_id") REFERENCES "digital_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_intents" ADD CONSTRAINT "action_intents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "digital_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "PageIndexNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_task_messages" ADD CONSTRAINT "team_task_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "team_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entity_links" ADD CONSTRAINT "memory_entity_links_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "canonical_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_claims" ADD CONSTRAINT "canonical_claims_subject_entity_id_fkey" FOREIGN KEY ("subject_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_claims" ADD CONSTRAINT "canonical_claims_object_entity_id_fkey" FOREIGN KEY ("object_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_claims" ADD CONSTRAINT "canonical_claims_predicate_id_fkey" FOREIGN KEY ("predicate_id") REFERENCES "canonical_predicates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_claims" ADD CONSTRAINT "canonical_claims_supersedes_claim_id_fkey" FOREIGN KEY ("supersedes_claim_id") REFERENCES "canonical_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence_links" ADD CONSTRAINT "claim_evidence_links_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "canonical_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence_links" ADD CONSTRAINT "claim_evidence_links_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_projection_states" ADD CONSTRAINT "memory_projection_states_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_playbook_artifacts" ADD CONSTRAINT "runtime_playbook_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runtime_playbook_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_playbook_checkpoints" ADD CONSTRAINT "runtime_playbook_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runtime_playbook_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_playbook_authorities" ADD CONSTRAINT "runtime_playbook_authorities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runtime_playbook_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_intelligence_steps" ADD CONSTRAINT "visual_intelligence_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "visual_intelligence_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "access_applications_email_type_key" RENAME TO "access_applications_email_hash_account_type_key";

-- RenameIndex
ALTER INDEX "action_intents_employee_created_idx" RENAME TO "action_intents_employee_id_created_at_idx";

-- RenameIndex
ALTER INDEX "agent_evals_agent_tuning_idx" RENAME TO "agent_evals_agent_id_used_for_tuning_at_idx";

-- RenameIndex
ALTER INDEX "agent_evals_turn_idx" RENAME TO "agent_evals_turn_id_idx";

-- RenameIndex
ALTER INDEX "audience_contacts_org_email_idx" RENAME TO "audience_contacts_org_id_email_idx";

-- RenameIndex
ALTER INDEX "audience_contacts_org_lifecycle_updated_idx" RENAME TO "audience_contacts_org_id_lifecycle_updated_at_idx";

-- RenameIndex
ALTER INDEX "audience_contacts_org_phone_idx" RENAME TO "audience_contacts_org_id_phone_idx";

-- RenameIndex
ALTER INDEX "campaign_action_attempts_action_attempt_key" RENAME TO "campaign_action_attempts_action_id_attempt_key";

-- RenameIndex
ALTER INDEX "campaign_action_attempts_action_status_idx" RENAME TO "campaign_action_attempts_action_id_status_idx";

-- RenameIndex
ALTER INDEX "campaign_actions_campaign_idempotency_key" RENAME TO "campaign_actions_campaign_id_idempotency_key_key";

-- RenameIndex
ALTER INDEX "campaign_actions_campaign_status_position_idx" RENAME TO "campaign_actions_campaign_id_status_position_idx";

-- RenameIndex
ALTER INDEX "campaign_actions_due_lease_idx" RENAME TO "campaign_actions_status_scheduled_at_lease_expires_at_idx";

-- RenameIndex
ALTER INDEX "campaign_actions_plan_version_idx" RENAME TO "campaign_actions_plan_version_id_idx";

-- RenameIndex
ALTER INDEX "campaign_approvals_campaign_status_approved_idx" RENAME TO "campaign_approvals_campaign_id_status_approved_at_idx";

-- RenameIndex
ALTER INDEX "campaign_approvals_plan_version_idx" RENAME TO "campaign_approvals_plan_version_id_idx";

-- RenameIndex
ALTER INDEX "campaign_assets_action_idx" RENAME TO "campaign_assets_action_id_idx";

-- RenameIndex
ALTER INDEX "campaign_assets_campaign_status_idx" RENAME TO "campaign_assets_campaign_id_status_idx";

-- RenameIndex
ALTER INDEX "campaign_audience_members_campaign_dedupe_key" RENAME TO "campaign_audience_members_campaign_id_dedupe_key_key";

-- RenameIndex
ALTER INDEX "campaign_audience_members_campaign_status_idx" RENAME TO "campaign_audience_members_campaign_id_status_idx";

-- RenameIndex
ALTER INDEX "campaign_audience_members_contact_idx" RENAME TO "campaign_audience_members_contact_id_idx";

-- RenameIndex
ALTER INDEX "campaign_channels_campaign_channel_key" RENAME TO "campaign_channels_campaign_id_channel_key";

-- RenameIndex
ALTER INDEX "campaign_channels_campaign_status_idx" RENAME TO "campaign_channels_campaign_id_status_idx";

-- RenameIndex
ALTER INDEX "campaign_events_campaign_id_idx" RENAME TO "campaign_events_campaign_id_id_idx";

-- RenameIndex
ALTER INDEX "campaign_events_org_created_idx" RENAME TO "campaign_events_org_id_created_at_idx";

-- RenameIndex
ALTER INDEX "campaign_metric_snapshots_campaign_captured_idx" RENAME TO "campaign_metric_snapshots_campaign_id_captured_at_idx";

-- RenameIndex
ALTER INDEX "campaign_metric_snapshots_campaign_channel_idx" RENAME TO "campaign_metric_snapshots_campaign_id_channel_captured_at_idx";

-- RenameIndex
ALTER INDEX "campaign_plan_versions_campaign_status_idx" RENAME TO "campaign_plan_versions_campaign_id_status_idx";

-- RenameIndex
ALTER INDEX "campaign_plan_versions_campaign_version_key" RENAME TO "campaign_plan_versions_campaign_id_version_key";

-- RenameIndex
ALTER INDEX "campaign_runs_campaign_created_idx" RENAME TO "campaign_runs_campaign_id_created_at_idx";

-- RenameIndex
ALTER INDEX "campaign_runs_status_created_idx" RENAME TO "campaign_runs_status_created_at_idx";

-- RenameIndex
ALTER INDEX "campaigns_org_status_created_idx" RENAME TO "campaigns_org_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "campaigns_owner_created_idx" RENAME TO "campaigns_owner_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "canonical_claims_org_object_idx" RENAME TO "canonical_claims_organization_id_object_entity_id_idx";

-- RenameIndex
ALTER INDEX "canonical_claims_org_subject_predicate_idx" RENAME TO "canonical_claims_organization_id_subject_entity_id_predicat_idx";

-- RenameIndex
ALTER INDEX "canonical_claims_org_valid_idx" RENAME TO "canonical_claims_organization_id_valid_from_valid_to_idx";

-- RenameIndex
ALTER INDEX "canonical_entities_aliases_gin" RENAME TO "canonical_entities_aliases_idx";

-- RenameIndex
ALTER INDEX "canonical_entities_email_domains_gin" RENAME TO "canonical_entities_email_domains_idx";

-- RenameIndex
ALTER INDEX "canonical_entities_org_kind_idx" RENAME TO "canonical_entities_organization_id_entity_kind_idx";

-- RenameIndex
ALTER INDEX "capability_adapter_states_lookup_idx" RENAME TO "capability_adapter_states_org_id_capability_key_state_expir_idx";

-- RenameIndex
ALTER INDEX "capability_adapter_states_org_capability_adapter_key" RENAME TO "capability_adapter_states_org_id_capability_key_adapter_id_key";

-- RenameIndex
ALTER INDEX "claim_evidence_links_claim_memory_digest_key" RENAME TO "claim_evidence_links_claim_id_memory_id_source_digest_key";

-- RenameIndex
ALTER INDEX "cluster_index_entity_keys_gin" RENAME TO "cluster_index_entity_keys_idx";

-- RenameIndex
ALTER INDEX "cluster_index_unique" RENAME TO "cluster_index_organization_id_user_id_cluster_hash_key";

-- RenameIndex
ALTER INDEX "contacts_user_email_unique" RENAME TO "contacts_user_id_email_source_platform_key";

-- RenameIndex
ALTER INDEX "idx_contacts_domain" RENAME TO "contacts_domain_idx";

-- RenameIndex
ALTER INDEX "idx_contacts_last_seen" RENAME TO "contacts_last_seen_at_idx";

-- RenameIndex
ALTER INDEX "idx_contacts_user_email" RENAME TO "contacts_user_id_email_idx";

-- RenameIndex
ALTER INDEX "decisions_entity_refs_gin" RENAME TO "decisions_entity_refs_idx";

-- RenameIndex
ALTER INDEX "decisions_org_decided_at_idx" RENAME TO "decisions_organization_id_decided_at_idx";

-- RenameIndex
ALTER INDEX "digital_employees_slack_team_idx" RENAME TO "digital_employees_slack_team_id_idx";

-- RenameIndex
ALTER INDEX "enterprise_invitations_recipient_status_idx" RENAME TO "enterprise_invitations_recipient_email_hash_status_idx";

-- RenameIndex
ALTER INDEX "enterprise_invitations_status_expiry_idx" RENAME TO "enterprise_invitations_status_invitation_expires_at_idx";

-- RenameIndex
ALTER INDEX "entity_review_org_status_idx" RENAME TO "entity_review_candidates_organization_id_status_idx";

-- RenameIndex
ALTER INDEX "external_refs_memory_idx" RENAME TO "external_refs_memory_id_idx";

-- RenameIndex
ALTER INDEX "external_refs_org_sys_obj_idx" RENAME TO "external_refs_organization_id_system_object_type_idx";

-- RenameIndex
ALTER INDEX "external_refs_unique" RENAME TO "external_refs_organization_id_system_object_type_external_i_key";

-- RenameIndex
ALTER INDEX "growth_delegations_stage_created_idx" RENAME TO "growth_delegations_growth_stage_id_created_at_idx";

-- RenameIndex
ALTER INDEX "growth_goals_org_status_idx" RENAME TO "growth_goals_org_id_status_idx";

-- RenameIndex
ALTER INDEX "growth_hypotheses_stage_created_idx" RENAME TO "growth_hypotheses_growth_stage_id_created_at_idx";

-- RenameIndex
ALTER INDEX "growth_journal_org_created_idx" RENAME TO "growth_journal_org_id_created_at_idx";

-- RenameIndex
ALTER INDEX "growth_stages_org_status_checkpoint_idx" RENAME TO "growth_stages_org_id_status_checkpoint_at_idx";

-- RenameIndex
ALTER INDEX "hq_activity_org_hq_created_idx" RENAME TO "hq_activity_org_id_hq_room_id_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_capability_requests_org_status_idx" RENAME TO "hq_capability_requests_org_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_cycles_runtime_created_idx" RENAME TO "hq_cycles_runtime_id_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_cycles_runtime_epoch_idx" RENAME TO "hq_cycles_runtime_id_runtime_epoch_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_cycles_status_lease_idx" RENAME TO "hq_cycles_status_lease_expires_at_idx";

-- RenameIndex
ALTER INDEX "hq_instructions_runtime_status_idx" RENAME TO "hq_instructions_runtime_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_events_cycle_sequence_idx" RENAME TO "hq_runtime_events_cycle_id_sequence_idx";

-- RenameIndex
ALTER INDEX "hq_events_org_created_idx" RENAME TO "hq_runtime_events_org_id_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_runtimes_state_wake_idx" RENAME TO "hq_runtimes_state_next_wake_at_idx";

-- RenameIndex
ALTER INDEX "hq_schedules_runtime_created_idx" RENAME TO "hq_schedules_runtime_id_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_schedules_runtime_epoch_due_idx" RENAME TO "hq_schedules_runtime_id_runtime_epoch_due_at_idx";

-- RenameIndex
ALTER INDEX "hq_schedules_status_due_idx" RENAME TO "hq_schedules_status_due_at_idx";

-- RenameIndex
ALTER INDEX "hq_todos_runtime_status_position_idx" RENAME TO "hq_todos_runtime_id_status_priority_position_idx";

-- RenameIndex
ALTER INDEX "hq_workflow_artifacts_org_type_status_idx" RENAME TO "hq_workflow_artifacts_org_id_artifact_type_status_idx";

-- RenameIndex
ALTER INDEX "hq_workflow_artifacts_step_created_idx" RENAME TO "hq_workflow_artifacts_step_id_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_workflow_artifacts_workflow_key_uq" RENAME TO "hq_workflow_artifacts_workflow_id_artifact_key_key";

-- RenameIndex
ALTER INDEX "hq_workflow_steps_org_status_due_idx" RENAME TO "hq_workflow_steps_org_id_status_due_at_idx";

-- RenameIndex
ALTER INDEX "hq_workflow_steps_work_order_uq" RENAME TO "hq_workflow_steps_work_order_id_key";

-- RenameIndex
ALTER INDEX "hq_workflow_steps_workflow_position_idx" RENAME TO "hq_workflow_steps_workflow_id_position_idx";

-- RenameIndex
ALTER INDEX "hq_workflow_steps_workflow_step_key_uq" RENAME TO "hq_workflow_steps_workflow_id_step_key_key";

-- RenameIndex
ALTER INDEX "hq_workflows_org_kind_status_idx" RENAME TO "hq_workflows_org_id_kind_status_idx";

-- RenameIndex
ALTER INDEX "hq_workflows_runtime_status_created_idx" RENAME TO "hq_workflows_runtime_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "hq_workflows_runtime_todo_uq" RENAME TO "hq_workflows_runtime_id_todo_id_key";

-- RenameIndex
ALTER INDEX "hyper_approval_rules_org_action_key" RENAME TO "hyper_approval_rules_org_id_action_label_key";

-- RenameIndex
ALTER INDEX "hyper_rooms_archived_idx" RENAME TO "hyper_rooms_archived_at_idx";

-- RenameIndex
ALTER INDEX "hyper_rooms_org_room_mode_idx" RENAME TO "hyper_rooms_org_id_room_mode_idx";

-- RenameIndex
ALTER INDEX "hyper_rooms_user_org_idx" RENAME TO "hyper_rooms_user_id_org_id_idx";

-- RenameIndex
ALTER INDEX "hyper_turns_room_idx" RENAME TO "hyper_turns_room_id_idx";

-- RenameIndex
ALTER INDEX "hyper_turns_runtime_playbook_run_id_runtime_checkpoint_sequence" RENAME TO "hyper_turns_runtime_playbook_run_id_runtime_checkpoint_sequ_idx";

-- RenameIndex
ALTER INDEX "hyper_turns_runtime_playbook_run_id_runtime_stage_id_runtime_at" RENAME TO "hyper_turns_runtime_playbook_run_id_runtime_stage_id_runtim_idx";

-- RenameIndex
ALTER INDEX "hyper_work_orders_hq_cycle_status_idx" RENAME TO "hyper_work_orders_hq_cycle_id_status_idx";

-- RenameIndex
ALTER INDEX "hyper_work_orders_org_epoch_status_idx" RENAME TO "hyper_work_orders_org_id_runtime_epoch_status_idx";

-- RenameIndex
ALTER INDEX "hyper_work_orders_org_room_status_idx" RENAME TO "hyper_work_orders_org_id_room_id_status_idx";

-- RenameIndex
ALTER INDEX "hyper_work_orders_turn_idx" RENAME TO "hyper_work_orders_turn_id_idx";

-- RenameIndex
ALTER INDEX "hyper_work_orders_turn_order_key_key" RENAME TO "hyper_work_orders_turn_id_order_key_key";

-- RenameIndex
ALTER INDEX "hyper_work_orders_turn_plan_step_idx" RENAME TO "hyper_work_orders_turn_id_plan_step_id_idx";

-- RenameIndex
ALTER INDEX "hyper_work_results_epoch_created_idx" RENAME TO "hyper_work_results_runtime_epoch_created_at_idx";

-- RenameIndex
ALTER INDEX "hyper_work_results_order_attempt_key" RENAME TO "hyper_work_results_work_order_id_attempt_key";

-- RenameIndex
ALTER INDEX "hyper_work_results_order_idx" RENAME TO "hyper_work_results_work_order_id_idx";

-- RenameIndex
ALTER INDEX "inbound_webhook_subscriptions_org_id_provider_key_external_id_k" RENAME TO "inbound_webhook_subscriptions_org_id_provider_key_external__key";

-- RenameIndex
ALTER INDEX "knowledge_documents_user_id_org_id_source_platform_sourc_key" RENAME TO "knowledge_documents_user_id_org_id_source_platform_source_i_key";

-- RenameIndex
ALTER INDEX "knowledge_ingest_jobs_org_scope_checksum_idx" RENAME TO "knowledge_ingest_jobs_org_id_scope_key_checksum_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_jobs_org_status_updated_idx" RENAME TO "knowledge_ingest_jobs_org_id_status_updated_at_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_jobs_org_user_created_idx" RENAME TO "knowledge_ingest_jobs_org_id_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_jobs_queue_job_idx" RENAME TO "knowledge_ingest_jobs_queue_job_id_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_leases_job_version_idx" RENAME TO "knowledge_ingest_leases_job_id_processing_version_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_steps_identity_key" RENAME TO "knowledge_ingest_steps_job_id_processing_version_stage_key__key";

-- RenameIndex
ALTER INDEX "knowledge_ingest_steps_job_status_idx" RENAME TO "knowledge_ingest_steps_job_id_processing_version_status_idx";

-- RenameIndex
ALTER INDEX "knowledge_ingest_steps_lease_idx" RENAME TO "knowledge_ingest_steps_status_lease_until_idx";

-- RenameIndex
ALTER INDEX "knowledge_usage_settlements_job_metric_key" RENAME TO "knowledge_usage_settlements_job_id_metric_key";

-- RenameIndex
ALTER INDEX "knowledge_usage_settlements_org_user_created_idx" RENAME TO "knowledge_usage_settlements_org_id_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "memory_box_connections_state_heartbeat_idx" RENAME TO "memory_box_connections_state_last_heartbeat_at_idx";

-- RenameIndex
ALTER INDEX "memory_entity_links_entity_idx" RENAME TO "memory_entity_links_entity_id_idx";

-- RenameIndex
ALTER INDEX "memory_projection_states_org_claims_status_idx" RENAME TO "memory_projection_states_organization_id_claims_status_idx";

-- RenameIndex
ALTER INDEX "org_invites_org_creator_idempotency_key_uidx" RENAME TO "org_invites_org_id_created_by_idempotency_key_key";

-- RenameIndex
ALTER INDEX "outbound_actions_campaign_action_idx" RENAME TO "outbound_actions_campaign_action_id_idx";

-- RenameIndex
ALTER INDEX "outbound_actions_campaign_sent_idx" RENAME TO "outbound_actions_campaign_id_sent_at_idx";

-- RenameIndex
ALTER INDEX "outreach_campaigns_unified_campaign_idx" RENAME TO "outreach_campaigns_unified_campaign_id_idx";

-- RenameIndex
ALTER INDEX "plan_catalog_versions_plan_version_unique" RENAME TO "plan_catalog_versions_plan_id_version_key";

-- RenameIndex
ALTER INDEX "playbooks_org_status_idx" RENAME TO "playbooks_organization_id_status_idx";

-- RenameIndex
ALTER INDEX "promotion_redemptions_promotion_email_idx" RENAME TO "promotion_redemptions_promotion_id_email_hash_idx";

-- RenameIndex
ALTER INDEX "referral_redemptions_campaign_idx" RENAME TO "referral_redemptions_campaign_id_idx";

-- RenameIndex
ALTER INDEX "runtime_performance_metrics_metric_idx" RENAME TO "runtime_performance_metrics_org_id_metric_created_at_idx";

-- RenameIndex
ALTER INDEX "runtime_performance_metrics_run_idx" RENAME TO "runtime_performance_metrics_run_id_stage_id_idx";

-- RenameIndex
ALTER INDEX "runtime_playbook_runs_parent_position_idx" RENAME TO "runtime_playbook_runs_parent_run_id_position_idx";

-- RenameIndex
ALTER INDEX "runtime_release_evidence_org_feature_created_idx" RENAME TO "runtime_release_evidence_org_id_feature_created_at_idx";

-- RenameIndex
ALTER INDEX "runtime_rollout_policies_org_feature_key" RENAME TO "runtime_rollout_policies_org_id_feature_key";

-- RenameIndex
ALTER INDEX "slack_events_routed_to_employee_idx" RENAME TO "slack_events_routed_to_employee_id_idx";

-- RenameIndex
ALTER INDEX "slack_events_status_created_idx" RENAME TO "slack_events_status_created_at_idx";

-- RenameIndex
ALTER INDEX "slack_events_workspace_channel_idx" RENAME TO "slack_events_workspace_id_channel_id_idx";

-- RenameIndex
ALTER INDEX "tara_call_attempts_outreach_target_idx" RENAME TO "tara_call_attempts_outreach_campaign_id_outreach_target_id_idx";

-- RenameIndex
ALTER INDEX "tara_call_attempts_reconciliation_idx" RENAME TO "tara_call_attempts_org_id_reconciliation_state_updated_at_idx";

-- RenameIndex
ALTER INDEX "tara_call_attempts_runtime_stage_idx" RENAME TO "tara_call_attempts_runtime_playbook_run_id_runtime_stage_id_idx";

-- RenameIndex
ALTER INDEX "tara_campaigns_unified_campaign_idx" RENAME TO "tara_campaigns_unified_campaign_id_idx";

-- RenameIndex
ALTER INDEX "team_task_messages_kind_idx" RENAME TO "team_task_messages_task_id_kind_idx";

-- RenameIndex
ALTER INDEX "team_task_messages_task_idx" RENAME TO "team_task_messages_task_id_ts_idx";

-- RenameIndex
ALTER INDEX "team_tasks_org_idx" RENAME TO "team_tasks_org_id_idx";

-- RenameIndex
ALTER INDEX "team_tasks_team_idx" RENAME TO "team_tasks_team_id_idx";

-- RenameIndex
ALTER INDEX "visual_intelligence_runs_org_user_created_idx" RENAME TO "visual_intelligence_runs_org_id_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "visual_intelligence_runs_status_heartbeat_idx" RENAME TO "visual_intelligence_runs_status_heartbeat_at_idx";

-- RenameIndex
ALTER INDEX "visual_intelligence_steps_status_lease_idx" RENAME TO "visual_intelligence_steps_status_lease_expires_at_idx";

-- RenameIndex
ALTER INDEX "web_intel_jobs_owner_updated_idx" RENAME TO "web_intel_jobs_org_id_user_id_updated_at_idx";

-- RenameIndex
ALTER INDEX "web_intel_jobs_status_updated_idx" RENAME TO "web_intel_jobs_org_id_status_updated_at_idx";

-- RenameIndex
ALTER INDEX "web_intel_usage_settlements_org_user_idx" RENAME TO "web_intel_usage_settlements_org_id_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "workspace_notifications_org_user_created_idx" RENAME TO "workspace_notifications_org_id_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "workspace_notifications_org_user_dedupe_uidx" RENAME TO "workspace_notifications_org_id_user_id_dedupe_key_key";

-- RenameIndex
ALTER INDEX "workspace_notifications_org_user_unread_idx" RENAME TO "workspace_notifications_org_id_user_id_read_at_idx";

-- RenameIndex
ALTER INDEX "x_ads_campaign_steps_campaign_status_idx" RENAME TO "x_ads_campaign_steps_campaign_id_status_idx";

-- RenameIndex
ALTER INDEX "x_ads_campaign_steps_campaign_step_key" RENAME TO "x_ads_campaign_steps_campaign_id_step_key";

-- RenameIndex
ALTER INDEX "x_ads_campaigns_org_status_created_idx" RENAME TO "x_ads_campaigns_org_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX "x_ads_campaigns_unified_campaign_idx" RENAME TO "x_ads_campaigns_unified_campaign_id_idx";

-- RenameIndex
ALTER INDEX "x_ads_campaigns_user_created_idx" RENAME TO "x_ads_campaigns_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "zernio_org_profiles_provider_id_key" RENAME TO "zernio_org_profiles_zernio_profile_id_key";

-- RenameIndex
ALTER INDEX "zernio_org_profiles_status_synced_idx" RENAME TO "zernio_org_profiles_status_last_synced_at_idx";

-- RenameIndex
ALTER INDEX "zernio_webhook_events_org_received_idx" RENAME TO "zernio_webhook_events_org_id_received_at_idx";

-- RenameIndex
ALTER INDEX "zernio_webhook_events_status_received_idx" RENAME TO "zernio_webhook_events_status_received_at_idx";

