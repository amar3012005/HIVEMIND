import crypto from 'node:crypto';
import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const LINEAR_WEBHOOK_REPLAY_WINDOW_MS = 60 * 1000;

const LINEAR_API = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 15000;

async function linearRequest(token, query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.errors?.length) {
    const message = json?.errors?.map(err => err.message).join('; ') || `Linear HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return json.data;
}

function normalizeIssue(issue) {
  const labels = Array.isArray(issue?.labels?.nodes) ? issue.labels.nodes.map(label => label.name).filter(Boolean) : [];
  const body = [
    issue?.description || '',
    issue?.project?.name ? `\n\nProject: ${issue.project.name}` : '',
    issue?.team?.name ? `\nTeam: ${issue.team.name}` : '',
  ].join('').trim();

  return {
    id: issue.id,
    resource_id: issue.id,
    resource_type: 'issue',
    title: issue.title || '(untitled issue)',
    body,
    ts: issue.updatedAt || issue.createdAt || null,
    refs: {
      identifier: issue.identifier || null,
      url: issue.url || null,
      state: issue.state?.name || null,
      team: issue.team?.key || issue.team?.name || null,
      project: issue.project?.name || null,
      labels,
      assignee: issue.assignee?.name || issue.assignee?.email || null,
    },
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  createdAt
  updatedAt
  state { name }
  team { key name }
  project { name }
  assignee { name email }
  labels { nodes { name } }
`;

export class LinearAdapter extends BaseConnectorAdapter {
  constructor(ctx) {
    super(ctx);
    this.supportsWebhooks = true;
  }

  verifyWebhookSignature(headers, rawBody) {
    const secret = process.env.LINEAR_WEBHOOK_SECRET;
    if (!secret) throw Object.assign(new Error('LinearAdapter: LINEAR_WEBHOOK_SECRET not configured'), { code: 'no_secret' });
    const sig = headers['linear-signature'];
    if (!sig) throw Object.assign(new Error('LinearAdapter: missing linear-signature'), { code: 'missing_headers' });
    const ts = Number(headers['linear-delivery-timestamp']);
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > LINEAR_WEBHOOK_REPLAY_WINDOW_MS) {
      throw Object.assign(new Error('LinearAdapter: replay window exceeded'), { code: 'replay' });
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const computed = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(computed, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('LinearAdapter: invalid signature'), { code: 'invalid_signature' });
    }
    return true;
  }

  parseEvent(payload) {
    const data = payload?.data || {};
    return {
      eventId: payload.id || `linear-${data.id || 'evt'}-${Date.now()}`,
      eventType: `${payload.type || 'unknown'}.${payload.action || 'updated'}`,
      resourceId: data.id || data.issueId || data.identifier,
      type: payload.type === 'Issue' ? 'issue' : (payload.type || 'unknown').toLowerCase(),
      externalId: data.organizationId || payload.organizationId || 'linear',
    };
  }

  async registerWebhook({ userId, orgId, callbackUrl }) {
    const token = await this.getBearer({ userId, orgId });
    // Linear webhook registration uses GraphQL webhookCreate mutation
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `mutation Create($url: String!) {
            webhookCreate(input: { url: $url, resourceTypes: ["Issue","Comment","Project"] }) {
              webhook { id }
            }
          }`,
          variables: { url: callbackUrl },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      return {
        externalId: json?.data?.webhookCreate?.webhook?.id || 'linear',
        manual: !json?.data?.webhookCreate?.webhook?.id,
      };
    } catch {
      return { externalId: 'linear', manual: true };
    }
  }

  async fetchBulk({ userId, orgId, cursor = null, limit = 50 }) {
    const token = await this.getBearer({ userId, orgId });
    const data = await linearRequest(token, `
      query Issues($first: Int!, $after: String) {
        issues(first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: limit, after: cursor || null });

    const issues = data?.issues?.nodes || [];
    return {
      records: issues.map(normalizeIssue),
      nextCursor: data?.issues?.pageInfo?.hasNextPage ? data?.issues?.pageInfo?.endCursor || null : null,
    };
  }

  async fetchResource({ userId, orgId, resourceId }) {
    const token = await this.getBearer({ userId, orgId });
    const data = await linearRequest(token, `
      query Issue($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }
    `, { id: resourceId });

    if (!data?.issue) throw new Error(`linear: no issue found for ${resourceId}`);
    return normalizeIssue(data.issue);
  }

  toMemoryPayloads(record, context) {
    const tags = [
      'linear',
      'issue',
      record?.refs?.team ? `team:${record.refs.team}` : null,
      ...(record?.refs?.labels || []).map(label => `label:${label}`),
    ].filter(Boolean);

    return [this.buildMemoryPayload(record, context, {
      memory_type: 'decision',
      tags,
      source_type: 'issue',
      metadata: {
        source_type_normalized: 'linear',
        linear_identifier: record?.refs?.identifier || null,
        linear_state: record?.refs?.state || null,
        linear_team: record?.refs?.team || null,
        linear_project: record?.refs?.project || null,
        linear_assignee: record?.refs?.assignee || null,
      },
    })];
  }
}

adapterRegistry.register('linear', LinearAdapter);
