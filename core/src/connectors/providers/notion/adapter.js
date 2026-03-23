import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const NOTION_API = 'https://api.notion.com/v1';

export class NotionAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'notion', requiredScopes: [], defaultTags: ['notion'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const body = { page_size: 50 };
    if (cursor) body.start_cursor = cursor;

    const res = await this._notionFetch('/search', accessToken, body);
    const records = (res.results || []).filter(r => r.object === 'page');

    return { records, nextCursor: res.next_cursor || null, hasMore: res.has_more || false };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this.fetchInitial({ accessToken, cursor, context });
  }

  normalize(record, context) {
    const title = this._extractTitle(record);
    if (!title) return [];

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: title,
      title,
      tags: [...this.defaultTags],
      memory_type: 'fact',
      document_date: record.last_edited_time || record.created_time,
      source_metadata: {
        source_type: 'notion',
        source_platform: 'notion',
        source_id: record.id,
        source_url: record.url,
      },
      metadata: { notion_id: record.id, parent_type: record.parent?.type },
    }];
  }

  dedupeKey(record) {
    return `notion:page:${record.id}`;
  }

  _extractTitle(page) {
    const props = page.properties || {};
    for (const val of Object.values(props)) {
      if (val.type === 'title' && val.title?.length > 0) {
        return val.title.map(t => t.plain_text).join('');
      }
    }
    return null;
  }

  async _notionFetch(path, token, body) {
    const res = await fetch(`${NOTION_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = new Error(`Notion API ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }
}
