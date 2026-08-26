import crypto from 'crypto';

import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';

const MAX_HTML_BYTES = 200_000;
const SOURCE_PLATFORM = 'hyper_room_artifact';
const DEFAULT_VISUAL_CRITIC_MODEL = 'google/gemini-2.5-flash-lite';
const VISUAL_QUALITY_PASS_SCORE = 80;

export function hyperArtifactsEnabled() {
  const value = process.env.Visual_path_In_Hyperrooms
    ?? process.env.VISUAL_PATH_IN_HYPERROOMS
    ?? 'false';
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function validateHyperArtifactHtml(html) {
  const errors = [];
  const bytes = Buffer.byteLength(html || '', 'utf8');
  if (!/^\s*<!doctype html>/i.test(html)) errors.push('Document must begin with <!doctype html>.');
  if (bytes < 800) errors.push('Document is too small to be a complete designed artifact.');
  if (bytes > MAX_HTML_BYTES) errors.push(`Document exceeds ${MAX_HTML_BYTES} bytes.`);
  if (!/<meta\s+[^>]*name=["']viewport["']/i.test(html)) errors.push('Viewport meta tag is required.');
  if (!/<h1(?:\s|>)/i.test(html)) errors.push('One primary h1 heading is required.');
  if (!/<style(?:\s|>)/i.test(html)) errors.push('A self-contained visual design system is required.');
  const visibleText = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  if (/\*\*|(?:^|\s)#{1,6}\s/.test(visibleText)) {
    errors.push('Rendered copy contains raw Markdown residue.');
  }
  if (/\(\s*source\s*\)/i.test(visibleText)) {
    errors.push('Replace generic (source) placeholders with meaningful evidence labels.');
  }
  const visualExplanations = String(html || '').match(/<(?:svg|figure|table|canvas|meter|progress)\b/gi) || [];
  if (visualExplanations.length < 1) {
    errors.push('Artifact needs at least one meaningful visual explanation (figure, chart, table, diagram, or timeline).');
  }
  const blocked = [
    [/<script\b[^>]*\bsrc\s*=/i, 'External scripts are forbidden.'],
    [/<(?:iframe|object|embed|form|base)\b/i, 'iframes, objects, embeds, forms, and base tags are forbidden.'],
    [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, 'Meta refresh is forbidden.'],
    [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i, 'Network APIs are forbidden.'],
    [/\b(?:localStorage|sessionStorage|document\.cookie)\b/i, 'Browser credential and storage APIs are forbidden.'],
    [/(?:\bsrc\s*=|<link\b[^>]*\bhref\s*=)\s*["']\s*(?:https?:)?\/\//i, 'External loaded assets are forbidden.'],
    [/url\(\s*["']?\s*(?:https?:)?\/\//i, 'External CSS assets are forbidden.'],
  ];
  for (const [pattern, message] of blocked) if (pattern.test(html)) errors.push(message);
  return [...new Set(errors)];
}

export function validateHyperArtifactMedium(html, intent = {}) {
  const errors = [];
  if (intent?.kind === 'presentation') {
    const slides = String(html || '').match(
      /<section\b[^>]*(?:\bdata-slide(?:\s*=|\s|>)|\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["'])/gi,
    ) || [];
    if (slides.length < 3) {
      errors.push(`Presentation must contain at least three semantic slide sections; found ${slides.length}.`);
    }
    if (!/(?:aria-label\s*=\s*["'][^"']*(?:next|previous)|data-(?:next|previous)|class\s*=\s*["'][^"']*\b(?:next|previous)-slide\b)/i.test(html)) {
      errors.push('Presentation requires accessible next/previous slide navigation.');
    }
    if (!/@media\s+print/i.test(html) || !/(?:break-after|page-break-after)\s*:/i.test(html)) {
      errors.push('Presentation requires print-friendly slide page breaks.');
    }
  }
  return errors;
}

let browserPromise;
async function browserInstance() {
  if (!browserPromise) {
    browserPromise = import('puppeteer').then(({ default: puppeteer }) => puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      userDataDir: '/tmp/hivemind-artifact-browser',
      env: { ...process.env, HOME: '/tmp' },
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-breakpad', '--disable-crash-reporter', '--no-first-run',
      ],
    })).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function inspectViewport(page, viewport) {
  await page.setViewport(viewport);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const metrics = await page.evaluate(() => {
    const body = document.body;
    const text = String(body?.innerText || '').trim();
    const candidates = [...document.querySelectorAll('h1,h2,h3,p,li,button,a,label,output')]
      .filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      });
    let overlaps = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const a = candidates[i];
      const ar = a.getBoundingClientRect();
      for (let j = i + 1; j < candidates.length; j += 1) {
        const b = candidates[j];
        if (a.contains(b) || b.contains(a)) continue;
        const br = b.getBoundingClientRect();
        const x = Math.max(0, Math.min(ar.right, br.right) - Math.max(ar.left, br.left));
        const y = Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
        if (x * y > 80) overlaps += 1;
      }
    }
    return {
      text_chars: text.length,
      element_count: document.querySelectorAll('*').length,
      horizontal_overflow: Math.max(document.documentElement.scrollWidth, body?.scrollWidth || 0) > window.innerWidth + 2,
      scroll_width: Math.max(document.documentElement.scrollWidth, body?.scrollWidth || 0),
      scroll_height: Math.max(document.documentElement.scrollHeight, body?.scrollHeight || 0),
      overlap_count: overlaps,
      h1_count: document.querySelectorAll('h1').length,
    };
  });
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 68, fullPage: false });
  return { ...metrics, screenshot: screenshot.toString('base64') };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

export async function reviewHyperArtifactVisualQuality({
  desktopScreenshot,
  mobileScreenshot,
  intent = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!desktopScreenshot || !mobileScreenshot) {
    return { reviewed: false, passed: true, reason: 'screenshots_unavailable' };
  }
  const model = String(
    process.env.HYPER_VISUAL_CRITIC_MODEL
      || process.env.HIVEMIND_VISION_OR_MODEL
      || DEFAULT_VISUAL_CRITIC_MODEL,
  ).trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await gatewayFirstFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.OPENROUTER_API_KEY
          ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
          : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You are the acceptance reviewer for a premium, purpose-authored HTML artifact.',
              'Judge the screenshots, not the intent of the author. A technically valid report template is not enough.',
              'Pass only work that could be shown to a demanding executive without apology.',
              'Score visual hierarchy, first-viewport thesis, purpose-specific composition, information design,',
              'typography, spacing, density, responsive adaptation, and polish.',
              'Reject stacked generic cards, crude diagrams, huge empty areas, raw markup, placeholder citations,',
              'decorative metrics without evidence, collapsed primary content, and controls that look unfinished.',
              'Do not require a particular theme, color palette, illustration style, or external imagery.',
              'Return JSON only: {"pass":boolean,"score":integer_0_to_100,"issues":[up_to_5_specific_repair_instructions],"strengths":[up_to_3_strings]}.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Artifact intent: ${JSON.stringify(intent || {}).slice(0, 3000)}\nReview desktop and mobile together. The minimum passing score is ${VISUAL_QUALITY_PASS_SCORE}.`,
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${desktopScreenshot}` } },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${mobileScreenshot}` } },
            ],
          },
        ],
      }),
    }, { fetchImpl });
    if (!response.ok) throw new Error(`visual_critic_http_${response.status}`);
    const payload = await response.json();
    const verdict = parseJsonObject(payload?.choices?.[0]?.message?.content);
    if (!verdict || !Number.isFinite(Number(verdict.score)) || typeof verdict.pass !== 'boolean') {
      throw new Error('visual_critic_invalid_response');
    }
    const score = Math.max(0, Math.min(100, Math.round(Number(verdict.score))));
    const issues = Array.isArray(verdict.issues)
      ? verdict.issues.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
      : [];
    const strengths = Array.isArray(verdict.strengths)
      ? verdict.strengths.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      reviewed: true,
      passed: verdict.pass && score >= VISUAL_QUALITY_PASS_SCORE,
      score,
      issues,
      strengths,
      model,
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'hyper_artifact.visual_review_unavailable',
      error: String(error?.message || error).slice(0, 300),
    }));
    return { reviewed: false, passed: true, reason: 'critic_unavailable', model };
  } finally {
    clearTimeout(timeout);
  }
}

async function renderAndValidate(html, intent) {
  const errors = [
    ...validateHyperArtifactHtml(html),
    ...validateHyperArtifactMedium(html, intent),
  ];
  if (errors.length) return { ok: false, errors };
  const browser = await browserInstance();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error.message || error).slice(0, 500)));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (/^(?:data|blob|about):/i.test(url)) request.continue();
    else request.abort('blockedbyclient');
  });
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const desktop = await inspectViewport(page, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    const mobile = await inspectViewport(page, { width: 390, height: 844, deviceScaleFactor: 1 });
    if (desktop.text_chars < 120) errors.push('Rendered desktop artifact is effectively blank.');
    if (mobile.text_chars < 120) errors.push('Rendered mobile artifact is effectively blank.');
    if (desktop.horizontal_overflow) errors.push(`Desktop has horizontal overflow (${desktop.scroll_width}px).`);
    if (mobile.horizontal_overflow) errors.push(`Mobile has horizontal overflow (${mobile.scroll_width}px).`);
    if (desktop.h1_count !== 1) errors.push(`Artifact must render exactly one h1; found ${desktop.h1_count}.`);
    if (consoleErrors.length) errors.push(...consoleErrors.slice(0, 5).map((error) => `Browser error: ${error}`));
    let visualQuality = { reviewed: false, passed: true, reason: 'technical_validation_failed' };
    if (errors.length === 0) {
      visualQuality = await reviewHyperArtifactVisualQuality({
        desktopScreenshot: desktop.screenshot,
        mobileScreenshot: mobile.screenshot,
        intent,
      });
      if (!visualQuality.passed) {
        const issues = visualQuality.issues.length
          ? visualQuality.issues
          : ['The rendered artifact does not meet the authored visual quality threshold.'];
        errors.push(...issues.map((issue) => `Visual quality review (${visualQuality.score}/100): ${issue}`));
      }
    }
    return {
      ok: errors.length === 0,
      errors: [...new Set(errors)],
      desktop,
      mobile,
      console_errors: consoleErrors,
      visual_quality: visualQuality,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function persistHyperArtifactCandidate({ prisma, turnId, candidate }) {
  if (!hyperArtifactsEnabled()) return { ok: false, errors: ['Visual_path_In_Hyperrooms is disabled.'] };
  if (!candidate || candidate.contract !== 'artifact-candidate.v1') {
    return { ok: false, errors: ['Unsupported artifact candidate contract.'] };
  }
  const html = String(candidate.html || '');
  const intent = candidate.intent && typeof candidate.intent === 'object' ? candidate.intent : {};
  let validation;
  try {
    validation = await renderAndValidate(html, intent);
  } catch (error) {
    return { ok: false, errors: [`Browser validation failed: ${String(error.message || error).slice(0, 500)}`] };
  }
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const turn = await prisma.hyperTurn.findUnique({
    where: { id: turnId },
    select: { roomId: true, room: { select: { orgId: true, userId: true } } },
  });
  if (!turn?.room) return { ok: false, errors: ['Artifact turn scope could not be resolved.'] };
  const checksum = crypto.createHash('sha256').update(html).digest('hex');
  const { screenshot: _desktopScreenshot, ...desktopReceipt } = validation.desktop;
  const { screenshot: _mobileScreenshot, ...mobileReceipt } = validation.mobile;
  const payload = {
    contract: 'artifact-record.v1',
    html,
    previews: {
      desktop: validation.desktop.screenshot,
      mobile: validation.mobile.screenshot,
    },
    title: String(candidate.title || 'Interactive artifact').slice(0, 180),
    summary: String(candidate.summary || '').slice(0, 1200),
    source_refs: Array.isArray(candidate.source_refs) ? candidate.source_refs.slice(0, 24) : [],
    intent,
    receipt: {
      contract: 'artifact-receipt.v1',
      rendered: true,
      desktop_checked: true,
      mobile_checked: true,
      console_errors: validation.console_errors.length,
      desktop: desktopReceipt,
      mobile: mobileReceipt,
      visual_quality: validation.visual_quality,
      content_sha256: checksum,
    },
  };
  let artifact = await prisma.sourceArtifact.findFirst({
    where: { userId: turn.room.userId, orgId: turn.room.orgId, checksum, sourcePlatform: SOURCE_PLATFORM },
  });
  if (!artifact) {
    artifact = await prisma.sourceArtifact.create({ data: {
      userId: turn.room.userId,
      orgId: turn.room.orgId,
      artifactType: 'generated',
      sourcePlatform: SOURCE_PLATFORM,
      sourceId: `${turn.roomId}:${turnId}`,
      contentType: 'text/html; charset=utf-8',
      sizeBytes: Buffer.byteLength(html, 'utf8'),
      checksum,
      storageLocation: 'inline:source_artifacts.payload',
      payload,
      metadata: { room_id: turn.roomId, turn_id: turnId, artifact_kind: intent.kind, medium: 'html' },
    } });
  }
  const url = `/v1/hyper-artifacts/${artifact.id}`;
  const previewUrl = `${url}/preview?viewport=desktop`;
  const receipt = {
    ok: true,
    artifact_id: artifact.id,
    artifact_type: intent.kind || 'interactive_document',
    medium: 'html',
    title: payload.title,
    summary: payload.summary,
    url,
    preview_url: previewUrl,
    receipt: payload.receipt,
  };
  const { ok: _ok, ...eventReceipt } = receipt;
  return { ...receipt, event: { t: 'artifact_ready', ...eventReceipt } };
}

export async function readHyperArtifact({ prisma, artifactId, orgId }) {
  return prisma.sourceArtifact.findFirst({
    where: { id: artifactId, orgId, sourcePlatform: SOURCE_PLATFORM },
    select: { id: true, contentType: true, payload: true, metadata: true, createdAt: true },
  });
}
