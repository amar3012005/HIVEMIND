// Connector Runtime V1 — typed errors.
//
// Every failure inside the runtime maps to exactly ONE CanonicalConnectorResult
// status (plan §3). Plugins throw these; the pipeline catches and renders a
// structured result — the agent never sees a raw stack or an unbounded hang.
//
// Errors carry NO provider credentials or tokens (security suite: "OAuth token
// leakage"). Messages are safe to surface.

export class ConnectorError extends Error {
  /** @param {string} message @param {object} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    /** Canonical result status this error renders as. */
    this.status = opts.status || 'failed';
    /** Stable machine code (for metrics / client branching). */
    this.code = opts.code || this.status;
    /** Whether a retry could succeed (rate-limit / timeout / transient). */
    this.retryable = opts.retryable === true;
    /** Optional structured detail (safe — never secrets). */
    this.detail = opts.detail || null;
    /** Optional provider HTTP status echoed for observability. */
    this.providerStatus = opts.providerStatus || null;
  }
}

export class ManifestError extends ConnectorError {
  constructor(message, meta = {}) {
    super(message, { status: 'failed', code: 'manifest_invalid', detail: meta });
  }
}

export class NotConnectedError extends ConnectorError {
  constructor(message = 'connector not connected for this user', detail = null) {
    super(message, { status: 'not_connected', code: 'not_connected', detail });
  }
}

export class ReauthRequiredError extends ConnectorError {
  constructor(message = 'connector requires re-authorization', detail = null) {
    super(message, { status: 'reauth_required', code: 'reauth_required', detail });
  }
}

export class ForbiddenError extends ConnectorError {
  constructor(message = 'not permitted', detail = null) {
    super(message, { status: 'forbidden', code: 'forbidden', detail });
  }
}

export class InvalidInputError extends ConnectorError {
  constructor(message = 'invalid input', detail = null) {
    super(message, { status: 'invalid_input', code: 'invalid_input', detail });
  }
}

export class TimeoutError extends ConnectorError {
  constructor(message = 'connector call timed out', detail = null) {
    super(message, { status: 'timeout', code: 'timeout', retryable: true, detail });
  }
}

export class RateLimitedError extends ConnectorError {
  constructor(message = 'provider rate limited', detail = null) {
    super(message, { status: 'rate_limited', code: 'rate_limited', retryable: true, detail });
  }
}

export class ApprovalRequiredError extends ConnectorError {
  /** @param {{id:string,summary:string,expiresAt:string}} approval */
  constructor(approval, message = 'approval required') {
    super(message, { status: 'approval_required', code: 'approval_required' });
    this.approval = approval;
  }
}

export class ConnectorFailedError extends ConnectorError {
  constructor(message = 'connector call failed', detail = null) {
    super(message, { status: 'failed', code: 'failed', detail });
  }
}

// Redact anything that looks like a bearer token / access token before a
// provider error message reaches a result or log line. Defence-in-depth for the
// "OAuth token leakage" security case — provider error bodies sometimes echo
// the auth header.
const TOKEN_RE = /(Bearer\s+[A-Za-z0-9._-]+|ya29\.[A-Za-z0-9._-]+|(?:access_token|refresh_token|client_secret)["'=:\s]+[A-Za-z0-9._-]+)/gi;
export function redactSecrets(text) {
  return String(text == null ? '' : text).replace(TOKEN_RE, '[redacted]');
}

/**
 * Best-effort classification of a raw provider/plugin error into a
 * ConnectorError. Recognises HTTP-status hints ("Google API 401: ...",
 * "429", etc.) without English-keyword matching where possible — status codes
 * are language-neutral. Falls back to ConnectorFailedError.
 */
export function classifyError(err) {
  if (err instanceof ConnectorError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const msg = redactSecrets(raw);
  // Provider HTTP status codes are the most reliable, language-neutral signal.
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  const httpStatus = m ? parseInt(m[1], 10) : null;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new TimeoutError('connector call timed out', { cause: msg });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    // 401 → token invalid/expired (reauth); 403 → forbidden/insufficient scope.
    return httpStatus === 401
      ? new ReauthRequiredError('provider rejected credentials (401)', { providerStatus: 401 })
      : new ForbiddenError('provider denied access (403)', { providerStatus: 403 });
  }
  if (httpStatus === 429) return new RateLimitedError('provider rate limited (429)', { providerStatus: 429 });
  if (httpStatus === 400 || httpStatus === 422) return new InvalidInputError('provider rejected input', { providerStatus: httpStatus });
  const e = new ConnectorFailedError(msg);
  if (httpStatus) e.providerStatus = httpStatus;
  return e;
}
