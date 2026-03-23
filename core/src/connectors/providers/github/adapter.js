import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const GH_API = 'https://api.github.com';

export class GitHubAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'github', requiredScopes: ['repo'], defaultTags: ['github'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const repos = await this._ghFetch('/user/repos?per_page=10&sort=pushed', accessToken);
    const records = [];

    for (const repo of repos) {
      const params = cursor ? `&since=${cursor}` : '';
      const issues = await this._ghFetch(`/repos/${repo.full_name}/issues?state=all&per_page=30${params}`, accessToken);
      for (const issue of issues) {
        records.push({ ...issue, _repo: repo.full_name });
      }
    }

    return { records, nextCursor: new Date().toISOString(), hasMore: false };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this.fetchInitial({ accessToken, cursor, context });
  }

  normalize(record, context) {
    const body = record.body || '';
    const title = record.title || '';
    const labels = (record.labels || []).map(l => typeof l === 'string' ? l : l.name);

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: record._repo,
      content: `${title}\n\n${body}`.trim(),
      title: `${record._repo}#${record.number}: ${title}`,
      tags: [...this.defaultTags, ...labels, record.pull_request ? 'pr' : 'issue'],
      memory_type: 'fact',
      document_date: record.created_at,
      source_metadata: {
        source_type: 'github',
        source_platform: 'github',
        source_id: `${record._repo}:${record.number}`,
        source_url: record.html_url,
      },
      metadata: {
        repo: record._repo,
        number: record.number,
        state: record.state,
        author: record.user?.login,
        assignee: record.assignee?.login,
        labels,
      },
    }];
  }

  dedupeKey(record) {
    return `github:issue:${record._repo}:${record.number}`;
  }

  async _ghFetch(path, token) {
    const res = await fetch(`${GH_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) { const e = new Error(`GitHub API ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }
}
