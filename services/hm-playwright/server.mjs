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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
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
        if (captureScreenshot && current.depth === 0 && !pages.length) {
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const mcpRunning = mcp.exitCode === null;
    return send(res, mcpRunning ? 200 : 503, { status: mcpRunning ? 'ok' : 'degraded', browser: browserPromise ? 'warm' : 'idle', active, queued: waiters.length, mcp: mcpRunning ? 'running' : 'stopped' });
  }
  if (req.method !== 'POST' || req.url !== '/v1/crawl') return send(res, 404, { error: 'not_found' });
  if (!secureEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), TOKEN)) return send(res, 401, { error: 'unauthorized' });
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
