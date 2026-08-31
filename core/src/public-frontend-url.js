export const CANONICAL_PUBLIC_FRONTEND = 'https://next.singulancelabs.com';

const LEGACY_FRONTEND_HOSTS = new Set(['hivemind.davinciai.eu']);

export function resolvePublicFrontendBaseUrl(value = process.env.HIVEMIND_FRONTEND_URL) {
  const candidate = String(value || CANONICAL_PUBLIC_FRONTEND).trim();
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return CANONICAL_PUBLIC_FRONTEND;
    if (LEGACY_FRONTEND_HOSTS.has(parsed.hostname.toLowerCase())) return CANONICAL_PUBLIC_FRONTEND;
    return parsed.origin;
  } catch {
    return CANONICAL_PUBLIC_FRONTEND;
  }
}

export function resolveInvitationBaseUrl(env = process.env) {
  return resolvePublicFrontendBaseUrl(env.HIVEMIND_INVITATION_BASE_URL || env.HIVEMIND_FRONTEND_URL);
}

export function resolvePublicAppUrl(env = process.env) {
  const configured = String(env.HIVEMIND_APP_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (!LEGACY_FRONTEND_HOSTS.has(parsed.hostname.toLowerCase()) && ['http:', 'https:'].includes(parsed.protocol)) {
        return configured.replace(/\/$/, '');
      }
    } catch {
      // Fall through to the canonical application URL.
    }
  }
  return `${resolvePublicFrontendBaseUrl(env.HIVEMIND_FRONTEND_URL)}/hivemind/app`;
}
