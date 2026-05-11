-- Migration: P0-5 Enterprise SSO (SAML + SCIM)
-- Creates org_sso_configs table for per-org SSO configuration.

CREATE TABLE IF NOT EXISTS "org_sso_configs" (
  "org_id"               UUID          NOT NULL,
  "sso_type"             VARCHAR(50)   NOT NULL DEFAULT 'zitadel_oidc',
  "zitadel_project_id"   VARCHAR(255),
  "saml_idp_metadata_url" TEXT,
  "saml_acs_url"         TEXT,
  "scim_token_hash"      VARCHAR(255),
  "scim_token_id"        VARCHAR(64),
  "subdomain"            VARCHAR(100)  UNIQUE,
  "enabled"              BOOLEAN       NOT NULL DEFAULT FALSE,
  "jit_provisioning"     BOOLEAN       NOT NULL DEFAULT TRUE,
  "default_role"         VARCHAR(50)   DEFAULT 'member',
  "default_team_id"      UUID,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "org_sso_configs_pkey" PRIMARY KEY ("org_id"),
  CONSTRAINT "org_sso_configs_org_fkey" FOREIGN KEY ("org_id")
    REFERENCES "organizations" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_sso_configs_subdomain_key"
  ON "org_sso_configs" ("subdomain");

CREATE INDEX IF NOT EXISTS "org_sso_configs_subdomain_idx"
  ON "org_sso_configs" ("subdomain")
  WHERE "subdomain" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "org_sso_configs_enabled_idx"
  ON "org_sso_configs" ("enabled");
