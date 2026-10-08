-- Native attention reads only authenticated-admin evidence and the canonical
-- Runtime's two decision types. Never grant the runner base-table access.
CREATE VIEW hivemind.hivemind_attention_subscriptions WITH (security_barrier=true) AS
SELECT s.id,s.org_id,s.user_id,s.account_id,s.toolkit,s.config,s.status,
 s.runtime_attention,s.runtime_attention_revision,s.runtime_attention_enabled_at
FROM hivemind.hivemind_trigger_subscriptions s
JOIN hivemind.user_organizations a ON a.org_id::text=s.org_id AND a.user_id::text=s.user_id
JOIN hivemind.users u ON u.id=a.user_id
WHERE s.org_id=current_setting('app.hivemind_org_id',true)
 AND s.user_id=current_setting('app.hivemind_user_id',true)
 AND a.is_active AND a.deactivated_at IS NULL AND a.role IN('owner','admin') AND u.deleted_at IS NULL;

CREATE VIEW hivemind.hivemind_attention_events WITH (security_barrier=true) AS
SELECT e.id,e.subscription_id,e.org_id,e.user_id,e.data,e.occurred_at,e.received_at,
 e.relevance_status,e.relevance_decision,
 CASE WHEN s.account_id NOT LIKE 'native:%' THEN true
 WHEN s.config->>'source'='native_slack' THEN
  s.account_id='native:slack:'||(s.config->>'integration_id')
  AND e.data->'_source'->>'integration_id'=s.config->>'integration_id'
  AND e.data->'_source'->>'team_id'=s.config->>'team_id'
  AND EXISTS(SELECT 1 FROM hivemind.hivemind_native_slack_attention_sources p
   WHERE p.id::text=s.config->>'integration_id' AND p.user_id::text=e.user_id AND p.is_active
    AND p.attention_org_id=e.org_id AND p.team_id=s.config->>'team_id'
    AND e.occurred_at>=p.attention_enabled_at::timestamptz)
 WHEN s.config->>'source'='dreaming' THEN
  s.account_id='native:dreaming:'||e.user_id AND EXISTS(
   SELECT 1 FROM hivemind.harness_dream_runs d
   JOIN hivemind.harness_dream_settings ds ON ds.org_id=d.org_id AND ds.user_id=d.user_id
   JOIN hivemind.harness_dream_outputs o ON o.run_id=d.id AND o.org_id=d.org_id
   JOIN hivemind.memories m ON m.id=o.memory_id AND m.org_id=d.org_id
   WHERE d.id::text=e.data->'_source'->>'run_id' AND d.org_id::text=e.org_id AND d.user_id::text=e.user_id
    AND d.status='completed' AND ds.enabled AND ds.revision=d.revision
    AND d.trigger_id NOT LIKE '%introduction%' AND o.receipt IS NOT NULL AND o.receipt<>'null'::jsonb
    AND o.idempotency_key=e.data->'_source'->>'output_key' AND m.id::text=e.data->'_source'->>'memory_id'
    AND m.deleted_at IS NULL AND (m.scope='organization' OR (m.scope='project' AND EXISTS(
     SELECT 1 FROM hivemind.projects p WHERE p.id=m.project_id AND p.org_id=m.org_id AND p.policy='org_visible' AND p.status='active')))
    AND 'flashback'=ANY(m.tags))
 ELSE false END AS native_source_valid,
 CASE WHEN s.config->>'source'='dreaming' THEN (
  SELECT m.created_at FROM hivemind.memories m WHERE m.id::text=e.data->'_source'->>'memory_id' AND m.org_id::text=e.org_id
 ) ELSE NULL END AS native_source_created_at
FROM hivemind.hivemind_trigger_events e
JOIN hivemind.hivemind_attention_subscriptions s ON s.id=e.subscription_id AND s.org_id=e.org_id AND s.user_id=e.user_id;

CREATE VIEW hivemind.hivemind_attention_decision_memories WITH (security_barrier=true) AS
SELECT m.id,m.org_id,m.author_user_id,m.kind,m.title,m.summary,m.context,m.created_at,m.project_slug,m.agent_slug
FROM hivemind.hyper_agent_operating_memories m
JOIN hivemind.user_organizations a ON a.org_id=m.org_id
 AND a.user_id::text=current_setting('app.hivemind_user_id',true)
JOIN hivemind.users u ON u.id=a.user_id
JOIN hivemind.harness_company_hq h ON h.org_id=m.org_id
JOIN hivemind.harness_sessions r ON r.id=h.session_id AND r.org_id=h.org_id AND r.user_id=h.user_id AND r.status='active'
WHERE m.org_id::text=current_setting('app.hivemind_org_id',true)
 AND a.is_active AND a.deactivated_at IS NULL AND a.role IN('owner','admin') AND u.deleted_at IS NULL
 AND m.project_slug='hyper-agents' AND m.agent_slug='runtime' AND m.kind IN('user_agenda','uncertainty')
 AND m.context->>'sessionId'=h.session_id;

REVOKE ALL ON hivemind.hivemind_attention_events,hivemind.hivemind_attention_subscriptions,hivemind.hivemind_attention_decision_memories FROM PUBLIC;
-- The managed release grants SELECT on these three views to its verified
-- restricted Harness role. No grant on events, connectors, or memories bases.
