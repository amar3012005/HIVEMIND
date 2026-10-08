// Organization agent storage identity is distinct from the human actor. This
// resolver never issues connector authority or changes the actor's credentials.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code, status) { const error = new Error(code); error.code = code; error.status = status; throw error; }

export async function organizationAgentAccess(db, { userId, orgId }, { schema = 'hivemind' } = {}) {
  if (!UUID.test(userId || '') || !UUID.test(orgId || '')) fail('invalid_agent_actor', 401);
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail('invalid_agent_schema', 503);
  const membership = await db.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { role: true, isActive: true, deactivatedAt: true },
  });
  if (!membership?.isActive || membership.deactivatedAt || !['owner', 'admin'].includes(membership.role)) {
    fail('organization_agent_admin_required', 403);
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { displayName: true, deletedAt: true } });
  if (!user || user.deletedAt) fail('organization_agent_admin_required', 403);
  const roots = await db.$queryRawUnsafe(`SELECT h.session_id,h.user_id FROM ${schema}.harness_company_hq h
    JOIN ${schema}.harness_sessions s ON s.id=h.session_id AND s.org_id=h.org_id AND s.user_id=h.user_id
    WHERE h.org_id=$1::uuid AND s.status='active' LIMIT 1`, orgId);
  const root = roots[0];
  const initial = root ? null : await nativeAgentStoragePrincipal(db,{userId,orgId,sharedOrganizationAgents:true});

  return {
    contract: 'hivemind.organization-agent-access.v1',
    actor: { user_id: userId, org_id: orgId, role: membership.role,
      name: typeof user.displayName === 'string' ? user.displayName.trim().slice(0, 180) : '',
      authority: 'authenticated-profile' },
    agent: { org_id: orgId, runtime_session_id: root?.session_id ?? null, storage_user_id: root?.user_id ?? initial.userId },
    access: 'read-write',
  };
}

/** Internal SQL scope only. Do not use the returned userId for credentials,
 * connected apps, attribution, notification recipients or membership checks. */
export async function nativeAgentStoragePrincipal(db, principal) {
  if (!principal.sharedOrganizationAgents) return principal;
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",principal.orgId,principal.userId);
    const rows=await tx.$queryRawUnsafe('SELECT storage_user_id,runtime_session_id FROM hivemind.organization_agent_storage_scope($1::uuid,$2::uuid)',principal.orgId,principal.userId);
    const row=rows[0];
    if (!row) fail('organization_agent_admin_required',403);
    if (principal.runtimeSessionId && principal.runtimeSessionId!==row.runtime_session_id) fail('canonical_runtime_required',403);
    return {...principal,userId:row.storage_user_id,actorUserId:principal.userId};
  });
}

/** Authorize reading only canonical organization-agent history/results. Personal
 * Brain rooms remain with their human; the caller never receives another token. */
export async function organizationAgentSessionAccess(db, principal, sessionId) {
  if (!principal.sharedOrganizationAgents) return false;
  let storage;
  try { storage=await nativeAgentStoragePrincipal(db,principal); }
  catch(error) { if(error.code==='organization_agent_admin_required') return false; throw error; }
  return db.$transaction(async tx=>{
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",storage.orgId,storage.userId);
    const seen=new Set();let id=sessionId;
    for(let depth=0;depth<100;depth++) {
      if(typeof id!=='string'||seen.has(id)) return false;seen.add(id);
      const rows=await tx.$queryRawUnsafe(`SELECT s.header,COALESCE((SELECT e.payload->'data'->>'agentPreset'
        FROM hivemind.harness_session_events e WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
          AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset') AS preset
        FROM hivemind.harness_sessions s WHERE s.id=$1 AND s.org_id=$2::uuid AND s.user_id=$3::uuid AND s.status='active'`,id,storage.orgId,storage.userId);
      const row=rows[0];if(!row) return false;
      if(row.header.parentSession) {id=row.header.parentSession;continue;}
      if(row.preset==='hivemind-hyperagents') return true;
      if(row.preset!=='hivemind-hq') return false;
      const roots=await tx.$queryRawUnsafe('SELECT session_id FROM hivemind.harness_company_hq WHERE org_id=$1::uuid',storage.orgId);
      return roots[0]?.session_id===id;
    }
    return false;
  });
}
