/**
 * Google Docs Adapter (Nango provider key: google-docs)
 *
 * Schema: Doc → Section tree.
 *   Parent  memory_type=fact, summary + headings list
 *   Children memory_type=fact, one per H1/H2 section (token-capped)
 *
 * The canonical pipeline (graph-engine + smart-router) handles:
 *   - entity:* and time:* tag extraction (LLM, multilingual)
 *   - ts:* timestamp tags + content suffix
 *   - operator inference (Updates/Extends/Contradicts/Derives/Mentions)
 *   - cross-doc linking (LLM picks shared entities)
 *
 * Adapter responsibility: fetch from Nango, return memory payload tree.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const NANGO_URL = process.env.NANGO_URL || 'http://hivemind-nango:8080';
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;
const PROVIDER_CONFIG_KEY = process.env.NANGO_GOOGLE_DOCS_KEY || 'google-docs';

// Section size threshold: above this, we route the doc through Docling KB
// pipeline for heading-aware chunking instead of the simple H1/H2 split.
const KB_PIPELINE_THRESHOLD_CHARS = 5_000;

export class GoogleDocsAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'google-docs',
      requiredScopes: [
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
      ],
      defaultTags: ['google-docs', 'document'],
    });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetchDocs({ accessToken, cursor, context, mode: 'initial' });
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this._fetchDocs({ accessToken, cursor, context, mode: 'incremental' });
  }

  async _fetchDocs({ accessToken, cursor, context, mode }) {
    // List google docs via Drive API (filter mimeType=application/vnd.google-apps.document).
    // Page over results; track latest modifiedTime as cursor.
    const records = [];
    let pageToken = mode === 'incremental' ? null : null;
    let latestModified = cursor || '1970-01-01T00:00:00Z';
    const seenIds = new Set();
    const MAX_DOCS_PER_RUN = 80;

    // Single page query is enough for now — incremental sync runs hourly via
    // sync scheduler so we don't need full pagination on every tick.
    const q = encodeURIComponent("mimeType='application/vnd.google-apps.document' and trashed=false");
    const orderBy = encodeURIComponent('modifiedTime desc');
    const fields = encodeURIComponent('files(id,name,modifiedTime,owners,webViewLink),nextPageToken');
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${orderBy}&fields=${fields}&pageSize=${MAX_DOCS_PER_RUN}`;

    const listRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      throw new Error(`Drive list failed ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
    }
    const listJson = await listRes.json();
    const files = listJson.files || [];

    // Incremental: skip files whose modifiedTime is older than cursor.
    const cutoff = mode === 'incremental' && cursor ? new Date(cursor).getTime() : 0;

    for (const f of files) {
      if (seenIds.has(f.id)) continue;
      seenIds.add(f.id);
      const modMs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
      if (cutoff && modMs <= cutoff) continue;
      if (f.modifiedTime && f.modifiedTime > latestModified) {
        latestModified = f.modifiedTime;
      }
      try {
        const doc = await this._fetchDocBody(f.id, accessToken);
        records.push({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          owner: f.owners?.[0]?.emailAddress || null,
          webViewLink: f.webViewLink,
          markdown: doc.markdown,
          sections: doc.sections,
        });
      } catch (err) {
        console.warn(`[gdocs-adapter] fetch body failed for ${f.id}: ${err.message}`);
      }
    }

    return {
      records,
      nextCursor: latestModified,
      hasMore: false,
    };
  }

  /**
   * Fetch the Google Doc body via Docs API. Returns markdown + structured
   * section list (heading + content). Falls back to flat markdown when
   * the doc has no headings.
   */
  async _fetchDocBody(docId, accessToken) {
    const url = `https://docs.googleapis.com/v1/documents/${docId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Docs get failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const doc = await res.json();
    return this._extractStructure(doc);
  }

  _extractStructure(doc) {
    const body = doc.body || {};
    const elements = body.content || [];
    const sections = [];
    let currentSection = null;
    let mdParts = [];

    const flushSection = () => {
      if (currentSection && currentSection.content.trim()) {
        sections.push(currentSection);
      }
    };

    for (const el of elements) {
      const para = el.paragraph;
      if (!para) continue;
      const text = (para.elements || [])
        .map(e => e.textRun?.content || '')
        .join('')
        .replace(/\n+$/, '');
      if (!text) continue;
      const style = para.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
      const isHeading = /^HEADING_[1-3]$/.test(style);

      if (isHeading) {
        flushSection();
        const depth = Number(style.split('_')[1]) || 2;
        const md = '#'.repeat(depth) + ' ' + text;
        mdParts.push('', md, '');
        currentSection = { heading: text, depth, content: '' };
      } else {
        mdParts.push(text);
        if (currentSection) {
          currentSection.content += (currentSection.content ? '\n' : '') + text;
        } else {
          // Pre-heading content goes into an implicit "Introduction" section.
          currentSection = { heading: 'Introduction', depth: 1, content: text };
        }
      }
    }
    flushSection();

    return {
      markdown: mdParts.join('\n').trim(),
      sections,
    };
  }

  normalize(record, context) {
    const docTitle = record.name || 'Untitled Doc';
    const docId = record.id;
    const modifiedTime = record.modifiedTime;
    const sections = Array.isArray(record.sections) ? record.sections : [];
    const fullLen = (record.markdown || '').length;

    const baseTags = [
      'google-docs', 'document',
      `doc:${docId}`,
      ...(record.owner ? [`owner:${record.owner}`] : []),
    ];

    // Above the threshold → return a single payload that the smart-router
    // hands off to documentFirstIngestion (Docling hybrid chunker) via the
    // 'knowledge_base' route. Below the threshold → emit a parent + section
    // tree directly so each section is its own canonical memory.
    if (fullLen > KB_PIPELINE_THRESHOLD_CHARS) {
      return [{
        user_id: context.user_id,
        org_id: context.org_id,
        title: `Doc: ${docTitle}`,
        content: record.markdown,
        tags: [...baseTags, 'kb-routed'],
        memory_type: 'fact',
        document_date: modifiedTime || null,
        source_metadata: {
          source_type: 'google-docs',
          source_platform: 'google-docs',
          source_id: `gdocs:${docId}`,
          source_url: record.webViewLink || null,
        },
        metadata: {
          gdocs_doc_id: docId,
          gdocs_owner: record.owner,
          section_count: sections.length,
          length_chars: fullLen,
          force_entity_linking: true,
        },
      }];
    }

    // Small doc → parent + section tree.
    const parent = {
      user_id: context.user_id,
      org_id: context.org_id,
      title: `Doc: ${docTitle}`,
      content: this._buildDocSummary(docTitle, sections, record.markdown),
      tags: [...baseTags, 'doc-parent'],
      memory_type: 'fact',
      document_date: modifiedTime || null,
      source_metadata: {
        source_type: 'google-docs',
        source_platform: 'google-docs',
        source_id: `gdocs:${docId}`,
        source_url: record.webViewLink || null,
      },
      metadata: {
        gdocs_doc_id: docId,
        gdocs_owner: record.owner,
        section_count: sections.length,
        ingest_tree_role: 'parent',
        force_entity_linking: true,
      },
    };

    const children = sections.map((s, i) => ({
      user_id: context.user_id,
      org_id: context.org_id,
      title: `${docTitle} — ${s.heading}`,
      content: s.content,
      tags: [
        ...baseTags,
        `heading:${this._slug(s.heading)}`,
        `section-depth:${s.depth}`,
        'doc-section',
      ],
      memory_type: 'fact',
      document_date: modifiedTime || null,
      source_metadata: {
        source_type: 'google-docs',
        source_platform: 'google-docs',
        source_id: `gdocs:${docId}:section:${i}`,
      },
      metadata: {
        gdocs_doc_id: docId,
        heading: s.heading,
        section_index: i,
        section_total: sections.length,
        parent_title: `Doc: ${docTitle}`,
        chunk_index: i,
        chunk_total: sections.length,
        ingest_tree_role: 'child',
        force_entity_linking: true,
      },
    }));

    // Tree payload — graph-engine.ingestMemoryTree handles parent first,
    // backfills parent_memory_id on children, links via PartOf edges.
    return [{ _tree: { parent, children } }];
  }

  _buildDocSummary(title, sections, markdown) {
    if (sections.length === 0) {
      return (markdown || '').slice(0, 1500);
    }
    const lines = [`Document "${title}" with ${sections.length} section${sections.length > 1 ? 's' : ''}.`, '', 'Sections:'];
    for (const s of sections.slice(0, 10)) {
      lines.push(`  - ${s.heading} (${s.content.length} chars)`);
    }
    if (sections.length > 10) lines.push(`  ... +${sections.length - 10} more`);
    return lines.join('\n');
  }

  _slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  dedupeKey(record) {
    // Doc id + modifiedTime → content hash idempotent across re-runs.
    return `gdocs:${record.id}:${record.modifiedTime || 'unknown'}`;
  }
}

export default GoogleDocsAdapter;
