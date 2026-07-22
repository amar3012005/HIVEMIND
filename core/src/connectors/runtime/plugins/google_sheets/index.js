// Connector Runtime V1 — Google Sheets plugin (connector-wise script).
// Wraps runGoogleTool (google-native.js) sheets operations.

import { GoogleFamilyPlugin, googleRead, googleWrite } from '../google-base.js';

const MAP = Object.freeze({
  google_sheets__get_range: 'sheets_get',
  google_sheets__create: 'sheets_create',
  google_sheets__append_rows: 'sheets_append',
});

export const GOOGLE_SHEETS_MANIFEST = {
  id: 'google_sheets',
  version: '1.0.0',
  displayName: 'Google Sheets',
  description: 'Read and write Google Sheets',
  authProvider: 'gdocs',
  connectionAliases: ['gsheets', 'google_sheets'],
  supportedSurfaces: ['chat', 'hyperagents', 'tara', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    googleRead('google_sheets__get_range',
      "Read a Google Sheet's cell values. args: spreadsheetId (or id), optional range (default A1:Z500). Returns { spreadsheetId, range, rows }.",
      { type: 'object', additionalProperties: false, properties: { spreadsheetId: { type: 'string' }, id: { type: 'string' }, range: { type: 'string' } } },
      'sheets_get'),
    googleWrite('google_sheets__create',
      'Create a new Google Sheet from a 2-D rows array (first row = headers). Returns spreadsheetId + url. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } }, required: ['title', 'rows'] },
      'sheets_create'),
    googleWrite('google_sheets__append_rows',
      'Append rows (2-D array) to an existing Google Sheet. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { spreadsheetId: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } }, required: ['spreadsheetId', 'rows'] },
      'sheets_append'),
  ],
};

function sourceIdsFor(name, payload) {
  try {
    if (payload.spreadsheetId) return [payload.spreadsheetId];
  } catch { /* ignore */ }
  return [];
}

export function createGoogleSheetsPlugin(deps = {}) {
  return new GoogleFamilyPlugin(GOOGLE_SHEETS_MANIFEST, MAP, { ...deps, sourceIdsFor });
}
