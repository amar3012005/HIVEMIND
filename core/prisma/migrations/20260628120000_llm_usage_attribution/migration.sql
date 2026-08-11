-- Per-API-key LLM usage rollup. Records every LLM call against the org's HIVEMIND API key
-- (org_id + api_key_id + model + feature). OrgUsage stays the org-wide monthly total (untouched).
-- Additive + backward-compatible: new table only. System/background/master-key calls (no request
-- API key) are written with the all-zero SENTINEL uuid so they fold into one row per (org,month,model)
-- under the plain unique index — no NULLs, so ON CONFLICT stays on plain columns (robust, no expression
-- inference). NO FK by design: a billing ledger must keep spend after a key is revoked, and the sentinel
-- has no api_keys row. Idempotent (IF NOT EXISTS) so re-applies cleanly.

CREATE TABLE IF NOT EXISTS "api_key_usage" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id"            UUID NOT NULL,
  "api_key_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  "month"             VARCHAR(7) NOT NULL,
  "model"             VARCHAR(128) NOT NULL DEFAULT '',
  "feature"           VARCHAR(64) NOT NULL DEFAULT '',
  "tokens_processed"  BIGINT NOT NULL DEFAULT 0,
  "prompt_tokens"     BIGINT NOT NULL DEFAULT 0,
  "completion_tokens" BIGINT NOT NULL DEFAULT 0,
  "requests"          BIGINT NOT NULL DEFAULT 0,
  "last_used_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "api_key_usage_pkey" PRIMARY KEY ("id")
);

-- Upsert key. Plain columns (api_key_id is never NULL — sentinel for keyless calls), so
-- recordKeyUsage's INSERT ... ON CONFLICT ("org_id","api_key_id","month","model") infers cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_key_usage_org_key_month_model"
  ON "api_key_usage" ("org_id", "api_key_id", "month", "model");

CREATE INDEX IF NOT EXISTS "idx_api_key_usage_org_month" ON "api_key_usage" ("org_id", "month");
CREATE INDEX IF NOT EXISTS "idx_api_key_usage_key_month" ON "api_key_usage" ("api_key_id", "month");
