/**
 * Provider Adapter Contract
 *
 * Every connector provider (Gmail, Slack, GitHub, etc.) implements this interface.
 * The sync engine calls these methods — providers just return data.
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} providerId - e.g. 'gmail', 'slack', 'github'
 * @property {string[]} requiredScopes - OAuth scopes needed
 * @property {Function} fetchInitial - Full backfill from beginning or cursor
 * @property {Function} fetchIncremental - Delta sync from last cursor
 * @property {Function} normalize - Transform provider record to memory payload(s)
 * @property {Function} dedupeKey - Generate idempotency key for a record
 */

/**
 * Base class for provider adapters. Extend this to add a new provider.
 */
export class BaseProviderAdapter {
  constructor({ providerId, requiredScopes = [], defaultTags = [] }) {
    this.providerId = providerId;
    this.requiredScopes = requiredScopes;
    this.defaultTags = defaultTags;
  }

  /**
   * Fetch all records from the beginning (or from a cursor for resume).
   * @param {Object} params
   * @param {string} params.accessToken - OAuth access token
   * @param {string|null} params.cursor - Resume cursor (null for fresh start)
   * @param {Object} params.context - { user_id, org_id }
   * @returns {Promise<{ records: any[], nextCursor: string|null, hasMore: boolean }>}
   */
  async fetchInitial({ accessToken, cursor, context }) {
    throw new Error(`${this.providerId}: fetchInitial() not implemented`);
  }

  /**
   * Fetch only new/changed records since last cursor.
   * @param {Object} params
   * @param {string} params.accessToken - OAuth access token
   * @param {string} params.cursor - Last known cursor
   * @param {Object} params.context - { user_id, org_id }
   * @returns {Promise<{ records: any[], nextCursor: string|null, hasMore: boolean }>}
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    throw new Error(`${this.providerId}: fetchIncremental() not implemented`);
  }

  /**
   * Transform a raw provider record into one or more memory ingestion payloads.
   * @param {any} record - Raw record from fetchInitial/fetchIncremental
   * @param {Object} context - { user_id, org_id, connector_id }
   * @returns {Object[]} Array of memory payloads ready for ingestMemory()
   */
  normalize(record, context) {
    throw new Error(`${this.providerId}: normalize() not implemented`);
  }

  /**
   * Generate a unique deduplication key for a record.
   * Used to prevent duplicate memories on retry/replay.
   * @param {any} record - Raw provider record
   * @returns {string} Deterministic dedupe key
   */
  dedupeKey(record) {
    throw new Error(`${this.providerId}: dedupeKey() not implemented`);
  }
}
