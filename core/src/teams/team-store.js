/**
 * TeamStore — Prisma-backed CRUD for Team, TeamMember, Project,
 * ProjectMember, MemoryProject. Used by control-plane REST endpoints
 * and by the memory recall/ingest paths to enforce scope filters.
 *
 * Permission model:
 * - Team create/archive: org owner or org admin (caller enforces via session)
 * - Team rename/desc: team_lead OR org admin
 * - Team member add/remove: team_lead OR org admin
 * - Project CRUD: team_lead OR project owner OR org admin
 *
 * This module performs DB operations only; permission checks happen at the
 * REST handler layer using `assertTeamPermission` exported below.
 */

const VALID_TEAM_ROLES = new Set(['lead', 'member']);
const VALID_PROJECT_ROLES = new Set(['owner', 'contributor', 'viewer']);
const VALID_PROJECT_STATUS = new Set(['active', 'archived']);
const VALID_PROJECT_POLICIES = new Set(['private', 'team_inherited', 'org_visible']);

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'team';
}

export class TeamStore {
  constructor(prisma) {
    if (!prisma) throw new Error('TeamStore: prisma required');
    this.prisma = prisma;
    this._onMembershipChange = null;
  }

  /** Register a callback invoked after any team/project membership change. */
  onMembershipChange(fn) {
    this._onMembershipChange = fn;
  }

  _notifyMembershipChange(userId, orgId) {
    if (typeof this._onMembershipChange === 'function') {
      try {
        this._onMembershipChange(userId, orgId);
      } catch { /* noop */ }
    }
  }

  // ── Teams ─────────────────────────────────────────────────

  async listTeamsForUser({ userId, orgId }) {
    return this.prisma.team.findMany({
      where: {
        orgId,
        archivedAt: null,
        members: { some: { userId } },
      },
      include: {
        _count: { select: { members: true, projects: true } },
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Ensure an org has a default team and the given user is a member.
   * - Finds existing { orgId, isDefault: true } team, OR creates one.
   * - On create, auto-adds every active org_member as a team member
   *   (lead = first member if no creator), matching the user's expectation
   *   that "if there's no team, all org members are the default team."
   * - Idempotent: safe to call repeatedly. If the team exists, just adds
   *   the caller (if missing) and any newly-joined org members.
   * Returns the team row with _count + members.
   */
  async ensureDefaultTeam({ orgId, userId }) {
    if (!orgId) throw new Error('orgId required');
    let team = await this.prisma.team.findFirst({
      where: { orgId, isDefault: true, archivedAt: null },
    });
    if (!team) {
      // Fetch active org members to seed the default team.
      const orgMembers = await this.prisma.userOrganization.findMany({
        // Guests are project-scoped invitees — keep them OFF the default team
        // (membership there exposes every team project).
        where: { orgId, isActive: true, role: { not: 'guest' } },
        select: { userId: true, role: true },
      });
      const seedMembers = orgMembers.length
        ? orgMembers
        : (userId ? [{ userId, role: 'member' }] : []);
      const creator = userId || seedMembers[0]?.userId;
      if (!creator) throw new Error('Cannot create default team — no org members');
      // Unique slug
      let slug = 'default-team';
      let n = 1;
      while (await this.prisma.team.findUnique({ where: { orgId_slug: { orgId, slug } } })) {
        n += 1;
        slug = `default-team-${n}`;
      }
      team = await this.prisma.team.create({
        data: {
          orgId,
          name: 'Default Team',
          slug,
          description: 'Auto-created. Includes all organization members.',
          isDefault: true,
          createdBy: creator,
          members: {
            create: seedMembers.map((m, i) => ({
              userId: m.userId,
              role: m.userId === creator ? 'lead' : 'member',
              addedById: creator,
            })),
          },
        },
        include: { _count: { select: { members: true, projects: true } } },
      });
      return team;
    }
    // Existing default team — ensure caller is a member (guests excluded:
    // default-team membership would expose every team project to them).
    if (userId) {
      const callerMembership = await this.prisma.userOrganization.findUnique({
        where: { userId_orgId: { userId, orgId } },
        select: { role: true },
      }).catch(() => null);
      if (callerMembership?.role !== 'guest') {
        await this.prisma.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId } },
          create: { teamId: team.id, userId, role: 'member', addedById: userId },
          update: {},
        });
      }
    }
    // Backfill: add any active org member that isn't already on the team.
    try {
      const orgMembers = await this.prisma.userOrganization.findMany({
        where: { orgId, isActive: true, role: { not: 'guest' } },
        select: { userId: true },
      });
      const existing = await this.prisma.teamMember.findMany({
        where: { teamId: team.id },
        select: { userId: true },
      });
      const existingIds = new Set(existing.map((m) => m.userId));
      const toAdd = orgMembers.filter((m) => !existingIds.has(m.userId));
      if (toAdd.length) {
        await this.prisma.teamMember.createMany({
          data: toAdd.map((m) => ({
            teamId: team.id,
            userId: m.userId,
            role: 'member',
            addedById: userId || m.userId,
          })),
          skipDuplicates: true,
        });
      }
    } catch (err) {
      // best-effort backfill — never block the call
    }
    return this.prisma.team.findUnique({
      where: { id: team.id },
      include: { _count: { select: { members: true, projects: true } } },
    });
  }

  async listAllTeamsInOrg({ orgId }) {
    return this.prisma.team.findMany({
      where: { orgId, archivedAt: null },
      include: { _count: { select: { members: true, projects: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async getTeam({ teamId, orgId }) {
    return this.prisma.team.findFirst({
      where: { id: teamId, orgId },
      include: {
        members: { include: { user: { select: { id: true, email: true, displayName: true } } } },
        projects: { where: { status: 'active' } },
      },
    });
  }

  async createTeam({ orgId, name, description = null, createdBy }) {
    const baseSlug = slugify(name);
    let slug = baseSlug;
    let n = 1;
    // Ensure unique slug within org
    while (await this.prisma.team.findUnique({ where: { orgId_slug: { orgId, slug } } })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }
    const team = await this.prisma.team.create({
      data: {
        orgId,
        name,
        slug,
        description,
        createdBy,
        members: { create: [{ userId: createdBy, role: 'lead', addedById: createdBy }] },
      },
      include: { members: true },
    });
    return team;
  }

  async updateTeam({ teamId, orgId, data }) {
    const allowed = {};
    if (typeof data.name === 'string' && data.name.trim()) allowed.name = data.name.trim();
    if (typeof data.description === 'string') allowed.description = data.description;
    if (Object.keys(allowed).length === 0) {
      throw new Error('No mutable fields supplied');
    }
    return this.prisma.team.update({
      where: { id: teamId },
      data: allowed,
    });
  }

  async archiveTeam({ teamId, orgId }) {
    // Default team cannot be archived
    const team = await this.prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return null;
    if (team.isDefault) throw new Error('Cannot archive default team');
    return this.prisma.team.update({
      where: { id: teamId },
      data: { archivedAt: new Date() },
    });
  }

  // ── Team members ─────────────────────────────────────────

  async listTeamMembers({ teamId }) {
    return this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { id: true, email: true, displayName: true, avatarUrl: true } } },
      orderBy: { addedAt: 'asc' },
    });
  }

  async addTeamMember({ teamId, userId, role = 'member', addedById }) {
    if (!VALID_TEAM_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
    const result = await this.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      create: { teamId, userId, role, addedById },
      update: { role },
    });
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { orgId: true } });
    if (team) this._notifyMembershipChange(userId, team.orgId);
    return result;
  }

  async removeTeamMember({ teamId, userId }) {
    // Cannot remove last lead
    const leads = await this.prisma.teamMember.count({ where: { teamId, role: 'lead' } });
    const target = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (target?.role === 'lead' && leads <= 1) {
      throw new Error('Cannot remove the last team lead. Promote another member first.');
    }
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { orgId: true } });
    const result = await this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
    if (team) this._notifyMembershipChange(userId, team.orgId);
    return result;
  }

  async userIsTeamMember({ teamId, userId }) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    return !!m;
  }

  async userIsTeamLead({ teamId, userId }) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    return m?.role === 'lead';
  }

  // ── Projects ─────────────────────────────────────────────

  /**
   * Policy-aware project visibility. Raw SQL on purpose: the `policy` column
   * postdates the deployed Prisma client (drift-proof — never reference new
   * columns through Prisma selects).
   *   admin/owner    → every active project
   *   guest          → ONLY explicit ProjectMember rows (invited projects)
   *   member         → explicit member, OR policy='org_visible', OR
   *                    (policy='team_inherited' AND member of project's team).
   *                    'private' projects are invisible to non-members — the
   *                    creator (auto-member) decides who else gets in.
   */
  async listProjectsForUser({ userId, orgId, teamId = null, orgRole = null }) {
    const isAdmin = orgRole === 'owner' || orgRole === 'admin';
    const isGuest = orgRole === 'guest';

    let visibility;
    if (isAdmin) {
      visibility = 'TRUE';
    } else if (isGuest) {
      visibility = `EXISTS (SELECT 1 FROM hivemind.project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::uuid)`;
    } else {
      const teamRows = await this.prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true },
      });
      const teamIdList = teamRows.map(t => `'${t.teamId}'::uuid`).join(',');
      const teamClause = teamIdList
        ? `(p.policy = 'team_inherited' AND p.team_id IN (${teamIdList}))`
        : 'FALSE';
      visibility = `(
        EXISTS (SELECT 1 FROM hivemind.project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2::uuid)
        OR p.policy = 'org_visible'
        OR ${teamClause}
      )`;
    }

    // Team-tab narrowing (non-guests): that team's projects + org-level rows +
    // explicit memberships — composed with the role visibility above via AND.
    const teamNarrow = teamId && !isGuest
      ? `AND (p.team_id = '${teamId}'::uuid OR p.team_id IS NULL OR EXISTS (SELECT 1 FROM hivemind.project_members pm3 WHERE pm3.project_id = p.id AND pm3.user_id = $2::uuid))`
      : '';

    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT p.id, p.org_id, p.team_id, p.name, p.slug, p.description, p.status,
              p.policy, p.created_by, p.created_at, p.updated_at,
              (SELECT count(*)::int FROM hivemind.project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
              (SELECT count(*)::int FROM hivemind.memories m
                WHERE m.deleted_at IS NULL
                  AND (m.project_id = p.id OR EXISTS (SELECT 1 FROM hivemind.memory_projects mp WHERE mp.memory_id = m.id AND mp.project_id = p.id))) AS memory_count
         FROM hivemind.projects p
        WHERE p.org_id = $1::uuid AND p.status = 'active' AND ${visibility} ${teamNarrow}
        ORDER BY p.updated_at DESC`,
      orgId, userId,
    );
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      teamId: r.team_id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      status: r.status,
      policy: r.policy,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      _count: { members: r.member_count, memories: r.memory_count },
    }));
  }

  async _legacyListProjectsForUser({ userId, orgId, teamId = null }) {
    const teamIds = (await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    })).map(t => t.teamId);

    const where = {
      orgId,
      status: 'active',
      OR: [
        { members: { some: { userId } } },
        { teamId: { in: teamIds } },
        { teamId: null }, // legacy / org-level projects (no team)
      ],
    };
    if (teamId) {
      where.OR = [
        { teamId },
        { teamId: null },
        { members: { some: { userId } } },
      ];
    }
    return this.prisma.project.findMany({
      where,
      include: { _count: { select: { members: true, memories: true } } },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async getProject({ projectId, orgId }) {
    return this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      include: {
        team: true,
        members: { include: { user: { select: { id: true, email: true, displayName: true } } } },
      },
    });
  }

  async createProject({ orgId, teamId = null, name, description = null, createdBy, policy = null }) {
    const baseSlug = slugify(name);
    let slug = baseSlug;
    let n = 1;
    while (await this.prisma.project.findUnique({ where: { orgId_slug: { orgId, slug } } })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }
    // Belt-and-braces: Project.id has @default(gen_random_uuid()) in schema
    // but some prod DBs were created without that default. Generate
    // explicitly so insertion never fails on null id even on stale schemas.
    const { randomUUID } = await import('node:crypto');
    const created = await this.prisma.project.create({
      data: {
        id: randomUUID(),
        orgId,
        teamId,
        name,
        slug,
        description,
        createdBy,
        // ProjectMember has composite PK (projectId, userId) — no `id` column
        members: { create: [{ userId: createdBy, role: 'owner', addedById: createdBy }] },
      },
      include: { members: true },
    });
    // policy column postdates the deployed Prisma client — set via raw SQL.
    const effectivePolicy = VALID_PROJECT_POLICIES.has(policy) ? policy : 'private';
    await this.prisma.$executeRawUnsafe(
      `UPDATE hivemind.projects SET policy = $1 WHERE id = $2::uuid`,
      effectivePolicy, created.id,
    ).catch(() => {});
    created.policy = effectivePolicy;
    return created;
  }

  async updateProject({ projectId, data }) {
    const allowed = {};
    if (typeof data.name === 'string' && data.name.trim()) allowed.name = data.name.trim();
    if (typeof data.description === 'string') allowed.description = data.description;
    if (typeof data.teamId === 'string') allowed.teamId = data.teamId;
    if (typeof data.status === 'string' && VALID_PROJECT_STATUS.has(data.status)) {
      allowed.status = data.status;
      if (data.status === 'archived') allowed.archivedAt = new Date();
    }
    if (typeof data.policy === 'string' && VALID_PROJECT_POLICIES.has(data.policy)) {
      // Raw SQL — column postdates the deployed Prisma client.
      await this.prisma.$executeRawUnsafe(
        `UPDATE hivemind.projects SET policy = $1 WHERE id = $2::uuid`,
        data.policy, projectId,
      );
      if (Object.keys(allowed).length === 0 && Object.keys(data).length === 1) {
        return this.prisma.project.findUnique({ where: { id: projectId } });
      }
    }
    if (Object.keys(allowed).length === 0) {
      throw new Error('No mutable fields supplied');
    }
    return this.prisma.project.update({ where: { id: projectId }, data: allowed });
  }

  async archiveProject({ projectId }) {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'archived', archivedAt: new Date() },
    });
  }

  async addProjectMember({ projectId, userId, role = 'contributor', addedById }) {
    if (!VALID_PROJECT_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
    const result = await this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, role, addedById },
      update: { role },
    });
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    if (project) this._notifyMembershipChange(userId, project.orgId);
    return result;
  }

  async removeProjectMember({ projectId, userId }) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    const result = await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    if (project) this._notifyMembershipChange(userId, project.orgId);
    return result;
  }

  // ── Memory ↔ Project linking ─────────────────────────────

  async setMemoryProjects({ memoryId, projectIds, addedById }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.memoryProject.deleteMany({ where: { memoryId } });
      if (projectIds && projectIds.length > 0) {
        await tx.memoryProject.createMany({
          data: projectIds.map(projectId => ({ memoryId, projectId, addedById })),
          skipDuplicates: true,
        });
      }
      return tx.memoryProject.findMany({ where: { memoryId } });
    });
  }

  async addMemoryToProject({ memoryId, projectId, addedById }) {
    return this.prisma.memoryProject.upsert({
      where: { memoryId_projectId: { memoryId, projectId } },
      create: { memoryId, projectId, addedById },
      update: {},
    });
  }

  async removeMemoryFromProject({ memoryId, projectId }) {
    return this.prisma.memoryProject.delete({
      where: { memoryId_projectId: { memoryId, projectId } },
    });
  }

  /**
   * Returns the set of project IDs the user can access in this org.
   * Used by recall scope filter to construct the OR clause.
   */
  async accessibleProjectIds({ userId, orgId }) {
    const explicit = await this.prisma.projectMember.findMany({
      where: { userId, project: { orgId, status: 'active' } },
      select: { projectId: true },
    });
    const teamIds = (await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    })).map(t => t.teamId);
    const viaTeam = await this.prisma.project.findMany({
      where: { orgId, status: 'active', teamId: { in: teamIds } },
      select: { id: true },
    });
    return Array.from(new Set([
      ...explicit.map(p => p.projectId),
      ...viaTeam.map(p => p.id),
    ]));
  }

  /**
   * Returns team IDs the user is a member of in this org.
   */
  async accessibleTeamIds({ userId, orgId }) {
    const rows = await this.prisma.teamMember.findMany({
      where: { userId, team: { orgId, archivedAt: null } },
      select: { teamId: true },
    });
    return rows.map(r => r.teamId);
  }
}

/**
 * Helper: enforce that the caller has the required permission level on a team
 * or project. Throws an Error with .status if denied. Use at REST layer.
 *
 * level: 'member' | 'lead' | 'admin'
 *   - member: any team_member row OR org_admin/owner
 *   - lead:   role='lead' on team OR org_admin/owner
 *   - admin:  org_admin or owner only (used for archive)
 */
export async function assertTeamPermission(prisma, { teamId, userId, orgRole, level }) {
  const isOrgAdmin = orgRole === 'owner' || orgRole === 'admin';
  if (level === 'admin') {
    if (!isOrgAdmin) {
      const err = new Error('Forbidden: org admin required');
      err.status = 403;
      throw err;
    }
    return true;
  }
  if (isOrgAdmin) return true;
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!m) {
    const err = new Error('Forbidden: not a team member');
    err.status = 403;
    throw err;
  }
  if (level === 'lead' && m.role !== 'lead') {
    const err = new Error('Forbidden: team lead required');
    err.status = 403;
    throw err;
  }
  return true;
}

export async function assertProjectPermission(prisma, { projectId, orgId, userId, orgRole, level }) {
  if (!orgId) {
    const err = new Error('Organization scope required');
    err.status = 400;
    throw err;
  }
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId, archivedAt: null } });
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  const isOrgAdmin = orgRole === 'owner' || orgRole === 'admin';
  if (isOrgAdmin) return true;
  // Owner-style mutation requires explicit ProjectMember role='owner' or team_lead
  const m = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (level === 'owner' && m?.role !== 'owner') {
    if (project.teamId) {
      const tm = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (tm?.role === 'lead') return true;
    }
    const err = new Error('Forbidden: project owner required');
    err.status = 403;
    throw err;
  }
  if (!m) {
    // Fallback: team membership grants read+contribute access
    if (project.teamId) {
      const tm = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (tm) return true;
    }
    const err = new Error('Forbidden: not a project member');
    err.status = 403;
    throw err;
  }
  return true;
}
