SET search_path TO hivemind, public;

CREATE TABLE IF NOT EXISTS "x_ads_credentials" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "auth_kind" VARCHAR(16) NOT NULL,
  "x_user_id" VARCHAR(32),
  "x_username" VARCHAR(64),
  "access_token_encrypted" TEXT NOT NULL,
  "refresh_token_encrypted" TEXT,
  "token_secret_encrypted" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_at" TIMESTAMPTZ,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "x_ads_credentials_tenant_auth_key" UNIQUE ("org_id", "user_id", "auth_kind"),
  CONSTRAINT "x_ads_credentials_auth_kind_check" CHECK ("auth_kind" IN ('OAUTH1', 'OAUTH2'))
);

CREATE TABLE IF NOT EXISTS "x_ads_oauth_states" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "auth_kind" VARCHAR(16) NOT NULL,
  "state_hash" VARCHAR(64),
  "request_token_hash" VARCHAR(64),
  "verifier_encrypted" TEXT,
  "request_secret_encrypted" TEXT,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "x_ads_oauth_states_state_hash_key" UNIQUE ("state_hash"),
  CONSTRAINT "x_ads_oauth_states_request_token_hash_key" UNIQUE ("request_token_hash"),
  CONSTRAINT "x_ads_oauth_states_auth_kind_check" CHECK ("auth_kind" IN ('OAUTH1', 'OAUTH2'))
);

CREATE INDEX IF NOT EXISTS "x_ads_credentials_org_user_status_idx"
  ON "x_ads_credentials"("org_id", "user_id", "status");
CREATE INDEX IF NOT EXISTS "x_ads_credentials_x_user_idx"
  ON "x_ads_credentials"("x_user_id");
CREATE INDEX IF NOT EXISTS "x_ads_oauth_states_tenant_expiry_idx"
  ON "x_ads_oauth_states"("org_id", "user_id", "auth_kind", "expires_at");
