/**
 * BaseConnectorAdapter
 *
 * Second-generation base class for provider adapters that need:
 *  - Bearer token resolution via an injected tokenResolver (Nango or custom)
 *  - A structured logger
 *  - Webhook / polling discrimination
 *
 * Instantiated exclusively through AdapterRegistry.instantiate(providerKey, ctx).
 *
 * @typedef {{ userId: string, orgId: string }} BearerParams
 * @typedef {{ id: string, title: string, body: string, ts: string, refs: Object }} NormalizedRecord
 */

export class BaseConnectorAdapter {
  /**
   * @param {{ providerKey: string, tokenResolver: function(BearerParams): Promise<string>, prisma: object, logger: object }} ctx
   */
  constructor(ctx) {
    this.providerKey = ctx.providerKey;
    this.prisma = ctx.prisma;
    this.logger = ctx.logger;
    this._tokenResolver = ctx.tokenResolver;

    /**
     * Set to false on adapters that use polling only.
     * @type {boolean}
     */
    this.supportsWebhooks = false;
  }

  // ── Token ────────────────────────────────────────────────────────────────

  /**
   * Resolve a bearer token for the given user/org pair.
   * Delegates to the injected tokenResolver (typically nango-service).
   *
   * @param {BearerParams} params
   * @returns {Promise<string>}
   */
  async getBearer({ userId, orgId }) {
    if (typeof this._tokenResolver !== 'function') {
      throw new Error(`${this.providerKey}: tokenResolver not injected`);
    }
    return this._tokenResolver({ userId, orgId, providerKey: this.providerKey });
  }

  // ── Bulk / Resource ──────────────────────────────────────────────────────

  /**
   * Fetch a page of records for polling sync.
   * @param {{ userId: string, orgId: string, cursor: string|null, scope?: string, limit?: number }} params
   * @returns {Promise<{ records: NormalizedRecord[], nextCursor: string|null }>}
   */
  async fetchBulk(params) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.providerKey}: fetchBulk() not implemented`);
  }

  /**
   * Legacy SyncEngine compatibility wrapper.
   * Second-generation adapters expose fetchBulk(); the older engine expects
   * fetchInitial/fetchIncremental plus a hasMore flag.
   *
   * @param {{ cursor: string|null, context: Object }} params
   * @returns {Promise<{ records: NormalizedRecord[], nextCursor: string|null, hasMore: boolean }>}
   */
  async fetchInitial({ cursor = null, context = {} }) {
    const result = await this.fetchBulk({
      userId: context.user_id,
      orgId: context.org_id,
      cursor,
      scope: {
        targetScope: context.target_scope,
        teamId: context.team_id,
        providerMetadata: context.provider_metadata || {},
      },
      limit: context.limit,
    });

    return {
      records: result?.records || [],
      nextCursor: result?.nextCursor || null,
      hasMore: Boolean(result?.nextCursor),
    };
  }

  /** @inheritdoc */
  async fetchIncremental(params) {
    return this.fetchInitial(params);
  }

  /**
   * Fetch a single resource by ID.
   * @param {{ userId: string, orgId: string, resourceId: string, type?: string }} params
   * @returns {Promise<NormalizedRecord>}
   */
  async fetchResource(params) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.providerKey}: fetchResource() not implemented`);
  }

  // ── Webhook stubs ────────────────────────────────────────────────────────

  /** @throws {Error} always — webhook not supported */
  verifyWebhookSignature() {
    throw Object.assign(new Error(`${this.providerKey}: webhooks not supported`), { code: 'not_supported' });
  }

  /** @throws {Error} always — webhook not supported */
  parseEvent() {
    throw Object.assign(new Error(`${this.providerKey}: webhooks not supported`), { code: 'not_supported' });
  }

  /** @throws {Error} always — webhook not supported */
  registerWebhook() {
    throw Object.assign(new Error(`${this.providerKey}: webhooks not supported`), { code: 'not_supported' });
  }

  // ── Normalize helper ─────────────────────────────────────────────────────

  /**
   * Build a NormalizedRecord shell. Subclasses call this then fill in fields.
   *
   * @param {Object} raw - Raw API response object
   * @param {string} type - e.g. 'page', 'issue', 'message'
   * @returns {NormalizedRecord}
   */
  normalize(raw, type) { // eslint-disable-line no-unused-vars
    return { id: null, title: '', body: '', ts: null, refs: {} };
  }

  /**
   * Default dedupe key for normalized records.
   * @param {NormalizedRecord} record
   * @returns {string}
   */
  dedupeKey(record) {
    return String(
      record?.resource_id
      || record?.id
      || record?.refs?.url
      || `${this.providerKey}:${record?.ts || 'unknown'}`
    );
  }

  /**
   * Shared helper for converting a normalized record into the canonical
   * memory-ingest payload shape expected by SmartIngestRouter + graph engine.
   *
   * @param {NormalizedRecord} record
   * @param {{ user_id: string, org_id: string, user_account_ref?: string }} context
   * @param {Object} overrides
   * @returns {Object}
   */
  buildMemoryPayload(record, context, overrides = {}) {
    const sourceId = this.dedupeKey(record);
    const metadata = {
      source_platform: this.providerKey,
      resource_type: record?.resource_type || null,
      created_at: record?.ts || null,
      ...(record?.refs || {}),
      ...(overrides.metadata || {}),
    };

    return {
      title: overrides.title ?? record?.title ?? null,
      content: overrides.content ?? record?.body ?? record?.title ?? '',
      memory_type: overrides.memory_type ?? 'fact',
      tags: overrides.tags ?? [this.providerKey],
      source_metadata: {
        source_platform: this.providerKey,
        source_type: overrides.source_type ?? record?.resource_type ?? 'record',
        source_id: sourceId,
        user_account_ref: context?.user_account_ref || null,
        ...(record?.refs || {}),
        ...(overrides.source_metadata || {}),
      },
      metadata,
      user_id: context?.user_id,
      org_id: context?.org_id,
      ...(overrides.extra || {}),
    };
  }

  /**
   * Convert a normalized record into one or more canonical memory payloads.
   * Subclasses can override for provider-specific shaping.
   *
   * @param {NormalizedRecord} record
   * @param {Object} context
   * @returns {Object[]}
   */
  toMemoryPayloads(record, context) {
    return [this.buildMemoryPayload(record, context)];
  }
}
