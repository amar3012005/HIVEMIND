export const CANONICAL_PUBLIC_FRONTEND = 'https://next.singulancelabs.com';
export const DEVELOPMENT_PUBLIC_FRONTEND = 'https://dev.next.singulancelabs.com';

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
  // The invitation token exists only in the database of the Control Plane that
  // issued it. A known issuing server is authoritative even if a generic or
  // stale frontend override was copied from another environment.
  try {
    const controlPlane = new URL(String(env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || '').trim());
    const hostname = controlPlane.hostname.toLowerCase();
    if (hostname === 'api.dev.next.singulancelabs.com') return DEVELOPMENT_PUBLIC_FRONTEND;
    if (hostname === 'api.singulancelabs.com') return CANONICAL_PUBLIC_FRONTEND;
  } catch {
    // Missing/invalid issuer URL falls through to the configured frontend.
  }
  if (String(env.HIVEMIND_INVITATION_BASE_URL || '').trim()) {
    return resolvePublicFrontendBaseUrl(env.HIVEMIND_INVITATION_BASE_URL);
  }
  return resolvePublicFrontendBaseUrl(env.HIVEMIND_FRONTEND_URL);
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
