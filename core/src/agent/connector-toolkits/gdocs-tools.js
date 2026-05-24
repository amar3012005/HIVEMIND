/**
 * Google Docs tool group — 3 minimal-surface tools.
 * Inactive by default. Activated via reset_equipped_tools.
 * Write tool routes through draft-approval middleware.
 */

import { nangoProxyFetch } from './nango-fetch.js';

const DOCS_PROVIDER = 'google-docs';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DOCS_API = 'https://docs.googleapis.com/v1';

const SKILL_NOTES = [
  'GOOGLE DOCS TOOLS — find and act on the user\'s Google Docs.',
  '  • gdocs_search(query) — full-text search across the user\'s Docs. Returns id + title + modified time.',
  '  • gdocs_read(doc_id) — full doc body as markdown (headings preserved).',
  '  • gdocs_create(title, markdown) — creates a new Doc. Routes through draft-approval.',
  'Tip: gdocs_search returns ≤10 docs ordered by modifiedTime desc.',
].join('\n');

export function registerGdocsTools(toolkit) {
  toolkit.createToolGroup({
    name: 'google-docs',
    description: 'Google Docs read + create tools (Nango-routed).',
    active: false,
    notes: SKILL_NOTES,
  });

  toolkit.registerToolFunction({
    name: 'gdocs_search',
    description: 'Search the user\'s Google Docs by full-text query. Returns id, title, modified time. Most-recent first.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query.' },
        max_results: { type: 'integer', description: 'Max docs to return (default 10, max 20).', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
    groupName: 'google-docs',
    readOnly: true,
    handler: async (args, ctx) => {
      const max = Math.min(Math.max(Number(args.max_results) || 10, 1), 20);
      const q = [
        "mimeType='application/vnd.google-apps.document'",
        'trashed=false',
        `fullText contains '${String(args.query).replace(/'/g, "\\'")}'`,
      ].join(' and ');
      const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=${max}&fields=${encodeURIComponent('files(id,name,modifiedTime,owners,webViewLink)')}`;
      const data = await nangoProxyFetch({ providerKey: DOCS_PROVIDER, url, ctx });
      return {
        count: data.files?.length || 0,
        docs: (data.files || []).map(f => ({
          doc_id: f.id,
          title: f.name,
          modified_at: f.modifiedTime,
          owner: f.owners?.[0]?.emailAddress || null,
          url: f.webViewLink,
        })),
      };
    },
  });

  toolkit.registerToolFunction({
    name: 'gdocs_read',
    description: 'Read a Google Doc body. Returns markdown with H1/H2/H3 headings preserved + per-section content.',
    parameters: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Doc ID from gdocs_search.' },
      },
      required: ['doc_id'],
    },
    groupName: 'google-docs',
    readOnly: true,
    handler: async (args, ctx) => {
      const url = `${DOCS_API}/documents/${encodeURIComponent(args.doc_id)}`;
      const doc = await nangoProxyFetch({ providerKey: DOCS_PROVIDER, url, ctx });
      const out = extractStructure(doc);
      return {
        doc_id: args.doc_id,
        title: doc.title,
        markdown: out.markdown.slice(0, 12000),
        sections: out.sections.slice(0, 30).map(s => ({ heading: s.heading, depth: s.depth, length: s.content.length })),
        truncated: out.markdown.length > 12000,
      };
    },
  });

  toolkit.registerToolFunction({
    name: 'gdocs_create',
    description: 'Create a NEW Google Doc with the given title and markdown body. Headings (#, ##, ###) convert to H1/H2/H3. Routes through draft-approval.',
    parameters: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Doc title.' },
        markdown: { type: 'string', description: 'Doc body in markdown. Use #, ##, ### for headings.' },
      },
      required: ['title', 'markdown'],
    },
    groupName: 'google-docs',
    readOnly: false,
    handler: async (args, ctx) => {
      // Step 1: create empty doc with title.
      const created = await nangoProxyFetch({
        providerKey: DOCS_PROVIDER,
        url: `${DOCS_API}/documents`,
        method: 'POST',
        body: { title: args.title },
        ctx,
      });
      const docId = created.documentId;
      // Step 2: batchUpdate to insert markdown→styled content.
      const requests = markdownToDocsRequests(args.markdown);
      if (requests.length > 0) {
        await nangoProxyFetch({
          providerKey: DOCS_PROVIDER,
          url: `${DOCS_API}/documents/${encodeURIComponent(docId)}:batchUpdate`,
          method: 'POST',
          body: { requests },
          ctx,
        });
      }
      return { created: true, doc_id: docId, url: `https://docs.google.com/document/d/${docId}/edit` };
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractStructure(doc) {
  const elements = doc.body?.content || [];
  const sections = [];
  let current = null;
  const md = [];
  for (const el of elements) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('').replace(/\n+$/, '');
    if (!text) continue;
    const style = p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    const heading = /^HEADING_[1-3]$/.test(style);
    if (heading) {
      if (current?.content?.trim()) sections.push(current);
      const depth = Number(style.split('_')[1]) || 2;
      md.push('', '#'.repeat(depth) + ' ' + text, '');
      current = { heading: text, depth, content: '' };
    } else {
      md.push(text);
      if (!current) current = { heading: 'Introduction', depth: 1, content: '' };
      current.content += (current.content ? '\n' : '') + text;
    }
  }
  if (current?.content?.trim()) sections.push(current);
  return { markdown: md.join('\n').trim(), sections };
}

function markdownToDocsRequests(markdown) {
  // Insert all text first, then apply heading styles per-paragraph.
  const text = String(markdown || '');
  if (!text.trim()) return [];
  const requests = [
    { insertText: { location: { index: 1 }, text: text + '\n' } },
  ];
  // Apply heading styles by scanning markdown line by line.
  let cursor = 1;
  for (const line of text.split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    const lineLen = line.length + 1; // +1 for newline
    if (m) {
      const depth = m[1].length;
      const named = `HEADING_${Math.min(depth, 3)}`;
      const startIdx = cursor;
      const endIdx = cursor + line.length;
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: startIdx, endIndex: endIdx + 1 },
          paragraphStyle: { namedStyleType: named },
          fields: 'namedStyleType',
        },
      });
    }
    cursor += lineLen;
  }
  return requests;
}
