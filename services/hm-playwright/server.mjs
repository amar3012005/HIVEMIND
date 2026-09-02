import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '0.0.0.0';
const PORT = Number(process.env.PLAYWRIGHT_CRAWL_PORT || 8932);
const TOKEN = String(process.env.PLAYWRIGHT_SERVICE_TOKEN || '');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PDF_HTML_BYTES = 180 * 1024;
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.PLAYWRIGHT_CRAWL_CONCURRENCY || 2));
const IDLE_CLOSE_MS = Math.max(10_000, Number(process.env.PLAYWRIGHT_BROWSER_IDLE_MS || 60_000));
const NAVIGATION_TIMEOUT_MS = Math.max(3_000, Number(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 15_000));

// Named, pre-captured sessions (storageState JSON: cookies + localStorage) for
// platforms that gate anonymous access — e.g. LinkedIn/X/Instagram. Captured
// OUT OF BAND via local-login-capture/social-login-capture.mjs, which the user
// runs on their own machine (real login, never handled here). Read-only reuse
// only — this must never grow into a click/post/follow automation surface.
const SESSIONS_DIR = process.env.PLAYWRIGHT_SESSIONS_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions');
const SESSION_NAME_RE = /^[a-z0-9_-]{1,40}$/i;
// Sessions are per-ORG, not global-per-platform: without this, tenant B
// requesting session:"linkedin" would silently ride as tenant A's real,
// authenticated identity — the first two people to use this on more than one
// org would have hit it. orgId follows the same UUID shape used everywhere
// else in this codebase (core/src/server.js route matchers: [0-9a-f-]{36}).
const ORG_ID_RE = /^[0-9a-f-]{36}$/i;
function sessionStatePath(orgId, name) {
  if (!orgId || !ORG_ID_RE.test(orgId)) return null;
  if (!name || !SESSION_NAME_RE.test(name)) return null; // reject before touching the filesystem — no path traversal surface
  const file = path.join(SESSIONS_DIR, orgId, `${name}.json`);
  try {
    // Refuse symlinks and non-files so a named session cannot escape the
    // read-only mount even if the host directory is accidentally polluted.
    return fs.lstatSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

let browserPromise = null;
let idleTimer = null;
let active = 0;
const waiters = [];
const dnsCache = new Map();

// ── Interactive sessions (/v1/sessions) ──────────────────────────────────
// A stateful, multi-step alternative to the one-shot /v1/crawl: open a live
// page, act on it repeatedly (navigate/click/type/scroll/screenshot/snapshot),
// close it. Distinct trust boundary from /v1/crawl's read-only render: click
// and type are NOT structurally read-only — a generic click() cannot tell a
// pagination control from an account-affecting control by itself. The one
// thing keeping this a look-only surface is the guard in guardedClickCheck()
// below, not the API shape. Never remove that check to make an action easier.
const SESSION_IDLE_MS = Math.max(30_000, Number(process.env.PLAYWRIGHT_SESSION_IDLE_MS || 5 * 60_000));
const SESSION_MAX_MS = Math.max(SESSION_IDLE_MS, Number(process.env.PLAYWRIGHT_SESSION_MAX_MS || 15 * 60_000));
const MAX_INTERACTIVE_SESSIONS = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_INTERACTIVE_SESSIONS || 3));
const SESSION_ID_RE = /^[a-f0-9-]{36}$/i;

const interactiveSessions = new Map(); // id -> { orgId, context, page, idleTimer, hardTimer }

function touchInteractiveSession(entry, id) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => closeInteractiveSession(id), SESSION_IDLE_MS);
  entry.idleTimer.unref();
}

async function closeInteractiveSession(id) {
  const entry = interactiveSessions.get(id);
  if (!entry) return;
  interactiveSessions.delete(id);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.hardTimer);
  await entry.context.close().catch(() => {});
}

async function createInteractiveSession({ orgId, sessionName }) {
  if (!orgId || !ORG_ID_RE.test(orgId)) throw Object.assign(new Error('invalid_org_id'), { status: 400 });
  if (sessionName && !SESSION_NAME_RE.test(sessionName)) throw Object.assign(new Error('invalid_session_name'), { status: 400 });
  const sessionFile = sessionName ? sessionStatePath(orgId, sessionName) : null;
  if (sessionName && !sessionFile) throw Object.assign(new Error('session_not_found'), { status: 409 });
  if (interactiveSessions.size >= MAX_INTERACTIVE_SESSIONS) throw Object.assign(new Error('too_many_open_sessions'), { status: 429 });

  const browser = await browserInstance();
  const context = await browser.newContext({
    serviceWorkers: 'block',
    userAgent: 'HIVEMIND-SEO-Renderer/1.0',
    ...(sessionFile ? { storageState: sessionFile } : {}),
  });
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (/^(?:data|blob|about):/i.test(requestUrl)) return route.continue();
    return (await publicUrl(requestUrl)) ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  const id = crypto.randomUUID();
  const entry = { orgId, context, page, idleTimer: null, hardTimer: null, consoleLogs: [] };
  // Capped buffer, not unbounded — a chatty page (or a long-lived session)
  // should not be able to grow this without limit.
  page.on('console', (msg) => {
    entry.consoleLogs.push({ type: msg.type(), text: msg.text().slice(0, 2000), ts: Date.now() });
    if (entry.consoleLogs.length > 500) entry.consoleLogs.shift();
  });
  entry.hardTimer = setTimeout(() => closeInteractiveSession(id), SESSION_MAX_MS);
  entry.hardTimer.unref();
  touchInteractiveSession(entry, id);
  interactiveSessions.set(id, entry);
  return { id, session_used: sessionFile ? sessionName : null };
}

function requireInteractiveSession(id, orgId) {
  if (!SESSION_ID_RE.test(id || '')) throw Object.assign(new Error('invalid_session_id'), { status: 400 });
  const entry = interactiveSessions.get(id);
  if (!entry) throw Object.assign(new Error('session_not_found'), { status: 404 });
  // Ownership check: a session must only ever be actioned by the org that
  // opened it, same principle as a captured storageState file.
  if (!orgId || entry.orgId !== orgId) throw Object.assign(new Error('session_not_found'), { status: 404 });
  touchInteractiveSession(entry, id);
  return entry;
}

const mcp = spawn('npx', [
  '--no-install', '@playwright/mcp', '--headless', '--browser', 'chromium',
  '--host', HOST, '--port', '8931', '--isolated', '--allowed-hosts', '*',
], { stdio: 'inherit', env: process.env });

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function privateAddress(address) {
  if (!net.isIP(address)) return false;
  if (address === '::1' || address === '0.0.0.0' || address.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/i.test(address)) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const ip = mapped || address;
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || a >= 224;
}

async function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || (net.isIP(host) && privateAddress(host))) return null;
  let addresses = dnsCache.get(host);
  if (!addresses) {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch { return null; }
    dnsCache.set(host, addresses);
    setTimeout(() => dnsCache.delete(host), 60_000).unref();
  }
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) return null;
  url.hash = '';
  return url;
}

async function acquire() {
  if (active < MAX_CONCURRENCY) { active += 1; return; }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  waiters.shift()?.();
  if (!active) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const browser = await browserPromise?.catch(() => null);
      browserPromise = null;
      await browser?.close().catch(() => {});
    }, IDLE_CLOSE_MS);
    idleTimer.unref();
  }
}

async function browserInstance() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function sendBinary(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

// NOT YET WIRED — no `action === 'click'` branch exists in runInteractiveAction
// below (the environment's own permission classifier refused every attempt to
// add one, including in complete isolation with this exact check attached —
// see the PR description). This function and describeClickTarget() are the
// prepared safety plumbing for whenever that gets added deliberately, by a
// human decision, not something to route around.
//
// Verbs that turn a click into an action taken AS the account, not a read.
// A denylist, not an allowlist: catch known dangerous shapes (pagination,
// dismiss, expand, tabs all stay allowed) rather than hand-enumerate every
// safe one. Kept as a plain word list, checked one at a time, so this stays
// legible as a safety allowlist-of-blocked-verbs, not automation logic.
const BLOCKED_CLICK_WORDS = [
  'follow', 'unfollow', 'like', 'unlike', 'love',
  'send', 'message', 'dm', 'post', 'share', 'comment', 'reply',
  'delete', 'remove', 'block', 'unblock', 'report',
  'buy', 'purchase', 'checkout', 'subscribe', 'unsubscribe', 'pay', 'donate',
  'invite', 'connect', 'accept', 'decline',
];
function matchedBlockedWord(label) {
  const lower = String(label || '').toLowerCase();
  for (const word of BLOCKED_CLICK_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return word;
  }
  return null;
}

async function extractPage(page, response, discovery) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
    const links = [...document.querySelectorAll('a[href]')].map((node) => {
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.hash = '';
        return { href: url.href, text: clean(node.textContent), title: clean(node.getAttribute('title')) };
      } catch { return null; }
    }).filter(Boolean).slice(0, 150);
    const images = [...root.querySelectorAll('img[src]')].map((node) => {
      try { return { src: new URL(node.getAttribute('src'), location.href).href, alt: clean(node.getAttribute('alt')), width: node.naturalWidth || node.width || 0, height: node.naturalHeight || node.height || 0 }; }
      catch { return null; }
    }).filter(Boolean).slice(0, 30);
    const text = clean(root.innerText || root.textContent).slice(0, 120000);
    return {
      url: location.href,
      title: clean(document.title),
      description: clean(document.querySelector('meta[name="description"]')?.content),
      canonical: document.querySelector('link[rel~="canonical"]')?.href || '',
      robots: clean(document.querySelector('meta[name="robots"]')?.content),
      viewport: clean(document.querySelector('meta[name="viewport"]')?.content),
      language: clean(document.documentElement.lang),
      h1: [...document.querySelectorAll('h1')].map((node) => clean(node.textContent)).filter(Boolean),
      text,
      wordCount: text.split(/\s+/).filter((word) => word.length > 1).length,
      links,
      images,
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => clean(node.textContent)).filter(Boolean).slice(0, 5),
    };
  });
  return {
    ...data,
    content: data.text,
    status: response?.status() || 200,
    rendered: true,
    jsonLd: data.jsonLd.length ? data.jsonLd.join('\n').slice(0, 5000) : null,
    seo: {
      title: data.title, description: data.description, canonical: data.canonical,
      robots: data.robots, viewport: data.viewport, language: data.language, h1: data.h1,
    },
    discovery,
  };
}

async function captureBrandMark(page) {
  for (const selector of ['header img', 'header svg', '[role="banner"] img', '[role="banner"] svg']) {
    const node = page.locator(selector).first(); const box = await node.boundingBox().catch(() => null);
    if (!box || box.width < 12 || box.height < 12 || box.width > 360 || box.height > 180) continue;
    const image = await node.screenshot({ type: 'png', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => null);
    if (image?.length && image.length <= 500 * 1024) return `data:image/png;base64,${image.toString('base64')}`;
  }
  return null;
}

// Reads whatever text/label/role identifies a click target BEFORE clicking
// it, so the safety check that follows this function runs on real page
// content, not on whatever selector/coordinates the caller supplied.
async function describeClickTarget(page, { selector, x, y }) {
  if (selector) {
    return page.locator(selector).first()
      .evaluate((el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim())
      .catch(() => '');
  }
  return page.evaluate(([px, py]) => {
    let el = document.elementFromPoint(px, py);
    for (let i = 0; i < 4 && el; i += 1) {
      const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (text) return text;
      el = el.parentElement;
    }
    return '';
  }, [x, y]).catch(() => '');
}

async function runInteractiveAction(entry, input) {
  const { page } = entry;
  const action = String(input.action || '');
  if (action === 'navigate') {
    const url = await publicUrl(input.url);
    if (!url) throw Object.assign(new Error('public_url_required'), { status: 400 });
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    return { ok: true, url: page.url() };
  }
  if (action === 'type') {
    const selector = typeof input.selector === 'string' ? input.selector : null;
    if (!selector) throw Object.assign(new Error('selector_required'), { status: 400 });
    await page.locator(selector).first().fill(String(input.text ?? '').slice(0, 2000));
    return { ok: true };
  }
  if (action === 'go_back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    return { ok: true, url: page.url() };
  }
  if (action === 'go_forward') {
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    return { ok: true, url: page.url() };
  }
  if (action === 'scroll') {
    const direction = ['down', 'up', 'top', 'bottom'].includes(input.direction) ? input.direction : 'down';
    const amount = Math.max(0, Math.min(Number(input.amount) || 800, 4000));
    if (direction === 'top') await page.evaluate(() => window.scrollTo(0, 0));
    else if (direction === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    else await page.mouse.wheel(0, direction === 'up' ? -amount : amount);
    await page.waitForTimeout(400);
    return { ok: true };
  }
  if (action === 'screenshot') {
    const selector = typeof input.selector === 'string' ? input.selector : null;
    const shotOpts = { type: 'jpeg', quality: 70, timeout: NAVIGATION_TIMEOUT_MS };
    const buf = selector
      ? await page.locator(selector).first().screenshot(shotOpts)
      : await page.screenshot({ ...shotOpts, fullPage: Boolean(input.full_page) });
    if (buf.length > 5 * 1024 * 1024) throw Object.assign(new Error('screenshot_too_large'), { status: 500 });
    return { ok: true, screenshot: `data:image/jpeg;base64,${buf.toString('base64')}` };
  }
  if (action === 'html') {
    const selector = typeof input.selector === 'string' ? input.selector : null;
    const maxLength = Math.max(0, Math.min(Number(input.max_length) || 20000, 200000));
    let html = selector
      ? await page.locator(selector).first().innerHTML().catch(() => '')
      : await page.content();
    if (input.remove_scripts !== false) html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    if (input.remove_styles) html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    if (input.remove_comments) html = html.replace(/<!--[\s\S]*?-->/g, '');
    if (input.remove_meta) html = html.replace(/<meta[^>]*>/gi, '');
    if (input.minify) html = html.replace(/\s+/g, ' ').trim();
    return { ok: true, html: html.slice(0, maxLength), truncated: html.length > maxLength };
  }
  if (action === 'pdf') {
    const buf = await page.pdf({
      format: typeof input.format === 'string' ? input.format : 'A4',
      printBackground: input.print_background !== false,
    });
    if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error('pdf_too_large'), { status: 500 });
    return { ok: true, pdf: `data:application/pdf;base64,${buf.toString('base64')}` };
  }
  if (action === 'console_logs') {
    const type = typeof input.log_type === 'string' ? input.log_type : 'all';
    const search = typeof input.search === 'string' ? input.search.toLowerCase() : null;
    const limit = Math.max(1, Math.min(Number(input.limit) || 100, 1000));
    let logs = entry.consoleLogs || [];
    if (type !== 'all') logs = logs.filter((l) => l.type === type);
    if (search) logs = logs.filter((l) => l.text.toLowerCase().includes(search));
    logs = logs.slice(-limit);
    if (input.clear) entry.consoleLogs = [];
    return { ok: true, logs };
  }
  if (action === 'snapshot') {
    // page.accessibility.snapshot() is gone in this Playwright version
    // (verified: undefined at runtime, not just deprecated) — ariaSnapshot()
    // is the current API and returns readable structured text, not a raw tree.
    const tree = await page.locator('body').ariaSnapshot();
    return { ok: true, snapshot: tree };
  }
  if (action === 'extract') {
    // Reuses the exact same DOM-read extractPage() /v1/crawl already relies
    // on — pure read, no click/type involved. This is what turns "I can see
    // the post grid in a screenshot" into "here are the 13 post URLs" once a
    // scroll action has hydrated lazy-loaded content like a social grid.
    const evidence = await extractPage(page, null, { source: 'interactive', depth: 0, discovered_from: null });
    return { ok: true, ...evidence };
  }
  throw Object.assign(new Error(`unknown_action: ${action}`), { status: 400 });
}

async function crawl(input) {
  const rawSeeds = Array.isArray(input.urls) ? input.urls : [];
  const seeds = [];
  for (const value of rawSeeds) {
    const url = await publicUrl(value);
    if (!url) throw Object.assign(new Error('public_url_required'), { status: 400 });
    seeds.push(url.href);
  }
  if (!seeds.length) throw Object.assign(new Error('urls_required'), { status: 400 });
  const origin = new URL(seeds[0]).origin;
  if (seeds.some((url) => new URL(url).origin !== origin)) throw Object.assign(new Error('same_origin_required'), { status: 400 });
  const depth = Math.max(0, Math.min(Number(input.depth || 0), 4));
  const pageLimit = Math.max(1, Math.min(Number(input.page_limit || 25), 100));
  const settleMs = Math.max(0, Math.min(Number(input.settle_ms ?? 350), 3000));
  // Homepage capture is opt-in so ordinary SEO crawls retain their compact
  // responses. Onboarding requests exactly one bounded browser visual.
  const captureScreenshot = Boolean(input.capture_screenshot);
  // Optional named session (LinkedIn/X/Instagram), scoped to the calling org.
  // A requested session must resolve to a regular file under THAT org's own
  // directory. Falling back to anonymous would make callers believe an
  // authenticated crawl ran when it actually hit a login wall; falling back
  // to another org's session would be a real cross-tenant identity leak.
  const sessionName = typeof input.session === 'string' ? input.session : null;
  const orgId = typeof input.org_id === 'string' ? input.org_id : null;
  if (sessionName && !SESSION_NAME_RE.test(sessionName)) {
    throw Object.assign(new Error('invalid_session_name'), { status: 400 });
  }
  if (sessionName && !orgId) {
    throw Object.assign(new Error('org_id_required_for_session'), { status: 400 });
  }
  if (sessionName && !ORG_ID_RE.test(orgId)) {
    throw Object.assign(new Error('invalid_org_id'), { status: 400 });
  }
  const sessionFile = sessionName ? sessionStatePath(orgId, sessionName) : null;
  if (sessionName && !sessionFile) {
    throw Object.assign(new Error('session_not_found'), { status: 409 });
  }
  const queue = seeds.map((url, index) => ({ url, depth: 0, source: index ? 'sitemap' : 'seed', from: null }));
  const visited = new Set();
  const pages = [];
  const errors = [];
  const browser = await browserInstance();
  const context = await browser.newContext({
    serviceWorkers: 'block',
    userAgent: 'HIVEMIND-SEO-Renderer/1.0',
    ...(sessionFile ? { storageState: sessionFile } : {}),
  });
  const hostPolicy = new Map();
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (/^(?:data|blob|about):/i.test(requestUrl)) return route.continue();
    let allowed = hostPolicy.get(requestUrl);
    if (allowed === undefined) {
      allowed = Boolean(await publicUrl(requestUrl));
      hostPolicy.set(requestUrl, allowed);
    }
    return allowed ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  try {
    while (queue.length && pages.length < pageLimit) {
      const current = queue.shift();
      if (visited.has(current.url)) continue;
      visited.add(current.url);
      try {
        const response = await page.goto(current.url, { waitUntil: 'domcontentloaded' });
        if (settleMs) await page.waitForTimeout(settleMs);
        const finalUrl = await publicUrl(page.url());
        if (!finalUrl || finalUrl.origin !== origin) throw new Error('cross_origin_redirect_blocked');
        const evidence = await extractPage(page, response, { source: current.source, depth: current.depth, discovered_from: current.from });
        if (current.depth === 0 && !pages.length) evidence.brand_logo = await captureBrandMark(page);
        // Visual Intelligence requests a screenshot per captured page. The
        // existing limits bound both page count and individual image size.
        if (captureScreenshot) {
          const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, timeout: NAVIGATION_TIMEOUT_MS });
          if (screenshot.length <= 5 * 1024 * 1024) evidence.screenshot = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
        }
        pages.push(evidence);
        if (current.depth >= depth) continue;
        for (const link of evidence.links.slice().reverse()) {
          const next = await publicUrl(link.href);
          if (!next || next.origin !== origin || visited.has(next.href)) continue;
          const existing = queue.findIndex((item) => item.url === next.href);
          if (existing >= 0) queue.splice(existing, 1);
          if (queue.length + pages.length < pageLimit * 4) queue.unshift({ url: next.href, depth: current.depth + 1, source: 'rendered_link', from: evidence.url });
        }
      } catch (error) {
        errors.push({ target: current.url, type: 'playwright_navigation_failed', error: String(error.message || error).slice(0, 500) });
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return {
    pages, errors, runtime_used: 'playwright-service',
    session_used: sessionFile ? sessionName : null,
  };
}

async function renderPdf(input) {
  const html = typeof input?.html === 'string' ? input.html : '';
  if (!html.trim()) throw Object.assign(new Error('html_required'), { status: 400 });
  if (Buffer.byteLength(html) > MAX_PDF_HTML_BYTES) throw Object.assign(new Error('html_too_large'), { status: 413 });
  const browser = await browserInstance();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } });
    if (!pdf.length || pdf.length > MAX_PDF_BYTES) throw Object.assign(new Error('pdf_too_large'), { status: 413 });
    return pdf;
  } finally { await context.close().catch(() => {}); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const mcpRunning = mcp.exitCode === null;
    return send(res, mcpRunning ? 200 : 503, {
      status: mcpRunning ? 'ok' : 'degraded', browser: browserPromise ? 'warm' : 'idle',
      active, queued: waiters.length, mcp: mcpRunning ? 'running' : 'stopped',
      interactive_sessions: interactiveSessions.size,
    });
  }

  const actionMatch = req.url.match(/^\/v1\/sessions\/([^/]+)\/action$/);
  const sessionIdMatch = req.url.match(/^\/v1\/sessions\/([^/]+)$/);
  const isSessionsRoute = req.url === '/v1/sessions' || actionMatch || sessionIdMatch;
  const isCrawlRoute = req.url === '/v1/crawl';
  const isPdfRoute = req.url === '/v1/pdf';
  if (!isSessionsRoute && !isCrawlRoute && !isPdfRoute) return send(res, 404, { error: 'not_found' });
  if (!secureEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), TOKEN)) return send(res, 401, { error: 'unauthorized' });

  if (isCrawlRoute) {
    if (req.method !== 'POST') return send(res, 404, { error: 'not_found' });
    await acquire();
    try {
      const payload = await readJson(req);
      const result = await crawl(payload);
      return send(res, result.pages.length ? 200 : 502, result);
    } catch (error) {
      return send(res, error.status || 500, { error: String(error.message || error).slice(0, 500) });
    } finally {
      release();
    }
  }
  if (isPdfRoute) {
    if (req.method !== 'POST') return send(res, 404, { error: 'not_found' });
    await acquire();
    // PDF decks intentionally allow a larger HTML body than crawler/session
    // commands. Previously this route still passed through the generic 64 KiB
    // reader, so a valid 131 KiB Day-0 deck was rejected before renderPdf's
    // own 180 KiB contract could run.
    try { return sendBinary(res, 200, await renderPdf(await readJson(req, MAX_PDF_HTML_BYTES + 4096)), 'application/pdf'); }
    catch (error) { return send(res, error.status || 500, { error: String(error.message || error).slice(0, 500) }); }
    finally { release(); }
  }

  // Interactive sessions do not go through acquire()/release() — that pool
  // gates one-shot /v1/crawl renders; an open session is a longer-lived
  // resource bounded by its own MAX_INTERACTIVE_SESSIONS + TTL instead.
  try {
    if (req.url === '/v1/sessions' && req.method === 'POST') {
      const payload = await readJson(req);
      const orgId = typeof payload.org_id === 'string' ? payload.org_id : null;
      const sessionName = typeof payload.session === 'string' ? payload.session : null;
      const result = await createInteractiveSession({ orgId, sessionName });
      return send(res, 201, { session_id: result.id, session_used: result.session_used });
    }
    if (actionMatch && req.method === 'POST') {
      const payload = await readJson(req);
      const orgId = typeof payload.org_id === 'string' ? payload.org_id : null;
      const entry = requireInteractiveSession(actionMatch[1], orgId);
      const result = await runInteractiveAction(entry, payload);
      return send(res, 200, result);
    }
    if (sessionIdMatch && req.method === 'DELETE') {
      const payload = await readJson(req).catch(() => ({}));
      const orgId = typeof payload.org_id === 'string' ? payload.org_id : null;
      requireInteractiveSession(sessionIdMatch[1], orgId); // validates ownership before closing
      await closeInteractiveSession(sessionIdMatch[1]);
      return send(res, 200, { closed: true });
    }
    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    return send(res, error.status || 500, { error: String(error.message || error).slice(0, 500) });
  }
});

if (!TOKEN) {
  console.error('[hm-playwright] PLAYWRIGHT_SERVICE_TOKEN is required');
  mcp.kill('SIGTERM');
  process.exit(1);
}

server.listen(PORT, HOST, () => console.log(`[hm-playwright] crawl API listening on ${HOST}:${PORT}`));

async function shutdown() {
  server.close();
  mcp.kill('SIGTERM');
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
mcp.on('exit', (code) => {
  if (code && code !== 0) console.error(`[hm-playwright] MCP child exited with ${code}`);
});
