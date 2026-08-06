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

// THE PARSER MUST FINISH INSIDE THE JOB THAT OWNS IT.
//
// Docling's timeouts were configured independently of the queue's job timeout and
// exceeded it: smart convert 600s (equal to the WHOLE job budget) plus hybrid
// chunking 600s, against a 600s KB_QUEUE_JOB_TIMEOUT_MS. So a slow parse could
// never fail cleanly — the worker was killed mid-parse and the stale-job reaper
// recorded STALE_ABANDONED ("the worker was lost") with no real cause.
//
// Measured on a text-less 8KB PDF: groq-vision returned empty, Docling was used
// as the fallback, and the job burned 609s before being reaped. Not a crash, not
// a timeout the user could see — just a document that silently never ingested.
//
// Deriving the ceiling from the job budget makes the invariant structural rather
// than a coincidence of two env vars: raising KB_QUEUE_JOB_TIMEOUT_MS raises this
// automatically, and no override can push the parser past the job that owns it.
// The reserve covers everything AFTER parse (measured: promote ~25s, embed ~4s,
// plus segment writes and relationship passes).
const JOB_BUDGET_MS = Number(process.env.KB_QUEUE_JOB_TIMEOUT_MS || 600_000);
const PARSE_CEILING_MS = Math.max(
  30_000,
  Number(process.env.DOCLING_PARSE_CEILING_MS || Math.floor(JOB_BUDGET_MS * 0.55)),
);

/**
 * Collapse letter-spacing artifacts from designed/branded PDFs.
 *
 * Some PDFs carry a text layer with per-character tracking, so a title like
 * "GEMEINWOHL-BILANZ" extracts as "G E M E I N W O H L - B I L A N Z". Docling
 * preserves it faithfully — which then poisons embeddings, titles, and recall.
 * We collapse any run of >=4 single word-characters each separated by whitespace
 * back into a word. The single-char constraint means normal prose ("I am a x")
 * is never touched — only true letter-spacing runs match.
 */
export function collapseLetterSpacing(s) {
  if (!s || typeof s !== 'string') return s;
  // 1. Strip bytes Postgres cannot store: NUL (0x00) breaks text/jsonb
  //    inserts, and lone control chars from PDF text layers surface as
  //    "unexpected end of hex escape" on sourceMetadata.upsert() — aborting
  //    promotion (17/167). Keep \n \r \t; drop the rest of C0 + DEL + C1.
  let out = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  // 2. Collapse runs of >=5 single LETTERS (no digits/underscore) each
  //    separated by whitespace. Letter-only + min-5 protects numeric/tabular
  //    data (ledger cells "3 1 4 1 5", short lists "a b c d") while still
  //    collapsing real letter-spaced words ("G E M E I N" → "GEMEIN").
  out = out.replace(/(?<=^|\s)[^\W\d_](?:\s+[^\W\d_]){4,}(?=\s|$)/gu, (run) => run.replace(/\s+/g, ''));
  return out;
}

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
export async function parseWithDocling(filePath, filename, opts = {}) {
  const ext = path.extname(filename).toLowerCase();
  const formData = new FormData();

  // Docling expects "files" (plural) on both /v1/convert/file and /v1/chunk/hybrid/file
  formData.append('files', new Blob([fs.readFileSync(filePath)]), filename);

  // Smart-extract mode unlocks Docling's rich features: OCR, table structure,
  // code/formula/chart enrichment, picture classification.
  // Activated when user toggles Smart Extract OR for PDF/DOCX/XLSX which
  // benefit from layout-aware parsing.
  // The comment above has always described layout-aware parsing as automatic for
  // PDF/DOCX/XLSX — but the code only ever read opts.smart, and the KB upload path
  // never passes it. So the documented behaviour never once ran in production.
  //
  // Everything that makes a rich document worth ingesting lives inside the
  // `if (smart)` block below: OCR, table structure, chart extraction, picture
  // classification and picture DESCRIPTIONS. With smart false, a 54-page deck
  // parsed in 813ms via fast-pdf, its 7-row inverter matrix arrived as loose text,
  // and every figure was discarded — which also made the picture_descriptions
  // default from b59ce73d6 unreachable, since it is consumed in here.
  //
  // Ingest is async (202), so the extra parse time is invisible; the quality is
  // permanent. Layout-bearing formats now opt IN by default; opts.smart === false
  // still forces the fast path.
  const LAYOUT_FORMATS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);
  const smart = opts.smart === true
    || (opts.smart !== false
        && LAYOUT_FORMATS.has(ext)
        && String(process.env.DOCLING_SMART_BY_FORMAT ?? 'true').toLowerCase() !== 'false');
  // Each of these toggles downloads / runs a separate model. Tables+OCR are
  // fast and warm; the rest can balloon latency 5-10x. Opt-in individually.
  const wantPictureDesc = opts.picture_descriptions === true;
  const wantCharts = opts.charts === true;
  const wantCode = opts.code === true;
  const wantFormulas = opts.formulas === true;
  const wantPicClass = opts.picture_classification === true;
  if (smart) {
    // OCR and table structure are the two most expensive passes and are NOT
    // wanted by every format. The caller's per-format profile decides; absent a
    // profile both stay on, preserving the previous behaviour exactly.
    //
    // Why this matters: a real .pptx spent 600s and TIMED OUT running a
    // document-wide OCR + accurate-table pass over slides that have neither a
    // scanned text layer nor document tables. It only produced memories at all
    // because the hybrid chunker finished and the chunk-survival path kept its
    // output. Slides need picture description, not OCR.
    const wantOcr = opts.ocr !== false;
    const wantTables = opts.tables !== false;
    if (wantOcr) formData.append('do_ocr', 'true');
    if (wantTables) {
      formData.append('do_table_structure', 'true');
      formData.append('table_mode', 'accurate');
    }
    formData.append('pdf_backend', process.env.DOCLING_PDF_BACKEND || 'dlparse_v4');
    // Only meaningful when OCR actually runs; appending it otherwise is noise.
    // The default was 'de,en' — one tenant's languages baked into a multi-tenant
    // path, which quietly degrades OCR for every French, Spanish, Italian, Dutch
    // or Portuguese customer. Widened to the Latin-script set the engine ships,
    // still overridable per deployment via DOCLING_OCR_LANGS.
    if (wantOcr) {
      const ocrLangs = (process.env.DOCLING_OCR_LANGS || 'en,de,fr,es,it,nl,pt')
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const lang of ocrLangs) formData.append('ocr_lang', lang);
    }
    if (wantCharts)   formData.append('do_chart_extraction', 'true');
    if (wantPicClass) formData.append('do_picture_classification', 'true');
    if (wantCode)     formData.append('do_code_enrichment', 'true');
    if (wantFormulas) formData.append('do_formula_enrichment', 'true');
    if (wantPictureDesc && process.env.GROQ_API_KEY) {
      formData.append('do_picture_description', 'true');
      formData.append('enable_remote_services', 'true');
      formData.append('picture_description_custom_config', JSON.stringify({
        kind: 'api',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        params: { model: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct' },
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        prompt: 'Describe this figure in 1 short sentence (max 25 words). Focus on what is depicted, not styling.',
        timeout: 30,
      }));
      formData.append('picture_description_area_threshold', '0.05');
    }
    formData.append('md_page_break_placeholder', '\n-- {page} of {total} --\n');
  }

  // For large files OR smart-mode, use async + poll (Docling sync wait caps
  // at DOCLING_SERVE_MAX_SYNC_WAIT seconds internally).
  const fileSize = fs.statSync(filePath).size;
  const useAsync = smart || fileSize > 4 * 1024 * 1024; // >4 MB
  // Ceiling before the caller gives up and falls back to fast-pdf Tier 1.
  // Was 180s smart / 120s non-smart, hardcoded. A real 54-page deck blew the
  // non-smart ceiling ("Docling async polling timeout after 120000ms") and fell
  // back to fast-pdf, which flattens table cells — so its 7-row inverter matrix
  // reached the extractor as loose text and was never captured as a table.
  //
  // Ingest is ASYNCHRONOUS (upload returns 202), so parse duration is invisible
  // to the user while parse QUALITY decides everything downstream — a document is
  // extracted once and recalled forever. Spend the time here, not at query time.
  const overallTimeout = Math.min(
    Number(
      smart ? (process.env.DOCLING_SMART_TIMEOUT_MS || 600_000)
            : (process.env.DOCLING_TIMEOUT_MS || 420_000),
    ),
    PARSE_CEILING_MS,
  );

  try {
    if (useAsync) {
      const submitRes = await fetch(`${DOCLING_URL}/v1/convert/file/async`, {
        method: 'POST', body: formData,
        signal: AbortSignal.timeout(60_000),
      });
      if (!submitRes.ok) {
        return fallbackResult(`Docling async submit ${submitRes.status}: ${(await submitRes.text()).slice(0, 200)}`);
      }
      const submit = await submitRes.json();
      const taskId = submit.task_id || submit.task?.task_id || submit.id;
      if (!taskId) return fallbackResult(`Docling async submit missing task_id`);
      const deadline = Date.now() + overallTimeout;
      let pollDelay = 1500;
      // A 404 means the task is GONE, not "not ready yet" — docling-serve returns
      // the task record from submit onwards, so the only way it disappears is the
      // worker dying mid-conversion (OOM on a large enriched PDF, taking the
      // in-flight task with it). Treated as a transient blip by `continue`, that
      // turned a crash into a full-timeout stall: observed burning the entire
      // 600s on a 54-page deck while every poll 404'd, then falling back anyway.
      // Allow a short grace for registration lag, then fail fast to the fallback.
      const MAX_404 = Number(process.env.DOCLING_POLL_MAX_404 || 3);
      let notFound = 0;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollDelay));
        const statusRes = await fetch(`${DOCLING_URL}/v1/status/poll/${taskId}`).catch(() => null);
        if (statusRes && statusRes.status === 404) {
          if (++notFound >= MAX_404) {
            return fallbackResult(
              `Docling task ${taskId} vanished (${notFound}× 404) — worker likely died mid-conversion; `
              + `check hm-docling mem_limit and restart count`);
          }
          continue;
        }
        if (statusRes && statusRes.ok) notFound = 0;
        if (!statusRes || !statusRes.ok) continue;
        const status = await statusRes.json().catch(() => ({}));
        const taskStatus = status.task_status || status.status;
        if (taskStatus === 'success' || taskStatus === 'completed') break;
        if (taskStatus === 'failed' || taskStatus === 'error') {
          return fallbackResult(`Docling async failed: ${JSON.stringify(status).slice(0, 200)}`);
        }
        pollDelay = Math.min(pollDelay * 1.5, 5000);
      }
      if (Date.now() >= deadline) {
        return fallbackResult(`Docling async polling timeout after ${overallTimeout}ms`);
      }
      const resultRes = await fetch(`${DOCLING_URL}/v1/result/${taskId}`);
      if (!resultRes.ok) {
        return fallbackResult(`Docling result ${resultRes.status}`);
      }
      const data = await resultRes.json();
      const doc = data.document || data;
      // docling-serve returns md_content / text_content — NOT markdown / text. Reading
      // the wrong field made EVERY docling parse look empty (chars=0, chunks=0, no error),
      // so every PDF silently fell through to fast-pdf (letter-spaced) or vision. Verified
      // by calling /v1/convert/file directly: md_len 28237, text_len 0 on an 11-page PDF.
      return {
        markdown: collapseLetterSpacing(data.md_content || doc.md_content || data.markdown || doc.markdown || ''),
        text: collapseLetterSpacing(data.text_content || doc.text_content || data.md_content || doc.md_content || data.text || doc.text || ''),
        json: doc,
        tables: extractTablesFromDocling(doc),
        pages: Array.isArray(data.pages) ? data.pages.length : (doc.num_pages || 1),
        confidence: data.confidence ?? doc.confidence ?? null,
        error: null,
      };
    }

    const res = await fetch(`${DOCLING_URL}/v1/convert/file`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(overallTimeout),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown error');
      return fallbackResult(`Docling returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const doc = data.document || data;

    // SYNC path had the same defect as async: export_to_markdown/export_to_text are
    // PYTHON methods that never exist across HTTP, so it always fell to data.markdown —
    // a field docling-serve does not send. md_content / text_content are the real ones.
    return {
      markdown: collapseLetterSpacing(typeof doc.export_to_markdown === 'function'
        ? doc.export_to_markdown() || ''
        : (data.md_content || doc.md_content || data.markdown || '')),
      text: collapseLetterSpacing(typeof doc.export_to_text === 'function'
        ? doc.export_to_text() || ''
        : (data.text_content || doc.text_content || data.md_content || doc.md_content || data.text || '')),
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
  // Docling hybrid chunker expects "files" (plural), unlike /v1/convert which uses "file"
  formData.append('files', new Blob([fs.readFileSync(filePath)]), filename);
  // Match embedder context window (BGE-M3 → 512 tokens). Repeat table header
  // across split chunks so each row keeps its column names.
  formData.append('max_tokens', String(Number(process.env.DOCLING_CHUNK_MAX_TOKENS || 512)));
  formData.append('merge_peers', 'true');
  formData.append('repeat_table_header', 'true');
  try {
    // This endpoint is SYNCHRONOUS and re-converts the document to chunk it, so it
    // costs roughly what the parse costs — on a 54-page enriched PDF the parse
    // alone took 228s, and 180s here aborted the chunker while the parse was still
    // succeeding. The caller runs parse+chunk under Promise.all, so both must be
    // allowed to outlive a slow document or the pair is discarded and the whole
    // upload silently degrades to fast-pdf. Server side must also permit it:
    // DOCLING_SERVE_MAX_SYNC_WAIT (900s in compose).
    const res = await fetch(`${DOCLING_URL}/v1/chunk/hybrid/file`, {
      method: 'POST',
      body: formData,
      // Same ceiling as convert (see PARSE_CEILING_MS): chunking used to allow a
      // further 600s AFTER a convert that could already consume the entire job
      // budget, so the two together could reach 1200s inside a 600s job.
      signal: AbortSignal.timeout(Math.min(
        Number(process.env.DOCLING_CHUNK_TIMEOUT_MS || 600_000),
        PARSE_CEILING_MS,
      )),
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
      const text = collapseLetterSpacing(c.text || c.content || c.body || (typeof c === 'string' ? c : ''));
      const meta = c.meta || c.metadata || {};
      const headings = Array.isArray(c.headings) ? c.headings
        : Array.isArray(meta.headings) ? meta.headings
        : [];
      // Docling returns page_numbers: number[] — pick first if present
      const page = Array.isArray(c.page_numbers) && c.page_numbers.length
        ? c.page_numbers[0]
        : (meta.page || meta.page_no || c.page || null);
      return {
        text,
        headings,
        page,
        meta: { ...meta, num_tokens: c.num_tokens || null, doc_items: c.doc_items || null },
      };
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
