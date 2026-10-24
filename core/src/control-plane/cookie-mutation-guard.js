/**
 * Cross-site request protection for cookie-authenticated Control Plane
 * mutations.
 *
 * The dashboard session cookie is `SameSite=None` so first-party frontends on
 * other hosts can use it. Browsers therefore attach it to cross-site form
 * posts and no-preflight fetches, and CORS only hides the response. This guard
 * rejects a state-changing request that carries the session cookie unless the
 * browser reports a trusted origin, and it rejects the CORS "simple" body
 * types (`text/plain`, `application/x-www-form-urlencoded`, and multipart
 * outside upload routes) that a cross-site page can send without a preflight.
 *
 * Requests without the session cookie, and requests that carry an
 * `Authorization` header (which a cross-site page cannot set without a
 * preflight), are outside this guard. Non-browser clients send neither
 * `Origin` nor `Sec-Fetch-Site` and are not exposed to ambient-cookie CSRF.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * @param {string | undefined} cookieHeader raw `Cookie` header
 * @param {string} name cookie name
 * @returns {boolean} whether the named cookie is present with a non-empty value
 */
export function hasCookie(cookieHeader, name) {
  if (!cookieHeader || !name) return false;
  return String(cookieHeader).split(';').some((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return false;
    return part.slice(0, eq).trim() === name && part.slice(eq + 1).trim() !== '';
  });
}

/**
 * Normalize configured origins and URLs to their `scheme://host[:port]` form.
 *
 * @param {Array<string | null | undefined>} values origins or URLs
 * @returns {Set<string>} normalized origins
 */
export function trustedOriginSet(values) {
  const out = new Set();
  for (const value of values || []) {
    if (!value) continue;
    try { out.add(new URL(String(value).trim()).origin); } catch { /* an unparsable entry cannot match any browser Origin */ }
  }
  return out;
}

/**
 * Decide whether a request may proceed.
 *
 * @param {{
 *   method: string,
 *   headers: Record<string, string | string[] | undefined>,
 *   pathname: string,
 *   cookieName: string,
 *   trustedOrigins: Set<string>,
 *   multipartPathPrefixes?: string[],
 * }} input
 * @returns {{ allowed: true } | { allowed: false, status: 403 | 415, error: string }}
 */
export function evaluateCookieMutation({ method, headers, pathname, cookieName, trustedOrigins, multipartPathPrefixes = [] }) {
  if (SAFE_METHODS.has(String(method || '').toUpperCase())) return { allowed: true };
  if (!hasCookie(headers.cookie, cookieName)) return { allowed: true };
  if (headers.authorization) return { allowed: true };

  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : '';
  const fetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].trim().toLowerCase() : '';
  if (origin) {
    if (origin === 'null' || !trustedOrigins.has(origin)) {
      return { allowed: false, status: 403, error: 'cross_site_request_blocked' };
    }
  } else if (fetchSite && fetchSite !== 'same-origin') {
    return { allowed: false, status: 403, error: 'cross_site_request_blocked' };
  }

  const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType) return { allowed: true };
  if (contentType === 'application/json' || contentType.endsWith('+json')) return { allowed: true };
  if (contentType === 'multipart/form-data' && multipartPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || (prefix.endsWith('/') && pathname.startsWith(prefix)))) {
    return { allowed: true };
  }
  return { allowed: false, status: 415, error: 'json_content_type_required' };
}
