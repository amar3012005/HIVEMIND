export async function authorizeKnowledgeScope({ prisma, userId, orgId, targetScope, projectIds = [], primaryTeamId = null }) {
  const membership = await prisma.userOrganization.findFirst({
    where: { userId, orgId, isActive: true }, select: { role: true, roles: true },
  }).catch(() => null);
  // FOUR different checks below all answer the same opaque `scope_not_found`, with
  // no logging anywhere — so an operator seeing it in the UI cannot tell whether the
  // caller was not a member, sent no project at all, or named a project in another
  // org. That ambiguity is why a real batch-upload failure took a full
  // investigation to place. Every rejection now says which check fired and with
  // what, at warn level; the RESPONSE code is unchanged so nothing downstream
  // shifts, and no project/team names are logged — ids only.
  const _deny = (reason, extra = {}) => {
    console.warn(`[scope-auth] DENY ${reason} user=${String(userId).slice(0, 8)} `
      + `org=${String(orgId).slice(0, 8)} targetScope=${targetScope || 'none'} `
      + `projectIds=${JSON.stringify(projectIds)} primaryTeamId=${primaryTeamId || 'none'}`
      + (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''));
    return { ok: false, status: 404, code: 'scope_not_found' };
  };
  if (!membership) return _deny('not_a_member_of_org');
  const roles = new Set([membership.role, ...(membership.roles || [])].filter(Boolean));
  if ((targetScope === 'team' && !primaryTeamId)
      || (targetScope === 'project' && projectIds.length === 0)
      || (primaryTeamId && projectIds.length)) {
    return _deny(
      targetScope === 'team' && !primaryTeamId ? 'team_scope_without_team_id'
        : targetScope === 'project' && projectIds.length === 0 ? 'project_scope_without_project_id'
          : 'team_and_project_both_set',
    );
  }

  if (primaryTeamId) {
    const teamAccess = roles.has('owner') || roles.has('admin')
      ? { id: primaryTeamId, orgId, archivedAt: null }
      : { id: primaryTeamId, orgId, archivedAt: null, members: { some: { userId } } };
    const team = await prisma.team.findFirst({
      where: teamAccess, select: { id: true },
    }).catch(() => null);
    if (!team) return _deny('team_not_found_or_not_accessible', { isAdmin: roles.has('owner') || roles.has('admin') });
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
    if (accessible.length !== new Set(projectIds).size) {
      // The commonest real cause: the id is a project in ANOTHER org (verified —
      // three projects named "Solvis" exist across different tenants), or it is
      // archived / not active, or the caller is not a member on the non-admin path.
      return _deny('project_not_found_in_this_org_or_not_accessible', {
        requested: projectIds.length,
        accessible: accessible.length,
        isAdmin: roles.has('owner') || roles.has('admin'),
      });
    }
  }

  if (targetScope === 'organization' && !projectIds.length && !primaryTeamId
      && !roles.has('owner') && !roles.has('admin')) {
    return { ok: false, status: 403, code: 'org_scope_admin_only' };
  }
  const scopeType = primaryTeamId ? 'team' : projectIds.length ? 'project' : targetScope === 'organization' ? 'organization' : 'personal';
  const scopeId = primaryTeamId || projectIds[0] || (scopeType === 'organization' ? orgId : userId);
  return { ok: true, membership, scopeType, scopeId, scopeKey: `${scopeType}:${scopeId}` };
}
