/**
 * Docling adapter — thin wrapper around the Docling sidecar HTTP API.
 *
 * Sends a file to the Docling docker service, receives structured parse output,
 * and normalises it for use by enterprise detector/extractor.
 *
 * Docling runs CPU-only by default; GPU optional for higher throughput.
 */

import fs from 'fs';
import path from 'path';

const DOCLING_URL = process.env.DOCLING_URL || 'http://docling:5001';

/**
 * Parse a file with the Docling sidecar.
 *
 * @param {string} filePath — absolute temp path
 * @param {string} filename — original filename (for mime hint)
 * @returns {Promise<{
 *   markdown: string,
 *   text: string,
 *   json: object,
 *   tables: Array<{ sheet: string, headers: string[], rows: any[][] }>,
 *   pages: number,
 *   confidence: number | null,
 *   error: string | null
 * }>}
 */
export async function parseWithDocling(filePath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const formData = new FormData();

  formData.append('file', new Blob([fs.readFileSync(filePath)]), filename);

  try {
    const res = await fetch(`${DOCLING_URL}/v1/convert/file`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown error');
      return fallbackResult(`Docling returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const doc = data.document || data;

    return {
      markdown: typeof doc.export_to_markdown === 'function'
        ? doc.export_to_markdown() || ''
        : data.markdown || '',
      text: typeof doc.export_to_text === 'function'
        ? doc.export_to_text() || ''
        : data.text || '',
      json: doc,
      tables: extractTablesFromDocling(doc),
      pages: Array.isArray(data.pages) ? data.pages.length : (doc.num_pages || 1),
      confidence: data.confidence ?? doc.confidence ?? null,
      error: null,
    };
  } catch (err) {
    return fallbackResult(`Docling parse error: ${err.message}`);
  }
}

/**
 * Structure-aware chunking via Docling's hybrid chunker.
 * Returns array of chunks with heading + metadata.
 *
 * @param {string} filePath
 * @param {string} filename
 * @returns {Promise<{chunks: Array<{text: string, headings: string[], page: number|null, meta: object}>, error: string|null}>}
 */
export async function chunkWithDocling(filePath, filename) {
  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(filePath)]), filename);
  try {
    const res = await fetch(`${DOCLING_URL}/v1/chunk/hybrid/file`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      return { chunks: [], error: `chunker ${res.status}: ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const rawChunks = Array.isArray(data?.chunks) ? data.chunks
      : Array.isArray(data?.document?.chunks) ? data.document.chunks
      : Array.isArray(data) ? data : [];
    const chunks = rawChunks.map(c => {
      const text = c.text || c.content || c.body || (typeof c === 'string' ? c : '');
      const meta = c.meta || c.metadata || {};
      const headings = Array.isArray(meta.headings) ? meta.headings
        : Array.isArray(c.headings) ? c.headings
        : [];
      const page = meta.page || meta.page_no || c.page || null;
      return { text, headings, page, meta };
    }).filter(c => c.text && c.text.trim().length > 0);
    return { chunks, error: null };
  } catch (err) {
    return { chunks: [], error: `chunker error: ${err.message}` };
  }
}

/**
 * Parse via Docling, but only for text+dumb markdown extraction.
 * Falls back to plain file read if Docling call fails.
 * Used for non-smart (standard) uploads.
 */
export async function parseTextWithDocling(filePath, filename) {
  const result = await parseWithDocling(filePath, filename);
  if (result.error) {
    // fallback: plain text read
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { text: raw, markdown: raw };
  }
  return { text: result.text || result.markdown, markdown: result.markdown };
}

// ── Internal helpers ──────────────────────────────────────────────────

function extractTablesFromDocling(doc) {
  const tables = [];
  const rawTables = doc.tables || [];

  for (let i = 0; i < rawTables.length; i++) {
    const t = rawTables[i];
    const headers = (t.data?.grid || []).slice(0, 1).flat().map(c =>
      typeof c === 'object' ? (c.text || '') : String(c || '')
    );
    const rows = (t.data?.grid || []).slice(1).map(row =>
      row.map(c => typeof c === 'object' ? (c.text || '') : String(c || ''))
    );
    tables.push({
      sheet: `Table_${i + 1}`,
      headers,
      rows,
    });
  }
  return tables;
}

function fallbackResult(reason) {
  console.warn(`[docling] ${reason}`);
  return {
    markdown: '',
    text: '',
    json: null,
    tables: [],
    pages: 0,
    confidence: null,
    error: reason,
  };
}
