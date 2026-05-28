/**
 * SCIM 2.0 (RFC 7644) provisioning endpoints — minimum-viable.
 *
 * Implements the subset Okta + Azure AD use most for User + Group
 * lifecycle. Bearer auth: sha256(token) must match
 * OrgSsoConfig.scimTokenHash for the org we resolve from the token.
 *
 * Out of scope (for v1):
 *   - RFC 7644 §3.5.2 PATCH operations (path expressions, complex
 *     add/replace/remove). We support full PUT and a simple JSON-merge
 *     PATCH that replaces top-level fields only.
 *   - Filter syntax beyond `userName eq "x"` / `displayName eq "y"`.
 *   - Sorting + complex sortBy.
 *   - Bulk endpoint.
 *
 * Coverage:
 *   GET    /scim/v2/ServiceProviderConfig
 *   GET    /scim/v2/Schemas
 *   GET    /scim/v2/ResourceTypes
 *   GET    /scim/v2/Users           (paginate + filter)
 *   POST   /scim/v2/Users           (create)
 *   GET    /scim/v2/Users/:id
 *   PUT    /scim/v2/Users/:id       (replace)
 *   PATCH  /scim/v2/Users/:id       (merge top-level)
 *   DELETE /scim/v2/Users/:id       (soft: deactivate UserOrganization)
 *   GET    /scim/v2/Groups
 *   POST   /scim/v2/Groups
 *   GET    /scim/v2/Groups/:id
 *   PATCH  /scim/v2/Groups/:id      (add/remove members)
 *   DELETE /scim/v2/Groups/:id
 */

import crypto from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────────
// Token auth
// ────────────────────────────────────────────────────────────────────────────

/** Returns { orgId } when bearer matches an OrgSsoConfig.scimTokenHash, else null. */
export async function verifyScimToken(prisma, req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(scim_[a-f0-9]{64})$/i);
  if (!m) return null;
  const tokenHash = crypto.createHash('sha256').update(m[1]).digest('hex');
  const cfg = await prisma.orgSsoConfig.findFirst({
    where: { scimTokenHash: tokenHash },
    select: { orgId: true },
  });
  return cfg ? { orgId: cfg.orgId } : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Response helpers
// ────────────────────────────────────────────────────────────────────────────

function scimError(res, status, detail, scimType = null) {
  res.writeHead(status, { 'Content-Type': 'application/scim+json' });
  res.end(JSON.stringify({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  }));
}

function scimReply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/scim+json' });
  res.end(JSON.stringify(body));
}

// ────────────────────────────────────────────────────────────────────────────
// Mappers — internal DB shape ⇄ SCIM resource
// ────────────────────────────────────────────────────────────────────────────

function userToScim(user, uo) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    userName: user.email,
    displayName: user.displayName || user.email,
    name: { formatted: user.displayName || user.email },
    emails: [{ value: user.email, primary: true }],
    active: uo ? uo.isActive : false,
    meta: {
      resourceType: 'User',
      created: user.createdAt,
      lastModified: user.updatedAt || user.createdAt,
      location: `/scim/v2/Users/${user.id}`,
    },
  };
}

function teamToScim(team, memberRows) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: team.id,
    displayName: team.name,
    members: (memberRows || []).map((tm) => ({
      value: tm.userId,
      display: tm.user?.displayName || tm.user?.email || tm.userId,
      $ref: `/scim/v2/Users/${tm.userId}`,
    })),
    meta: {
      resourceType: 'Group',
      created: team.createdAt,
      lastModified: team.updatedAt || team.createdAt,
      location: `/scim/v2/Groups/${team.id}`,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Filter parser (minimal subset)
// ────────────────────────────────────────────────────────────────────────────
//   userName eq "alice@x.com"
//   displayName eq "Alice"
//   externalId eq "..."  (treated as id)
function parseFilter(filter) {
  if (!filter) return null;
  const m = String(filter).match(/^(\w+)\s+eq\s+"([^"]+)"$/i);
  if (!m) return null;
  const [, field, value] = m;
  const lower = field.toLowerCase();
  if (lower === 'username' || lower === 'emails.value') return { email: value };
  if (lower === 'displayname') return { displayName: value };
  if (lower === 'externalid' || lower === 'id') return { id: value };
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Body reader (limited; mirrors control-plane parseBody but tolerant of
// `application/scim+json` content-type).
// ────────────────────────────────────────────────────────────────────────────
async function readScimBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '', bytes = 0, aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        const err = new Error('payload_too_large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      body += chunk;
    });
    req.on('end', () => { if (!aborted) { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } } });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Static metadata endpoints
// ────────────────────────────────────────────────────────────────────────────

const SCHEMAS_BUNDLE = [
  { id: 'urn:ietf:params:scim:schemas:core:2.0:User', name: 'User' },
  { id: 'urn:ietf:params:scim:schemas:core:2.0:Group', name: 'Group' },
];

const RESOURCE_TYPES = [
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'User', name: 'User', endpoint: '/Users',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
  },
  {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'Group', name: 'Group', endpoint: '/Groups',
    schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  },
];

const SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://github.com/amar3012005/HIVEMIND/blob/main/docs/architecture/SCIM_ROADMAP.md',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{
    type: 'oauthbearertoken', name: 'Bearer Token',
    description: 'Per-org SCIM token generated via AdminSso UI.',
    primary: true,
  }],
};

// ────────────────────────────────────────────────────────────────────────────
// Dispatch — called from control-plane-server.js
// ────────────────────────────────────────────────────────────────────────────

export async function handleScimRequest({ prisma, req, res, pathname, url }) {
  // Unauthenticated discovery only — no token required.
  if (pathname === '/scim/v2/ServiceProviderConfig' && req.method === 'GET') {
    return scimReply(res, 200, SERVICE_PROVIDER_CONFIG);
  }
  if (pathname === '/scim/v2/Schemas' && req.method === 'GET') {
    return scimReply(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: SCHEMAS_BUNDLE.length,
      itemsPerPage: SCHEMAS_BUNDLE.length,
      startIndex: 1,
      Resources: SCHEMAS_BUNDLE,
    });
  }
  if (pathname === '/scim/v2/ResourceTypes' && req.method === 'GET') {
    return scimReply(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: RESOURCE_TYPES.length,
      itemsPerPage: RESOURCE_TYPES.length,
      startIndex: 1,
      Resources: RESOURCE_TYPES,
    });
  }

  // Everything below requires SCIM bearer.
  const auth = await verifyScimToken(prisma, req);
  if (!auth) return scimError(res, 401, 'Unauthorized — SCIM bearer required');
  const { orgId } = auth;

  // ── Users ─────────────────────────────────────────────────────────────
  const usersCollection = pathname === '/scim/v2/Users';
  const userDetailMatch = pathname.match(/^\/scim\/v2\/Users\/([0-9a-f-]{36})$/);

  if (usersCollection && req.method === 'GET') {
    const filter = parseFilter(url.searchParams.get('filter'));
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10) | 0);
    const count = Math.min(200, Math.max(0, parseInt(url.searchParams.get('count') || '100', 10) | 0));
    const where = {
      organizations: { some: { orgId, isActive: true } },
      deletedAt: null,
      ...(filter?.email ? { email: filter.email } : {}),
      ...(filter?.displayName ? { displayName: filter.displayName } : {}),
      ...(filter?.id ? { id: filter.id } : {}),
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where, orderBy: { createdAt: 'asc' },
        skip: startIndex - 1, take: count,
        include: { organizations: { where: { orgId }, take: 1 } },
      }),
    ]);
    return scimReply(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total, itemsPerPage: users.length, startIndex,
      Resources: users.map((u) => userToScim(u, u.organizations[0])),
    });
  }

  if (usersCollection && req.method === 'POST') {
    let body;
    try { body = await readScimBody(req); }
    catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') return scimError(res, 413, 'payload too large');
      return scimError(res, 400, `Invalid JSON: ${e.message}`);
    }
    const email = (body.userName || body.emails?.[0]?.value || '').trim().toLowerCase();
    if (!email) return scimError(res, 400, 'userName required', 'invalidValue');
    const displayName = body.displayName || body.name?.formatted || email;

    // Upsert user by email globally — SCIM Users with same userName collapse.
    const user = await prisma.user.upsert({
      where: { email },
      update: { displayName },
      create: {
        email, displayName,
        zitadelUserId: `scim:${orgId}:${email}`, // synthesised — SSO login replaces it
      },
    });
    await prisma.userOrganization.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      update: { isActive: body.active !== false, role: 'member', roles: ['member'] },
      create: { userId: user.id, orgId, role: 'member', roles: ['member'], isActive: body.active !== false, invitedAt: new Date(), joinedAt: new Date() },
    });
    const uo = { isActive: body.active !== false };
    return scimReply(res, 201, userToScim(user, uo));
  }

  if (userDetailMatch && req.method === 'GET') {
    const userId = userDetailMatch[1];
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null, organizations: { some: { orgId } } },
      include: { organizations: { where: { orgId }, take: 1 } },
    });
    if (!user) return scimError(res, 404, 'User not found');
    return scimReply(res, 200, userToScim(user, user.organizations[0]));
  }

  if (userDetailMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
    const userId = userDetailMatch[1];
    const user = await prisma.user.findFirst({
      where: { id: userId, organizations: { some: { orgId } } },
    });
    if (!user) return scimError(res, 404, 'User not found');
    let body;
    try { body = await readScimBody(req); } catch (e) { return scimError(res, 400, `Invalid JSON: ${e.message}`); }
    // PATCH with Operations[] (RFC 7644 §3.5.2) — handle simple replace ops.
    let active = body.active;
    let displayName = body.displayName;
    if (Array.isArray(body.Operations)) {
      for (const op of body.Operations) {
        const path = (op.path || '').toLowerCase();
        if (op.op?.toLowerCase() === 'replace') {
          if (path === 'active' || (!path && typeof op.value?.active === 'boolean')) active = op.value?.active ?? op.value;
          if (path === 'displayname' || (!path && op.value?.displayName)) displayName = op.value?.displayName || op.value;
        }
      }
    }
    if (typeof displayName === 'string' && displayName !== user.displayName) {
      await prisma.user.update({ where: { id: userId }, data: { displayName } });
    }
    if (typeof active === 'boolean') {
      await prisma.userOrganization.update({
        where: { userId_orgId: { userId, orgId } },
        data: { isActive: active, deactivatedAt: active ? null : new Date() },
      });
    }
    const fresh = await prisma.user.findUnique({
      where: { id: userId },
      include: { organizations: { where: { orgId }, take: 1 } },
    });
    return scimReply(res, 200, userToScim(fresh, fresh.organizations[0]));
  }

  if (userDetailMatch && req.method === 'DELETE') {
    const userId = userDetailMatch[1];
    // Soft delete = deactivate the org membership. User row stays so
    // memory authorship + audit trail remain intact.
    const updated = await prisma.userOrganization.updateMany({
      where: { userId, orgId },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    if (updated.count === 0) return scimError(res, 404, 'User not found in this org');
    res.writeHead(204); res.end(); return;
  }

  // ── Groups (Teams) ────────────────────────────────────────────────────
  const groupsCollection = pathname === '/scim/v2/Groups';
  const groupDetailMatch = pathname.match(/^\/scim\/v2\/Groups\/([0-9a-f-]{36})$/);

  if (groupsCollection && req.method === 'GET') {
    const filter = parseFilter(url.searchParams.get('filter'));
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10) | 0);
    const count = Math.min(200, Math.max(0, parseInt(url.searchParams.get('count') || '100', 10) | 0));
    const where = {
      orgId,
      ...(filter?.displayName ? { name: filter.displayName } : {}),
      ...(filter?.id ? { id: filter.id } : {}),
    };
    const [total, teams] = await Promise.all([
      prisma.team.count({ where }),
      prisma.team.findMany({
        where, orderBy: { createdAt: 'asc' },
        skip: startIndex - 1, take: count,
        include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
      }),
    ]);
    return scimReply(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total, itemsPerPage: teams.length, startIndex,
      Resources: teams.map((t) => teamToScim(t, t.members)),
    });
  }

  if (groupsCollection && req.method === 'POST') {
    let body; try { body = await readScimBody(req); } catch (e) { return scimError(res, 400, `Invalid JSON: ${e.message}`); }
    if (!body.displayName) return scimError(res, 400, 'displayName required', 'invalidValue');
    const slug = body.displayName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80);
    const team = await prisma.team.create({
      data: { orgId, name: body.displayName, slug: `${slug}-${crypto.randomBytes(3).toString('hex')}` },
    });
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        if (!m.value) continue;
        await prisma.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId: m.value } },
          update: {},
          create: { teamId: team.id, userId: m.value, role: 'member' },
        }).catch(() => null);
      }
    }
    const fresh = await prisma.team.findUnique({
      where: { id: team.id },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });
    return scimReply(res, 201, teamToScim(fresh, fresh.members));
  }

  if (groupDetailMatch && req.method === 'GET') {
    const teamId = groupDetailMatch[1];
    const team = await prisma.team.findFirst({
      where: { id: teamId, orgId },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });
    if (!team) return scimError(res, 404, 'Group not found');
    return scimReply(res, 200, teamToScim(team, team.members));
  }

  if (groupDetailMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const teamId = groupDetailMatch[1];
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return scimError(res, 404, 'Group not found');
    let body; try { body = await readScimBody(req); } catch (e) { return scimError(res, 400, `Invalid JSON: ${e.message}`); }
    const ops = Array.isArray(body.Operations) ? body.Operations : (Array.isArray(body.members) ? [{ op: 'replace', path: 'members', value: body.members }] : []);
    for (const op of ops) {
      const path = (op.path || '').toLowerCase();
      const action = op.op?.toLowerCase();
      if (path === 'members' && (action === 'add' || action === 'replace')) {
        const newMembers = Array.isArray(op.value) ? op.value : [];
        if (action === 'replace') {
          await prisma.teamMember.deleteMany({ where: { teamId } });
        }
        for (const m of newMembers) {
          if (!m.value) continue;
          await prisma.teamMember.upsert({
            where: { teamId_userId: { teamId, userId: m.value } },
            update: {},
            create: { teamId, userId: m.value, role: 'member' },
          }).catch(() => null);
        }
      }
      if (path === 'members' && action === 'remove' && op.value) {
        const ids = (Array.isArray(op.value) ? op.value : [op.value]).map((m) => m.value || m).filter(Boolean);
        if (ids.length) await prisma.teamMember.deleteMany({ where: { teamId, userId: { in: ids } } });
      }
      if (path === 'displayname' && action === 'replace') {
        await prisma.team.update({ where: { id: teamId }, data: { name: op.value } });
      }
    }
    const fresh = await prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });
    return scimReply(res, 200, teamToScim(fresh, fresh.members));
  }

  if (groupDetailMatch && req.method === 'DELETE') {
    const teamId = groupDetailMatch[1];
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return scimError(res, 404, 'Group not found');
    await prisma.teamMember.deleteMany({ where: { teamId } });
    await prisma.team.delete({ where: { id: teamId } });
    res.writeHead(204); res.end(); return;
  }

  // Unknown SCIM path.
  return scimError(res, 404, `SCIM resource not found: ${pathname}`);
}
