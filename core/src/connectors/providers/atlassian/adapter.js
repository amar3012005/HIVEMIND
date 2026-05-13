import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

/**
 * Atlassian adapter — pages through Jira issues + Confluence pages.
 *
 * Cursor shape:
 *   "jira:<jql-cursor>|conf:<page-cursor>"
 *
 * We interleave the two sources: each fetch call returns up to PAGE_SIZE
 * records from whichever stream still has more. When both streams are
 * exhausted we signal hasMore=false.
 *
 * cloud_id comes from context.provider_metadata (set during OAuth).
 * Without a cloud_id we cannot call any Jira/Confluence endpoint, so
 * we short-circuit with empty results to keep the sync engine green.
 */

const PAGE_SIZE = 50;
const JIRA_FIELDS = 'summary,description,status,priority,issuetype,project,assignee,reporter,labels,components,fixVersions,updated,created';

export class AtlassianAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'atlassian',
      requiredScopes: [
        'read:jira-work',
        'read:confluence-content.all',
        'offline_access',
      ],
      defaultTags: ['atlassian'],
    });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetch({ accessToken, cursor, context, jql: 'updated >= -90d ORDER BY updated DESC' });
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this._fetch({ accessToken, cursor, context, jql: 'updated >= -7d ORDER BY updated DESC' });
  }

  async _fetch({ accessToken, cursor, context, jql }) {
    const cloudId = context?.provider_metadata?.cloud_id;
    if (!cloudId) {
      return { records: [], nextCursor: null, hasMore: false };
    }

    const parsed = _parseCursor(cursor);
    const records = [];

    // Half from Jira, half from Confluence.
    const jiraBudget = Math.ceil(PAGE_SIZE / 2);
    const confBudget = PAGE_SIZE - jiraBudget;

    const [jiraResult, confResult] = await Promise.all([
      parsed.jiraDone
        ? Promise.resolve({ issues: [], nextCursor: null, hasMore: false })
        : this._fetchJira({ accessToken, cloudId, startAt: parsed.jiraStartAt, maxResults: jiraBudget, jql }),
      parsed.confDone
        ? Promise.resolve({ pages: [], nextCursor: null, hasMore: false })
        : this._fetchConfluence({ accessToken, cloudId, cursor: parsed.confCursor, limit: confBudget }),
    ]);

    for (const issue of jiraResult.issues) {
      records.push({ _kind: 'jira', cloudId, cloudUrl: context?.provider_metadata?.cloud_url || null, data: issue });
    }
    for (const page of confResult.pages) {
      records.push({ _kind: 'confluence', cloudId, cloudUrl: context?.provider_metadata?.cloud_url || null, data: page });
    }

    const nextCursor = _serializeCursor({
      jiraStartAt: jiraResult.nextStartAt,
      jiraDone: !jiraResult.hasMore,
      confCursor: confResult.nextCursor,
      confDone: !confResult.hasMore,
    });
    const hasMore = jiraResult.hasMore || confResult.hasMore;
    return { records, nextCursor, hasMore };
  }

  async _fetchJira({ accessToken, cloudId, startAt = 0, maxResults, jql }) {
    const url = new URL(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', JIRA_FIELDS);
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('maxResults', String(maxResults));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 401) { const e = new Error('Atlassian Jira 401'); e.status = 401; throw e; }
      throw new Error(`Atlassian Jira ${res.status}`);
    }
    const data = await res.json();
    const issues = data.issues || [];
    const total = data.total || 0;
    const nextStartAt = startAt + issues.length;
    return { issues, nextStartAt, hasMore: nextStartAt < total };
  }

  async _fetchConfluence({ accessToken, cloudId, cursor, limit }) {
    let url;
    if (cursor) {
      // Confluence returns next URL fragments; we stored them verbatim.
      url = `https://api.atlassian.com${cursor}`;
    } else {
      url = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages?limit=${limit}&body-format=storage`;
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 401) { const e = new Error('Atlassian Confluence 401'); e.status = 401; throw e; }
      throw new Error(`Atlassian Confluence ${res.status}`);
    }
    const data = await res.json();
    const pages = data.results || [];
    const nextLink = data._links?.next || null;
    return { pages, nextCursor: nextLink, hasMore: Boolean(nextLink) };
  }

  normalize(record, context) {
    if (record._kind === 'jira') return [this._normalizeJira(record, context)];
    if (record._kind === 'confluence') return [this._normalizeConfluence(record, context)];
    return [];
  }

  _normalizeJira(record, context) {
    const issue = record.data;
    const f = issue.fields || {};
    const url = record.cloudUrl ? `${record.cloudUrl}/browse/${issue.key}` : null;
    const description = f.description?.content ? _renderAdf(f.description) : (f.description || '');
    const content = [`${issue.key}: ${f.summary || ''}`, description].filter(Boolean).join('\n\n');
    return {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title: `${issue.key}: ${f.summary || ''}`.slice(0, 200),
      tags: [
        'atlassian', 'jira',
        f.project?.key ? `project:${f.project.key}` : null,
        f.issuetype?.name ? `type:${f.issuetype.name.toLowerCase()}` : null,
        f.status?.name ? `status:${f.status.name.toLowerCase().replace(/\s+/g, '-')}` : null,
        f.priority?.name ? `priority:${f.priority.name.toLowerCase()}` : null,
      ].filter(Boolean),
      memory_type: 'task',
      document_date: f.updated || f.created || null,
      source_metadata: {
        source_type: 'jira_issue',
        source_platform: 'atlassian',
        source_id: issue.id,
        source_url: url,
      },
      metadata: {
        jira_key: issue.key,
        project_key: f.project?.key || null,
        status: f.status?.name || null,
        assignee: f.assignee?.displayName || null,
        reporter: f.reporter?.displayName || null,
      },
    };
  }

  _normalizeConfluence(record, context) {
    const page = record.data;
    const url = record.cloudUrl && page.id ? `${record.cloudUrl}/wiki/pages/${page.id}` : null;
    const body = page.body?.storage?.value
      ? _stripHtml(page.body.storage.value).slice(0, 8000)
      : '';
    return {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: [page.title || '', body].filter(Boolean).join('\n\n'),
      title: (page.title || '').slice(0, 200),
      tags: [
        'atlassian', 'confluence',
        page.spaceId ? `space:${page.spaceId}` : null,
        page.status ? `status:${page.status}` : null,
      ].filter(Boolean),
      memory_type: 'note',
      document_date: page.version?.createdAt || page.createdAt || null,
      source_metadata: {
        source_type: 'confluence_page',
        source_platform: 'atlassian',
        source_id: page.id,
        source_url: url,
      },
      metadata: { space_id: page.spaceId || null, version: page.version?.number || null },
    };
  }

  dedupeKey(record) {
    if (record._kind === 'jira') return `atlassian:jira:${record.data.id}`;
    if (record._kind === 'confluence') return `atlassian:confluence:${record.data.id}`;
    return `atlassian:unknown:${Date.now()}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────
function _parseCursor(cursor) {
  if (!cursor) return { jiraStartAt: 0, jiraDone: false, confCursor: null, confDone: false };
  const parts = String(cursor).split('|');
  const out = { jiraStartAt: 0, jiraDone: false, confCursor: null, confDone: false };
  for (const p of parts) {
    if (p.startsWith('jira:')) {
      const v = p.slice('jira:'.length);
      if (v === 'done') out.jiraDone = true;
      else out.jiraStartAt = parseInt(v, 10) || 0;
    } else if (p.startsWith('conf:')) {
      const v = p.slice('conf:'.length);
      if (v === 'done') out.confDone = true;
      else out.confCursor = v || null;
    }
  }
  return out;
}

function _serializeCursor({ jiraStartAt, jiraDone, confCursor, confDone }) {
  const j = jiraDone ? 'jira:done' : `jira:${jiraStartAt || 0}`;
  const c = confDone ? 'conf:done' : `conf:${confCursor || ''}`;
  return `${j}|${c}`;
}

/** Atlassian Document Format → plain text (lossy but sufficient for memory). */
function _renderAdf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(_renderAdf).join('');
  if (node.text) return node.text;
  if (node.content) return node.content.map(_renderAdf).join(node.type === 'paragraph' ? '\n' : '');
  return '';
}

function _stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
