/**
 * Authoritative post-hydration memory authorization shared by vector and
 * lexical recall lanes. Relevance may rank a candidate; it never grants access.
 */
export function matchesMemoryAccess(memory, { userId, orgId, accessContext } = {}) {
  if (!accessContext) return true;
  const m = (memory?.memory && typeof memory.memory === 'object') ? memory.memory : memory;
  if (!m) return false;
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const isGuest = accessContext.orgRole === 'guest';
  if ((isGuest || accessContext.crossProject === false) && tags.includes('scope:cross-project')) return false;
  const projectIds = Array.isArray(m.project_ids) ? m.project_ids : (Array.isArray(m.projectIds) ? m.projectIds : []);
  const projectId = m.project_id || m.projectId || null;
  const teamId = m.primary_team_id || m.primaryTeamId || null;
  const scope = m.scope || ((projectId || projectIds.length) ? 'project' : 'organization');
  const memoryUserId = m.user_id || m.userId || null;
  const memoryOrgId = m.org_id || m.orgId || null;
  return (scope === 'personal' && memoryUserId === userId)
    || (scope === 'organization' && memoryOrgId === orgId && !isGuest)
    || (scope === 'team' && (accessContext.teamIds || []).includes(teamId))
    || (scope === 'project' && (
      projectIds.some((id) => (accessContext.projectIds || []).includes(id))
      || (projectId && (accessContext.projectIds || []).includes(projectId))
    ));
}

export default matchesMemoryAccess;
