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
import crypto from 'node:crypto';
import { chunkText } from '../../../knowledge/document-chunker.js';

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
    const ownerTags = (file.owners?.map(o => `owner:${o.emailAddress}`) || []).slice(0, 2);
    const baseTags = [...this.defaultTags, `drive-${docType}`, ...ownerTags];

    // Doc-hash for dedup on re-sync (skip unchanged docs entirely)
    const docHash = crypto.createHash('sha256').update(file._body).digest('hex').slice(0, 16);
    const docHashTag = `doc-hash:${docHash}`;

    // KB-style chunking: same chunker as /api/knowledge/upload uses
    let chunks;
    try {
      chunks = chunkText(file._body, { targetSize: 800, maxSize: 1200, minSize: 100, overlapSize: 80 });
    } catch (_chunkerErr) {
      // Fallback: single chunk if chunker fails
      chunks = [{ text: file._body, index: 0 }];
    }

    // Document-level summary payload (gets the full body? no — just metadata)
    const summaryPayload = {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: `# ${file.name || 'Untitled'}\n\n${file._body.slice(0, 500)}${file._body.length > 500 ? '…' : ''}`,
      title: file.name || 'Untitled',
      tags: [
        ...baseTags,
        'document-summary',
        docHashTag,
        // Rich tags for recall — owner / mime / folder / year-month
        ...(file.owners || []).slice(0, 3).map(o => `owner:${(o.emailAddress || '').toLowerCase()}`),
        file.mimeType ? `mime:${file.mimeType}` : null,
        `drive_type:${docType}`, // doc | sheet | slide | pdf | file
      ].filter(Boolean),
      // Provider-specific type — distinguishes Drive docs from generic facts.
      // Maps from Drive mime: drive_doc / drive_sheet / drive_slide / drive_pdf / drive_file
      memory_type: `drive_${docType}`,
      document_date: lastModified,
      importance_score: 0.7,
      source_metadata: {
        source_type: 'google_drive',
        source_platform: 'google_drive',
        source_id: `drive:${file.id}`,
        source_url: file.webViewLink || `https://drive.google.com/file/d/${file.id}`,
      },
      metadata: {
        type: `google_${docType}`, // legacy alias retained for downstream
        drive_type: docType,
        drive_file_id: file.id,
        mime_type: file.mimeType,
        file_name: file.name,
        owners: file.owners?.map(o => o.emailAddress) || [],
        last_modifying_user: file.lastModifyingUser?.emailAddress || null,
        parents: file.parents || [],
        size_bytes: parseInt(file.size, 10) || null,
        modified_time: lastModified,
        created_time: file.createdTime || null,
        web_view_link: file.webViewLink,
        starred: !!file.starred,
        shared: !!file.shared,
        total_chunks: chunks.length,
        doc_hash: docHash,
        is_document_summary: true,
      },
    };

    // Per-chunk payloads — searchable units. Type tagged with drive_chunk
    // so chunk noise is filterable separately from summary cards.
    const chunkPayloads = chunks.map((chunk, idx) => ({
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: chunk.text,
      title: `${file.name || 'Untitled'} (chunk ${idx + 1}/${chunks.length})`,
      tags: [
        ...baseTags,
        'document-chunk',
        `chunk:${idx}`,
        docHashTag,
        `drive_type:${docType}`,
      ],
      memory_type: `drive_${docType}_chunk`,
      document_date: lastModified,
      importance_score: 0.5,
      source_metadata: {
        source_type: 'google_drive',
        source_platform: 'google_drive',
        source_id: `drive:${file.id}:chunk:${idx}`,
        source_url: file.webViewLink || `https://drive.google.com/file/d/${file.id}`,
      },
      metadata: {
        drive_file_id: file.id,
        drive_type: docType,
        chunk_index: idx,
        total_chunks: chunks.length,
        parent_summary_id: `drive:${file.id}`,
        doc_hash: docHash,
      },
    }));

    return [summaryPayload, ...chunkPayloads];
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
