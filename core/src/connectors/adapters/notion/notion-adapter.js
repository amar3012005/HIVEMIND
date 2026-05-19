/**
 * NotionAdapter
 *
 * Polling-only connector for the Notion API (v2022-06-28).
 * Notion does not expose outbound webhooks, so supportsWebhooks = false.
 *
 * Authentication: Bearer token resolved via BaseConnectorAdapter.getBearer(),
 * which delegates to the injected tokenResolver (Nango or equivalent).
 *
 * fetchBulk  — pages via POST /v1/search (metadata only, no block children)
 * fetchResource — full page metadata + block children up to depth 3
 */

import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BLOCK_DEPTH = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build shared Notion request headers.
 * @param {string} token
 * @returns {Record<string, string>}
 */
function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a fetch with a 20-second timeout, honouring Retry-After on 429.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {import('pino').Logger} logger
 * @returns {Promise<Response>}
 */
async function notionFetch(url, options, logger) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
    const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000;
    logger.warn({ url, waitMs }, 'notion: rate limited, backing off');
    await sleep(waitMs);
    // Single retry after back-off; caller handles further failures.
    return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  return res;
}

/**
 * Extract page title from Notion page properties.
 * Tries every title-type property; falls back to common names.
 *
 * @param {Object} properties
 * @returns {string}
 */
function extractTitle(properties = {}) {
  // 1. Any property whose type is 'title' (official)
  for (const val of Object.values(properties)) {
    if (val?.type === 'title' && Array.isArray(val.title) && val.title.length > 0) {
      return val.title.map(t => t.plain_text ?? '').join('');
    }
  }
  // 2. Fallback: common property names used in Notion templates
  for (const key of ['title', 'Title', 'Name', 'name']) {
    const prop = properties[key];
    if (prop?.title?.length > 0) {
      return prop.title.map(t => t.plain_text ?? '').join('');
    }
  }
  return '';
}

/**
 * Recursively fetch block children and return concatenated plain text.
 *
 * @param {string} blockId
 * @param {string} token
 * @param {import('pino').Logger} logger
 * @param {number} depth - remaining recursion depth
 * @returns {Promise<string>}
 */
async function fetchBlockText(blockId, token, logger, depth) {
  if (depth <= 0) return '';

  const url = `${NOTION_API}/blocks/${blockId}/children?page_size=100`;
  const res = await notionFetch(url, { method: 'GET', headers: notionHeaders(token) }, logger);

  if (!res.ok) {
    logger.warn({ blockId, status: res.status }, 'notion: failed to fetch block children');
    return '';
  }

  const data = await res.json();
  const lines = [];

  for (const block of data.results ?? []) {
    const richTexts = block[block.type]?.rich_text ?? [];
    const text = richTexts.map(rt => rt.plain_text ?? '').join('');
    if (text) lines.push(text);

    if (block.has_children) {
      const childText = await fetchBlockText(block.id, token, logger, depth - 1);
      if (childText) lines.push(childText);
    }
  }

  return lines.join('\n');
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class NotionAdapter extends BaseConnectorAdapter {
  /** Notion has no outbound webhooks. */
  supportsWebhooks = false;

  // ── fetchBulk ─────────────────────────────────────────────────────────────

  /**
   * Fetch a page of Notion pages via POST /v1/search.
   * Body is metadata-only; block children are not fetched here for speed.
   *
   * @param {{ userId: string, orgId: string, cursor: string|null, scope?: string, limit?: number }} params
   * @returns {Promise<{ records: import('../../framework/base-connector-adapter.js').NormalizedRecord[], nextCursor: string|null }>}
   */
  async fetchBulk({ userId, orgId, cursor, scope, limit = 100 }) {
    const token = await this.getBearer({ userId, orgId });

    const body = {
      query: '',
      page_size: limit,
      filter: { property: 'object', value: 'page' },
    };
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(
      `${NOTION_API}/search`,
      { method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body) },
      this.logger,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = Object.assign(new Error(`Notion search ${res.status}: ${text}`), { status: res.status });
      this.logger.error({ userId, orgId, status: res.status }, 'notion: fetchBulk failed');
      throw err;
    }

    const data = await res.json();

    const records = (data.results ?? []).map(raw => this.normalize(raw, 'page'));

    this.logger.debug({ userId, orgId, count: records.length, hasMore: data.has_more }, 'notion: fetchBulk page');

    return { records, nextCursor: data.next_cursor ?? null };
  }

  // ── fetchResource ─────────────────────────────────────────────────────────

  /**
   * Fetch a single Notion page with full block-text body (depth ≤ 3).
   *
   * @param {{ userId: string, orgId: string, resourceId: string, type?: string }} params
   * @returns {Promise<import('../../framework/base-connector-adapter.js').NormalizedRecord>}
   */
  async fetchResource({ userId, orgId, resourceId, type = 'page' }) {
    const token = await this.getBearer({ userId, orgId });

    const res = await notionFetch(
      `${NOTION_API}/pages/${resourceId}`,
      { method: 'GET', headers: notionHeaders(token) },
      this.logger,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = Object.assign(
        new Error(`Notion GET page ${resourceId} → ${res.status}: ${text}`),
        { status: res.status },
      );
      this.logger.error({ userId, orgId, resourceId, status: res.status }, 'notion: fetchResource failed');
      throw err;
    }

    const raw = await res.json();
    const record = this.normalize(raw, type);

    // Enrich with full body text from block children
    const body = await fetchBlockText(resourceId, token, this.logger, MAX_BLOCK_DEPTH);
    record.body = body;

    return record;
  }

  // ── normalize ─────────────────────────────────────────────────────────────

  /**
   * Map a raw Notion page object to a NormalizedRecord.
   * Body is intentionally empty in bulk mode (filled by fetchResource).
   *
   * @param {Object} raw - Raw Notion page object
   * @param {string} type - Resource type ('page')
   * @returns {import('../../framework/base-connector-adapter.js').NormalizedRecord}
   */
  normalize(raw, type) {
    return {
      id: raw.id,
      resource_id: raw.id,
      resource_type: type,
      title: extractTitle(raw.properties),
      body: '',           // populated only by fetchResource
      ts: raw.last_edited_time ?? raw.created_time ?? null,
      refs: {
        notion_id: raw.id,
        url: raw.url,
        parent: raw.parent ?? null,
      },
    };
  }

  /**
   * Convert normalized Notion records into canonical knowledge payloads.
   * @param {import('../../framework/base-connector-adapter.js').NormalizedRecord} record
   * @param {Object} context
   * @returns {Object[]}
   */
  toMemoryPayloads(record, context) {
    const tags = ['notion', 'knowledge'];
    const url = record?.refs?.url || null;
    if (url) tags.push('document');

    return [this.buildMemoryPayload(record, context, {
      content: record?.body || record?.title || '',
      memory_type: 'fact',
      tags,
      source_type: 'page',
      metadata: {
        source_type_normalized: 'knowledge_base',
        notion_url: url,
        notion_parent: record?.refs?.parent || null,
      },
    })];
  }

  // ── Webhook stubs (not_supported) ─────────────────────────────────────────

  /** @override */
  verifyWebhookSignature() {
    throw Object.assign(new Error('notion: webhooks not supported'), { code: 'not_supported' });
  }

  /** @override */
  parseEvent() {
    throw Object.assign(new Error('notion: webhooks not supported'), { code: 'not_supported' });
  }

  /** @override */
  registerWebhook() {
    throw Object.assign(new Error('notion: webhooks not supported'), { code: 'not_supported' });
  }
}

// Self-register
adapterRegistry.register('notion', NotionAdapter);
