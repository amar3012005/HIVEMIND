-- Per-organization policy snapshots. Usage and commercial entitlement history remain untouched.
CREATE TABLE IF NOT EXISTS hivemind.organization_policy_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0),
 limits JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(limits)='object'),
 features JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(features)='object'),
 reason VARCHAR(500) NOT NULL,
 operator VARCHAR(160) NOT NULL,
 operator_session_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(org_id,version)
);
CREATE INDEX IF NOT EXISTS organization_policy_versions_latest_idx ON hivemind.organization_policy_versions(org_id,version DESC);
REVOKE ALL ON hivemind.organization_policy_versions FROM PUBLIC;
-- Core/Control use this central billing principal. Never grant the Harness/private-memory runner access.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hivemind_user') THEN
  GRANT SELECT, INSERT ON hivemind.organization_policy_versions TO hivemind_user;
 END IF;
END $$;
