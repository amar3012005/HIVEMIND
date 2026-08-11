import { effectiveRoles, hasPermission } from './permissions.js';
import { requireActiveOrganizationUser, notFound } from '../workspace/access-policy.js';

// One principal-derived tenant envelope for Core and Control Plane handlers.
export async function resolveTenantAccess(prisma, principal, permission = null) {
  if (!principal?.orgId || !principal?.userId) throw notFound();
  const membership = await requireActiveOrganizationUser(prisma, { orgId: principal.orgId, userId: principal.userId });
  const roles = effectiveRoles(membership);
  if (permission && !hasPermission(roles, permission.resource, permission.action)) throw notFound();
  return { orgId: principal.orgId, userId: principal.userId, apiKeyId: principal.keyId || null, membership, roles,
    canManageBilling: hasPermission(roles, 'billing', 'manage') };
}
