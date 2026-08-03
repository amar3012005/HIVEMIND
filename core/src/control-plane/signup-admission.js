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

export function createSignupAdmission({ accountType, secret, ttlSeconds = DEFAULT_SIGNUP_ADMISSION_TTL_SECONDS, now = Date.now() }) {
  if (!secret || !['personal', 'enterprise'].includes(accountType)) return null;
  const payload = Buffer.from(JSON.stringify({
    account_type: accountType,
    exp: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomUUID(),
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
    return { accountType: decoded.account_type, expiresAt: Number(decoded.exp) };
  } catch {
    return null;
  }
}
