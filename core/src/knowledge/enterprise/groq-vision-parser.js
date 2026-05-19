/**
 * Groq Vision PDF parser — Tier 3.
 *
 * Renders each PDF page to a PNG via ImageMagick (`convert`), then sends
 * each page in parallel to a Groq vision model (default
 * `meta-llama/llama-4-scout-17b-16e-instruct`) for OCR + structure extraction.
 *
 * Outputs markdown stitched in page order.
 *
 * Requires: GROQ_API_KEY env, `convert` (ImageMagick) on PATH.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import crypto from 'crypto';

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const CONCURRENCY = Number(process.env.GROQ_VISION_CONCURRENCY || 4);
const MAX_PAGES = Number(process.env.GROQ_VISION_MAX_PAGES || 30);
const PAGE_DENSITY = process.env.GROQ_VISION_DENSITY || '150'; // DPI for convert

const SYSTEM_PROMPT = `You are an OCR + layout extractor. Read the entire page image and output clean Markdown:
- Use # / ## / ### for headings as in the source
- Format tables as Markdown tables
- Format lists with - or 1. 2. 3.
- Inline product names, prices, codes verbatim
- For diagrams or schematics, write a 1-line description
- Do not summarise or omit content. Extract everything readable.
- No commentary. Markdown only.`;

/**
 * @param {string} pdfPath
 * @returns {Promise<{text: string, pages: number, markdown: string, error: string|null}>}
 */
export async function parsePdfWithGroqVision(pdfPath) {
  if (!GROQ_KEY) return { text: '', pages: 0, markdown: '', error: 'GROQ_API_KEY not set' };
  const workDir = path.join(os.tmpdir(), `vision-${crypto.randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    // Step 1: render each page to PNG
    // `-density 150` then `convert PDF PNG` produces page-N.png files
    try {
      execFileSync('convert', [
        '-density', PAGE_DENSITY, '-quality', '85', '-trim',
        pdfPath,
        path.join(workDir, 'page-%03d.png'),
      ], { stdio: 'pipe', timeout: 180_000 });
    } catch (renderErr) {
      return { text: '', pages: 0, markdown: '', error: `Render failed: ${renderErr.message}` };
    }
    const pages = fs.readdirSync(workDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    if (!pages.length) return { text: '', pages: 0, markdown: '', error: 'No pages rendered' };

    const usePages = pages.slice(0, MAX_PAGES);

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
      error: null,
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

async function visionOcrPage(imagePath, pageNum) {
  const imageBuf = fs.readFileSync(imagePath);
  const b64 = imageBuf.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const body = {
    model: VISION_MODEL,
    temperature: 0.0,
    max_tokens: 4096,
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

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq vision ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}
