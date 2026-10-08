-- Reserve a stable storage principal before the first Runtime awakening.
-- This changes no credentials and does not admit or execute model work.
CREATE OR REPLACE FUNCTION hivemind.organization_agent_storage_scope(p_org uuid, p_actor uuid)
RETURNS TABLE(storage_user_id uuid, runtime_session_id text, actor_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.hivemind_org_id',true) IS DISTINCT FROM p_org::text
    OR current_setting('app.hivemind_user_id',true) IS DISTINCT FROM p_actor::text THEN RETURN; END IF;
  RETURN QUERY SELECT COALESCE(h.user_id,initial.user_id), h.session_id::text, m.role::text
    FROM hivemind.user_organizations m
    JOIN hivemind.users u ON u.id=m.user_id AND u.deleted_at IS NULL
    LEFT JOIN hivemind.harness_company_hq h ON h.org_id=m.org_id
    JOIN LATERAL (SELECT seed.user_id FROM hivemind.user_organizations seed
      JOIN hivemind.users su ON su.id=seed.user_id AND su.deleted_at IS NULL
      WHERE seed.org_id=m.org_id AND seed.is_active AND seed.deactivated_at IS NULL
        AND seed.role::text IN ('owner','admin')
      ORDER BY CASE WHEN seed.role::text='owner' THEN 0 ELSE 1 END,seed.user_id LIMIT 1) initial ON true
    WHERE m.org_id=p_org AND m.user_id=p_actor AND m.is_active
      AND m.deactivated_at IS NULL AND m.role::text IN ('owner','admin');
END;
$$;
REVOKE ALL ON FUNCTION hivemind.organization_agent_storage_scope(uuid,uuid) FROM PUBLIC;
