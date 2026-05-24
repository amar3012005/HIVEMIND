/**
 * Google Gemini Adapter (Nango provider key: google-gemini)
 *
 * Gemini is an LLM API not a workspace data source, so this adapter has
 * NO automatic fetch path. Two ingest paths supported:
 *
 *   1. Bulk paste — user POSTs a Gemini chat export (json or text) to
 *      /api/connectors/gemini/ingest-paste. We parse into Session+Turn
 *      tree and let the canonical pipeline handle the rest.
 *
 *   2. Per-turn live log — when HIVEMIND proxies a Gemini call on behalf
 *      of the user, log each user/assistant turn here. Same tree shape.
 *
 * Schema (mirrors _routeClaude):
 *   Session (parent, fact)        — "Gemini chat: <first-prompt-50>"
 *     ├── Turn (child, fact)      — "Turn N/M — user|assistant"
 *     └── ...
 *
 * Canonical pipeline guarantees entity, temporal, operator inference.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

export class GeminiAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'google-gemini',
      requiredScopes: [
        // Gemini API uses Google sign-in; no separate fetch scopes needed.
      ],
      defaultTags: ['gemini', 'conversation'],
    });
  }

  async fetchInitial(_args) {
    // Gemini has no inbox of past chats accessible by API — return empty.
    // The two ingest paths above are POST-driven, not pull-driven.
    return { records: [], nextCursor: null, hasMore: false };
  }

  async fetchIncremental(_args) {
    return { records: [], nextCursor: null, hasMore: false };
  }

  /**
   * Normalize one Gemini session record into Session+Turn tree.
   *
   * @param {Object} record
   * @param {string} record.session_id
   * @param {string} [record.title]            optional chat title
   * @param {string} [record.model]            e.g. "gemini-2.0-pro"
   * @param {Array<{role:'user'|'assistant', content:string, ts?:string}>} record.turns
   * @param {string} [record.exported_at]      ISO timestamp for the export
   */
  normalize(record, context) {
    const turns = Array.isArray(record.turns) ? record.turns : [];
    if (turns.length === 0) return [];

    const sessionId = record.session_id || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const firstUser = turns.find(t => t.role === 'user');
    const title = record.title
      || (firstUser ? `Gemini chat: ${String(firstUser.content || '').slice(0, 50).trim()}` : `Gemini session ${sessionId.slice(0, 8)}`);
    const model = record.model || 'gemini';
    const exportedAt = record.exported_at || new Date().toISOString();

    const baseTags = [
      'gemini', 'conversation',
      `session:${sessionId}`,
      `model:${model}`,
      'force-tree',
    ];

    const parent = {
      user_id: context.user_id,
      org_id: context.org_id,
      title,
      content: `Gemini session "${title}" — ${turns.length} turns with ${model}.`,
      tags: baseTags,
      memory_type: 'fact',
      document_date: exportedAt,
      source_metadata: {
        source_type: 'google-gemini',
        source_platform: 'google-gemini',
        source_id: `gemini:session:${sessionId}`,
        session_id: sessionId,
      },
      metadata: {
        gemini_session_id: sessionId,
        gemini_model: model,
        turn_count: turns.length,
        ingest_tree_role: 'parent',
        force_entity_linking: true,
      },
    };

    const children = turns.map((t, i) => ({
      user_id: context.user_id,
      org_id: context.org_id,
      title: `Turn ${i + 1}/${turns.length} — ${t.role || 'unknown'}`,
      content: String(t.content || '').trim(),
      tags: [
        ...baseTags,
        `turn-role:${t.role || 'unknown'}`,
        `turn-index:${i}`,
      ],
      memory_type: 'fact',
      document_date: t.ts || exportedAt,
      source_metadata: {
        source_type: 'google-gemini',
        source_platform: 'google-gemini',
        source_id: `gemini:session:${sessionId}:turn:${i}`,
        session_id: sessionId,
      },
      metadata: {
        gemini_session_id: sessionId,
        gemini_model: model,
        turn_index: i,
        turn_total: turns.length,
        turn_role: t.role || null,
        turn_ts: t.ts || null,
        parent_title: title,
        chunk_index: i,
        chunk_total: turns.length,
        ingest_tree_role: 'child',
        force_entity_linking: true,
      },
    })).filter(c => c.content.length > 0);

    return [{ _tree: { parent, children } }];
  }

  dedupeKey(record) {
    return `gemini:${record.session_id || record.id || 'unknown'}`;
  }
}

export default GeminiAdapter;
