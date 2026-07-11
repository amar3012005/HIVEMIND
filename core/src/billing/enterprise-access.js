import crypto from 'node:crypto';

function configuredCodes(value) {
  return String(value || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

// Enterprise workspace creation is sales-approved. Compare fixed-length values
// in constant time so an onboarding link remains the only self-service capability.
export function isEnterpriseAccessCodeAllowed(candidate, configured = process.env.ENTERPRISE_SELF_SERVICE_CODES) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const received = Buffer.from(candidate.trim());
  return configuredCodes(configured).some((allowed) => {
    const expected = Buffer.from(allowed);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

export function hashEnterpriseOnboardingCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
}

// Claims a one-time database-backed code before an enterprise tenant is made.
// updateMany makes concurrent attempts race safely: exactly one can succeed.
export async function claimEnterpriseOnboardingCode(prisma, candidate, userId, hostingMode) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  const now = new Date();
  const code = await prisma.enterpriseOnboardingCode.findUnique({
    where: { codeHash: hashEnterpriseOnboardingCode(candidate) },
    select: { id: true, hostingMode: true, expiresAt: true, usedAt: true, revokedAt: true },
  });
  if (!code || code.usedAt || code.revokedAt || code.expiresAt <= now) return false;
  if (code.hostingMode && code.hostingMode !== hostingMode) return false;
  const claimed = await prisma.enterpriseOnboardingCode.updateMany({
    where: { id: code.id, usedAt: null, revokedAt: null },
    data: { usedAt: now, usedBy: userId },
  });
  return claimed.count === 1;
}
