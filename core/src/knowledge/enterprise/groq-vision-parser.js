/**
 * Groq Vision PDF parser — Tier 3.
 *
 * Renders each PDF page to a PNG via ImageMagick (`convert`), then sends
 * each page in parallel to the configured vision model for OCR + structure
 * extraction. Production prefers the low-latency OpenRouter model and keeps
 * Groq Scout as an independent fallback.
 *
 * Outputs markdown stitched in page order.
 *
 * Requires: GROQ_API_KEY env, `convert` (ImageMagick) on PATH.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const OPENROUTER_VISION_MODEL = process.env.HIVEMIND_VISION_OR_MODEL || process.env.GROQ_VISION_OR_MODEL || 'google/gemini-2.5-flash-lite';
const CONCURRENCY = Number(process.env.GROQ_VISION_CONCURRENCY || 8);
const MAX_PAGES = Number(process.env.GROQ_VISION_MAX_PAGES || 200);
const PAGE_DENSITY = process.env.GROQ_VISION_DENSITY || '150'; // DPI for the rasteriser
const execFileAsync = promisify(execFile);
const OCR_MAX_TOKENS = Number(process.env.HIVEMIND_VISION_OCR_MAX_TOKENS || 2600);

const SYSTEM_PROMPT = `You are an OCR + layout extractor. Read the entire page image and output clean Markdown:
- Use # / ## / ### for headings as in the source
- Format tables as Markdown tables
- Format lists with - or 1. 2. 3.
- Preserve names, dates, measurements, prices, units, codes, and table cells verbatim where readable.
- For diagrams or schematics, list visible labels and write a one-line relationship description.
- Do not summarise, omit content, or infer unreadable text. Mark unreadable fragments as [illegible].
- No commentary. Markdown only.

TRANSCRIBE, DO NOT AUTHOR. You are converting an image to text, not answering about it.
- Output ONLY what is visibly printed on this page. If it is not on the page, it does not
  go in the output.
- NEVER invent or "correct" a number, price, date, name, article number, unit or code. A
  wrong digit in a price or part number is worse than [illegible].
- Do not complete a truncated word, sentence or table row. Transcribe it as it appears.
- Do not carry over context from other pages, and do not add headings the page does not have.
- Blank or unreadable table cells stay blank. Do not guess a plausible value.
- If the page has no readable content, output exactly: [blank page]
- Keep the source language. Do not translate.`;

/**
 * @param {string} pdfPath
 * @returns {Promise<{text: string, pages: number, markdown: string, error: string|null}>}
 */
export async function parsePdfWithGroqVision(pdfPath) {
  if (!GROQ_KEY && !OPENROUTER_KEY) return { text: '', pages: 0, markdown: '', error: 'No vision provider API key set' };
  const workDir = path.join(os.tmpdir(), `vision-${crypto.randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    // Step 1: render each page to PNG.
    //
    // POPPLER FIRST, ImageMagick only as a fallback. `convert whole.pdf page-%03d.png` rasterises
    // the ENTIRE document through one pixel cache and dies on real uploads: measured on a 32-page
    // 16MB PDF, "cache resources exhausted @ error/cache.c/OpenPixelCache" against ImageMagick's
    // own ceilings (Memory 256MiB / Disk 1GiB — `identify -list resource`), which failed the whole
    // vision tier and left the document unparsed. Raising those ceilings only moves the cliff to a
    // slightly larger file; pdftoppm removes it, because poppler streams ONE PAGE AT A TIME with
    // bounded memory regardless of document size.
    //
    // `-l MAX_PAGES` also stops us rasterising 200 pages just to slice them away below.
    // Note: the ImageMagick path used `-trim`; pdftoppm has no equivalent, which is fine here —
    // trimming whitespace borders does not change what the vision model can read.
    // ASYNC, not execFileSync. The sync form BLOCKS THE EVENT LOOP for the whole render — up to the
    // 180s timeout — and the ingestion worker cannot answer anything while blocked, including
    // BullMQ's job-lock renewal. Observed together in one upload batch: the render error above and
    // four `[kb-queue] worker error: could not renew lock for job …`. A lost lock means the job is
    // considered stalled and re-run, so a blocking render does not just delay work, it duplicates it.
    let rendered = false;
    try {
      await execFileAsync('pdftoppm', [
        '-r', String(PAGE_DENSITY), '-png', '-f', '1', '-l', String(MAX_PAGES),
        pdfPath, path.join(workDir, 'page'),
      ], { timeout: 180_000, maxBuffer: 1 << 20 });
      rendered = true;
    } catch (popplerErr) {
      console.warn(`[groq-vision] pdftoppm failed (${popplerErr.message}) — falling back to ImageMagick`);
    }
    if (!rendered) {
      try {
        await execFileAsync('convert', [
          '-limit', 'memory', '1GiB', '-limit', 'map', '2GiB', '-limit', 'disk', '8GiB',
          '-density', PAGE_DENSITY, '-quality', '85', '-trim',
          pdfPath,
          path.join(workDir, 'page-%03d.png'),
        ], { timeout: 180_000, maxBuffer: 1 << 20 });
      } catch (renderErr) {
        return { text: '', pages: 0, markdown: '', error: `Render failed: ${renderErr.message}` };
      }
    }
    const pages = fs.readdirSync(workDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    if (!pages.length) return { text: '', pages: 0, markdown: '', error: 'No pages rendered' };

    const totalRendered = pages.length;
    const usePages = pages.slice(0, MAX_PAGES);
    const truncated = totalRendered > MAX_PAGES;
    if (truncated) {
      console.warn(`[groq-vision] truncating to ${MAX_PAGES} of ${totalRendered} pages (override via GROQ_VISION_MAX_PAGES)`);
    }

    // Step 2: parallel vision OCR with concurrency limit
    const results = new Array(usePages.length);
    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, usePages.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= usePages.length) return;
        const fp = path.join(workDir, usePages[i]);
        try {
          results[i] = await visionOcrPage(fp, i + 1);
        } catch (err) {
          results[i] = `<!-- page ${i + 1} failed: ${err.message} -->`;
        }
      }
    });
    await Promise.all(workers);

    const markdown = results.map((r, i) => `\n\n<!-- page ${i + 1} -->\n\n${r || ''}`).join('').trim();
    return {
      text: markdown,
      markdown,
      pages: usePages.length,
      totalPages: totalRendered,
      truncated,
      error: truncated ? `Truncated to ${MAX_PAGES} of ${totalRendered} pages — raise GROQ_VISION_MAX_PAGES to ingest more.` : null,
    };
  } finally {
    // Cleanup tmp dir
    try {
      for (const f of fs.readdirSync(workDir)) {
        try { fs.unlinkSync(path.join(workDir, f)); } catch {}
      }
      fs.rmdirSync(workDir);
    } catch {}
  }
}

/**
 * OCR a single image file (PNG/JPG/TIFF/WebP) via Groq vision.
 * Used for image-only uploads (no PDF render step needed).
 * @param {string} imagePath
 * @returns {Promise<{text:string, markdown:string, error:string|null}>}
 */
export async function ocrSingleImage(imagePath) {
  if (!GROQ_KEY && !OPENROUTER_KEY) return { text: '', markdown: '', error: 'No vision provider API key set' };
  try {
    const text = await visionOcrPage(imagePath, 1);
    return { text, markdown: text, error: null };
  } catch (err) {
    return { text: '', markdown: '', error: err.message };
  }
}

async function visionOcrPage(imagePath, pageNum) {
  const imageBuf = fs.readFileSync(imagePath);
  const b64 = imageBuf.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const body = {
    model: VISION_MODEL,
    temperature: 0.0,
    max_tokens: OCR_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SYSTEM_PROMPT + `\n\nThis is page ${pageNum}.` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const orKey = OPENROUTER_KEY;
  // Provider order. When Groq is billing-blocked/delinquent org-wide (every call
  // 400s "restricted because of overdue payment"), preferring OpenRouter skips the
  // always-failing Groq attempt + its noisy error + 60s timeout risk. Flag-gated
  // (VISION_OPENROUTER_PRIMARY or the global HYPER_OPENROUTER_PRIMARY); default
  // Groq-first for healthy accounts, OR as fallback either way.
  const orFirst = orKey && (
    String(process.env.VISION_OPENROUTER_PRIMARY ?? '').toLowerCase() === 'true'
    || String(process.env.HYPER_OPENROUTER_PRIMARY ?? '').toLowerCase() === 'true');

  // Retry up to 3× on 429/5xx with exponential backoff.
  const tryGroq = async () => {
    let err = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) { const json = await res.json(); return json.choices?.[0]?.message?.content || ''; }
      const txt = await res.text().catch(() => '');
      err = new Error(`Groq vision ${res.status}: ${txt.slice(0, 200)}`);
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 3) break;
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await new Promise(r => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 500 * Math.pow(2, attempt))));
    }
    throw err || new Error('Groq vision failed');
  };
  const tryOR = async () => {
    if (!orKey) throw new Error('OPENROUTER_API_KEY not set');
    const orModel = OPENROUTER_VISION_MODEL;
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://hivemind.davinciai.eu', 'X-Title': 'HIVEMIND' },
      body: JSON.stringify({ ...body, model: orModel }),
      signal: AbortSignal.timeout(60_000),
    });
    if (orRes.ok) { const json = await orRes.json(); const msg = json.choices?.[0]?.message || {}; return msg.content || msg.reasoning || ''; }
    throw new Error(`OpenRouter vision ${orRes.status}: ${(await orRes.text().catch(() => '')).slice(0, 200)}`);
  };

  const order = orFirst ? [tryOR, tryGroq] : [tryGroq, tryOR];
  let lastErr = null;
  for (const fn of order) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('vision OCR exhausted (Groq + OpenRouter)');
}
