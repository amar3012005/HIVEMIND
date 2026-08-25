const B2B_PLANS = new Set(['scale', 'enterprise_onboarding', 'enterprise', 'managed']);

export function parseOrigins(value = '') {
  return String(value).split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function resolveTierCore({
  origin,
  routingOrigins = [],
  plan,
  defaultInternalUrl,
  defaultPublicUrl,
  b2bInternalUrl,
  b2bPublicUrl,
  b2cInternalUrl,
  b2cPublicUrl,
} = {}) {
  const fallback = { internalUrl: defaultInternalUrl, publicUrl: defaultPublicUrl, tier: 'default' };
  if (!origin || !routingOrigins.includes(origin)) return fallback;

  const isB2B = B2B_PLANS.has(String(plan || '').toLowerCase());
  const internalUrl = isB2B ? b2bInternalUrl : b2cInternalUrl;
  const publicUrl = isB2B ? b2bPublicUrl : b2cPublicUrl;
  if (!internalUrl || !publicUrl) return fallback;
  return { internalUrl, publicUrl, tier: isB2B ? 'b2b' : 'b2c' };
}
