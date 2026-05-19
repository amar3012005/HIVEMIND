/**
 * ConfluenceAdapter — Atlassian Cloud Confluence REST API for pages + comments.
 * Webhooks: same HMAC-SHA256 X-Hub-Signature as Jira.
 */

import crypto from 'node:crypto';
import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const REQUEST_TIMEOUT_MS = 25000;
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

async function getCloudId(token) {
  const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Confluence accessible-resources ${res.status}`);
  const list = await res.json();
  const cloud = Array.isArray(list) ? list.find(r => r.scopes?.some(s => s.includes('confluence'))) || list[0] : null;
  if (!cloud) throw new Error('Confluence: no accessible Confluence cloud');
  return cloud.id;
}

async function confGet(token, cloudId, path, params = {}) {
  const url = new URL(`https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Confluence ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`), { status: res.status });
  }
  return res.json();
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePage(page, cloudId) {
  const html = page.body?.storage?.value || page.body?.atlas_doc_format?.value || page.body?.view?.value || '';
  const text = stripHtml(html);
  return {
    resource_id: String(page.id),
    resource_type: 'page',
    title: page.title || `Page ${page.id}`,
    body: `${page.title || ''}\n\n${text}`.trim(),
    content: `${page.title || ''}\n\n${text}`.trim(),
    ts: page.version?.createdAt || page.createdAt || null,
    refs: {
      cloudId, pageId: page.id,
      spaceId: page.spaceId,
      version: page.version?.number || null,
      authorId: page.authorId || null,
      status: page.status || null,
    },
  };
}

export class ConfluenceAdapter extends BaseConnectorAdapter {
  constructor(ctx) { super(ctx); this.supportsWebhooks = true; this._cloudIdCache = new Map(); }

  async _getCloudId({ userId, orgId }) {
    const k = `${userId}:${orgId}`;
    if (this._cloudIdCache.has(k)) return this._cloudIdCache.get(k);
    const token = await this.getBearer({ userId, orgId });
    const id = await getCloudId(token);
    this._cloudIdCache.set(k, id);
    return id;
  }

  async fetchBulk({ userId, orgId, cursor, scope = {}, limit = 50 }) {
    const token = await this.getBearer({ userId, orgId });
    const cloudId = await this._getCloudId({ userId, orgId });
    const params = {
      limit: Math.min(limit, 100),
      'body-format': 'storage',
      sort: '-modified-date',
    };
    if (scope.spaceId) params['space-id'] = scope.spaceId;
    if (cursor) params.cursor = cursor;
    const data = await confGet(token, cloudId, '/pages', params);
    const records = (data.results || []).map(p => normalizePage(p, cloudId));
    const next = data._links?.next ? new URL(data._links.next, 'https://x').searchParams.get('cursor') : null;
    return { records, nextCursor: next || null };
  }

  async fetchResource({ userId, orgId, resourceId }) {
    const token = await this.getBearer({ userId, orgId });
    const cloudId = await this._getCloudId({ userId, orgId });
    const page = await confGet(token, cloudId, `/pages/${encodeURIComponent(resourceId)}`, { 'body-format': 'storage' });
    return normalizePage(page, cloudId);
  }

  toMemoryPayloads(record, context) {
    const tags = ['confluence', record.resource_type];
    if (record.refs?.spaceId) tags.push(`space:${record.refs.spaceId}`);
    return [this.buildMemoryPayload(record, context, {
      memory_type: 'fact',
      tags, source_type: 'confluence',
      metadata: {
        source_type_normalized: 'confluence',
        confluence_page_id: record.refs?.pageId,
        confluence_space_id: record.refs?.spaceId,
        confluence_version: record.refs?.version,
      },
    })];
  }

  verifyWebhookSignature(headers, rawBody) {
    const secret = process.env.CONFLUENCE_WEBHOOK_SECRET;
    if (!secret) throw Object.assign(new Error('ConfluenceAdapter: CONFLUENCE_WEBHOOK_SECRET not configured'), { code: 'no_secret' });
    const sig = headers['x-hub-signature'];
    if (!sig || !sig.startsWith('sha256=')) {
      throw Object.assign(new Error('ConfluenceAdapter: missing signature'), { code: 'missing_headers' });
    }
    const ts = Number(headers['x-atlassian-webhook-identifier-timestamp']);
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
      throw Object.assign(new Error('ConfluenceAdapter: replay window exceeded'), { code: 'replay' });
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const computed = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('ConfluenceAdapter: invalid signature'), { code: 'invalid_signature' });
    }
    return true;
  }

  parseEvent(payload) {
    const page = payload?.page || payload?.content || null;
    if (!page) return null;
    const cloudId = payload?.cloudId || 'confluence';
    return {
      eventId: page.id && page.version?.number ? `conf-${page.id}-v${page.version.number}` : `conf-${page.id || 'evt'}-${Date.now()}`,
      eventType: payload.webhookEvent || 'page_updated',
      resourceId: String(page.id),
      type: 'page',
      externalId: String(cloudId),
    };
  }

  async registerWebhook({ userId, orgId }) {
    const cloudId = await this._getCloudId({ userId, orgId });
    return { externalId: cloudId, manual: true };
  }
}

adapterRegistry.register('confluence', ConfluenceAdapter);
