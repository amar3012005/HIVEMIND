/**
 * Pure rules for whether an app can be connected right now, and how a failed
 * connect attempt is explained to the person who clicked "Sign in".
 *
 * No I/O: callers supply the Composio toolkit record and the auth config ids
 * Core can actually use, so the same rule backs the connect route, the
 * toolkit list the web app renders and the daily connect-health run.
 */

/** Copy shown for an app whose connect is known broken. Locale-neutral key plus English text for API callers. */
export const CONNECT_UNAVAILABLE_MESSAGE = "This app can't be connected right now. We're on it.";

/**
 * Typed connect failure. `code` is stable and shown to clients; `message` is safe to display.
 */
export class ComposioConnectError extends Error {
  /**
   * @param {string} code - Stable machine code, see {@link classifyConnectError}.
   * @param {string} message - Text safe to show to the person connecting.
   * @param {{ status?: number, retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, { status = 409, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ComposioConnectError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Classify one Composio toolkit record into a connect mode.
 *
 * Modes: `configured` (Core holds an auth config id for it), `managed_oauth2`
 * (Composio supplies the OAuth app), `api_key` (credential form, no redirect),
 * `no_auth` (nothing to connect) and `blocked` (every other scheme, or OAuth2
 * that needs a customer-owned OAuth app Core has no credentials for).
 *
 * @param {{ slug?: string, authSchemes?: string[], composioManagedAuthSchemes?: string[], noAuth?: boolean }} toolkit - Fields as returned by `listToolkits`.
 * @param {{ authConfigId?: string | null }} [context] - `authConfigId` is a usable Core-owned auth config for this toolkit.
 * @returns {{ connectable: boolean, mode: 'configured'|'managed_oauth2'|'api_key'|'no_auth'|'blocked', reason: string|null }}
 */
export function classifyToolkitConnect(toolkit, { authConfigId = null } = {}) {
  if (authConfigId) return { connectable: true, mode: 'configured', reason: null };
  if (toolkit?.noAuth) return { connectable: false, mode: 'no_auth', reason: 'no_auth' };
  const schemes = Array.isArray(toolkit?.authSchemes) ? toolkit.authSchemes : [];
  const managed = Array.isArray(toolkit?.composioManagedAuthSchemes) ? toolkit.composioManagedAuthSchemes : [];
  if (managed.includes('OAUTH2')) return { connectable: true, mode: 'managed_oauth2', reason: null };
  if (!schemes.includes('OAUTH2') && schemes.includes('API_KEY')) return { connectable: true, mode: 'api_key', reason: null };
  if (schemes.includes('OAUTH2')) return { connectable: false, mode: 'blocked', reason: 'needs_custom_oauth_app' };
  return { connectable: false, mode: 'blocked', reason: 'unsupported_auth_scheme' };
}

const STALE_CONNECTION = /already (?:exists?|connected)|existing (?:connected )?account|duplicate|multiple (?:connected )?accounts?|expired|reinitiate|re-?authenticate/i;

/**
 * Map a Composio or Core connect failure to a stable code and a message that
 * says what to do next. Raw upstream text never reaches the client.
 *
 * @param {unknown} error - Thrown by a Composio request or by {@link ComposioConnectError}.
 * @returns {ComposioConnectError}
 */
export function classifyConnectError(error) {
  if (error instanceof ComposioConnectError) return error;
  const status = Number(error?.status) || 0;
  const text = String(error?.message || '');
  if (status === 401 || status === 403) {
    return new ComposioConnectError('provider_auth', CONNECT_UNAVAILABLE_MESSAGE, { status: 502, cause: error });
  }
  if (status === 404) {
    return new ComposioConnectError('connect_unavailable', CONNECT_UNAVAILABLE_MESSAGE, { status: 409, cause: error });
  }
  if (status === 429) {
    return new ComposioConnectError('rate_limited', 'Too many sign-in attempts. Wait a minute, then try again.', { status: 429, retryable: true, cause: error });
  }
  if (status >= 500 || !status) {
    return new ComposioConnectError('provider_unavailable', 'The sign-in service did not respond. Please try again in a moment.', { status: 502, retryable: true, cause: error });
  }
  if (STALE_CONNECTION.test(text)) {
    return new ComposioConnectError('stale_connection', 'An earlier sign-in for this app expired. Please try again to replace it.', { status: 409, retryable: true, cause: error });
  }
  return new ComposioConnectError('connect_unavailable', CONNECT_UNAVAILABLE_MESSAGE, { status: 409, cause: error });
}

/**
 * True when a failed link request looks caused by an earlier connection for the same app, so replacing
 * non-ACTIVE accounts and retrying once can succeed.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isStaleConnectionFailure(error) {
  const status = Number(error?.status) || 0;
  return (status === 400 || status === 409) && STALE_CONNECTION.test(String(error?.message || ''));
}

/** Account statuses that are safe to replace: they cannot serve any request. */
export const REPLACEABLE_ACCOUNT_STATUSES = new Set(['EXPIRED', 'FAILED', 'INACTIVE', 'INITIATED']);
