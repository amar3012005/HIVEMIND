/**
 * Cloudflare Gemini Vision PDF parser — Tier 3.
 *
 * Renders each PDF page to a PNG via ImageMagick (`convert`), then sends
 * each page in parallel to Cloudflare's Gemini 2.5 Flash-Lite model for OCR +
 * structure extraction. The `hivemind-prod` AI Gateway remains the telemetry,
 * policy and cost-control boundary; OpenRouter and Groq are not OCR fallbacks.
 *
 * Outputs markdown stitched in page order.
 *
 * Requires: a direct provider key or Cloudflare AI Gateway BYOK alias, plus
 * `pdftoppm` (preferred) or `convert` (ImageMagick) on PATH.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
const cloudflareVisionConfig = () => ({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  token: process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '',
  gatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID || 'hivemind-prod',
  model: process.env.HIVEMIND_CLOUDFLARE_VISION_MODEL || 'google/gemini-2.5-flash-lite',
});
const CONCURRENCY = Number(process.env.GROQ_VISION_CONCURRENCY || 8);
const MAX_PAGES = Number(process.env.GROQ_VISION_MAX_PAGES || 200);
const PAGE_DENSITY = process.env.GROQ_VISION_DENSITY || '150'; // DPI for the rasteriser
const execFileAsync = promisify(execFile);
const OCR_MAX_TOKENS = Number(process.env.HIVEMIND_VISION_OCR_MAX_TOKENS || 2600);
const RENDER_TIMEOUT_MS = Number(process.env.GROQ_VISION_RENDER_TIMEOUT_MS || 300_000);

export function visionProviderAvailable() {
  const { accountId, token } = cloudflareVisionConfig();
  return Boolean(accountId && token);
}

// PDF rasterisation is CPU, RAM and temporary-disk heavy. Ingestion admits
// multiple tenant jobs concurrently, so allowing every vision document to run
// pdftoppm at once makes healthy jobs starve each other and pushes them into the
// much heavier ImageMagick fallback. A small bounded pool keeps useful CPU
// concurrency without turning rasterisation into a single global convoy.
const RENDER_CONCURRENCY = Math.max(1, Number(process.env.HIVEMIND_PDF_RENDER_CONCURRENCY || 2));
let activeRenderers = 0;
const renderWaiters = [];
export async function withPdfRenderSlot(task) {
  const queuedAt = Date.now();
  if (activeRenderers >= RENDER_CONCURRENCY) {
    await new Promise((resolve) => renderWaiters.push(resolve));
  } else {
    activeRenderers += 1;
  }
  const waitMs = Date.now() - queuedAt;
  if (waitMs >= 100) console.log(`[groq-vision] render slot acquired wait_ms=${waitMs} queued=${renderWaiters.length}`);
  try {
    return await task();
  } finally {
    const next = renderWaiters.shift();
    if (next) next(); // transfer the occupied slot directly to the oldest waiter
    else activeRenderers -= 1;
  }
}

async function renderPdfPages(pdfPath, workDir, pageNumbers = null) {
  let rendered = false;
  try {
    if (Array.isArray(pageNumbers) && pageNumbers.length) {
      for (const page of pageNumbers) {
        await execFileAsync('pdftoppm', [
          '-r', String(PAGE_DENSITY), '-png', '-singlefile', '-f', String(page), '-l', String(page),
          pdfPath, path.join(workDir, `page-${page}`),
        ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1 << 20 });
      }
    } else {
      await execFileAsync('pdftoppm', [
        '-r', String(PAGE_DENSITY), '-png', '-f', '1', '-l', String(MAX_PAGES),
        pdfPath, path.join(workDir, 'page'),
      ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1 << 20 });
    }
    rendered = true;
  } catch (popplerErr) {
    console.warn(`[groq-vision] pdftoppm failed (${popplerErr.message}) — falling back to ImageMagick`);
  }
  if (!rendered) {
    try {
      if (Array.isArray(pageNumbers) && pageNumbers.length) {
        for (const page of pageNumbers) {
          await execFileAsync('convert', [
            '-limit', 'memory', '1GiB', '-limit', 'map', '2GiB', '-limit', 'disk', '8GiB',
            '-density', PAGE_DENSITY, '-quality', '85', '-trim',
            `${pdfPath}[${page - 1}]`, path.join(workDir, `page-${page}.png`),
          ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1 << 20 });
        }
      } else {
        await execFileAsync('convert', [
          '-limit', 'memory', '1GiB', '-limit', 'map', '2GiB', '-limit', 'disk', '8GiB',
          '-density', PAGE_DENSITY, '-quality', '85', '-trim',
          pdfPath,
          path.join(workDir, 'page-%03d.png'),
        ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1 << 20 });
      }
    } catch (renderErr) {
      return { error: `Render failed: ${renderErr.message}` };
    }
  }
  return { error: null };
}

// Use Poppler's object inventory to select only pages that contain a
// substantial raster image. Tiny logos/icons are ignored. This lets a PDF with
// a healthy text layer keep its fast lexical extraction while diagrams and
// scanned inserts receive vision enrichment page-by-page.
export async function detectVisualPdfPages(pdfPath) {
  try {
    const { stdout } = await execFileAsync('pdfimages', ['-list', pdfPath], {
      timeout: 30_000, maxBuffer: 4 << 20,
    });
    const pages = new Set();
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      const page = Number(fields[0]);
      const width = Number(fields[3]);
      const height = Number(fields[4]);
      if (Number.isInteger(page) && page > 0 && width * height >= 250_000) pages.add(page);
    }
    return [...pages].sort((a, b) => a - b).slice(0, MAX_PAGES);
  } catch {
    return [];
  }
}

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
export async function parsePdfWithGroqVision(pdfPath, { pageNumbers = null } = {}) {
  if (!visionProviderAvailable()) return { text: '', pages: 0, markdown: '', error: 'No vision provider or AI Gateway BYOK alias set' };
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
    const selectedPages = Array.isArray(pageNumbers) && pageNumbers.length
      ? [...new Set(pageNumbers.map(Number).filter((page) => page > 0))].sort((a, b) => a - b)
      : null;
    const render = await withPdfRenderSlot(() => renderPdfPages(pdfPath, workDir, selectedPages));
    if (render.error) return { text: '', pages: 0, markdown: '', error: render.error };
    const pages = fs.readdirSync(workDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    if (!pages.length) return { text: '', pages: 0, markdown: '', error: 'No pages rendered' };

    const totalRendered = pages.length;
    const usePages = pages.slice(0, MAX_PAGES);
    const actualPageNumbers = selectedPages || usePages.map((_, index) => index + 1);
    const truncated = totalRendered > MAX_PAGES;
    if (truncated) {
      console.warn(`[groq-vision] truncating to ${MAX_PAGES} of ${totalRendered} pages (override via GROQ_VISION_MAX_PAGES)`);
    }

    // Step 2: parallel vision OCR with concurrency limit
    const results = new Array(usePages.length);
    const failures = [];
    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, usePages.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= usePages.length) return;
        const fp = path.join(workDir, usePages[i]);
        try {
          results[i] = await visionOcrPage(fp, actualPageNumbers[i] || i + 1);
        } catch (err) {
          // Provider failures are control-plane data, never document content.
          // The old HTML comment was persisted, embedded, and returned by recall.
          failures.push({ page: actualPageNumbers[i] || i + 1, message: String(err?.message || err).slice(0, 240) });
        }
      }
    });
    await Promise.all(workers);

    const markdown = results
      .map((r, i) => r ? `\n\n<!-- page ${actualPageNumbers[i] || i + 1} -->\n\n${r}` : '')
      .join('').trim();
    const failureMessage = failures.length
      ? `Vision OCR failed for ${failures.length}/${usePages.length} selected pages; successful pages were preserved.`
      : null;
    return {
      text: markdown,
      markdown,
      pages: selectedPages ? results.filter(Boolean).length : totalRendered,
      totalPages: totalRendered,
      truncated,
      failedPages: failures,
      error: failureMessage || (truncated ? `Truncated to ${MAX_PAGES} of ${totalRendered} pages — raise GROQ_VISION_MAX_PAGES to ingest more.` : null),
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
  if (!visionProviderAvailable()) return { text: '', markdown: '', error: 'No vision provider or AI Gateway BYOK alias set' };
  try {
    const text = await visionOcrPage(imagePath, 1);
    return { text, markdown: text, error: null };
  } catch (err) {
    return { text: '', markdown: '', error: err.message };
  }
}

async function visionOcrPage(imagePath, pageNum) {
  const { accountId, token, gatewayId, model } = cloudflareVisionConfig();
  const imageBuf = fs.readFileSync(imagePath);
  const b64 = imageBuf.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const body = {
    model,
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

  if (!visionProviderAvailable()) throw new Error('Cloudflare Gemini vision is not configured');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
  let lastError = null;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'cf-aig-gateway-id': gatewayId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.ok) {
      const json = await response.json();
      const content = String(json?.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error('Cloudflare Gemini vision returned empty content');
      return content;
    }
    const details = await response.text().catch(() => '');
    lastError = new Error(`Cloudflare Gemini vision ${response.status}: ${details.slice(0, 200)}`);
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt === 3) break;
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    await new Promise((resolve) => setTimeout(resolve,
      retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 500 * (2 ** attempt))));
  }
  throw lastError || new Error('Cloudflare Gemini vision failed');
}
