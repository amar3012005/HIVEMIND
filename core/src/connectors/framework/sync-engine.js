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
  constructor({ connectorStore, memoryEngine, memoryStore, prisma, trailExecutor, smartIngestRouter }) {
    this.connectorStore = connectorStore;
    this.memoryEngine = memoryEngine;
    this.memoryStore = memoryStore;
    this.prisma = prisma;
    this.trailExecutor = trailExecutor || null;
    this.smartIngestRouter = smartIngestRouter || null;
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
  async runSync({ adapter, userId, orgId, provider, cursor = null, incremental = false, targetScope = null, teamId = null }) {
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

      let existingConnector = null;
      if (this.connectorStore?.getConnector) {
        existingConnector = await this.connectorStore.getConnector(userId, provider);
      }

      if (incremental && cursor == null) {
        cursor = existingConnector?.cursor || null;
      }

      const effectiveTargetScope = targetScope || existingConnector?.target_scope || 'personal';
      // team_id from caller takes precedence; fall back to what is stored on the connector record
      const effectiveTeamId = teamId || existingConnector?.team_id || null;

      const usesResolvedBearer = typeof adapter.getBearer === 'function' && typeof adapter.fetchBulk === 'function';
      let accessToken = null;
      if (!usesResolvedBearer) {
        accessToken = await this.connectorStore.getAccessToken(userId, provider);
        if (!accessToken) {
          await this.connectorStore.updateStatus(userId, provider, {
            status: 'revoked',
            error: 'No valid access token',
          });
          return { ...telemetry, status: 'reauth_required' };
        }
      }

      const context = {
        user_id: userId,
        org_id: orgId,
        target_scope: effectiveTargetScope,
        team_id: effectiveTeamId,
        // Provider-specific metadata captured at OAuth time (Atlassian
        // cloud_id, Salesforce instance_url, Microsoft tenant_id, ...).
        // Adapters that need these fields read them from context.
        provider_metadata: existingConnector?.provider_metadata || {},
      };
      let hasMore = true;
      let currentCursor = cursor;

      while (hasMore) {
        let fetchResult;
        try {
          if (usesResolvedBearer) {
            fetchResult = incremental && currentCursor
              ? await adapter.fetchIncremental({ cursor: currentCursor, context })
              : await adapter.fetchInitial({ cursor: currentCursor, context });
          } else if (incremental && currentCursor) {
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
            let effectiveRecord = record;
            if (
              usesResolvedBearer &&
              typeof adapter.fetchResource === 'function' &&
              (!record?.body || String(record.body).trim() === '') &&
              (record?.resource_id || record?.id)
            ) {
              try {
                effectiveRecord = await adapter.fetchResource({
                  userId,
                  orgId,
                  resourceId: record.resource_id || record.id,
                  type: record.resource_type || undefined,
                });
              } catch (fetchResourceErr) {
                console.warn(`[sync-engine] fetchResource failed for ${provider}: ${fetchResourceErr.message}`);
              }
            }

            // Dedupe check
            // Normalize to memory payloads — pass user's account ref for attribution
            const userAccountRef = existingConnector?.account_ref || existingConnector?.platformUserId || null;
            const normalizedContext = {
              user_id: userId,
              org_id: orgId,
              connector_id: provider,
              user_account_ref: userAccountRef,
              // Pass scope context so adapters can apply ACL filters
              // (e.g. Slack skips private channels in org/team mode).
              target_scope: effectiveTargetScope,
              team_id: effectiveTeamId,
              // Optional adapter context overrides (passed by caller)
              ...(this._normalizeContext || {}),
            };
            const payloads = typeof adapter.toMemoryPayloads === 'function'
              ? adapter.toMemoryPayloads(effectiveRecord, normalizedContext)
              : adapter.normalize(effectiveRecord, normalizedContext);

            // Post-normalize hook: adapters can extract structured side-data
            // (e.g. Gmail extracts contacts into hivemind.contacts table to
            // avoid polluting memory with "Fact: X email is Y@z.com" garbage)
            if (typeof adapter.extractStructured === 'function') {
              try {
                await adapter.extractStructured(effectiveRecord, {
                  user_id: userId,
                  org_id: orgId,
                  prisma: this.prisma,
                  // Slack adapter needs the user-token to download files
                  // via files.info url_private (auth-gated). Other adapters
                  // can ignore.
                  access_token: accessToken,
                  provider,
                });
              } catch (extractErr) {
                console.warn(`[sync-engine] extractStructured failed (non-fatal): ${extractErr.message}`);
              }
            }

            // Ingest each payload — scope routing
            for (const payload of payloads) {
              payload.user_id = userId;
              payload.org_id = orgId;

              // Derive visibility and memory scope from connector's target_scope.
              // - 'organization' → memory visible org-wide; scope=organization
              // - 'team'         → memory visible to team members; scope=team
              // - 'personal'     → private to installer; scope=personal (default)
              if (effectiveTargetScope === 'organization') {
                payload.visibility = 'organization';
                payload.target_scope = 'organization';
              } else if (effectiveTargetScope === 'team') {
                payload.visibility = 'private'; // team-scoped read handled by access_context
                payload.target_scope = 'team';
                payload.primary_team_id = effectiveTeamId;
              } else {
                payload.visibility = 'private';
                payload.target_scope = 'personal';
              }

              // Propagate connector-level project mapping into payload scope.
              // projectMetadata comes from existingConnector.connectorMetadata.project_ids
              // or adapter.enrichContext() if available.
              const connectorProjectIds = Array.isArray(existingConnector?.connectorMetadata?.project_ids)
                ? existingConnector.connectorMetadata.project_ids
                : (Array.isArray(existingConnector?.connectorMetadata?.projectId) ? [existingConnector.connectorMetadata.projectId] : []);
              if (connectorProjectIds.length > 0) {
                payload.project_ids = [...new Set([
                  ...(Array.isArray(payload.project_ids) ? payload.project_ids : []),
                  ...connectorProjectIds,
                ])];
                payload.scope = 'project';
              }
              if (!payload.primary_team_id && existingConnector?.team_id) {
                payload.primary_team_id = existingConnector.team_id;
              }

              const sourceId = payload?.source_metadata?.source_id || adapter.dedupeKey(effectiveRecord);
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
      // P1 canonical contract: route through SmartIngestRouter so background
      // connector polls produce deterministic edges (thread/session/chunk),
      // same as manual UI ingest paths. Safe fallback to raw payload on error.
      let effective = payload;
      if (this.smartIngestRouter) {
        try {
          const routed = await this.smartIngestRouter.route(payload);
          if (Array.isArray(routed) && routed.length > 0) {
            effective = routed[0];
          }
        } catch (routeErr) {
          console.warn('[sync-engine] route failed, using raw payload:', routeErr.message);
        }
      }
      await this.memoryEngine.ingestMemory(effective);
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
          maxSteps: 2,
          budget: { maxTokens: 5000, maxWallClockMs: 15000 },
          initialContext: {
            rawContent: content,
            platform: platform,
            threadMeta: payload.metadata || {},
          },
          routing: {
            strategy: 'force_softmax',
            temperature: 0.3,
            forceWeights: {
              goalAttraction: 1.0,
              affordanceAttraction: 1.0,
              blueprintPrior: 1.0,
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
