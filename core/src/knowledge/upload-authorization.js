export async function authorizeKnowledgeScope({ prisma, userId, orgId, targetScope, projectIds = [], primaryTeamId = null }) {
  const membership = await prisma.userOrganization.findFirst({
    where: { userId, orgId, isActive: true }, select: { role: true, roles: true },
  }).catch(() => null);
  if (!membership) return { ok: false, status: 404, code: 'scope_not_found' };
  const roles = new Set([membership.role, ...(membership.roles || [])].filter(Boolean));
  if ((targetScope === 'team' && !primaryTeamId)
      || (targetScope === 'project' && projectIds.length === 0)
      || (primaryTeamId && projectIds.length)) {
    return { ok: false, status: 404, code: 'scope_not_found' };
  }

  if (primaryTeamId) {
    const teamAccess = roles.has('owner') || roles.has('admin')
      ? { id: primaryTeamId, orgId, archivedAt: null }
      : { id: primaryTeamId, orgId, archivedAt: null, members: { some: { userId } } };
    const team = await prisma.team.findFirst({
      where: teamAccess, select: { id: true },
    }).catch(() => null);
    if (!team) return { ok: false, status: 404, code: 'scope_not_found' };
  }

  if (projectIds.length) {
    const projectAccess = roles.has('owner') || roles.has('admin')
      ? { id: { in: projectIds }, orgId, archivedAt: null, status: 'active' }
      : { id: { in: projectIds }, orgId, archivedAt: null, status: 'active', OR: [
          { members: { some: { userId } } },
          { team: { members: { some: { userId } } } },
          { createdBy: userId },
        ] };
    const accessible = await prisma.project.findMany({
      where: projectAccess, select: { id: true },
    }).catch(() => []);
    if (accessible.length !== new Set(projectIds).size) return { ok: false, status: 404, code: 'scope_not_found' };
  }

  if (targetScope === 'organization' && !projectIds.length && !primaryTeamId
      && !roles.has('owner') && !roles.has('admin')) {
    return { ok: false, status: 403, code: 'org_scope_admin_only' };
  }
  const scopeType = primaryTeamId ? 'team' : projectIds.length ? 'project' : targetScope === 'organization' ? 'organization' : 'personal';
  const scopeId = primaryTeamId || projectIds[0] || (scopeType === 'organization' ? orgId : userId);
  return { ok: true, membership, scopeType, scopeId, scopeKey: `${scopeType}:${scopeId}` };
}
