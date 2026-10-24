/**
 * Scope predicate for the Postgres full-text (keyword) lane of
 * PrismaGraphStore.searchMemories.
 *
 * Kept dependency-free so the authorization predicate can be unit-tested
 * without a Prisma client or database.
 *
 * Every value is appended to `ftsParams` and referenced by its positional
 * placeholder ($3, $4, ...); no caller-supplied value is interpolated into SQL.
 * `ftsParams` must already hold the fixed $1 (tsquery) and $2 (limit) values.
 *
 * @param {object} args
 * @param {string|null|undefined} args.user_id authenticated user id
 * @param {string|null|undefined} args.org_id authenticated organization id
 * @param {string} [args.scope] legacy single scope ('personal' or any other value)
 * @param {object|null} [args.access_context] V2 tier context (projectIds, teamIds, orgRole, crossProject)
 * @param {unknown[]} ftsParams bound parameter list, mutated in place
 * @returns {string} SQL fragment beginning with `AND`
 */
export function buildFtsScopeWhere({ user_id, org_id, scope = 'personal', access_context = null }, ftsParams) {
  let scopeWhere;
  if (access_context && (Array.isArray(access_context.projectIds) || Array.isArray(access_context.teamIds))) {
    const projectIds = Array.isArray(access_context.projectIds) ? access_context.projectIds : [];
    const teamIds = Array.isArray(access_context.teamIds) ? access_context.teamIds : [];

    // personal tier — always present
    ftsParams.push(user_id);
    const userParam = `$${ftsParams.length}`;
    const tiers = [
      `(m.user_id = ${userParam}::uuid AND m.scope = 'personal')`,
    ];

    // Guest gate mirrors scopedMemoryWhere: org guests (project-scoped
    // invitees) never get the org-wide tier — keyword search included.
    if (access_context.orgRole !== 'guest') {
      ftsParams.push(org_id);
      const orgTierParam = `$${ftsParams.length}`;
      tiers.push(`(m.scope = 'organization' AND m.org_id = ${orgTierParam}::uuid)`);
    }

    if (projectIds.length > 0) {
      const placeholders = projectIds.map(id => {
        ftsParams.push(id);
        return `$${ftsParams.length}::uuid`;
      }).join(',');
      tiers.push(`(m.scope = 'project' AND EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = m.id AND mp.project_id IN (${placeholders})))`);
    }

    if (teamIds.length > 0) {
      const placeholders = teamIds.map(id => {
        ftsParams.push(id);
        return `$${ftsParams.length}::uuid`;
      }).join(',');
      tiers.push(`(m.scope = 'team' AND m.primary_team_id IN (${placeholders}))`);
    }

    // Always require org scope match for safety
    ftsParams.push(org_id);
    const orgScopeParam = `$${ftsParams.length}`;
    scopeWhere = `AND m.org_id = ${orgScopeParam}::uuid AND (${tiers.join(' OR ')})`;
    // M2b: drop cross-project syntheses for guests (always) and for all users
    // when the org disabled cross_project (parameterized, no interpolation).
    if (access_context.orgRole === 'guest' || access_context.crossProject === false) {
      ftsParams.push('scope:cross-project');
      scopeWhere += ` AND NOT (${'$' + ftsParams.length} = ANY(m.tags))`;
    }
  } else if (scope === 'personal') {
    ftsParams.push(user_id);
    const userParam = `$${ftsParams.length}`;
    // LOW-1: also scope by org_id in personal branch (matches Prisma fallback)
    ftsParams.push(org_id);
    const orgParam = `$${ftsParams.length}`;
    scopeWhere = `AND m.user_id = ${userParam}::uuid AND m.org_id = ${orgParam}::uuid`;
  } else {
    // Non-personal legacy scope: org-wide rows, but another member's
    // personal-tier rows stay private (security audit 08 F2). With no user id
    // the bound NULL matches no personal row.
    ftsParams.push(org_id);
    const orgParam = `$${ftsParams.length}`;
    ftsParams.push(user_id ?? null);
    const userParam = `$${ftsParams.length}`;
    scopeWhere = `AND m.org_id = ${orgParam}::uuid AND (m.scope <> 'personal' OR m.user_id = ${userParam}::uuid)`;
  }
  return scopeWhere;
}
