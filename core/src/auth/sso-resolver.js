/**
 * SSO Resolver — maps incoming request host to OrgSsoConfig.
 *
 * For enterprise subdomain routing:
 *   acme.hivemind.davinciai.eu → subdomain "acme" → OrgSsoConfig row
 *
 * Design constraints:
 * - Extraction is host-pattern driven; falls back gracefully in local dev
 *   (host is "localhost" or missing dot pattern → no ssoContext).
 * - Does a single DB lookup on the subdomain unique index — O(1).
 * - Never throws; returns null on any failure so default auth flow proceeds.
 */

const BASE_DOMAIN = process.env.HIVEMIND_BASE_DOMAIN || 'hivemind.davinciai.eu';

/**
 * Extract subdomain from a host header.
 * Returns null when host is not a proper subdomain of BASE_DOMAIN.
 * @param {string|undefined} host
 * @returns {string|null}
 */
export function extractSubdomain(host) {
  if (!host) return null;
  // Strip port
  const bare = host.split(':')[0];
  // Must end with .<BASE_DOMAIN>
  const suffix = `.${BASE_DOMAIN}`;
  if (!bare.endsWith(suffix)) return null;
  const sub = bare.slice(0, bare.length - suffix.length);
  // Reject empty, multi-segment, or obviously non-slug values
  if (!sub || sub.includes('.') || sub.length > 100) return null;
  return sub;
}

/**
 * Resolve SSO config for a given subdomain.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} subdomain
 * @returns {Promise<{orgId: string, zitadelProjectId: string|null, enabled: boolean, jitProvisioning: boolean, defaultRole: string, defaultTeamId: string|null}|null>}
 */
export async function resolveSsoConfig(prisma, subdomain) {
  if (!prisma || !subdomain) return null;
  try {
    const config = await prisma.orgSsoConfig.findUnique({
      where: { subdomain },
      select: {
        orgId: true,
        zitadelProjectId: true,
        enabled: true,
        jitProvisioning: true,
        defaultRole: true,
        defaultTeamId: true,
        ssoType: true,
      },
    });
    return config || null;
  } catch {
    return null;
  }
}

/**
 * Middleware-style: given a request, resolve and attach ssoContext.
 * Sets req.ssoContext = { orgId, zitadelProjectId, enabled, ... } or null.
 * @param {import('http').IncomingMessage} req
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function attachSsoContext(req, prisma) {
  const host = req.headers.host;
  const subdomain = extractSubdomain(host);
  if (!subdomain) {
    req.ssoContext = null;
    return;
  }
  req.ssoContext = await resolveSsoConfig(prisma, subdomain);
}
