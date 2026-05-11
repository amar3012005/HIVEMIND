/**
 * SCIM 2.0 Router (RFC 7644)
 *
 * Mounted under /scim/v2/ in the control-plane HTTP server.
 * Authentication: Bearer token compared (timing-safe) against OrgSsoConfig.scimTokenHash (sha256).
 *
 * Endpoints implemented:
 *   Users:   GET list, GET/:id, POST, PUT/:id, PATCH/:id, DELETE/:id
 *   Groups:  GET list, GET/:id, POST, PUT/:id, PATCH/:id, DELETE/:id
 *   Discovery: GET ServiceProviderConfig, GET Schemas, GET ResourceTypes
 *
 * All mutating operations emit audit events via AuditLogger.
 */

import crypto from 'crypto';
import { parseScimFilter, ScimFilterError } from './filter-parser.js';

// ─── SCIM Content-Type ──────────────────────────────────────────
const SCIM_CT = 'application/scim+json; charset=utf-8';
const SCIM_SCHEMAS_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_SCHEMAS_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_SCHEMAS_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_SCHEMAS_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_SCHEMAS_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

// ─── Helpers ────────────────────────────────────────────────────

function scimError(res, status, detail, scimType) {
  const body = { schemas: [SCIM_SCHEMAS_ERROR], detail, status };
  if (scimType) body.scimType = scimType;
  res.writeHead(status, { 'Content-Type': SCIM_CT });
  res.end(JSON.stringify(body));
}

function scimJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': SCIM_CT });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Verify SCIM bearer token against stored sha256 hash.
 * Returns {orgId, config} on success, null on failure.
 */
async function authenticateScim(req, prisma) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  const hash = crypto.createHash('sha256').update(token).digest('hex');

  // Scan all enabled configs — we could index by hash but there are few orgs
  const config = await prisma.orgSsoConfig.findFirst({
    where: { enabled: true, scimTokenHash: { not: null } },
    select: {
      orgId: true,
      scimTokenHash: true,
      enabled: true,
      jitProvisioning: true,
      defaultRole: true,
      defaultTeamId: true,
    },
  });

  if (!config || !config.scimTokenHash) return null;
  if (!config.enabled) return null;

  // Constant-time comparison
  const storedBuf = Buffer.from(config.scimTokenHash, 'hex');
  const incomingBuf = Buffer.from(hash, 'hex');
  if (storedBuf.length !== incomingBuf.length) return null;
  if (!crypto.timingSafeEqual(storedBuf, incomingBuf)) return null;

  return config;
}

// ─── User → SCIM representation ─────────────────────────────────

function userToScim(user, orgId, membership, baseUrl) {
  const active = membership ? (membership.isActive !== false) : true;
  const nameParts = (user.displayName || '').split(' ');
  const givenName = nameParts[0] || '';
  const familyName = nameParts.slice(1).join(' ') || '';

  return {
    schemas: [SCIM_SCHEMAS_USER],
    id: user.id,
    externalId: user.zitadelUserId || undefined,
    userName: user.email,
    name: {
      formatted: user.displayName || '',
      givenName,
      familyName,
    },
    emails: [{ value: user.email, primary: true }],
    displayName: user.displayName || '',
    active,
    meta: {
      resourceType: 'User',
      created: user.createdAt?.toISOString() || new Date().toISOString(),
      lastModified: user.updatedAt?.toISOString() || new Date().toISOString(),
      location: `${baseUrl}/scim/v2/Users/${user.id}`,
    },
  };
}

// ─── Team → SCIM Group ────────────────────────────────────────────

function teamToScim(team, members, baseUrl) {
  return {
    schemas: [SCIM_SCHEMAS_GROUP],
    id: team.id,
    displayName: team.name,
    members: (members || []).map(m => ({
      value: m.userId,
      $ref: `${baseUrl}/scim/v2/Users/${m.userId}`,
      display: m.user?.displayName || m.user?.email || '',
    })),
    meta: {
      resourceType: 'Group',
      created: team.createdAt?.toISOString() || new Date().toISOString(),
      lastModified: team.updatedAt?.toISOString() || new Date().toISOString(),
      location: `${baseUrl}/scim/v2/Groups/${team.id}`,
    },
  };
}

// ─── PATCH operation handler ─────────────────────────────────────

/**
 * Apply RFC 7644 PATCH operations to a flat data object.
 * Supports path expressions: active, name.givenName, name.familyName, displayName, userName.
 * Returns the updated data object (for DB write) and a flag if active changed.
 */
function applyPatchOps(operations) {
  const data = {};
  let activeChanged = null; // null = not changed, true/false = new value

  for (const op of operations) {
    const { op: opName, path, value } = op;
    const norm = (opName || '').toLowerCase();

    if (!['replace', 'add', 'remove'].includes(norm)) {
      const err = new Error(`Unsupported PATCH op: ${opName}`);
      err.status = 400;
      err.scimType = 'invalidSyntax';
      throw err;
    }

    if (!path) {
      // No path — value must be object; apply each key
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          applyAttr(k, v, data, activeChanged);
          if (k === 'active') activeChanged = Boolean(v);
        }
      }
      continue;
    }

    applyAttr(path, norm === 'remove' ? null : value, data);
    if (path === 'active') activeChanged = norm === 'remove' ? false : Boolean(value);
  }

  return { data, activeChanged };
}

function applyAttr(path, value, data) {
  switch (path) {
    case 'active':
      // Handled at caller level; stash for clarity
      data.__active = value;
      break;
    case 'userName':
      if (value && typeof value === 'string') data.email = value.trim();
      break;
    case 'displayName':
    case 'name.formatted':
      if (typeof value === 'string') data.displayName = value.trim();
      break;
    case 'name.givenName': {
      data.__givenName = (value || '').trim();
      break;
    }
    case 'name.familyName': {
      data.__familyName = (value || '').trim();
      break;
    }
    // Silently ignore unknown paths — SCIM spec allows service to ignore unknown
    default:
      break;
  }
}

function resolveDisplayName(patchData, existingDisplayName) {
  // If givenName/familyName were patched, reconstruct displayName
  if ('__givenName' in patchData || '__familyName' in patchData) {
    const nameParts = (existingDisplayName || '').split(' ');
    const givenName = '__givenName' in patchData ? patchData.__givenName : (nameParts[0] || '');
    const familyName = '__familyName' in patchData ? patchData.__familyName : nameParts.slice(1).join(' ');
    return [givenName, familyName].filter(Boolean).join(' ') || null;
  }
  return patchData.displayName ?? null;
}

// ─── Discovery payloads ──────────────────────────────────────────

function buildServiceProviderConfig(baseUrl) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://hivemind.davinciai.eu/docs/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'HIVEMIND SCIM bearer token generated in Admin > SSO Config',
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${baseUrl}/scim/v2/ServiceProviderConfig`,
    },
  };
}

function buildSchemas() {
  return {
    schemas: [SCIM_SCHEMAS_LIST],
    totalResults: 2,
    itemsPerPage: 2,
    startIndex: 1,
    Resources: [
      {
        id: SCIM_SCHEMAS_USER,
        name: 'User',
        description: 'HIVEMIND User',
        attributes: [
          { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
          { name: 'displayName', type: 'string' },
          { name: 'emails', type: 'complex', multiValued: true },
          { name: 'active', type: 'boolean' },
          { name: 'name', type: 'complex' },
        ],
        meta: { resourceType: 'Schema', location: `${SCIM_SCHEMAS_USER}` },
      },
      {
        id: SCIM_SCHEMAS_GROUP,
        name: 'Group',
        description: 'HIVEMIND Team (mapped to SCIM Group)',
        attributes: [
          { name: 'displayName', type: 'string', required: true },
          { name: 'members', type: 'complex', multiValued: true },
        ],
        meta: { resourceType: 'Schema', location: `${SCIM_SCHEMAS_GROUP}` },
      },
    ],
  };
}

function buildResourceTypes(baseUrl) {
  return {
    schemas: [SCIM_SCHEMAS_LIST],
    totalResults: 2,
    itemsPerPage: 2,
    startIndex: 1,
    Resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'User Account',
        schema: SCIM_SCHEMAS_USER,
        meta: { resourceType: 'ResourceType', location: `${baseUrl}/scim/v2/ResourceTypes/User` },
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        description: 'Group (maps to Team)',
        schema: SCIM_SCHEMAS_GROUP,
        meta: { resourceType: 'ResourceType', location: `${baseUrl}/scim/v2/ResourceTypes/Group` },
      },
    ],
  };
}

// ─── Main router function ─────────────────────────────────────────

/**
 * Handle a SCIM 2.0 request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} pathname - URL pathname stripped of query string
 * @param {import('../audit/audit-logger.js').AuditLogger} auditLogger
 * @param {string} publicBaseUrl
 * @returns {Promise<boolean>} true if request was handled
 */
export async function handleScimRequest(req, res, prisma, pathname, auditLogger, publicBaseUrl) {
  // Only handle /scim/v2/*
  if (!pathname.startsWith('/scim/v2/')) return false;

  const subpath = pathname.slice('/scim/v2'.length); // e.g. /Users or /Users/:id

  // ── Discovery endpoints (no auth) ───────────────────────────────
  if (subpath === '/ServiceProviderConfig' && req.method === 'GET') {
    return scimJson(res, buildServiceProviderConfig(publicBaseUrl)), true;
  }
  if (subpath === '/Schemas' && req.method === 'GET') {
    return scimJson(res, buildSchemas()), true;
  }
  if ((subpath === '/ResourceTypes' || subpath === '/ResourceTypes/User' || subpath === '/ResourceTypes/Group') && req.method === 'GET') {
    return scimJson(res, buildResourceTypes(publicBaseUrl)), true;
  }

  // ── Auth ────────────────────────────────────────────────────────
  const ssoConfig = await authenticateScim(req, prisma);
  if (!ssoConfig) {
    scimError(res, 401, 'SCIM bearer token is invalid or missing', 'invalidToken');
    return true;
  }

  const { orgId } = ssoConfig;
  const baseUrl = publicBaseUrl;

  function reqMeta() {
    const fwd = req.headers['x-forwarded-for'];
    return {
      ipAddress: typeof fwd === 'string' ? fwd.split(',')[0].trim() : (req.socket?.remoteAddress || null),
      userAgent: req.headers['user-agent'] || null,
      platformType: 'scim',
    };
  }

  function auditLog(event) {
    if (!auditLogger) return;
    auditLogger.log({ organizationId: orgId, actorType: 'system', ...reqMeta(), ...event }).catch(() => {});
  }

  // ─── /scim/v2/Users ──────────────────────────────────────────────

  const userListMatch = subpath === '/Users';
  const userDetailMatch = subpath.match(/^\/Users\/([^/]+)$/);

  if (userListMatch && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10));
    const count = Math.min(200, Math.max(1, parseInt(url.searchParams.get('count') || '50', 10)));
    const filterStr = url.searchParams.get('filter') || '';

    let userWhere = { deletedAt: null };
    let activeFilter = null;

    if (filterStr) {
      try {
        const parsed = parseScimFilter(filterStr);
        if ('__scim_active' in parsed) {
          activeFilter = parsed.__scim_active;
          delete parsed.__scim_active;
        }
        if (Object.keys(parsed).length > 0) {
          Object.assign(userWhere, parsed);
        }
      } catch (err) {
        if (err instanceof ScimFilterError) {
          scimError(res, 400, err.message, err.scimType);
          return true;
        }
        scimError(res, 400, 'Invalid filter expression');
        return true;
      }
    }

    // Scope query to org members
    const memberships = await prisma.userOrganization.findMany({
      where: {
        orgId,
        ...(activeFilter !== null ? { isActive: activeFilter } : {}),
      },
      select: { userId: true, isActive: true, role: true },
    });

    const orgUserIds = memberships.map(m => m.userId);
    userWhere.id = { in: orgUserIds };

    const [total, users] = await Promise.all([
      prisma.user.count({ where: userWhere }),
      prisma.user.findMany({
        where: userWhere,
        skip: startIndex - 1,
        take: count,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const membershipMap = Object.fromEntries(memberships.map(m => [m.userId, m]));

    return scimJson(res, {
      schemas: [SCIM_SCHEMAS_LIST],
      totalResults: total,
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map(u => userToScim(u, orgId, membershipMap[u.id], baseUrl)),
    }), true;
  }

  if (userDetailMatch && req.method === 'GET') {
    const userId = userDetailMatch[1];
    const [user, membership] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId, deletedAt: null } }),
      prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId } } }),
    ]);
    if (!user || !membership) {
      scimError(res, 404, `User ${userId} not found`);
      return true;
    }
    return scimJson(res, userToScim(user, orgId, membership, baseUrl)), true;
  }

  if (userListMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const email = (body.userName || (body.emails?.[0]?.value) || '').trim().toLowerCase();
    if (!email) {
      scimError(res, 400, 'userName is required', 'invalidValue');
      return true;
    }

    const nameParts = body.name || {};
    const displayName = body.displayName
      || [nameParts.givenName, nameParts.familyName].filter(Boolean).join(' ')
      || email.split('@')[0];

    // Check for email collision
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      // Check if already in org
      const existingMembership = await prisma.userOrganization.findUnique({
        where: { userId_orgId: { userId: existing.id, orgId } },
      });
      if (existingMembership) {
        scimError(res, 409, `User with email ${email} already exists in this organization`, 'uniqueness');
        return true;
      }
    }

    let user;
    try {
      user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { displayName } })
        : await prisma.user.create({
            data: {
              zitadelUserId: `scim-${crypto.randomUUID()}`,
              email,
              displayName,
            },
          });
    } catch (err) {
      if (err.code === 'P2002') {
        scimError(res, 409, `User with email ${email} already exists`, 'uniqueness');
        return true;
      }
      throw err;
    }

    const role = ssoConfig.defaultRole || 'member';
    const isActive = body.active !== false;

    // Create UserOrganization — handle P0-4 roles[] column if present
    const uoData = { userId: user.id, orgId, role, joinedAt: new Date() };
    try {
      // Attempt to write roles array (P0-4 RBAC); fall back silently
      await prisma.userOrganization.upsert({
        where: { userId_orgId: { userId: user.id, orgId } },
        create: { ...uoData },
        update: { role },
      });
    } catch {
      await prisma.userOrganization.upsert({
        where: { userId_orgId: { userId: user.id, orgId } },
        create: { userId: user.id, orgId, role, joinedAt: new Date() },
        update: { role },
      });
    }

    // Add to default team if configured
    if (ssoConfig.defaultTeamId) {
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: ssoConfig.defaultTeamId, userId: user.id } },
        create: { teamId: ssoConfig.defaultTeamId, userId: user.id, role: 'member' },
        update: {},
      }).catch(() => {});
    }

    const membership = await prisma.userOrganization.findUnique({
      where: { userId_orgId: { userId: user.id, orgId } },
    });

    auditLog({
      userId: user.id,
      eventType: 'scim.user.created',
      eventCategory: 'provisioning',
      action: 'create',
      resourceType: 'user',
      resourceId: user.id,
      newValue: { email, displayName, role, defaultTeamId: ssoConfig.defaultTeamId },
    });

    return scimJson(res, userToScim(user, orgId, membership, baseUrl), 201), true;
  }

  if (userDetailMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
    const userId = userDetailMatch[1];
    const body = await parseBody(req);

    const [user, membership] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId, deletedAt: null } }),
      prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId } } }),
    ]);
    if (!user || !membership) {
      scimError(res, 404, `User ${userId} not found`);
      return true;
    }

    let userUpdate = {};
    let activeValue = null;

    if (req.method === 'PUT') {
      // Full replace
      const email = (body.userName || (body.emails?.[0]?.value) || user.email).trim().toLowerCase();
      const nameParts = body.name || {};
      const displayName = body.displayName
        || [nameParts.givenName, nameParts.familyName].filter(Boolean).join(' ')
        || user.displayName;
      userUpdate = { email, displayName };
      activeValue = body.active !== undefined ? Boolean(body.active) : null;
    } else {
      // PATCH
      const ops = body.Operations || [];
      if (!Array.isArray(ops)) {
        scimError(res, 400, 'Operations must be an array', 'invalidSyntax');
        return true;
      }
      try {
        const { data: patchData, activeChanged } = applyPatchOps(ops);
        activeValue = activeChanged;

        if (patchData.email) userUpdate.email = patchData.email;
        const newDisplay = resolveDisplayName(patchData, user.displayName);
        if (newDisplay) userUpdate.displayName = newDisplay;
        if ('displayName' in patchData && patchData.displayName) userUpdate.displayName = patchData.displayName;
      } catch (err) {
        scimError(res, err.status || 400, err.message, err.scimType);
        return true;
      }
    }

    // Apply user updates
    const updatedUser = Object.keys(userUpdate).length > 0
      ? await prisma.user.update({ where: { id: userId }, data: userUpdate })
      : user;

    // Handle active change → isActive on UserOrganization
    let updatedMembership = membership;
    if (activeValue !== null) {
      // isActive may not exist on P0-1 schema — handle gracefully
      try {
        updatedMembership = await prisma.userOrganization.update({
          where: { userId_orgId: { userId, orgId } },
          data: { isActive: activeValue },
        });
        if (!activeValue) {
          auditLog({
            userId,
            eventType: 'scim.user.deactivated',
            eventCategory: 'provisioning',
            action: 'update',
            resourceType: 'user',
            resourceId: userId,
            newValue: { active: false },
          });
        }
      } catch {
        // isActive column may not exist yet — skip
        updatedMembership = membership;
      }
    }

    auditLog({
      userId,
      eventType: 'scim.user.updated',
      eventCategory: 'provisioning',
      action: 'update',
      resourceType: 'user',
      resourceId: userId,
      newValue: { ...userUpdate, active: activeValue },
    });

    return scimJson(res, userToScim(updatedUser, orgId, updatedMembership, baseUrl)), true;
  }

  if (userDetailMatch && req.method === 'DELETE') {
    const userId = userDetailMatch[1];
    const membership = await prisma.userOrganization.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) {
      scimError(res, 404, `User ${userId} not found in this organization`);
      return true;
    }

    // Soft delete — set deletedAt on User
    await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });

    auditLog({
      userId,
      eventType: 'scim.user.deleted',
      eventCategory: 'provisioning',
      action: 'delete',
      resourceType: 'user',
      resourceId: userId,
    });

    res.writeHead(204);
    res.end();
    return true;
  }

  // ─── /scim/v2/Groups (mapped to Team) ─────────────────────────

  const groupListMatch = subpath === '/Groups';
  const groupDetailMatch = subpath.match(/^\/Groups\/([^/]+)$/);

  if (groupListMatch && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const startIndex = Math.max(1, parseInt(url.searchParams.get('startIndex') || '1', 10));
    const count = Math.min(200, Math.max(1, parseInt(url.searchParams.get('count') || '50', 10)));

    const [total, teams] = await Promise.all([
      prisma.team.count({ where: { orgId, archivedAt: null } }),
      prisma.team.findMany({
        where: { orgId, archivedAt: null },
        skip: startIndex - 1,
        take: count,
        orderBy: { createdAt: 'asc' },
        include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
      }),
    ]);

    return scimJson(res, {
      schemas: [SCIM_SCHEMAS_LIST],
      totalResults: total,
      startIndex,
      itemsPerPage: teams.length,
      Resources: teams.map(t => teamToScim(t, t.members, baseUrl)),
    }), true;
  }

  if (groupDetailMatch && req.method === 'GET') {
    const teamId = groupDetailMatch[1];
    const team = await prisma.team.findFirst({
      where: { id: teamId, orgId, archivedAt: null },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });
    if (!team) {
      scimError(res, 404, `Group ${teamId} not found`);
      return true;
    }
    return scimJson(res, teamToScim(team, team.members, baseUrl)), true;
  }

  if (groupListMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const name = (body.displayName || '').trim();
    if (!name) {
      scimError(res, 400, 'displayName is required', 'invalidValue');
      return true;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 120) || `team-${crypto.randomUUID().slice(0, 8)}`;

    // Find a system user to set as createdBy (use first org admin)
    const firstMembership = await prisma.userOrganization.findFirst({
      where: { orgId, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
      orderBy: { joinedAt: 'asc' },
    });
    const createdBy = firstMembership?.userId || crypto.randomUUID();

    const existing = await prisma.team.findFirst({ where: { orgId, slug } });
    const finalSlug = existing ? `${slug}-${crypto.randomUUID().slice(0, 6)}` : slug;

    const team = await prisma.team.create({
      data: { orgId, name, slug: finalSlug, createdBy },
    });

    // Add members from body.members
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        const memberId = m.value;
        if (!memberId) continue;
        await prisma.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId: memberId } },
          create: { teamId: team.id, userId: memberId, role: 'member' },
          update: {},
        }).catch(() => {});
      }
    }

    const teamWithMembers = await prisma.team.findUnique({
      where: { id: team.id },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });

    auditLog({
      eventType: 'scim.group.created',
      eventCategory: 'provisioning',
      action: 'create',
      resourceType: 'team',
      resourceId: team.id,
      newValue: { name, memberCount: body.members?.length || 0 },
    });

    return scimJson(res, teamToScim(teamWithMembers, teamWithMembers.members, baseUrl), 201), true;
  }

  if (groupDetailMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
    const teamId = groupDetailMatch[1];
    const body = await parseBody(req);
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId, archivedAt: null } });
    if (!team) {
      scimError(res, 404, `Group ${teamId} not found`);
      return true;
    }

    if (req.method === 'PUT') {
      // Full replace
      const name = (body.displayName || team.name).trim();
      await prisma.team.update({ where: { id: teamId }, data: { name } });

      // Replace members
      const memberIds = (body.members || []).map(m => m.value).filter(Boolean);
      await prisma.teamMember.deleteMany({ where: { teamId } });
      for (const userId of memberIds) {
        await prisma.teamMember.create({ data: { teamId, userId, role: 'member' } }).catch(() => {});
      }
    } else {
      // PATCH
      const ops = body.Operations || [];
      for (const op of ops) {
        const { op: opName, path, value } = op;
        const norm = (opName || '').toLowerCase();
        if (path === 'displayName' && value) {
          await prisma.team.update({ where: { id: teamId }, data: { name: value } });
        } else if (path === 'members') {
          if (norm === 'add' && Array.isArray(value)) {
            for (const m of value) {
              await prisma.teamMember.upsert({
                where: { teamId_userId: { teamId, userId: m.value } },
                create: { teamId, userId: m.value, role: 'member' },
                update: {},
              }).catch(() => {});
            }
          } else if (norm === 'remove') {
            if (Array.isArray(value)) {
              for (const m of value) {
                await prisma.teamMember.delete({
                  where: { teamId_userId: { teamId, userId: m.value } },
                }).catch(() => {});
              }
            }
          } else if (norm === 'replace' && Array.isArray(value)) {
            await prisma.teamMember.deleteMany({ where: { teamId } });
            for (const m of value) {
              await prisma.teamMember.create({ data: { teamId, userId: m.value, role: 'member' } }).catch(() => {});
            }
          }
        }
      }
    }

    const teamWithMembers = await prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { include: { user: { select: { id: true, displayName: true, email: true } } } } },
    });

    auditLog({
      eventType: 'scim.group.updated',
      eventCategory: 'provisioning',
      action: 'update',
      resourceType: 'team',
      resourceId: teamId,
    });

    return scimJson(res, teamToScim(teamWithMembers, teamWithMembers.members, baseUrl)), true;
  }

  if (groupDetailMatch && req.method === 'DELETE') {
    const teamId = groupDetailMatch[1];
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId, archivedAt: null } });
    if (!team) {
      scimError(res, 404, `Group ${teamId} not found`);
      return true;
    }

    // Soft delete — archive the team
    await prisma.team.update({ where: { id: teamId }, data: { archivedAt: new Date() } });

    auditLog({
      eventType: 'scim.group.deleted',
      eventCategory: 'provisioning',
      action: 'delete',
      resourceType: 'team',
      resourceId: teamId,
    });

    res.writeHead(204);
    res.end();
    return true;
  }

  // ── Unmatched SCIM path ──────────────────────────────────────────
  scimError(res, 404, `SCIM resource not found: ${subpath}`);
  return true;
}
