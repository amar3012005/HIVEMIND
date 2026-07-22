// Connector Runtime V1 — Google Docs plugin (connector-wise script).
// Wraps the existing runGoogleTool (google-native.js) docs operations. Reads
// immediate; writes (create/append) go through the approval pipeline.

import { GoogleFamilyPlugin, googleRead, googleWrite } from '../google-base.js';

const MAP = Object.freeze({
  google_docs__search: 'drive_search',
  google_docs__get: 'docs_get',
  google_docs__create: 'docs_create',
  google_docs__append: 'docs_append',
});

export const GOOGLE_DOCS_MANIFEST = {
  id: 'google_docs',
  version: '1.0.0',
  displayName: 'Google Docs',
  description: 'Search, read, and create Google Docs',
  authProvider: 'gdocs',
  connectionAliases: ['gdocs', 'google_docs', 'google-drive', 'gdrive'],
  supportedSurfaces: ['chat', 'hyperagents', 'tara', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    googleRead('google_docs__search',
      'Search Google Drive (docs, sheets, slides, files) by name/content. Returns id/name/type/url.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 25, default: 8 } }, required: ['query'] },
      'drive_search'),
    googleRead('google_docs__get',
      "Read an existing Google Doc's plain text by id. Returns { documentId, title, text }.",
      { type: 'object', additionalProperties: false, properties: { documentId: { type: 'string' }, id: { type: 'string' } } },
      'docs_get'),
    googleWrite('google_docs__create',
      'Create a new Google Doc from markdown content. Returns documentId + url. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
      'docs_create'),
    googleWrite('google_docs__append',
      'Append text to the end of an existing Google Doc. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { documentId: { type: 'string' }, text: { type: 'string' } }, required: ['documentId', 'text'] },
      'docs_append'),
  ],
};

function sourceIdsFor(name, payload) {
  try {
    if (name === 'google_docs__search') return (payload.files || payload.results || []).map((f) => f.id).filter(Boolean);
    if (name === 'google_docs__get') return payload.documentId ? [payload.documentId] : [];
    if (name === 'google_docs__create') return payload.documentId ? [payload.documentId] : [];
  } catch { /* ignore */ }
  return [];
}

export function createGoogleDocsPlugin(deps = {}) {
  return new GoogleFamilyPlugin(GOOGLE_DOCS_MANIFEST, MAP, { ...deps, sourceIdsFor });
}
