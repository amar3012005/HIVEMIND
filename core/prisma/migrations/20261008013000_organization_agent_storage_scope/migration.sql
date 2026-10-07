-- Resolve only storage identity. Human credentials and authored decisions are
-- never reassigned. Existing Session logs and canonical pointers remain intact.
CREATE OR REPLACE FUNCTION hivemind.organization_agent_storage_scope(p_org uuid, p_actor uuid)
RETURNS TABLE(storage_user_id uuid, runtime_session_id text, actor_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('app.hivemind_org_id',true) IS DISTINCT FROM p_org::text
    OR current_setting('app.hivemind_user_id',true) IS DISTINCT FROM p_actor::text THEN RETURN; END IF;
  RETURN QUERY SELECT COALESCE(h.user_id,p_actor), h.session_id::text, m.role::text
    FROM hivemind.user_organizations m
    JOIN hivemind.users u ON u.id=m.user_id AND u.deleted_at IS NULL
    LEFT JOIN hivemind.harness_company_hq h ON h.org_id=m.org_id
    WHERE m.org_id=p_org AND m.user_id=p_actor AND m.is_active
      AND m.deactivated_at IS NULL AND m.role::text IN ('owner','admin');
END;
$$;
REVOKE ALL ON FUNCTION hivemind.organization_agent_storage_scope(uuid,uuid) FROM PUBLIC;
COMMENT ON FUNCTION hivemind.organization_agent_storage_scope(uuid,uuid) IS
  'Fresh active-admin storage mapping only; not connected-account authority.';

-- Storage ownership survives shared access; execution keeps its authorizing
-- human. Existing schedules retain their original account authority.
ALTER TABLE hivemind.harness_scheduled_tasks ADD COLUMN actor_user_id uuid;
UPDATE hivemind.harness_scheduled_tasks SET actor_user_id=user_id;
ALTER TABLE hivemind.harness_scheduled_tasks ADD CONSTRAINT harness_schedule_actor_fk
  FOREIGN KEY(actor_user_id) REFERENCES hivemind.users(id);
ALTER TABLE hivemind.harness_scheduled_due ADD COLUMN actor_user_id uuid;
UPDATE hivemind.harness_scheduled_due d SET actor_user_id=t.actor_user_id
  FROM hivemind.harness_scheduled_tasks t WHERE t.id=d.task_id;
