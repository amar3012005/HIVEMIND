import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const PAGE_SIZE = 50;

/**
 * Linear adapter.
 *
 * Pulls Issues (with their team + project context) via the GraphQL API.
 * Cursor = Linear's GraphQL `endCursor` string. Incremental sync filters
 * `updatedAt > <last_run_iso>`.
 */
export class LinearAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'linear', requiredScopes: ['read', 'issues:read'], defaultTags: ['linear'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetchIssues({ accessToken, cursor });
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    // For incremental we still use Linear's pagination but Linear filters
    // by updatedAt; we use a 7-day window if no cursor present yet.
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this._fetchIssues({ accessToken, cursor, sinceIso });
  }

  async _fetchIssues({ accessToken, cursor, sinceIso = null }) {
    const variables = { first: PAGE_SIZE };
    if (cursor) variables.after = cursor;
    if (sinceIso) variables.filter = { updatedAt: { gt: sinceIso } };

    const query = `
      query ($first: Int!, $after: String, $filter: IssueFilter) {
        issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id identifier title description url priority
            state { name type }
            team { id key name }
            project { id name }
            assignee { name email }
            creator { name email }
            labels(first: 10) { nodes { name } }
            createdAt updatedAt completedAt
          }
        }
      }`;
    const data = await _gql(accessToken, query, variables);
    const issues = data?.issues;
    return {
      records: issues?.nodes || [],
      nextCursor: issues?.pageInfo?.hasNextPage ? issues.pageInfo.endCursor : null,
      hasMore: Boolean(issues?.pageInfo?.hasNextPage),
    };
  }

  normalize(record, context) {
    const labels = (record.labels?.nodes || []).map(l => l.name).filter(Boolean);
    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: [
        `${record.identifier}: ${record.title || ''}`,
        record.description || '',
      ].filter(Boolean).join('\n\n'),
      title: `${record.identifier}: ${record.title || ''}`.slice(0, 200),
      tags: [
        'linear',
        record.team?.key ? `team:${record.team.key.toLowerCase()}` : null,
        record.state?.type ? `state:${record.state.type}` : null,
        record.priority ? `priority:${record.priority}` : null,
        ...labels.map(l => `label:${l.toLowerCase().replace(/\s+/g, '-')}`),
      ].filter(Boolean),
      memory_type: 'task',
      document_date: record.updatedAt || record.createdAt || null,
      source_metadata: {
        source_type: 'linear_issue',
        source_platform: 'linear',
        source_id: record.id,
        source_url: record.url,
      },
      metadata: {
        identifier: record.identifier,
        team_key: record.team?.key || null,
        project: record.project?.name || null,
        state: record.state?.name || null,
        assignee: record.assignee?.name || null,
      },
    }];
  }

  dedupeKey(record) { return `linear:issue:${record.id}`; }
}

async function _gql(token, query, variables) {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    if (res.status === 401) { const e = new Error('Linear 401'); e.status = 401; throw e; }
    const text = await res.text().catch(() => '');
    throw new Error(`Linear GraphQL ${res.status} ${text}`);
  }
  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
  }
  return data.data;
}
