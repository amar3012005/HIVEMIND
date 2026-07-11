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
