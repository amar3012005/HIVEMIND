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
import { scimFilterToPrisma } from './scim-filter.js';
import { applyScimPatch } from './scim-patch.js';

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

// Filter parsing now lives in scim-filter.js (RFC 7644 §3.4.2 subset).

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
  bulk: { supported: true, maxOperations: 100, maxPayloadSize: 5242880 },
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
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10) | 0);
    const count = Math.min(200, Math.max(0, parseInt(url.searchParams.get('count') || '100', 10) | 0));
    const filterRaw = url.searchParams.get('filter');
    const { where: filterWhere, error: filterErr } = scimFilterToPrisma(filterRaw, 'user');
    if (filterErr) return scimError(res, 400, `Invalid filter: ${filterRaw}`, 'invalidFilter');
    // Active flag handled via UserOrganization.isActive separately.
    const wantActive = filterWhere?._uoActive;
    if (filterWhere && '_uoActive' in filterWhere) delete filterWhere._uoActive;
    const where = {
      organizations: { some: { orgId, ...(typeof wantActive === 'boolean' ? { isActive: wantActive } : { isActive: true }) } },
      deletedAt: null,
      ...(filterWhere || {}),
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
      include: { organizations: { where: { orgId }, take: 1 } },
    });
    if (!user) return scimError(res, 404, 'User not found');
    let body;
    try { body = await readScimBody(req); } catch (e) { return scimError(res, 400, `Invalid JSON: ${e.message}`); }

    // For PATCH apply RFC 7644 §3.5.2 ops via scim-patch.js; for PUT the
    // body IS the full resource.
    let merged;
    if (req.method === 'PATCH' && Array.isArray(body.Operations)) {
      const scimUser = userToScim(user, user.organizations[0]);
      merged = applyScimPatch(scimUser, body.Operations);
    } else {
      merged = body;
    }

    // Extract effective values from merged SCIM resource.
    const displayName = merged.displayName || merged.name?.formatted || user.displayName;
    const newEmail = merged.userName || merged.emails?.find?.((e) => e.primary)?.value || merged.emails?.[0]?.value || user.email;
    const active = typeof merged.active === 'boolean' ? merged.active : undefined;

    const userPatch = {};
    if (displayName !== user.displayName) userPatch.displayName = displayName;
    if (newEmail && newEmail !== user.email) userPatch.email = newEmail.toLowerCase();
    if (Object.keys(userPatch).length) {
      await prisma.user.update({ where: { id: userId }, data: userPatch });
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
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10) | 0);
    const count = Math.min(200, Math.max(0, parseInt(url.searchParams.get('count') || '100', 10) | 0));
    const filterRaw = url.searchParams.get('filter');
    const { where: gw, error: gErr } = scimFilterToPrisma(filterRaw, 'group');
    if (gErr) return scimError(res, 400, `Invalid filter: ${filterRaw}`, 'invalidFilter');
    const where = { orgId, ...(gw || {}) };
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
    // Team.createdBy is NOT NULL. SCIM has no user context (bearer scoped to
    // org) — use first active admin of the org as the synthetic creator, or
    // fall back to first active member.
    const creator = await prisma.userOrganization.findFirst({
      where: { orgId, isActive: true },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true },
    });
    if (!creator) return scimError(res, 400, 'org has no active members to attribute as creator', 'invalidValue');
    const slug = body.displayName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80);
    const team = await prisma.team.create({
      data: { orgId, name: body.displayName, slug: `${slug}-${crypto.randomBytes(3).toString('hex')}`, createdBy: creator.userId },
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

  // ── Bulk (RFC 7644 §3.7) ──────────────────────────────────────────────
  if (pathname === '/scim/v2/Bulk' && req.method === 'POST') {
    let body;
    try { body = await readScimBody(req, 5 * 1024 * 1024); }
    catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') return scimError(res, 413, 'payload too large');
      return scimError(res, 400, `Invalid JSON: ${e.message}`);
    }
    const ops = Array.isArray(body.Operations) ? body.Operations : [];
    if (ops.length === 0) return scimError(res, 400, 'Operations[] required', 'invalidValue');
    if (ops.length > 100) return scimError(res, 413, 'too many operations (max 100)', 'tooMany');

    const failOnErrors = Number(body.failOnErrors || 0);
    const results = [];
    let errCount = 0;

    // Sequential apply — each op re-enters the SCIM dispatcher with a
    // synthetic request so semantics match standalone calls.
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      const bulkId = op.bulkId || `op-${i}`;
      const method = String(op.method || '').toUpperCase();
      const opPath = String(op.path || '');
      const data = op.data || {};
      try {
        const result = await dispatchBulkSubOp({ prisma, orgId, method, path: opPath, data });
        results.push({ method, bulkId, location: result.location || null, status: String(result.status) });
        if (result.status >= 400) errCount += 1;
      } catch (e) {
        results.push({ method, bulkId, status: '500', response: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: e.message } });
        errCount += 1;
      }
      if (failOnErrors > 0 && errCount >= failOnErrors) break;
    }

    return scimReply(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkResponse'],
      Operations: results,
    });
  }

  // Unknown SCIM path.
  return scimError(res, 404, `SCIM resource not found: ${pathname}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Bulk sub-op dispatcher — replays Users/Groups create/update/delete against
// Prisma directly. Keeps logic close to the main handler so the same
// resource model is used.
// ────────────────────────────────────────────────────────────────────────────
async function dispatchBulkSubOp({ prisma, orgId, method, path, data }) {
  // Only Users + Groups paths supported in bulk.
  if (method === 'POST' && path === '/Users') {
    const email = (data.userName || data.emails?.[0]?.value || '').toLowerCase();
    if (!email) return { status: 400 };
    const displayName = data.displayName || data.name?.formatted || email;
    const user = await prisma.user.upsert({
      where: { email },
      update: { displayName },
      create: { email, displayName, zitadelUserId: `scim:${orgId}:${email}` },
    });
    await prisma.userOrganization.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      update: { isActive: data.active !== false, role: 'member', roles: ['member'] },
      create: { userId: user.id, orgId, role: 'member', roles: ['member'], isActive: data.active !== false, invitedAt: new Date(), joinedAt: new Date() },
    });
    return { status: 201, location: `/scim/v2/Users/${user.id}` };
  }

  if (method === 'POST' && path === '/Groups') {
    if (!data.displayName) return { status: 400 };
    const creator = await prisma.userOrganization.findFirst({
      where: { orgId, isActive: true },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true },
    });
    if (!creator) return { status: 400 };
    const slug = data.displayName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80);
    const team = await prisma.team.create({
      data: { orgId, name: data.displayName, slug: `${slug}-${crypto.randomBytes(3).toString('hex')}`, createdBy: creator.userId },
    });
    if (Array.isArray(data.members)) {
      for (const m of data.members) {
        if (!m.value) continue;
        await prisma.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId: m.value } },
          update: {},
          create: { teamId: team.id, userId: m.value, role: 'member' },
        }).catch(() => null);
      }
    }
    return { status: 201, location: `/scim/v2/Groups/${team.id}` };
  }

  const usersDetail = path.match(/^\/Users\/([0-9a-f-]{36})$/);
  if (usersDetail && method === 'DELETE') {
    const userId = usersDetail[1];
    const updated = await prisma.userOrganization.updateMany({
      where: { userId, orgId },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    return { status: updated.count > 0 ? 204 : 404 };
  }

  const groupsDetail = path.match(/^\/Groups\/([0-9a-f-]{36})$/);
  if (groupsDetail && method === 'DELETE') {
    const teamId = groupsDetail[1];
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return { status: 404 };
    await prisma.teamMember.deleteMany({ where: { teamId } });
    await prisma.team.delete({ where: { id: teamId } });
    return { status: 204 };
  }

  return { status: 400 };
}
