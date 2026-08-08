import crypto from 'crypto';

export const DEFAULT_SIGNUP_ADMISSION_TTL_SECONDS = 15 * 60;

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function invitationCodeMatches(candidate, configuredCode) {
  return Boolean(configuredCode) && constantTimeEqual(candidate, configuredCode);
}

export function createSignupAdmission({ accountType, secret, enterpriseInvitation = null, ttlSeconds = DEFAULT_SIGNUP_ADMISSION_TTL_SECONDS, now = Date.now() }) {
  if (!secret || !['personal', 'enterprise'].includes(accountType)) return null;
  if (enterpriseInvitation && accountType !== 'enterprise') return null;
  const invitation = enterpriseInvitation && {
    id: String(enterpriseInvitation.id || ''),
    method: String(enterpriseInvitation.method || ''),
    version: Number(enterpriseInvitation.version),
  };
  if (enterpriseInvitation && (!/^[0-9a-f-]{36}$/i.test(invitation.id) || !['code', 'link'].includes(invitation.method) || !Number.isInteger(invitation.version) || invitation.version < 1)) return null;
  const payload = Buffer.from(JSON.stringify({
    account_type: accountType,
    exp: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomUUID(),
    ...(invitation ? { enterprise_invitation: invitation } : {}),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`signup:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySignupAdmission({ ticket, accountType, secret, now = Date.now() }) {
  if (!secret || !['personal', 'enterprise'].includes(accountType)) return null;
  const [payload, signature, extra] = String(ticket || '').split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', secret).update(`signup:${payload}`).digest('base64url');
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded?.account_type !== accountType || !Number.isFinite(Number(decoded.exp)) || Number(decoded.exp) <= Math.floor(now / 1000)) return null;
    const invitation = decoded.enterprise_invitation;
    if (invitation && (!/^[0-9a-f-]{36}$/i.test(String(invitation.id || '')) || !['code', 'link'].includes(invitation.method) || !Number.isInteger(invitation.version) || invitation.version < 1)) return null;
    return {
      accountType: decoded.account_type,
      expiresAt: Number(decoded.exp),
      ...(invitation ? { enterpriseInvitation: { id: invitation.id, method: invitation.method, version: invitation.version } } : {}),
    };
  } catch {
    return null;
  }
}
