/**
 * JiraAdapter — Atlassian Cloud REST API v3 for issues + comments.
 * Webhooks: HMAC-SHA256 signed payloads via X-Hub-Signature.
 */

import crypto from 'node:crypto';
import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const REQUEST_TIMEOUT_MS = 20000;
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

async function jiraGet(token, cloudId, path, params = {}) {
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Jira ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`), { status: res.status });
  }
  return res.json();
}

async function getCloudId(token) {
  const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jira accessible-resources ${res.status}`);
  const list = await res.json();
  const cloud = Array.isArray(list) ? list.find(r => r.scopes?.some(s => s.startsWith('read:jira'))) || list[0] : null;
  if (!cloud) throw new Error('Jira: no accessible Jira cloud');
  return cloud.id;
}

function adfToText(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (Array.isArray(adf)) return adf.map(adfToText).join('\n');
  if (adf.type === 'text') return adf.text || '';
  if (Array.isArray(adf.content)) return adf.content.map(adfToText).join('\n');
  return '';
}

function normalizeIssue(issue, cloudId) {
  const f = issue.fields || {};
  const body = [f.summary || '', adfToText(f.description) || ''].filter(Boolean).join('\n\n').trim();
  return {
    resource_id: issue.key,
    resource_type: 'issue',
    title: f.summary || issue.key,
    body,
    content: body,
    ts: f.updated || f.created || null,
    refs: {
      cloudId, key: issue.key,
      project: f.project?.key || null,
      status: f.status?.name || null,
      assignee: f.assignee?.displayName || null,
      issueType: f.issuetype?.name || null,
      labels: f.labels || [],
      priority: f.priority?.name || null,
    },
  };
}

export class JiraAdapter extends BaseConnectorAdapter {
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
    const startAt = cursor ? parseInt(cursor, 10) || 0 : 0;
    const jql = scope.jql || (scope.project ? `project = ${scope.project} ORDER BY updated DESC` : 'ORDER BY updated DESC');
    const data = await jiraGet(token, cloudId, '/search', {
      jql, startAt, maxResults: Math.min(limit, 100),
      fields: 'summary,description,status,assignee,issuetype,labels,priority,project,updated,created',
    });
    const records = (data.issues || []).map(i => normalizeIssue(i, cloudId));
    const next = (startAt + records.length < (data.total || 0)) ? String(startAt + records.length) : null;
    return { records, nextCursor: next };
  }

  async fetchResource({ userId, orgId, resourceId }) {
    const token = await this.getBearer({ userId, orgId });
    const cloudId = await this._getCloudId({ userId, orgId });
    const issue = await jiraGet(token, cloudId, `/issue/${encodeURIComponent(resourceId)}`);
    return normalizeIssue(issue, cloudId);
  }

  toMemoryPayloads(record, context) {
    const tags = ['jira', record.resource_type, `project:${record.refs?.project || 'unknown'}`];
    if (record.refs?.status) tags.push(`status:${record.refs.status}`);
    return [this.buildMemoryPayload(record, context, {
      memory_type: 'decision',
      tags, source_type: 'jira',
      metadata: {
        source_type_normalized: 'jira',
        jira_key: record.refs?.key, jira_project: record.refs?.project,
        jira_status: record.refs?.status, jira_assignee: record.refs?.assignee,
      },
    })];
  }

  verifyWebhookSignature(headers, rawBody) {
    const secret = process.env.JIRA_WEBHOOK_SECRET;
    if (!secret) throw Object.assign(new Error('JiraAdapter: JIRA_WEBHOOK_SECRET not configured'), { code: 'no_secret' });
    const sig = headers['x-hub-signature'];
    if (!sig || !sig.startsWith('sha256=')) {
      throw Object.assign(new Error('JiraAdapter: missing signature'), { code: 'missing_headers' });
    }
    const ts = Number(headers['x-atlassian-webhook-identifier-timestamp']);
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
      throw Object.assign(new Error('JiraAdapter: replay window exceeded'), { code: 'replay' });
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const computed = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('JiraAdapter: invalid signature'), { code: 'invalid_signature' });
    }
    return true;
  }

  parseEvent(payload) {
    if (!payload?.issue) return null;
    const cloudId = payload?.matchedWebhookIds?.[0] || 'jira';
    return {
      eventId: payload.timestamp ? `jira-${payload.issue.key}-${payload.timestamp}` : `jira-${payload.issue.key}-${Date.now()}`,
      eventType: payload.webhookEvent || 'jira:issue_updated',
      resourceId: payload.issue.key,
      type: 'issue',
      externalId: String(cloudId),
    };
  }

  async registerWebhook({ userId, orgId, callbackUrl }) {
    const token = await this.getBearer({ userId, orgId });
    const cloudId = await this._getCloudId({ userId, orgId });
    const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: callbackUrl,
        webhooks: [{
          jqlFilter: 'project IS NOT EMPTY',
          events: ['jira:issue_created', 'jira:issue_updated', 'comment_created', 'comment_updated'],
        }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { externalId: cloudId, manual: !res.ok };
  }
}

adapterRegistry.register('jira', JiraAdapter);
