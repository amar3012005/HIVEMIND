/**
 * Google Drive Docs adapter — KB-style ingestion.
 *
 * Pre-ingests Google Docs, Sheets, Slides bodies as durable knowledge memories.
 * Pipes content through the existing knowledge-base chunker + smart-ingest
 * pipeline so each doc behaves like a KB upload.
 *
 * Uses workspace-mcp bridge for API calls so token handling is unified.
 *
 * NOT for: Drive file listings, search-on-demand, recent activity.
 * Those route through live-query-router for fresh-by-default behavior.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { WorkspaceMcpBridge } from './workspace-mcp-bridge.js';

const DOC_MIME_TYPES = {
  document:    'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation:'application/vnd.google-apps.presentation',
};

export class GoogleDriveDocsAdapter extends BaseProviderAdapter {
  constructor({ prisma, decryptToken, refreshOAuthToken, mcpUrl }) {
    super({
      providerId: 'google_drive_docs',
      requiredScopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/presentations.readonly',
      ],
      defaultTags: ['google-drive'],
    });
    this.bridge = new WorkspaceMcpBridge({ prisma, decryptToken, refreshOAuthToken, mcpUrl });
  }

  /**
   * Initial backfill: list user's Docs/Sheets/Slides + fetch bodies.
   * Cursor is the Drive pageToken.
   */
  async fetchInitial({ accessToken, cursor, context }) {
    // Use the bridge to call workspace-mcp; access token is fetched fresh per user
    const userId = context.user_id;
    const args = {
      query: `(mimeType='${DOC_MIME_TYPES.document}' OR mimeType='${DOC_MIME_TYPES.spreadsheet}' OR mimeType='${DOC_MIME_TYPES.presentation}') and trashed=false`,
      page_size: 50,
    };
    if (cursor) args.page_token = cursor;

    const result = await this.bridge.callTool(userId, 'search_drive_files', args);
    const items = this._parseListResult(result);
    const nextCursor = this._extractNextPageToken(result);

    // Fetch body for each file (limit parallelism — 5 at a time)
    const records = [];
    for (let i = 0; i < items.length; i += 5) {
      const batch = items.slice(i, i + 5);
      const fetched = await Promise.allSettled(
        batch.map(async (file) => {
          const body = await this._fetchFileBody(userId, file);
          return { ...file, _body: body };
        })
      );
      for (const r of fetched) {
        if (r.status === 'fulfilled' && r.value._body) records.push(r.value);
      }
    }

    return {
      records,
      nextCursor: nextCursor || null,
      hasMore: !!nextCursor,
    };
  }

  /**
   * Incremental sync: use Drive changes API via workspace-mcp.
   * Cursor is a startPageToken from previous run.
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    if (!cursor) return this.fetchInitial({ accessToken, cursor: null, context });
    const userId = context.user_id;
    try {
      const result = await this.bridge.callTool(userId, 'list_drive_changes', {
        page_token: cursor,
        page_size: 50,
      });
      const items = this._parseListResult(result);
      const nextCursor = this._extractNextPageToken(result);
      const records = [];
      for (const file of items) {
        if (!Object.values(DOC_MIME_TYPES).includes(file.mimeType)) continue;
        const body = await this._fetchFileBody(userId, file);
        if (body) records.push({ ...file, _body: body });
      }
      return { records, nextCursor: nextCursor || cursor, hasMore: !!nextCursor };
    } catch (err) {
      // Fall back to full sync if changes API rejects cursor
      if (/(invalid|expired).*page.*token/i.test(err.message)) {
        return this.fetchInitial({ accessToken, cursor: null, context });
      }
      throw err;
    }
  }

  /**
   * Normalize a Drive doc into KB-style memory payloads.
   * Long bodies get chunked by the existing knowledge-base chunker.
   */
  normalize(file, context) {
    if (!file._body) return [];

    const docType = file.mimeType === DOC_MIME_TYPES.document    ? 'document'
                  : file.mimeType === DOC_MIME_TYPES.spreadsheet ? 'spreadsheet'
                  : file.mimeType === DOC_MIME_TYPES.presentation? 'presentation'
                  : 'file';

    const lastModified = file.modifiedTime ? new Date(file.modifiedTime).toISOString() : null;

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: file._body,
      title: file.name || 'Untitled',
      tags: [...this.defaultTags, `drive-${docType}`, ...(file.owners?.map(o => `owner:${o.emailAddress}`) || []).slice(0, 2)],
      memory_type: 'fact',          // durable knowledge, not event
      document_date: lastModified,
      source_metadata: {
        source_type: 'google_drive',
        source_platform: 'google_drive',
        source_id: `drive:${file.id}`,
        source_url: file.webViewLink || `https://drive.google.com/file/d/${file.id}`,
      },
      metadata: {
        type: `google_${docType}`,
        drive_file_id: file.id,
        mime_type: file.mimeType,
        file_name: file.name,
        owners: file.owners?.map(o => o.emailAddress) || [],
        size_bytes: parseInt(file.size, 10) || null,
        modified_time: lastModified,
        web_view_link: file.webViewLink,
        // Hint to upstream chunker that this is a long-form doc
        kb_chunk: true,
      },
    }];
  }

  dedupeKey(file) {
    return `drive:${file.id}:${file.modifiedTime || ''}`;
  }

  // ─── Internal helpers ──────────────────────────────────────

  async _fetchFileBody(userId, file) {
    try {
      if (file.mimeType === DOC_MIME_TYPES.document) {
        const r = await this.bridge.callTool(userId, 'get_doc_content', {
          document_id: file.id,
        });
        return this._extractText(r);
      }
      if (file.mimeType === DOC_MIME_TYPES.spreadsheet) {
        const r = await this.bridge.callTool(userId, 'get_spreadsheet_info', {
          spreadsheet_id: file.id,
        });
        return this._extractText(r);
      }
      if (file.mimeType === DOC_MIME_TYPES.presentation) {
        const r = await this.bridge.callTool(userId, 'get_presentation', {
          presentation_id: file.id,
        });
        return this._extractText(r);
      }
      return null;
    } catch (err) {
      console.warn(`[drive-docs] fetch body failed for ${file.id}: ${err.message}`);
      return null;
    }
  }

  _extractText(toolResult) {
    if (!toolResult?.content?.length) return '';
    return toolResult.content.map(c => c.text || '').join('\n').trim();
  }

  _parseListResult(toolResult) {
    if (!toolResult?.content?.length) return [];
    const text = toolResult.content[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      return parsed.files || parsed.results || (Array.isArray(parsed) ? parsed : []);
    } catch (_e) {
      return [];
    }
  }

  _extractNextPageToken(toolResult) {
    if (!toolResult?.content?.length) return null;
    try {
      const parsed = JSON.parse(toolResult.content[0]?.text || '');
      return parsed.nextPageToken || parsed.next_page_token || null;
    } catch (_e) {
      return null;
    }
  }
}
