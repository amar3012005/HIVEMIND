/**
 * Composio connect return URL for the Control Plane. Composio redirects the
 * person's browser to this URL after consent, so it must be an absolute https
 * page on a first-party origin. A relative or foreign URL strands the person
 * on a provider page (or sends the redirect to an unrelated host).
 */

const LANDING_PATH = '/hivemind/connect-return';

function originOf(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/**
 * @param {object} input
 * @param {string} [input.requested] Caller-supplied callback_url.
 * @param {string} [input.requestOrigin] Origin header of the connect request.
 * @param {string} input.frontendBaseUrl Public frontend base URL.
 * @param {string[]} input.allowedOrigins First-party origins.
 * @param {string} input.toolkit Toolkit slug.
 * @returns {string} Absolute return URL.
 */
export function resolveComposioCallbackUrl({ requested, requestOrigin, frontendBaseUrl, allowedOrigins = [], toolkit }) {
  const trusted = new Set([...allowedOrigins, frontendBaseUrl].map(originOf).filter(Boolean));
  if (typeof requested === 'string' && requested) {
    const origin = originOf(requested);
    if (origin && trusted.has(origin)) {
      const url = new URL(requested);
      url.hash = '';
      return url.toString();
    }
  }
  const base = originOf(requestOrigin) && trusted.has(originOf(requestOrigin)) ? originOf(requestOrigin) : originOf(frontendBaseUrl);
  const landing = new URL(LANDING_PATH, base);
  landing.searchParams.set('composio_toolkit', toolkit);
  return landing.toString();
}
