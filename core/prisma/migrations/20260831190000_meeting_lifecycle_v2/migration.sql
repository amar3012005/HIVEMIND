-- Durable GDPR-ready Meeting Notes v2. Additive and inert while the feature is off.
CREATE TABLE IF NOT EXISTS hivemind.meeting_recording_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  version integer NOT NULL, status varchar(24) NOT NULL DEFAULT 'draft',
  controller_name text NOT NULL, privacy_contact text NOT NULL,
  country_code varchar(2) NOT NULL, recording_jurisdiction text NOT NULL,
  lawful_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  purposes jsonb NOT NULL DEFAULT '[]'::jsonb,
  special_category_condition text, national_recording_rule text NOT NULL,
  internal_consent_mode varchar(32) NOT NULL DEFAULT 'participant_authorization',
  external_consent_mode varchar(32) NOT NULL DEFAULT 'strict_participant_authorization',
  processors jsonb NOT NULL DEFAULT '[]'::jsonb,
  retention jsonb NOT NULL DEFAULT '{}'::jsonb,
  dpia_status varchar(24) NOT NULL DEFAULT 'required', dpia_reference text,
  dpia_approved_by uuid, dpia_approved_at timestamptz,
  approved_by uuid, approved_at timestamptz, effective_at timestamptz,
  superseded_at timestamptz, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_policy_one_active_org_idx
  ON hivemind.meeting_recording_policies(org_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS hivemind.meeting_notice_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid NOT NULL REFERENCES hivemind.meeting_recording_policies(id),
  version integer NOT NULL, locale varchar(16) NOT NULL DEFAULT 'en', title text NOT NULL,
  body text NOT NULL, content_digest varchar(64) NOT NULL, approved_by uuid,
  approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(policy_id, version, locale)
);

ALTER TABLE hivemind.meeting_sessions
  ADD COLUMN IF NOT EXISTS orchestration_mode varchar(24) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS pipeline_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS workflow_instance_id text,
  ADD COLUMN IF NOT EXISTS latched_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recording_policy_id uuid,
  ADD COLUMN IF NOT EXISTS recording_policy_version integer,
  ADD COLUMN IF NOT EXISTS authorization_status varchar(32) NOT NULL DEFAULT 'legacy_attested',
  ADD COLUMN IF NOT EXISTS authorization_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS purposes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS storage_placement varchar(32),
  ADD COLUMN IF NOT EXISTS gateway_route text,
  ADD COLUMN IF NOT EXISTS stt_model text,
  ADD COLUMN IF NOT EXISTS insights_model text,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS current_stage varchar(64),
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_status varchar(32),
  ADD COLUMN IF NOT EXISTS publication_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processing_restricted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS audio_retention_deadline timestamptz;

CREATE TABLE IF NOT EXISTS hivemind.meeting_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,
  org_id uuid NOT NULL, user_id uuid, normalized_email text, display_name text,
  participant_kind varchar(24) NOT NULL DEFAULT 'external', required boolean NOT NULL DEFAULT true,
  status varchar(24) NOT NULL DEFAULT 'pending', joined_at timestamptz, left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, normalized_email), UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS meeting_participants_tenant_idx ON hivemind.meeting_participants(org_id, session_id);

CREATE TABLE IF NOT EXISTS hivemind.meeting_consent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,
  participant_id uuid NOT NULL REFERENCES hivemind.meeting_participants(id), org_id uuid NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE, token_salt varchar(64) NOT NULL,
  delivery_secret_ciphertext text,
  otp_hash varchar(64), otp_salt varchar(64), otp_attempts integer NOT NULL DEFAULT 0, otp_expires_at timestamptz,
  notice_version_id uuid NOT NULL REFERENCES hivemind.meeting_notice_versions(id),
  requested_purposes jsonb NOT NULL, state varchar(24) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL, exchanged_at timestamptz, verified_at timestamptz,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_consent_requests_session_idx ON hivemind.meeting_consent_requests(org_id, session_id, state);
ALTER TABLE hivemind.meeting_consent_requests ADD COLUMN IF NOT EXISTS delivery_secret_ciphertext text;
ALTER TABLE hivemind.meeting_consent_requests ADD COLUMN IF NOT EXISTS otp_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS hivemind.meeting_consent_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,
  participant_id uuid NOT NULL REFERENCES hivemind.meeting_participants(id), request_id uuid REFERENCES hivemind.meeting_consent_requests(id),
  org_id uuid NOT NULL, policy_id uuid NOT NULL, policy_version integer NOT NULL,
  notice_version_id uuid NOT NULL, lawful_basis jsonb NOT NULL, purposes jsonb NOT NULL,
  decision varchar(24) NOT NULL, verification_method varchar(32) NOT NULL,
  subject_attestation boolean NOT NULL DEFAULT false, event_digest varchar(64) NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(), withdrawn_at timestamptz,
  UNIQUE(session_id, participant_id, event_digest)
);
CREATE INDEX IF NOT EXISTS meeting_consent_receipts_session_idx ON hivemind.meeting_consent_receipts(org_id, session_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS hivemind.meeting_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, participant_id uuid NOT NULL,
  org_id uuid NOT NULL, event_type varchar(32) NOT NULL, event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_digest varchar(64), event_digest varchar(64) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_authorization_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  policy_id uuid NOT NULL, policy_version integer NOT NULL, purposes jsonb NOT NULL,
  required_count integer NOT NULL, accepted_count integer NOT NULL, declined_count integer NOT NULL,
  participant_digest varchar(64) NOT NULL, status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, participant_digest)
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_pipeline_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  pipeline_version integer NOT NULL, stage_key varchar(64) NOT NULL, shard_key varchar(128) NOT NULL DEFAULT '0',
  status varchar(24) NOT NULL DEFAULT 'pending', attempt integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz, input_digest varchar(64), output_receipt jsonb,
  coverage_counters jsonb NOT NULL DEFAULT '{}'::jsonb, structured_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(session_id, pipeline_version, stage_key, shard_key)
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_artifact_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  artifact_kind varchar(32) NOT NULL, shard_key varchar(128) NOT NULL, storage_placement varchar(32) NOT NULL,
  object_key text, etag text, sha256 varchar(64), byte_count bigint, content_type varchar(160),
  start_ms integer, end_ms integer, status varchar(24) NOT NULL DEFAULT 'persisted',
  deletion_receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(session_id, artifact_kind, shard_key)
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  event_type varchar(64) NOT NULL, dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz, lease_expires_at timestamptz, provider_receipt jsonb, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_processing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  event_type varchar(64) NOT NULL, stage varchar(64), metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_processing_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, org_id uuid NOT NULL,
  participant_id uuid, restriction_type varchar(32) NOT NULL, reason text,
  status varchar(24) NOT NULL DEFAULT 'active', created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, session_id uuid,
  participant_id uuid, request_type varchar(24) NOT NULL, status varchar(24) NOT NULL DEFAULT 'received',
  requested_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz, completed_at timestamptz,
  result_receipt jsonb, legal_hold jsonb, created_by uuid
);

CREATE TABLE IF NOT EXISTS hivemind.meeting_deletion_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, session_id uuid NOT NULL,
  request_id uuid, artifact_kind varchar(32) NOT NULL, artifact_ref_hash varchar(64) NOT NULL,
  outcome varchar(24) NOT NULL, provider_receipt jsonb, deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, artifact_kind, artifact_ref_hash)
);

CREATE INDEX IF NOT EXISTS meeting_pipeline_ready_idx ON hivemind.meeting_pipeline_steps(status, lease_expires_at, updated_at);
CREATE INDEX IF NOT EXISTS meeting_outbox_ready_idx ON hivemind.meeting_outbox(status, next_attempt_at, created_at);
ALTER TABLE hivemind.meeting_outbox ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS meeting_dsar_tenant_idx ON hivemind.meeting_data_subject_requests(org_id, status, requested_at);
