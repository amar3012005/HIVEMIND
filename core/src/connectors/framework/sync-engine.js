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
  constructor({ connectorStore, memoryEngine, memoryStore, prisma, trailExecutor, smartIngestRouter, externalRefStore, entityResolver, qdrantClient }) {
    this.connectorStore = connectorStore;
    this.memoryEngine = memoryEngine;
    this.memoryStore = memoryStore;
    this.prisma = prisma;
    this.trailExecutor = trailExecutor || null;
    this.smartIngestRouter = smartIngestRouter || null;
    this.externalRefStore = externalRefStore || null;
    this.entityResolver = entityResolver || null;
    // Optional Qdrant client used to embed + upsert sync-ingested memories
    // into the vector store. Without this, connector memories live in
    // Postgres only and never surface via vector recall — they show up only
    // when the lexical FTS path happens to match the query (poor recall for
    // exact-name lookups like "Vinil Audit AI" against rich synthesis rows).
    this.qdrantClient = qdrantClient || null;
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
        // Persisted sync filters (date_range, folders, exclude_categories,
        // block_senders, max_emails). The adapter reads context.config to
        // build its provider query — WITHOUT this, scheduled auto-syncs ran
        // the firehose while manual syncs honored the user's noise filters.
        // Now auto-sync === manual sync.
        config: existingConnector?.connectorMetadata?.sync_config
          || existingConnector?.connector_metadata?.sync_config
          || {},
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
      // Source-id idempotency gate: connector re-syncs (cursor rewind, parallel
      // worker, manual re-run) used to write a NEW memory per thread every
      // time → 4 rows per gmail thread by the time the user noticed. Skip the
      // ingest entirely when the same (user_id, source_platform, source_id)
      // already has an active memory row. Caller's `force_save=true` opts in
      // to the legacy create-anyway behavior; manual UI / chat ingest doesn't
      // hit this path so it's unaffected.
      const sourcePlatform = payload?.source_metadata?.source_platform || payload?.source_platform;
      const sourceId = payload?.source_metadata?.source_id || payload?.source_id;
      if (!payload?.force_save && this.prisma && userId && sourcePlatform && sourceId) {
        try {
          const existing = await this.prisma.sourceMetadata.findFirst({
            where: {
              sourcePlatform,
              sourceId,
              memory: { userId, deletedAt: null },
            },
            select: { memoryId: true },
          });
          if (existing?.memoryId) {
            return { memoryId: existing.memoryId, skipped: 'duplicate_source_id' };
          }
        } catch (lookupErr) {
          // Lookup is opportunistic — never block ingest on a failed dedup probe.
          console.warn('[sync-engine] source-id dedup probe failed (non-fatal):', lookupErr.message);
        }
      }

      // P1 canonical contract: route through SmartIngestRouter so background
      // connector polls produce deterministic edges (thread/session/chunk),
      // same as manual UI ingest paths. Safe fallback to raw payload on error.
      let effective = payload;
      let ingestResult = null;
      if (this.smartIngestRouter) {
        try {
          const routed = await this.smartIngestRouter.route(payload);
          // Tree-shape: gdocs/gemini/slack-thread/gmail-thread emit
          //   { parent, children } — engine.ingestMemoryTree handles it.
          if (routed && !Array.isArray(routed) && routed.parent) {
            const treeRes = await this.memoryEngine.ingestMemoryTree(routed);
            await this._postIngestHooks(routed.parent, { memoryId: treeRes?.parentId }, userId);
            return;
          }
          if (Array.isArray(routed) && routed.length > 0) {
            effective = routed[0];
          }
        } catch (routeErr) {
          console.warn('[sync-engine] route failed, using raw payload:', routeErr.message);
        }
      }
      ingestResult = await this.memoryEngine.ingestMemory(effective);
      await this._postIngestHooks(effective, ingestResult, userId);
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
   * Post-ingest hooks: write external_ref for re-sync idempotency, run
   * entity-resolver for canonical-entity linking, enqueue enrichment.
   *
   * Fires for every successful ingestion. Errors are logged and never
   * throw — these hooks are best-effort and must not block the sync.
   */
  async _postIngestHooks(payload, ingestResult, userId) {
    const memoryId = ingestResult?.memoryId;
    if (!memoryId) return;
    const orgId = payload.org_id;
    const meta = payload.metadata || {};
    const sm = payload.source_metadata || {};

    // Vector embedding + Qdrant upsert. Without this, connector-synced
    // memories never enter the vector store and recall falls back to FTS
    // only. Gmail/Slack adapters call storeMemory explicitly today; we
    // centralize the hook here so every connector benefits (salesforce,
    // notion, github, linear, future) without per-adapter plumbing.
    //
    // Embed an augmented key (title + entity tags + content) instead of
    // raw content alone. Connector records often have terse, schema-shaped
    // content ("Name: X\nIndustry: Y") where the natural-language entity
    // signal lives in the title and entity:* tags — embedding raw content
    // alone yields poor similarity for direct-name queries.
    if (this.qdrantClient && this.memoryStore?.getMemory) {
      try {
        const fullMemory = await this.memoryStore.getMemory(memoryId);
        if (fullMemory) {
          // Noise-tier embed skip: low-signal connector mail (promotions,
          // updates, social, forums, notifications) is recallable by facet /
          // FTS tags but adds no semantic value — and recall demotes it to
          // ~0.15–0.40 anyway (persisted-retrieval). Skip the embedding to save
          // cost + keep the vector index clean. The user's own outbound
          // (sent-by-user / first-person) ALWAYS embeds — it is ground truth.
          const NOISE_EMBED_TAGS = new Set([
            'label:updates', 'label:promotions', 'label:social', 'label:forums',
            'updates', 'promotions', 'social', 'forums',
            'newsletter', 'notification', 'automated', 'no-reply',
          ]);
          const memTags = Array.isArray(fullMemory.tags) ? fullMemory.tags : [];
          const isNoiseTier = memTags.some((t) => NOISE_EMBED_TAGS.has(t));
          const isGroundTruth = memTags.includes('sent-by-user') || memTags.includes('first-person');
          if (isNoiseTier && !isGroundTruth) {
            // PG row + external_ref still written below — only the vector is skipped.
            console.log(`[sync-engine] skip embed (noise-tier) ${memoryId.slice(0, 8)} — PG/FTS only`);
          } else {
            const collectionName = 'HIVEMIND_PERSONAL';
            const entityNames = (fullMemory.tags || [])
              .filter((t) => typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('person:')))
              .map((t) => t.replace(/^(entity|person):/, '').replace(/_/g, ' '));
            const titleLine = fullMemory.title || '';
            const augmented = [
              titleLine,
              entityNames.join(', '),
              fullMemory.content || '',
            ].filter(Boolean).join('\n\n').slice(0, 8000);
            let vector = null;
            try {
              vector = await this.qdrantClient.generateEmbedding(augmented);
            } catch (embedFailedErr) {
              console.warn(`[sync-engine] augmented-embed failed, falling back: ${embedFailedErr.message}`);
            }
            if (vector) {
              await this.qdrantClient.storeMemory(fullMemory, { collectionName, vector });
            } else {
              await this.qdrantClient.storeMemory(fullMemory, { collectionName });
            }
          }
        }
      } catch (embedErr) {
        console.warn(`[sync-engine] qdrant store failed for ${memoryId.slice(0,8)}: ${embedErr.message}`);
      }
    }

    // External ref — uniformly use source_metadata.source_id when present.
    const system = (sm.source_platform || sm.source_type || '').toString().toLowerCase();
    const externalId = sm.source_id || meta.salesforce_id || meta.external_id || null;
    const objectType = meta.salesforce_object_type || sm.source_type || system;
    if (this.externalRefStore && system && externalId && objectType && orgId) {
      try {
        await this.externalRefStore.create({
          memoryId,
          system,
          objectType,
          externalId: String(externalId),
          externalUrl: sm.source_url || null,
          organizationId: orgId,
          userId,
          metadata: { last_modified: meta.salesforce_last_modified || null },
        });
      } catch (err) {
        console.warn(`[sync-engine] external_ref write failed for ${memoryId.slice(0,8)}: ${err.message}`);
      }
    }

    // Entity resolution — only for SF objects we can canonicalize cleanly.
    if (this.entityResolver && orgId && meta.salesforce_object_type) {
      try {
        const candidates = this._extractEntityCandidates(payload);
        if (candidates.length > 0) {
          await this.entityResolver.resolveAndLink({
            memoryId,
            candidates,
            organizationId: orgId,
            role: 'subject',
            userId,
          });
        }
      } catch (err) {
        console.warn(`[sync-engine] entity resolve failed for ${memoryId.slice(0,8)}: ${err.message}`);
      }
    }
  }

  _extractEntityCandidates(payload) {
    const meta = payload.metadata || {};
    const objType = meta.salesforce_object_type;
    const fields = meta.salesforce_business_fields || {};
    const sfId = meta.salesforce_id;
    const candidates = [];
    if (objType === 'Account') {
      candidates.push({
        name: fields.Name || payload.title,
        kind: meta.salesforce_is_person_account ? 'person' : 'company',
        externalRefs: { salesforce: sfId },
        emailDomain: this._domainFromWebsite(fields.Website),
        metadata: { industry: fields.Industry || null, country: fields.BillingCountry || null },
      });
    } else if (objType === 'Contact') {
      candidates.push({
        name: fields.Name || `${fields.FirstName || ''} ${fields.LastName || ''}`.trim() || payload.title,
        kind: 'person',
        email: fields.Email || null,
        emailDomain: meta.salesforce_email_domain || null,
        externalRefs: { salesforce: sfId },
        metadata: { title: fields.Title || null, account: fields.AccountName || null },
      });
      if (meta.salesforce_account_id && meta.salesforce_account_name) {
        candidates.push({
          name: meta.salesforce_account_name,
          kind: 'company',
          externalRefs: { salesforce: meta.salesforce_account_id },
        });
      }
    } else if (objType === 'Opportunity' && meta.salesforce_account_name) {
      candidates.push({
        name: meta.salesforce_account_name,
        kind: 'company',
        externalRefs: { salesforce: meta.salesforce_account_id || null },
      });
    }
    return candidates.filter((c) => c.name || c.email);
  }

  _domainFromWebsite(website) {
    if (!website || typeof website !== 'string') return null;
    try {
      const url = website.match(/^https?:\/\//) ? website : `https://${website}`;
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return host || null;
    } catch { return null; }
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
