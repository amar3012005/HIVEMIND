-- Append activity type and safe settings to the existing authenticated scoped projection.
-- Native attention reads only authenticated-admin evidence and the canonical
-- Runtime's two decision types. Never grant the runner base-table access.
CREATE OR REPLACE VIEW hivemind.hivemind_attention_subscriptions WITH (security_barrier=true) AS
SELECT s.id,s.org_id,s.user_id,s.account_id,s.toolkit,
 jsonb_build_object('source',s.config->>'source','attention_settings',s.config->'attention_settings') AS config,s.status,
 s.runtime_attention,s.runtime_attention_revision,s.runtime_attention_enabled_at,s.slug
FROM hivemind.hivemind_trigger_subscriptions s
JOIN hivemind.user_organizations a ON a.org_id::text=s.org_id AND a.user_id::text=s.user_id
JOIN hivemind.users u ON u.id=a.user_id
WHERE s.org_id=current_setting('app.hivemind_org_id',true)
 AND s.user_id=current_setting('app.hivemind_user_id',true)
 AND a.is_active AND a.deactivated_at IS NULL AND a.role IN('owner','admin') AND u.deleted_at IS NULL;
