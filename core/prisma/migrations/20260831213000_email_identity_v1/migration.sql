CREATE TABLE "user_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "user_id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL, "provider_subject" VARCHAR(255) NOT NULL,
  "normalized_email" VARCHAR(255), "verified_at" TIMESTAMPTZ(6),
  "is_primary" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_identities_provider_provider_subject_key" ON "user_identities"("provider", "provider_subject");
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");
CREATE INDEX "user_identities_normalized_email_idx" ON "user_identities"("normalized_email");
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "email_auth_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "email_ciphertext" TEXT NOT NULL,
  "email_lookup_hash" VARCHAR(64) NOT NULL, "otp_hash" VARCHAR(128) NOT NULL,
  "link_token_hash" VARCHAR(128) NOT NULL, "intent" VARCHAR(16) NOT NULL DEFAULT 'auto',
  "return_to" TEXT NOT NULL, "environment" VARCHAR(16) NOT NULL, "flag_mode" VARCHAR(16) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "resend_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6) NOT NULL, "resend_available_at" TIMESTAMPTZ(6) NOT NULL,
  "verified_at" TIMESTAMPTZ(6), "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_auth_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_auth_challenges_email_lookup_hash_created_at_idx" ON "email_auth_challenges"("email_lookup_hash", "created_at" DESC);
CREATE INDEX "email_auth_challenges_expires_at_idx" ON "email_auth_challenges"("expires_at");

CREATE TABLE "auth_email_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "challenge_id" UUID NOT NULL,
  "environment" VARCHAR(16) NOT NULL, "processing_version" INTEGER NOT NULL DEFAULT 1,
  "payload_ciphertext" TEXT NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0, "provider_message_id" VARCHAR(255),
  "provider_status" VARCHAR(32), "next_attempt_at" TIMESTAMPTZ(6), "sent_at" TIMESTAMPTZ(6),
  "terminal_at" TIMESTAMPTZ(6), "last_error" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_email_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_email_outbox_status_next_attempt_at_idx" ON "auth_email_outbox"("status", "next_attempt_at");
CREATE INDEX "auth_email_outbox_challenge_id_idx" ON "auth_email_outbox"("challenge_id");
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "email_auth_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_identity_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "user_id" UUID, "challenge_id" UUID,
  "event_type" VARCHAR(64) NOT NULL, "outcome" VARCHAR(24) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_identity_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_identity_events_user_id_created_at_idx" ON "auth_identity_events"("user_id", "created_at" DESC);
CREATE INDEX "auth_identity_events_challenge_id_created_at_idx" ON "auth_identity_events"("challenge_id", "created_at" DESC);
ALTER TABLE "auth_identity_events" ADD CONSTRAINT "auth_identity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auth_identity_events" ADD CONSTRAINT "auth_identity_events_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "email_auth_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "user_identities" ("user_id", "provider", "provider_subject", "normalized_email", "verified_at", "is_primary")
SELECT "id", 'zitadel', "zitadel_user_id", lower("email"), COALESCE("last_active_at", "created_at", CURRENT_TIMESTAMP), true
FROM "users"
ON CONFLICT ("provider", "provider_subject") DO NOTHING;
