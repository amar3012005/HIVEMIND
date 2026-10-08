/** Server-owned boundaries: absence of authorization never expands access. */
export function requiredSecret(value, name) {
  if (typeof value !== 'string' || value.trim().length < 32 || /^(change-me|default-(dev|mcp))/.test(value)) {
    throw Object.assign(new Error(`${name} is not configured securely`), { code: 'SECRET_UNAVAILABLE' });
  }
  return value;
}
export function dsrMemoryWhere({ userId, orgId, self }) {
  return self ? { userId, scope: 'personal', deletedAt: null } : { userId, orgId, scope: 'organization', deletedAt: null };
}
export function dsrAuditWhere({ userId, orgId, self }) {
  return self ? { userId, organizationId: null } : { userId, organizationId: orgId };
}
export async function requireDsrTargetMembership(prisma, { userId, orgId, self }) {
  if (self) return true;
  return !!await prisma.userOrganization.findFirst({ where: { userId, orgId, isActive: true }, select: { userId: true } });
}
