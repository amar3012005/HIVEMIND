/**
 * permissions.js — P0-4 RBAC permission system
 *
 * Roles are additive: a user can have ['org_admin', 'team_lead'] simultaneously.
 * New code reads roles[] from user_organizations; falls back to role (string) for
 * rows not yet migrated.
 *
 * Permission denials are fire-and-forget audited with per-(userId,resource,action)
 * per-minute deduplication to prevent audit spam.
 */

// ─── Role catalogue ────────────────────────────────────────────────────────────

export const ROLES = new Set([
  'org_owner',
  'org_admin',
  'compliance_admin',
  'team_lead',
  'member',
  'viewer',
  'service_account',
  // Project-scoped invitee (external collaborator): sees ONLY the projects
  // they're explicitly a member of — never the org-wide tier. Created by
  // project-scoped invites; was missing from this catalogue, which made the
  // role editor 400 on any guest ("Invalid roles: guest").
  'guest',
]);

// ─── Permission map ────────────────────────────────────────────────────────────
// { resource: { action: Set<role> } }

export const PERMISSIONS = {
  org: {
    manage: new Set(['org_owner', 'org_admin']),
    read:   new Set(['org_owner', 'org_admin', 'compliance_admin', 'team_lead', 'member', 'viewer', 'service_account', 'guest']),
  },
  team: {
    manage: new Set(['org_owner', 'org_admin', 'team_lead']),
    read:   new Set(['org_owner', 'org_admin', 'team_lead', 'member', 'viewer', 'service_account']),
  },
  project: {
    manage: new Set(['org_owner', 'org_admin', 'team_lead']),
    // Guests read only their explicit projects — the project-tier visibility
    // engine (listProjectsForUser / scopedMemoryWhere) enforces the narrowing.
    read:   new Set(['org_owner', 'org_admin', 'team_lead', 'member', 'viewer', 'service_account', 'guest']),
  },
  memory: {
    manage: new Set(['org_owner', 'org_admin']),
    read:   new Set(['org_owner', 'org_admin', 'team_lead', 'member', 'viewer', 'service_account', 'guest']),
    write:  new Set(['org_owner', 'org_admin', 'team_lead', 'member', 'service_account', 'guest']),
    delete: new Set(['org_owner', 'org_admin']),
  },
  connector: {
    manage: new Set(['org_owner', 'org_admin']),
    read:   new Set(['org_owner', 'org_admin', 'team_lead', 'member', 'service_account']),
  },
  audit: {
    read:   new Set(['org_owner', 'org_admin', 'compliance_admin']),
    export: new Set(['org_owner', 'org_admin', 'compliance_admin']),
  },
  user: {
    manage: new Set(['org_owner', 'org_admin']),
    read:   new Set(['org_owner', 'org_admin', 'compliance_admin', 'team_lead']),
  },
  billing: {
    read:   new Set(['org_owner', 'org_admin']),
    manage: new Set(['org_owner']),
  },
  webhook: {
    manage: new Set(['org_owner', 'org_admin']),
    read:   new Set(['org_owner', 'org_admin']),
  },
  privileged_agent: {
    use: new Set(['org_owner', 'org_admin', 'team_lead']),
  },
};

// ─── Core check ───────────────────────────────────────────────────────────────

/**
 * Returns true if any of the supplied roles satisfies resource+action.
 * @param {string[]} userRoles
 * @param {string}   resource
 * @param {string}   action
 * @returns {boolean}
 */
export function hasPermission(userRoles, resource, action) {
  const resourcePerms = PERMISSIONS[resource];
  if (!resourcePerms) return false;
  const allowed = resourcePerms[action];
  if (!allowed) return false;
  return userRoles.some(r => allowed.has(r));
}

/**
 * Derive the effective roles[] from a UserOrganization membership row.
 * Prefers the roles[] column (P0-4) but falls back to the legacy role string
 * so the system works before and after migration without code flag.
 * @param {{ roles?: string[], role?: string }} membership
 * @returns {string[]}
 */
export function effectiveRoles(membership) {
  if (!membership) return [];
  // If roles[] is non-empty, use it
  if (Array.isArray(membership.roles) && membership.roles.length > 0) {
    return membership.roles;
  }
  // Fallback: map legacy single role to equivalent new role
  const legacyMap = {
    owner:           'org_owner',
    admin:           'org_admin',
    member:          'member',
    viewer:          'viewer',
    developer:       'member',
    service_account: 'service_account',
  };
  const mapped = legacyMap[membership.role] || 'member';
  return [mapped];
}

/**
 * Expensive autonomous agents are restricted to organization leadership or
 * the owner of the project they are scoped to. Project ownership is checked
 * separately because it is not an organization role.
 */
export function canUsePrivilegedAgent(userRoles, projectRole = null) {
  return hasPermission(userRoles, 'privileged_agent', 'use') || projectRole === 'owner';
}

// ─── Denial dedup ─────────────────────────────────────────────────────────────
// In-memory map: `${userId}:${resource}:${action}` → timestamp of last audit row.
// Prevents flooding the audit log on repeated 403s (e.g. broken frontend polling).

const _denialCache = new Map();
const DENIAL_DEDUP_MS = 60_000; // 1 minute

function _shouldAuditDenial(userId, resource, action) {
  const key = `${userId}:${resource}:${action}`;
  const last = _denialCache.get(key) || 0;
  if (Date.now() - last < DENIAL_DEDUP_MS) return false;
  _denialCache.set(key, Date.now());
  return true;
}

// ─── assertPermission ─────────────────────────────────────────────────────────

/**
 * Throws { status: 403, error: 'Forbidden' } if the user lacks permission.
 * Fire-and-forgets a 'permission.denied' audit row on first denial per minute.
 *
 * @param {object}   req
 * @param {{ resource: string, action: string }} perm
 * @param {{ userRoles: string[], orgId?: string, userId?: string, auditLogger?: object }} ctx
 */
export function assertPermission(req, { resource, action }, { userRoles = [], orgId, userId, auditLogger } = {}) {
  if (hasPermission(userRoles, resource, action)) return;

  // Fire-and-forget audit row (deduplicated)
  if (auditLogger && userId && _shouldAuditDenial(userId, resource, action)) {
    const allowed = PERMISSIONS[resource]?.[action]
      ? [...PERMISSIONS[resource][action]]
      : [];
    auditLogger.log({
      userId,
      organizationId: orgId || null,
      eventType: 'permission.denied',
      eventCategory: 'auth',
      action: 'read',
      resourceType: resource,
      metadata: {
        attempted_action: action,
        attempted_roles: userRoles,
        required_roles: allowed,
      },
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || null,
      userAgent: req.headers['user-agent'] || null,
    }).catch(() => { /* never block */ });
  }

  const err = new Error('Forbidden');
  err.status = 403;
  err.error = 'Forbidden';
  throw err;
}
