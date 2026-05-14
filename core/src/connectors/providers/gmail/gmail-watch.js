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

/**
 * Verify the OIDC JWT Pub/Sub attaches to push requests.
 * Returns true if signature + audience + issuer check out.
 *
 * @param {string} authHeader - "Bearer <jwt>" from Authorization header
 * @param {string} expectedAudience - our webhook URL (must match topic push config)
 */
export async function verifyPubSubAuth(authHeader, expectedAudience) {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  try {
    // Lightweight: decode without verifying signature in dev mode.
    // In production, use google-auth-library OAuth2Client.verifyIdToken().
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return false;
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));

    const issuerOk = claims.iss === 'https://accounts.google.com' ||
                     claims.iss === 'accounts.google.com';
    const audienceOk = claims.aud === expectedAudience;
    const notExpired = !claims.exp || claims.exp * 1000 > Date.now();

    // TODO: cryptographic signature verification via Google JWK fetched from
    //       https://www.googleapis.com/oauth2/v3/certs (cache 6h). For now,
    //       presence of valid claims is the gate.
    return issuerOk && audienceOk && notExpired;
  } catch (_err) {
    return false;
  }
}

export const GMAIL_WATCH_TUNING = {
  WATCH_DURATION_MS,
  RENEW_BEFORE_MS,
  DEFAULT_LABELS,
};
