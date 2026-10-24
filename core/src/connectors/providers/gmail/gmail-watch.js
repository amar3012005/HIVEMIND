/**
 * Gmail Pub/Sub watch — real-time email change notifications.
 *
 * Flow:
 *   1. registerWatch(): call Gmail users.watch → Google starts publishing
 *      change events to our Pub/Sub topic (configured in env GCP_PUBSUB_TOPIC).
 *   2. Pub/Sub pushes to our webhook /api/connectors/gmail/pubsub-webhook
 *      with the user's `emailAddress` + `historyId`.
 *   3. Webhook fetches history since stored cursor → ingests new threads.
 *   4. renewAllWatches() runs daily (cron) — watches expire after 7 days.
 *
 * Requires GCP setup (one-time, per Cloud project):
 *   - Pub/Sub topic: gmail-changes (or env GCP_PUBSUB_TOPIC)
 *   - Topic IAM: grant gmail-api-push@system.gserviceaccount.com Publisher role
 *   - Push subscription → https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook
 *   - Push auth: enable OIDC token, audience = our webhook URL
 *
 * See docs/gmail-pubsub-setup.md for the exact gcloud commands.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const WATCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // Gmail-imposed max
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000; // renew with 1d margin
const DEFAULT_LABELS = ['INBOX']; // monitor inbox only by default (Supermemory pattern)

/**
 * Register a Gmail watch for the given user.
 * Stores expiration + historyId on the connection metadata.
 */
export async function registerWatch({ accessToken, topicName, labelIds = DEFAULT_LABELS }) {
  if (!topicName) {
    throw new Error('topicName required (set env GCP_PUBSUB_TOPIC)');
  }

  const response = await fetch(`${GMAIL_API_BASE}/watch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName, // e.g. projects/my-project/topics/gmail-changes
      labelIds,
      labelFilterBehavior: 'INCLUDE',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail watch.create failed ${response.status}: ${text}`);
  }

  const data = await response.json();
  return {
    historyId: data.historyId,
    expirationMs: Number(data.expiration), // epoch millis when watch expires
    labelIds,
  };
}

/**
 * Stop a Gmail watch (call on disconnect).
 */
export async function stopWatch({ accessToken }) {
  const response = await fetch(`${GMAIL_API_BASE}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // Gmail returns 204 on success, but stop is idempotent — 4xx fine on disconnect race
  return response.ok || response.status === 404;
}

/**
 * Check whether watch needs renewal.
 */
export function needsRenewal(watchMetadata) {
  if (!watchMetadata?.expirationMs) return true;
  return Date.now() >= watchMetadata.expirationMs - RENEW_BEFORE_MS;
}

/**
 * Cron-driven: renew watches across all Gmail connections close to expiry.
 * Caller injects connector store + token getter.
 *
 * @param {object} deps
 * @param {object} deps.connectorStore - has listAllByProvider + updateStatus
 * @param {Function} deps.refreshAccessToken - (userId) => Promise<accessToken>
 * @param {string} deps.topicName - GCP Pub/Sub topic name
 */
export async function renewAllWatches({ connectorStore, refreshAccessToken, topicName }) {
  const connections = await connectorStore.listAllByProvider('gmail');
  const results = { renewed: 0, skipped: 0, failed: 0 };

  for (const conn of connections) {
    try {
      const watchMeta = conn.metadata?.watch || null;
      if (!needsRenewal(watchMeta)) {
        results.skipped++;
        continue;
      }

      const accessToken = await refreshAccessToken(conn.userId);
      const renewed = await registerWatch({ accessToken, topicName });

      await connectorStore.updateMetadata(conn.userId, 'gmail', {
        watch: renewed,
      });
      results.renewed++;
    } catch (err) {
      console.warn(`[gmail-watch] Renewal failed for user ${conn.userId}: ${err.message}`);
      results.failed++;
    }
  }
  return results;
}

/**
 * Decode a Pub/Sub push body.
 * Pub/Sub wraps data in base64-encoded JSON: { message: { data, attributes, messageId, publishTime } }
 *
 * Returns { emailAddress, historyId } from the decoded Gmail notification,
 * or null if malformed.
 */
export function decodePubSubMessage(rawBody) {
  if (!rawBody || !rawBody.message?.data) return null;
  try {
    const decoded = Buffer.from(rawBody.message.data, 'base64').toString('utf-8');
    const payload = JSON.parse(decoded);
    if (!payload.emailAddress || !payload.historyId) return null;
    return {
      emailAddress: String(payload.emailAddress).toLowerCase(),
      historyId: String(payload.historyId),
      messageId: rawBody.message.messageId,
      publishTime: rawBody.message.publishTime,
    };
  } catch (_err) {
    return null;
  }
}

const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_OIDC_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_CERTS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const PUBSUB_CLOCK_SKEW_SECONDS = 60;
let googleCertsCache = { keys: null, expiresAt: 0 };

/** Reset the cached Google signing keys (tests). */
export function resetGoogleCertsCache() {
  googleCertsCache = { keys: null, expiresAt: 0 };
}

async function googleSigningKeys(fetchImpl, now) {
  if (googleCertsCache.keys && googleCertsCache.expiresAt > now) return googleCertsCache.keys;
  const response = await fetchImpl(GOOGLE_OIDC_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`google_certs_unavailable_${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 50) throw new Error('google_certs_invalid');
  const maxAge = /max-age=(\d+)/i.exec(response.headers?.get?.('cache-control') || '');
  const ttlMs = maxAge ? Math.min(Number(maxAge[1]) * 1000, 6 * GOOGLE_CERTS_DEFAULT_TTL_MS) : GOOGLE_CERTS_DEFAULT_TTL_MS;
  googleCertsCache = { keys: body.keys, expiresAt: now + ttlMs };
  return body.keys;
}

/**
 * Verify the Google-signed OIDC JWT that Pub/Sub attaches to push requests.
 *
 * Checks the RS256 signature against Google's published signing keys (cached
 * for the certificate endpoint's max-age), then the issuer, audience, expiry,
 * issued-at, and, when configured, the push subscription's service-account
 * email. Any missing or invalid element returns false; this function never
 * accepts decoded claims without a valid signature.
 *
 * @param {string} authHeader "Bearer <jwt>" from the Authorization header
 * @param {string} expectedAudience audience configured on the push subscription
 * @param {{ expectedEmail?: string | null, fetchImpl?: typeof fetch, now?: number }} [options]
 * @returns {Promise<boolean>} whether the push is authenticated
 */
export async function verifyPubSubAuth(authHeader, expectedAudience, { expectedEmail = null, fetchImpl = fetch, now = Date.now() } = {}) {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ') || !expectedAudience) return false;
  const token = authHeader.slice(7).trim();
  if (!token || token.length > 8192) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) return false;

    const keys = await googleSigningKeys(fetchImpl, now);
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (!jwk) return false;
    const { createPublicKey, verify } = await import('node:crypto');
    const signatureOk = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
    if (!signatureOk) return false;

    const nowSeconds = Math.floor(now / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!GOOGLE_OIDC_ISSUERS.has(claims.iss)) return false;
    if (!audiences.includes(expectedAudience)) return false;
    if (!Number.isFinite(claims.exp) || claims.exp + PUBSUB_CLOCK_SKEW_SECONDS < nowSeconds) return false;
    if (Number.isFinite(claims.iat) && claims.iat - PUBSUB_CLOCK_SKEW_SECONDS > nowSeconds) return false;
    if (expectedEmail) {
      if (String(claims.email || '').toLowerCase() !== String(expectedEmail).toLowerCase()) return false;
      if (claims.email_verified !== true && claims.email_verified !== 'true') return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

export const GMAIL_WATCH_TUNING = {
  WATCH_DURATION_MS,
  RENEW_BEFORE_MS,
  DEFAULT_LABELS,
};
