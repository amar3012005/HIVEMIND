import { authenticatePersistedApiKey, resolveKeyAccess } from './api-keys.js';
import { getActiveOrganizationMembership } from '../workspace/access-policy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OPEN_DOT_RECOVERY_SCOPE = 'open_dot:recovery';

function denied(status, error) {
  return { status, body: { error } };
}

/**
 * Authenticate Open Dot's unattended recovery caller and derive the only
 * permitted tenant identity from its persisted service key. Request data is
 * never used to select the principal.
 */
export async function authorizeOpenDotRecoveryRequest({
  prisma,
  authorization,
  authenticate = authenticatePersistedApiKey,
  resolveAccess = resolveKeyAccess,
  getMembership = getActiveOrganizationMembership,
}) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return denied(401, 'Service key required');
  if (!prisma) return denied(503, 'Database unavailable');

  const keyRecord = await authenticate(prisma, token);
  if (!keyRecord) return denied(401, 'Invalid or expired service key');
  if (keyRecord.keyKind !== 'service' || !Array.isArray(keyRecord.scopes)
      || !keyRecord.scopes.includes(OPEN_DOT_RECOVERY_SCOPE)
      || keyRecord.scopes.includes('*')) {
    return denied(403, 'Open Dot recovery service scope required');
  }

  const userId = String(keyRecord.userId || '');
  const orgId = String(keyRecord.orgId || '');
  const principal = await resolveAccess(prisma, keyRecord, { projectIds: [], teamIds: [] });
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(orgId)
      || principal?.userId !== userId || principal?.orgId !== orgId
      || principal?.isServiceKey !== true
      || principal.projectId || principal.teamId
      || keyRecord.projectId || keyRecord.teamId) {
    return denied(403, 'Organization-bound recovery service key required');
  }

  const membership = await getMembership(prisma, { orgId, userId });
  if (!membership) return denied(403, 'Active organization membership required');

  return {
    status: 200,
    principal: Object.freeze({ orgId, userId }),
  };
}
