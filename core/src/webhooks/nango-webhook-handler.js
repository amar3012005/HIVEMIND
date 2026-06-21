/**
 * Nango Webhook Handler — unified endpoint for ALL Nango-routed providers.
 *
 * Nango fires three event families per connection:
 *   - "auth"     connection created / refreshed / errored
 *   - "sync"     scheduled sync completed (records ready to pull)
 *   - "webhook"  provider-native push event (Gmail push, Drive watch,
 *                Notion page update, etc.) — payload is provider-shaped
 *                under `payload.event` / `payload.data`.
 *
 * On every event we look up the HIVEMIND connection by Nango connectionId,
 * pick the right adapter, and trigger an incremental sync. The adapter's
 * normalize() → smart-router → engine.ingestMemoryTree pipeline does the
 * rest — same code path as scheduled sync, just triggered by push.
 *
 * Signature verification uses NANGO_WEBHOOK_SECRET shared secret (set in
 * Nango dashboard + env var here). HMAC-SHA256 over the raw body.
 *
 * Drop-in to server.js as the handler for POST /api/connectors/nango/webhook.
 */

import crypto from 'crypto';

const NANGO_WEBHOOK_SECRET = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || '';

// Map Nango providerConfigKey → adapter module path. Mirrors server.js
// adapterModules but resolves at runtime here so this file stays
// self-contained.
const PROVIDER_ADAPTERS = {
  'google-mail': './connectors/providers/gmail/adapter.js',
  gmail: './connectors/providers/gmail/adapter.js',
  'google-docs': './connectors/providers/gdocs/adapter.js',
  gdocs: './connectors/providers/gdocs/adapter.js',
  'google-gemini': './connectors/providers/gemini/adapter.js',
  gemini: './connectors/providers/gemini/adapter.js',
  slack: './connectors/providers/slack/adapter.js',
  'slack-mcp': './connectors/providers/slack/adapter.js',
  notion: './connectors/providers/notion/adapter.js',
  'notion-mcp': './connectors/providers/notion/adapter.js',
  github: './connectors/providers/github/adapter.js',
  linear: './connectors/providers/linear/adapter.js',
  'personio-v2': './connectors/providers/personio-v2/adapter.js',
  personio: './connectors/providers/personio-v2/adapter.js',
  atlassian: './connectors/providers/atlassian/adapter.js',
  jira: './connectors/providers/atlassian/adapter.js',
  confluence: './connectors/providers/atlassian/adapter.js',
  'google-drive': './connectors/providers/gdrive/adapter.js',
  gdrive: './connectors/providers/gdrive/adapter.js',
  microsoft: './connectors/providers/microsoft/adapter.js',
  'microsoft-365': './connectors/providers/microsoft/adapter.js',
  microsoft365: './connectors/providers/microsoft/adapter.js',
  salesforce: './connectors/providers/salesforce/adapter.js',
  'salesforce-sandbox': './connectors/providers/salesforce/adapter.js',
};

function verifyNangoSignature(rawBody, signatureHeader) {
  if (!NANGO_WEBHOOK_SECRET) {
    // No secret configured — fail-close: reject all webhooks.
    return false;
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = crypto
    .createHmac('sha256', NANGO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  // Constant-time compare. Nango header is `x-nango-signature` plain hex.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureHeader, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Resolve HIVEMIND user + org by Nango connectionId.
 * connectionId is set per-user during OAuth (we use `user_<userId>` format
 * or just the userId itself — both supported).
 */
async function resolveOwner(prisma, connectionId, providerConfigKey) {
  if (!connectionId || !prisma?.nangoConnection) return null;
  // Strip optional 'user_' prefix.
  const userIdGuess = String(connectionId).replace(/^user_/, '');
  // Lookup by exact connectionId column when stored verbatim.
  let row = await prisma.nangoConnection.findFirst({
    where: { connectionId: String(connectionId), providerKey: providerConfigKey },
    select: { userId: true, orgId: true, providerKey: true },
  }).catch(() => null);
  if (!row) {
    row = await prisma.nangoConnection.findFirst({
      where: { userId: userIdGuess, providerKey: providerConfigKey },
      select: { userId: true, orgId: true, providerKey: true },
    }).catch(() => null);
  }
  return row;
}

/**
 * Trigger an incremental sync for the affected connection.
 * Reuses the same SyncEngine path as scheduled sync so all canonical
 * pipeline guarantees (entity/temporal/operator) apply.
 */
async function triggerIncrementalSync({ provider, userId, orgId, deps }) {
  const adapterPath = PROVIDER_ADAPTERS[provider];
  if (!adapterPath) {
    throw new Error(`Unknown Nango provider: ${provider}`);
  }
  const mod = await import(adapterPath);
  const AdapterClass = Object.values(mod).find(v => typeof v === 'function') || mod.default;
  if (!AdapterClass) throw new Error(`Adapter has no exported class: ${provider}`);
  const adapter = new AdapterClass();

  const { ConnectorStore } = await import('../connectors/framework/connector-store.js');
  const { SyncEngine } = await import('../connectors/framework/sync-engine.js');
  const connectorStore = new ConnectorStore(deps.prisma);
  const engine = new SyncEngine({
    connectorStore,
    memoryStore: deps.persistentMemoryStore,
    memoryEngine: deps.persistentMemoryEngine,
    smartIngestRouter: deps.smartIngestRouter,
  });
  const result = await engine.runSync({
    adapter,
    userId,
    orgId,
    provider,
    mode: 'incremental',
  });
  return result;
}

/**
 * Entry point — invoked by server.js for POST /api/connectors/nango/webhook.
 *
 * @param {Object} params
 * @param {string} params.rawBody  raw request body string (for signature)
 * @param {Object} params.body     parsed JSON body
 * @param {Object} params.headers
 * @param {Object} params.deps     { prisma, persistentMemoryStore, persistentMemoryEngine, smartIngestRouter }
 * @returns {Promise<{status:'ok'|'skipped'|'error', reason?:string, syncResult?:any}>}
 */
export async function handleNangoWebhook({ rawBody, body, headers, deps }) {
  const sig = headers['x-nango-signature'] || headers['X-Nango-Signature'] || '';
  if (!verifyNangoSignature(rawBody, sig)) {
    return { status: 'error', reason: 'invalid-signature' };
  }

  const eventType = body.type || body.eventType || 'unknown';
  const provider = body.providerConfigKey || body.provider || null;
  const connectionId = body.connectionId || body.connection_id || null;

  console.log(`[nango-webhook] event=${eventType} provider=${provider} connection=${connectionId}`);

  if (!provider) {
    return { status: 'skipped', reason: 'no-provider' };
  }

  // Auth events: Nango notifying us a connection was just created /
  // refreshed / errored. Kick off the first sync so the user sees data
  // immediately instead of waiting for the next scheduled tick.
  if (eventType === 'auth' || eventType === 'auth.created' || eventType === 'connection.created') {
    const owner = await resolveOwner(deps.prisma, connectionId, provider);
    if (!owner) {
      return { status: 'skipped', reason: 'no-owner' };
    }
    try {
      const syncResult = await triggerIncrementalSync({
        provider, userId: owner.userId, orgId: owner.orgId, deps,
      });
      return { status: 'ok', syncResult };
    } catch (err) {
      console.warn(`[nango-webhook] auth sync failed: ${err.message}`);
      return { status: 'error', reason: err.message };
    }
  }

  // Sync events: Nango ran a scheduled sync. Records are already in the
  // Nango cache; we pull them via fetchIncremental on next tick OR pull
  // immediately to avoid latency. Pull immediately = lower delay,
  // duplicate-protected by SyncEngine's dedupeKey.
  if (eventType === 'sync' || eventType === 'sync.completed' || eventType === 'sync.success') {
    const owner = await resolveOwner(deps.prisma, connectionId, provider);
    if (!owner) {
      return { status: 'skipped', reason: 'no-owner' };
    }
    try {
      const syncResult = await triggerIncrementalSync({
        provider, userId: owner.userId, orgId: owner.orgId, deps,
      });
      return { status: 'ok', syncResult };
    } catch (err) {
      console.warn(`[nango-webhook] scheduled sync ingest failed: ${err.message}`);
      return { status: 'error', reason: err.message };
    }
  }

  // Webhook events: provider-native push (Gmail history change, Drive
  // file update, Notion page edit). Same response — incremental sync
  // catches the change.
  if (eventType === 'webhook' || eventType === 'forward.webhook' || eventType === 'change') {
    const owner = await resolveOwner(deps.prisma, connectionId, provider);
    if (!owner) {
      return { status: 'skipped', reason: 'no-owner' };
    }
    try {
      const syncResult = await triggerIncrementalSync({
        provider, userId: owner.userId, orgId: owner.orgId, deps,
      });
      return { status: 'ok', syncResult };
    } catch (err) {
      console.warn(`[nango-webhook] provider push ingest failed: ${err.message}`);
      return { status: 'error', reason: err.message };
    }
  }

  // Unknown event type — ack so Nango doesn't retry, but log.
  return { status: 'skipped', reason: `unknown-event:${eventType}` };
}
