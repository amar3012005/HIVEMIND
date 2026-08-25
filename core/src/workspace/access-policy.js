import { effectiveRoles, hasPermission } from '../auth/permissions.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function notFound(message = 'Resource not found') {
  const error = new Error(message);
  error.status = 404;
  return error;
}

export async function getActiveOrganizationMembership(prisma, { orgId, userId }) {
  if (!UUID_PATTERN.test(String(orgId || '')) || !UUID_PATTERN.test(String(userId || ''))) return null;
  return prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } },
    // Admin-facing callers need the resolved organization's canonical slug to
    // construct scoped links. Keep that data on the access-policy result so a
    // permitted route never has to reconstruct tenant identity from input.
    include: { org: true },
  }).then((membership) => (membership?.isActive ? membership : null));
}

export function isOrganizationAdmin(membership) {
  if (!membership) return false;
  const roles = effectiveRoles(membership);
  return hasPermission(roles, 'org', 'manage') || roles.includes('owner') || roles.includes('admin');
}

export async function requireActiveOrganizationUser(prisma, { orgId, userId }) {
  const membership = await getActiveOrganizationMembership(prisma, { orgId, userId });
  if (!membership) throw notFound();
  return membership;
}

export async function requireSameOrganizationMember(prisma, { orgId, userId }) {
  return requireActiveOrganizationUser(prisma, { orgId, userId });
}

export async function requireOrganizationAdmin(prisma, { orgId, userId }) {
  const membership = await requireActiveOrganizationUser(prisma, { orgId, userId });
  if (!isOrganizationAdmin(membership)) throw notFound();
  return membership;
}
