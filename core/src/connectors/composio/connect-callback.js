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
  if (toolkit) landing.searchParams.set('composio_toolkit', toolkit);
  return landing.toString();
}

/**
 * Same-origin path (with query) of the page a person started a chat connect from, taken from
 * the request Referer. Only a first-party origin yields a path; anything else is null, so the
 * return target can never leave the first-party site.
 *
 * @param {string|undefined} referer Referer request header
 * @param {string[]} trustedOrigins first-party origins
 * @returns {string|null} for example `/hivemind/app/chat?thread=1`
 */
export function returnPathFromReferer(referer, trustedOrigins = []) {
  try {
    const url = new URL(String(referer || ''));
    const trusted = new Set(trustedOrigins.map(originOf).filter(Boolean));
    if (!originOf(url.href) || !trusted.has(url.origin)) return null;
    return `${url.pathname}${url.search}`.slice(0, 1000);
  } catch { return null; }
}

/**
 * Callback URL for a connect card created inside a Core chat turn. It is the Connectors
 * callback (`resolveComposioCallbackUrl`): the first-party landing page carrying `return`,
 * the path where the person started, so they come back to the conversation after consent.
 *
 * @param {{ composioCallbackOrigin?: string, composioReturnPath?: string, composioAllowedOrigins?: string[] }} ctx chat turn context
 * @param {string} [toolkit] toolkit slug when the card is for one toolkit
 * @returns {string|null} absolute URL, or null when no first-party frontend origin is known
 */
export function chatConnectCallbackUrl(ctx, toolkit) {
  const frontendBaseUrl = process.env.HIVEMIND_FRONTEND_URL || ctx?.composioCallbackOrigin;
  if (!originOf(frontendBaseUrl)) return null;
  const requested = typeof ctx?.composioReturnPath === 'string' && ctx.composioReturnPath.startsWith('/') && !ctx.composioReturnPath.startsWith('//')
    ? (() => {
      const url = new URL(LANDING_PATH, originOf(frontendBaseUrl));
      if (toolkit) url.searchParams.set('composio_toolkit', toolkit);
      url.searchParams.set('return', ctx.composioReturnPath);
      return url.toString();
    })()
    : undefined;
  return resolveComposioCallbackUrl({
    requested, requestOrigin: ctx?.composioCallbackOrigin, frontendBaseUrl,
    allowedOrigins: [ctx?.composioCallbackOrigin, ...(ctx?.composioAllowedOrigins || [])].filter(Boolean), toolkit,
  });
}
