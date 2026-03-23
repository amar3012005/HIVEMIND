import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export class GDriveAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'gdrive', requiredScopes: ['drive.readonly'], defaultTags: ['gdrive', 'google-drive'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const params = new URLSearchParams({
      pageSize: '50',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
      q: "mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='text/plain'",
    });
    if (cursor) params.set('pageToken', cursor);

    const res = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) { const e = new Error(`Drive API ${res.status}`); e.status = res.status; throw e; }
    const data = await res.json();

    const records = [];
    for (const file of data.files || []) {
      try {
        const content = await this._exportFile(file, accessToken);
        if (content) records.push({ ...file, _content: content });
      } catch {}
    }

    return { records, nextCursor: data.nextPageToken || null, hasMore: !!data.nextPageToken };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this.fetchInitial({ accessToken, cursor, context });
  }

  normalize(record, context) {
    const content = record._content || '';
    if (content.length < 20) return [];

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title: record.name,
      tags: [...this.defaultTags],
      memory_type: 'fact',
      document_date: record.modifiedTime,
      source_metadata: {
        source_type: 'gdrive',
        source_platform: 'google-drive',
        source_id: record.id,
        source_url: record.webViewLink,
      },
      metadata: { drive_id: record.id, mime_type: record.mimeType },
    }];
  }

  dedupeKey(record) {
    return `gdrive:file:${record.id}`;
  }

  async _exportFile(file, token) {
    const exportMime = file.mimeType?.includes('google-apps') ? 'text/plain' : null;
    const url = exportMime
      ? `${DRIVE_API}/files/${file.id}/export?mimeType=text/plain`
      : `${DRIVE_API}/files/${file.id}?alt=media`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 10000);
  }
}
