/**
 * Sync Engine
 *
 * Orchestrates fetch → normalize → dedupe → ingest for any provider adapter.
 * Handles checkpoint cursor persistence, retry/backoff, dead-letter, and telemetry.
 */

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

export class SyncEngine {
  /**
   * @param {Object} deps
   * @param {import('./connector-store.js').ConnectorStore} deps.connectorStore
   * @param {import('../../memory/graph-engine.js').MemoryGraphEngine} deps.memoryEngine
   * @param {import('../../memory/prisma-graph-store.js').PrismaGraphStore} deps.memoryStore
   */
  constructor({ connectorStore, memoryEngine, memoryStore, prisma, trailExecutor }) {
    this.connectorStore = connectorStore;
    this.memoryEngine = memoryEngine;
    this.memoryStore = memoryStore;
    this.prisma = prisma;
    this.trailExecutor = trailExecutor || null;
    this._dedupeCache = new Map(); // in-memory for now; can be Redis later
  }

  /**
   * Run a full sync for a connector.
   * @param {Object} params
   * @param {import('./provider-adapter.js').BaseProviderAdapter} params.adapter
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.provider
   * @param {string|null} params.cursor - Resume cursor
   * @param {boolean} params.incremental - true for delta sync
   * @returns {Promise<SyncResult>}
   */
  async runSync({ adapter, userId, orgId, provider, cursor = null, incremental = false }) {
    const telemetry = {
      provider,
      user_id: userId,
      started_at: new Date().toISOString(),
      processed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      final_cursor: cursor,
    };

    try {
      // Mark as syncing
      await this.connectorStore.updateStatus(userId, provider, { status: 'syncing' });

      if (incremental && cursor == null && this.connectorStore?.getConnector) {
        const existingConnector = await this.connectorStore.getConnector(userId, provider);
        cursor = existingConnector?.cursor || null;
      }

      // Get access token
      let accessToken = await this.connectorStore.getAccessToken(userId, provider);
      if (!accessToken) {
        await this.connectorStore.updateStatus(userId, provider, {
          status: 'revoked',
          error: 'No valid access token',
        });
        return { ...telemetry, status: 'reauth_required' };
      }

      const context = { user_id: userId, org_id: orgId };
      let hasMore = true;
      let currentCursor = cursor;

      while (hasMore) {
        let fetchResult;
        try {
          if (incremental && currentCursor) {
            fetchResult = await adapter.fetchIncremental({ accessToken, cursor: currentCursor, context });
          } else {
            fetchResult = await adapter.fetchInitial({ accessToken, cursor: currentCursor, context });
          }
        } catch (fetchError) {
          // Check if it's a token expiry — attempt refresh
          if (fetchError.status === 401 || fetchError.response?.status === 401) {
            const refreshed = await this._refreshToken(userId, provider);
            if (refreshed) {
              accessToken = refreshed;
              continue; // Retry with new token
            }
            await this.connectorStore.updateStatus(userId, provider, {
              status: 'revoked',
              error: 'Token refresh failed',
            });
            return { ...telemetry, status: 'reauth_required' };
          }
          throw fetchError;
        }

        const { records, nextCursor, hasMore: more } = fetchResult;
        hasMore = more && records.length > 0;
        currentCursor = nextCursor;
        telemetry.final_cursor = currentCursor;

        // Process records
        for (const record of records) {
          telemetry.processed++;

          try {
            // Dedupe check
            // Normalize to memory payloads
            const payloads = adapter.normalize(record, {
              user_id: userId,
              org_id: orgId,
              connector_id: provider,
            });

            // Ingest each payload
            for (const payload of payloads) {
              const sourceId = payload?.source_metadata?.source_id || adapter.dedupeKey(record);
              if (await this._isDuplicate(sourceId, userId, provider)) {
                telemetry.skipped++;
                continue;
              }

              await this._ingestWithRetry(payload, sourceId, userId);
              telemetry.imported++;
              this._markSeen(sourceId, userId, provider);

              // Trigger decision capture asynchronously (non-blocking)
              this._triggerDecisionCapture(payload, provider, userId, orgId);
            }
          } catch (recordError) {
            telemetry.failed++;
            telemetry.errors.push({
              dedupe_key: adapter.dedupeKey(record),
              error: recordError.message,
            });

            // Don't fail the whole sync for one bad record
            if (telemetry.failed > 50) {
              telemetry.errors.push({ error: 'Too many failures, aborting batch' });
              hasMore = false;
              break;
            }
          }
        }
      }

      // Mark as connected (idle)
      await this.connectorStore.updateStatus(userId, provider, {
        status: 'idle',
        cursor: telemetry.final_cursor,
        syncStats: telemetry,
      });

      telemetry.completed_at = new Date().toISOString();
      telemetry.status = 'completed';
      return telemetry;
    } catch (error) {
      await this.connectorStore.updateStatus(userId, provider, {
        status: 'error',
        error: error.message,
      });

      telemetry.completed_at = new Date().toISOString();
      telemetry.status = 'failed';
      telemetry.errors.push({ error: error.message });
      return telemetry;
    }
  }

  async _ingestWithRetry(payload, dedupeKey, userId, attempt = 0) {
    try {
      await this.memoryEngine.ingestMemory(payload);
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        return this._ingestWithRetry(payload, dedupeKey, userId, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Trigger decision capture for a newly ingested connector payload.
   * Non-blocking — fires and forgets. Errors are logged, never thrown.
   */
  _triggerDecisionCapture(payload, provider, userId, orgId) {
    if (!this.trailExecutor) return;

    const content = payload.content;
    if (!content || content.length < 20) return; // too short to be a decision

    const platform = payload.source_metadata?.source_type || provider;
    const agentId = `connector_${platform}`;

    setImmediate(async () => {
      try {
        await this.trailExecutor.execute('capture_decision', agentId, {
          maxSteps: 4,
          budget: { maxTokens: 5000, maxWallClockMs: 15000 },
          routing: {
            strategy: 'force_softmax',
            temperature: 0.5,
            forceWeights: {
              goalAttraction: 1.0,
              affordanceAttraction: 1.0,
              blueprintPrior: 0.3,
              conflictRepulsion: 1.0,
              congestionRepulsion: 1.0,
              costRepulsion: 1.0,
            },
          },
        });
      } catch (err) {
        // Non-fatal — decision capture should never block sync
        console.warn(`[sync-engine] Decision capture failed for ${platform}:${userId}:`, err.message);
      }
    });
  }

  async _isDuplicate(dedupeKey, userId, provider) {
    const cacheKey = `${userId}:${provider}:${dedupeKey}`;
    if (this._dedupeCache.has(cacheKey)) return true;

    // Check if a memory with this source_id already exists
    try {
      const existing = await this.prisma?.sourceMetadata?.findFirst({
        where: {
          sourceId: dedupeKey,
          sourcePlatform: provider,
        },
      });
      if (existing) {
        this._dedupeCache.set(cacheKey, true);
        return true;
      }
    } catch {
      // If Prisma query fails, skip dedupe check
    }

    return false;
  }

  _markSeen(dedupeKey, userId, provider) {
    const cacheKey = `${userId}:${provider}:${dedupeKey}`;
    this._dedupeCache.set(cacheKey, true);

    // Evict old entries if cache grows too large
    if (this._dedupeCache.size > 50000) {
      const entries = [...this._dedupeCache.keys()];
      for (let i = 0; i < 10000; i++) {
        this._dedupeCache.delete(entries[i]);
      }
    }
  }

  async _refreshToken(userId, provider) {
    const refreshToken = await this.connectorStore.getRefreshToken(userId, provider);
    if (!refreshToken) return null;

    try {
      // Import the provider's OAuth config
      const { getOAuthConfig } = await import(`../providers/${provider}/oauth.js`);
      const config = getOAuthConfig();

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) return null;

      const data = await response.json();
      await this.connectorStore.updateTokens(userId, provider, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        tokenExpiresAt: data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : null,
      });

      return data.access_token;
    } catch {
      return null;
    }
  }
}
