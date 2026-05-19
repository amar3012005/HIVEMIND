import crypto from 'node:crypto';
import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15000;
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Per-token rate-limit tracker (P3 #24) — respects GitHub 5000/h quota
const _ghRate = new Map(); // token -> { remaining, reset }

async function githubRequest(token, path, { method = 'GET', body } = {}) {
  // Pre-emptively pause when remaining quota is low
  const r = _ghRate.get(token);
  if (r && r.remaining < 50 && r.reset && r.reset > Date.now() / 1000) {
    const waitMs = Math.min((r.reset - Date.now() / 1000) * 1000, 60000);
    if (waitMs > 0) await new Promise(rs => setTimeout(rs, waitMs));
  }
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Cache quota for next call
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining) && Number.isFinite(reset)) {
    _ghRate.set(token, { remaining, reset });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`GitHub ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text().catch(() => '');
  return text ? JSON.parse(text) : null;
}

function normalizeIssue(issue) {
  const repoFullName = issue?.repository?.full_name || issue?.repository_url?.split('/repos/')[1] || null;
  const labels = Array.isArray(issue?.labels) ? issue.labels.map(label => label.name).filter(Boolean) : [];
  const body = [
    issue?.body || '',
    issue?.pull_request?.html_url ? `\n\nPull Request: ${issue.pull_request.html_url}` : '',
  ].join('').trim();

  return {
    id: String(issue.id),
    resource_id: String(issue.id),
    resource_type: issue?.pull_request ? 'pull_request' : 'issue',
    title: issue?.title || '(untitled issue)',
    body,
    ts: issue?.updated_at || issue?.created_at || null,
    refs: {
      issue_number: issue?.number ?? null,
      repository: repoFullName,
      state: issue?.state || null,
      url: issue?.html_url || issue?.url || null,
      labels,
      author: issue?.user?.login || null,
    },
  };
}

export class GitHubAdapter extends BaseConnectorAdapter {
  constructor(ctx) {
    super(ctx);
    this.supportsWebhooks = true;
  }

  async fetchBulk({ userId, orgId, cursor = null, limit = 50 }) {
    const token = await this.getBearer({ userId, orgId });
    const page = Number(cursor || 1);
    const issues = await githubRequest(token, `/issues?filter=all&sort=updated&direction=desc&per_page=${limit}&page=${page}`);
    const records = Array.isArray(issues) ? issues.map(normalizeIssue) : [];
    return {
      records,
      nextCursor: records.length === limit ? String(page + 1) : null,
    };
  }

  async fetchResource({ userId, orgId, resourceId }) {
    const token = await this.getBearer({ userId, orgId });
    const issue = await githubRequest(token, `/notifications/threads/${resourceId}`).catch(() => null);
    if (issue?.subject?.url) {
      const subjectPath = issue.subject.url.replace(GITHUB_API, '');
      const full = await githubRequest(token, subjectPath);
      full.repository = full.repository || issue.repository || null;
      return normalizeIssue(full);
    }

    const fallback = await githubRequest(token, `/search/issues?q=${encodeURIComponent(resourceId)}+in:number&per_page=1`).catch(() => null);
    const hit = fallback?.items?.[0];
    if (!hit) throw new Error(`github: no resource found for ${resourceId}`);
    return normalizeIssue(hit);
  }

  toMemoryPayloads(record, context) {
    const labels = Array.isArray(record?.refs?.labels) ? record.refs.labels : [];
    const repo = record?.refs?.repository || 'unknown';
    const tags = ['github', record?.resource_type || 'issue', `repo:${repo}`, ...labels.map(label => `label:${label}`)];
    return [this.buildMemoryPayload(record, context, {
      memory_type: 'decision',
      tags,
      source_type: record?.resource_type || 'issue',
      metadata: {
        source_type_normalized: 'github',
        repository: repo,
        issue_number: record?.refs?.issue_number || null,
        github_state: record?.refs?.state || null,
        github_author: record?.refs?.author || null,
      },
    })];
  }

  verifyWebhookSignature(headers, rawBody) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw Object.assign(new Error('github: GITHUB_WEBHOOK_SECRET not configured'), { code: 'not_supported' });

    const signature = headers['x-hub-signature-256'];
    if (!signature) {
      throw Object.assign(new Error('github: missing signature header'), { code: 'missing_headers' });
    }

    const deliveredAt = headers['x-github-delivery-timestamp'];
    if (deliveredAt) {
      const age = Math.abs(Date.now() - new Date(deliveredAt).getTime());
      if (Number.isFinite(age) && age > WEBHOOK_REPLAY_WINDOW_MS) {
        throw Object.assign(new Error('github: webhook timestamp too old'), { code: 'replay' });
      }
    }

    const computed = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const expectedBuf = Buffer.from(signature, 'utf8');
    const computedBuf = Buffer.from(computed, 'utf8');
    if (expectedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(expectedBuf, computedBuf)) {
      throw Object.assign(new Error('github: invalid webhook signature'), { code: 'invalid_signature' });
    }
    return true;
  }

  parseEvent(payload) {
    const issue = payload?.issue || payload?.pull_request || null;
    return {
      eventId: payload?.delivery || payload?.hook_id || `${payload?.repository?.id || 'repo'}:${issue?.id || 'event'}`,
      eventType: payload?.action || 'updated',
      resourceId: String(issue?.id || payload?.hook_id || payload?.repository?.id || ''),
      type: payload?.pull_request ? 'pull_request' : 'issue',
      externalId: payload?.repository?.owner?.login || payload?.organization?.login || null,
    };
  }

  registerWebhook() {
    throw Object.assign(new Error('github: automatic webhook registration requires repo scoping and is not yet supported'), { code: 'not_supported' });
  }
}

adapterRegistry.register('github', GitHubAdapter);
