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
}
