export const CANONICAL_PUBLIC_FRONTEND = 'https://next.singulancelabs.com';

const LEGACY_FRONTEND_HOSTS = new Set(['hivemind.davinciai.eu']);

/**
 * The public origin is one deployment-level contract. New environments must
 * set HIVEMIND_PUBLIC_ORIGIN; the older per-purpose values are retained only
 * so existing production and self-hosted installations can upgrade safely.
 */
export function resolvePublicFrontendBaseUrl(value = process.env.HIVEMIND_PUBLIC_ORIGIN || process.env.HIVEMIND_FRONTEND_URL) {
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
  return resolvePublicFrontendBaseUrl(env.HIVEMIND_PUBLIC_ORIGIN || env.HIVEMIND_FRONTEND_URL || env.HIVEMIND_INVITATION_BASE_URL);
}

export function resolvePublicAppUrl(env = process.env) {
  // A declared public origin wins over legacy app-specific settings. This
  // prevents invitation, OAuth, email, and browser routes drifting apart.
  const configured = String(env.HIVEMIND_PUBLIC_ORIGIN ? '' : env.HIVEMIND_APP_URL || '').trim();
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
  return `${resolvePublicFrontendBaseUrl(env.HIVEMIND_PUBLIC_ORIGIN || env.HIVEMIND_FRONTEND_URL)}/hivemind/app`;
}
