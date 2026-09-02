import crypto from 'crypto';

export const DEFAULT_SIGNUP_ADMISSION_TTL_SECONDS = 15 * 60;
export const DEFAULT_PERSONAL_INVITATION_LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function invitationCodeMatches(candidate, configuredCode) {
  return Boolean(configuredCode) && constantTimeEqual(candidate, configuredCode);
}

function personalCodeBinding(configuredCode, secret) {
  if (!configuredCode || !secret) return null;
  return crypto.createHmac('sha256', secret).update(`personal-code:${configuredCode}`).digest('base64url');
}

export function createPersonalInvitationLink({
  configuredCode,
  secret,
  ttlSeconds = DEFAULT_PERSONAL_INVITATION_LINK_TTL_SECONDS,
  now = Date.now(),
}) {
  const codeBinding = personalCodeBinding(configuredCode, secret);
  if (!codeBinding || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  const payload = Buffer.from(JSON.stringify({
    type: 'personal_invitation',
    code_binding: codeBinding,
    exp: Math.floor(now / 1000) + Math.floor(ttlSeconds),
    nonce: crypto.randomUUID(),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`personal-invite:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyPersonalInvitationLink({ token, configuredCode, secret, now = Date.now() }) {
  const expectedBinding = personalCodeBinding(configuredCode, secret);
  if (!token || !expectedBinding) return null;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', secret).update(`personal-invite:${payload}`).digest('base64url');
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded?.type !== 'personal_invitation'
      || !constantTimeEqual(decoded.code_binding, expectedBinding)
      || !Number.isFinite(Number(decoded.exp))
      || Number(decoded.exp) <= Math.floor(now / 1000)) return null;
    return { accountType: 'personal', expiresAt: Number(decoded.exp) };
  } catch {
    return null;
  }
}

export function createSignupAdmission({ accountType, secret, enterpriseInvitation = null, partnerReferral = null, ttlSeconds = DEFAULT_SIGNUP_ADMISSION_TTL_SECONDS, now = Date.now() }) {
  if (!secret || !['personal', 'enterprise'].includes(accountType)) return null;
  if (enterpriseInvitation && accountType !== 'enterprise') return null;
  if (enterpriseInvitation && partnerReferral) return null;
  if (partnerReferral && (!/^[0-9a-f-]{36}$/i.test(String(partnerReferral.id || '')) || !Number.isInteger(Number(partnerReferral.version)) || Number(partnerReferral.version) < 1)) return null;
  const invitation = enterpriseInvitation && {
    // EnterpriseInvitationService exposes `invitationId`; accept `id` as a
    // compatibility alias for direct callers and older tests.
    id: String(enterpriseInvitation.invitationId || enterpriseInvitation.id || ''),
    method: String(enterpriseInvitation.method || ''),
    version: Number(enterpriseInvitation.version),
  };
  if (enterpriseInvitation && (!/^[0-9a-f-]{36}$/i.test(invitation.id) || !['code', 'link'].includes(invitation.method) || !Number.isInteger(invitation.version) || invitation.version < 1)) return null;
  const payload = Buffer.from(JSON.stringify({
    account_type: accountType,
    exp: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomUUID(),
    ...(invitation ? { enterprise_invitation: invitation } : {}),
    ...(partnerReferral ? { partner_referral: { id: String(partnerReferral.id), version: Number(partnerReferral.version) } } : {}),
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
    const partnerReferral = decoded.partner_referral;
    if (partnerReferral && (!/^[0-9a-f-]{36}$/i.test(String(partnerReferral.id || '')) || !Number.isInteger(partnerReferral.version) || partnerReferral.version < 1)) return null;
    return {
      accountType: decoded.account_type,
      expiresAt: Number(decoded.exp),
      ...(invitation ? { enterpriseInvitation: { id: invitation.id, method: invitation.method, version: invitation.version } } : {}),
      ...(partnerReferral ? { partnerReferral: { id: partnerReferral.id, version: partnerReferral.version } } : {}),
    };
  } catch {
    return null;
  }
}
