-- Definer view exposes no connector metadata or OAuth credentials. The migration
-- owner retains underlying table authority; Harness receives view SELECT only.
CREATE VIEW hivemind.hivemind_native_slack_attention_sources
WITH (security_barrier = true) AS
SELECT p.id, p.user_id, p.is_active,
  p.connector_metadata->>'attention_org_id' AS attention_org_id,
  p.connector_metadata->>'attention_enabled_at' AS attention_enabled_at,
  p.connector_metadata->'provider_metadata'->>'team_id' AS team_id
FROM hivemind.platform_integrations p
JOIN hivemind.user_organizations a ON a.user_id=p.user_id
  AND a.org_id::text=p.connector_metadata->>'attention_org_id'
JOIN hivemind.users u ON u.id=p.user_id
WHERE p.platform_type='slack' AND p.is_active
  AND a.is_active AND a.deactivated_at IS NULL AND a.role IN ('owner','admin')
  AND u.deleted_at IS NULL
  AND p.user_id::text=current_setting('app.hivemind_user_id',true)
  AND a.org_id::text=current_setting('app.hivemind_org_id',true);
REVOKE ALL ON hivemind.hivemind_native_slack_attention_sources FROM PUBLIC;
-- Deployment explicitly grants SELECT to its verified restricted Harness role.
