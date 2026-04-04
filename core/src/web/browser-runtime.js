/**
 * Browser Runtime Abstraction for Web Intelligence
 *
 * Primary: Lightpanda via CDP (local process or cloud websocket)
 * Fallback: Lightweight fetch-based runtime for resiliency
 *
 * Reliability controls:
 * - Per-domain concurrency cap (DomainConcurrencyTracker)
 * - Circuit breaker for Lightpanda failures (CircuitBreaker)
 * - Per-job timeout via HIVEMIND_WEB_JOB_TIMEOUT_MS
 * - Fallback telemetry (getTelemetry)
 * - Structured error classification
 */
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';

// ---------------------------------------------------------------------------
// Reliability primitives
// ---------------------------------------------------------------------------

const JOB_TIMEOUT_MS = Number(process.env.HIVEMIND_WEB_JOB_TIMEOUT_MS || 120000);

class DomainConcurrencyTracker {
  constructor(maxPerDomain = 3) {
    this.active = new Map();
    this.max = maxPerDomain;
  }

  /** Returns true if a slot was acquired, false if the domain is at capacity. */
  acquire(domain) {
    const current = this.active.get(domain) || 0;
    if (current >= this.max) return false;
    this.active.set(domain, current + 1);
    return true;
  }

  release(domain) {
    const current = this.active.get(domain) || 0;
    if (current <= 1) {
      this.active.delete(domain);
    } else {
      this.active.set(domain, current - 1);
    }
  }

  /** Returns a shallow copy of the active-counts map. */
  getActive() {
    return new Map(this.active);
  }
}

const CIRCUIT_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  constructor({ failureThreshold = 5, resetTimeoutMs = 60000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failures = 0;
    this.lastFailure = null;
    this.state = CIRCUIT_STATE.CLOSED;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = CIRCUIT_STATE.CLOSED;
  }

  recordFailure() {
    this.failures += 1;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = CIRCUIT_STATE.OPEN;
      telemetry.circuitBreakerTrips += 1;
    }
  }

  isOpen() {
    if (this.state === CIRCUIT_STATE.CLOSED) return false;
    if (this.state === CIRCUIT_STATE.OPEN) {
      // Check if enough time has passed to transition to HALF_OPEN
      if (Date.now() - this.lastFailure >= this.resetTimeoutMs) {
        this.state = CIRCUIT_STATE.HALF_OPEN;
        return false; // allow one probe request
      }
      return true;
    }
    // HALF_OPEN — allow traffic (will be resolved by next success/failure)
    return false;
  }

  getState() {
    // Refresh state check for callers
    this.isOpen();
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      nextRetry: this.lastFailure ? this.lastFailure + this.resetTimeoutMs : null
    };
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

const _startTime = Date.now();
const _durations = [];

const telemetry = {
  totalJobs: 0,
  lightpandaSuccesses: 0,
  lightpandaFailures: 0,
  fallbackSuccesses: 0,
  fallbackFailures: 0,
  avgDurationMs: 0,
  circuitBreakerTrips: 0,
  domainConcurrencyRejections: 0,
  getSnapshot() {
    return {
      totalJobs: this.totalJobs,
      lightpandaSuccesses: this.lightpandaSuccesses,
      lightpandaFailures: this.lightpandaFailures,
      fallbackSuccesses: this.fallbackSuccesses,
      fallbackFailures: this.fallbackFailures,
      avgDurationMs: this.avgDurationMs,
      circuitBreakerTrips: this.circuitBreakerTrips,
      domainConcurrencyRejections: this.domainConcurrencyRejections,
      uptime_ms: Date.now() - _startTime
    };
  }
};

function _recordDuration(ms) {
  _durations.push(ms);
  // Rolling window of last 200 to avoid unbounded growth
  if (_durations.length > 200) _durations.shift();
  telemetry.avgDurationMs = Math.round(_durations.reduce((a, b) => a + b, 0) / _durations.length);
}

function getTelemetry() {
  return telemetry.getSnapshot();
}

// Module-level shared instances
const domainTracker = new DomainConcurrencyTracker(
  Number(process.env.HIVEMIND_WEB_DOMAIN_CONCURRENCY || 3)
);
const circuitBreaker = new CircuitBreaker({
  failureThreshold: Number(process.env.HIVEMIND_WEB_CB_THRESHOLD || 5),
  resetTimeoutMs: Number(process.env.HIVEMIND_WEB_CB_RESET_MS || 60000)
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function extractSnippet(text, maxLength = 320) {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).replace(/\s\S*$/, '')}...`;
}

function matchesPattern(url, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.includes('*')) {
      const safe = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${safe}$`, 'i').test(url);
    }
    return url.includes(pattern);
  });
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}

async function fetchFallbackPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HivemindBot/1.0 (+https://hivemind.davinciai.eu)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtmlToText(html) {
  let text = html;
  // Remove non-content sections first
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ');
  // Clean whitespace
  return text.replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

// Static asset extensions to skip during crawl link extraction
const SKIP_EXTENSIONS = new Set([
  '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp',
  '.css', '.js', '.mjs', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.avi', '.mov', '.webm',
  '.json', '.xml', '.rss', '.atom', '.map', '.wasm',
]);

function extractLinksFromHtml(html, baseUrl) {
  const links = [];
  // Only extract from <a> tags, not <link>, <script>, etc.
  const regex = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const href = match[1].trim();
      // Skip mailto, tel, javascript
      if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
      const resolved = new URL(href, baseUrl).href;
      if (!resolved.startsWith('http')) continue;
      // Skip static assets
      const pathname = new URL(resolved).pathname.toLowerCase();
      const ext = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '';
      if (SKIP_EXTENSIONS.has(ext)) continue;
      // Skip common non-content paths
      if (/\/(manifest|favicon|robots|sitemap|feed|rss|atom|wp-json|api\/|_next\/|static\/)/i.test(pathname)) continue;
      links.push(resolved);
    } catch {
      // skip invalid URLs
    }
  }
  return [...new Set(links)];
}

/**
 * Classify an error into a structured failure type.
 */
function classifyError(error, context = {}) {
  const msg = (error?.message || '').toLowerCase();

  if (context.circuitOpen) {
    return { type: 'circuit_open', message: 'Circuit breaker is open — Lightpanda temporarily disabled' };
  }
  if (context.concurrencyLimit) {
    return { type: 'concurrency_limit', message: `Domain ${context.domain} at capacity` };
  }
  if (context.jobTimeout) {
    return { type: 'timeout', message: `Job exceeded ${JOB_TIMEOUT_MS}ms timeout` };
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return { type: 'timeout', message: error.message };
  }
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('robots') || msg.includes('access denied')) {
    return { type: 'blocked_site', message: error.message };
  }
  if (msg.includes('navigation') || msg.includes('net::') || msg.includes('err_')) {
    return { type: 'navigation_failed', message: error.message };
  }
  return { type: 'navigation_failed', message: error.message || 'unknown_error' };
}

// ---------------------------------------------------------------------------
// Job timeout wrapper
// ---------------------------------------------------------------------------

function withJobTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('job_timeout'), { _jobTimeout: true })), JOB_TIMEOUT_MS)
    )
  ]);
}

// ---------------------------------------------------------------------------
// Lightpanda browser lifecycle
// ---------------------------------------------------------------------------

async function withLightpandaBrowser(callback) {
  const { chromium } = await import('playwright-core');

  const cloudWs =
    process.env.HIVEMIND_LIGHTPANDA_CLOUD_WS
    || process.env.LIGHTPANDA_CLOUD_WS
    || null;
  const cloudToken = process.env.HIVEMIND_LIGHTPANDA_TOKEN || process.env.LPD_TOKEN || process.env.LIGHTPANDA_TOKEN || null;
  const cloudRegion = process.env.HIVEMIND_LIGHTPANDA_REGION || process.env.LIGHTPANDA_REGION || 'euwest';

  let endpointURL = cloudWs;
  if (!endpointURL && cloudToken) {
    endpointURL = `wss://${cloudRegion}.cloud.lightpanda.io/ws?token=${cloudToken}`;
  }

  let browser = null;
  let proc = null;

  try {
    if (endpointURL) {
      browser = await chromium.connectOverCDP({ endpointURL });
    } else {
      if (!process.env.LIGHTPANDA_EXECUTABLE_PATH) {
        const executableCandidates = [
          '/usr/local/bin/lightpanda',
          '/tmp/.cache/lightpanda-node/lightpanda'
        ];
        for (const executablePath of executableCandidates) {
          try {
            await fs.access(executablePath, fsConstants.X_OK);
            process.env.LIGHTPANDA_EXECUTABLE_PATH = executablePath;
            break;
          } catch {
            // try next candidate
          }
        }
      }

      if (!process.env.HOME || process.env.HOME === '/nonexistent') {
        process.env.HOME = '/tmp';
      }
      if (!process.env.XDG_CACHE_HOME) {
        process.env.XDG_CACHE_HOME = '/tmp/.cache';
      }
      for (const dir of [process.env.XDG_CACHE_HOME]) {
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.access(dir);
        } catch {
          // best effort only
        }
      }

      const { lightpanda } = await import('@lightpanda/browser');
      const host = process.env.HIVEMIND_LIGHTPANDA_HOST || '127.0.0.1';
      const port = Number(process.env.HIVEMIND_LIGHTPANDA_PORT || 9222);
      proc = await lightpanda.serve({ host, port });
      browser = await chromium.connectOverCDP({ endpointURL: `ws://${host}:${port}` });
    }

    return await callback(browser);
  } finally {
    try {
      if (browser) {
        await browser.close();
      }
    } catch {
      // no-op
    }
    if (proc) {
      try {
        proc.stdout?.destroy?.();
        proc.stderr?.destroy?.();
      } catch {
        // no-op
      }
      try {
        proc.kill();
      } catch {
        // no-op
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LightpandaRuntime
// ---------------------------------------------------------------------------

class LightpandaRuntime {
  constructor() {
    this.name = 'lightpanda';
    this.navigationTimeoutMs = Number(process.env.HIVEMIND_WEB_NAV_TIMEOUT_MS || 15000);
  }

  async search({ query, domains, limit = 10 }) {
    const normalizedDomains = Array.isArray(domains)
      ? domains.map(normalizeUrl).filter(Boolean)
      : [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const errors = [];

    const results = await withLightpandaBrowser(async (browser) => {
      const context = await browser.newContext({});
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);

      const records = [];
      const pushRecord = (record) => {
        if (!record?.url) return;
        records.push(record);
      };

      try {
        if (normalizedDomains.length > 0) {
          for (const targetUrl of normalizedDomains) {
            if (records.length >= safeLimit) break;

            const domain = extractDomain(targetUrl);
            if (!domainTracker.acquire(domain)) {
              telemetry.domainConcurrencyRejections += 1;
              errors.push({ target: targetUrl, ...classifyError(null, { concurrencyLimit: true, domain }) });
              continue;
            }

            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
              const data = await page.evaluate(() => {
                const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                const title = (document.title || '').trim();
                const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                return { title, text, meta, url: window.location.href };
              });
              const combinedText = `${data.text} ${data.meta}`.toLowerCase();
              if (data.url === 'about:blank' || /navigation failed/i.test(combinedText)) {
                errors.push({ target: targetUrl, type: 'navigation_failed', error: 'navigation_failed' });
                continue;
              }
              const score = query ? (combinedText.includes(String(query).toLowerCase()) ? 1 : 0) : 1;
              pushRecord({
                title: data.title || new URL(data.url).hostname,
                url: data.url,
                snippet: extractSnippet(data.meta || data.text),
                score
              });
            } catch (error) {
              const classified = classifyError(error);
              errors.push({ target: targetUrl, type: classified.type, error: classified.message });
            } finally {
              domainTracker.release(domain);
            }
          }
        } else {
          const q = encodeURIComponent(query);
          const searchUrl = `https://duckduckgo.com/?q=${q}`;
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
          const ddg = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('article h2 a, .result__a, a[data-testid="result-title-a"]'));
            return items.slice(0, 20).map((node) => {
              const href = node.getAttribute('href') || '';
              const title = (node.textContent || '').trim();
              return { title, url: href };
            }).filter((item) => item.url && item.title);
          });

          for (const item of ddg.slice(0, safeLimit)) {
            pushRecord({ title: item.title, url: item.url, snippet: '' });
          }
        }
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }

      const uniqueByUrl = new Map();
      for (const row of records) {
        if (!uniqueByUrl.has(row.url)) {
          uniqueByUrl.set(row.url, row);
        }
      }
      return [...uniqueByUrl.values()]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, safeLimit)
        .map(({ title, url, snippet }) => ({ title, url, snippet }));
    });

    return { results, runtime_used: this.name, errors };
  }

  async crawl({ urls, depth = 1, pageLimit = 50, include, exclude }) {
    const queue = Array.isArray(urls)
      ? urls.map((url) => ({ url: normalizeUrl(url), currentDepth: 0 })).filter((x) => x.url)
      : [];
    const safeDepth = Math.max(0, Math.min(Number(depth) || 1, 4));
    const safePageLimit = Math.max(1, Math.min(Number(pageLimit) || 50, 500));
    const visited = new Set();
    const pages = [];
    const errors = [];

    await withLightpandaBrowser(async (browser) => {
      const context = await browser.newContext({});
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);

      try {
        while (queue.length > 0 && pages.length < safePageLimit) {
          const { url, currentDepth } = queue.shift();
          if (!url || visited.has(url)) continue;
          visited.add(url);

          if (include && !matchesPattern(url, include)) continue;
          if (exclude && matchesPattern(url, exclude)) continue;

          const domain = extractDomain(url);
          if (!domainTracker.acquire(domain)) {
            telemetry.domainConcurrencyRejections += 1;
            errors.push({ target: url, ...classifyError(null, { concurrencyLimit: true, domain }) });
            continue;
          }

          try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const data = await page.evaluate(() => {
              const title = (document.title || '').trim();
              const content = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
              const links = Array.from(document.querySelectorAll('a[href]'))
                .map((a) => a.href)
                .filter((href) => href && href.startsWith('http'));
              return {
                url: window.location.href,
                title,
                content,
                links
              };
            });

            const normalizedContent = (data.content || '').toLowerCase();
            if (data.url === 'about:blank' || normalizedContent.includes('navigation failed')) {
              errors.push({ target: url, type: 'navigation_failed', error: 'navigation_failed' });
              continue;
            }

            pages.push({
              url: data.url,
              title: data.title || data.url,
              content: data.content
            });

            if (currentDepth < safeDepth) {
              for (const link of data.links) {
                if (!visited.has(link) && queue.length + pages.length < safePageLimit * 3) {
                  queue.push({ url: link, currentDepth: currentDepth + 1 });
                }
              }
            }
          } catch (error) {
            const classified = classifyError(error);
            errors.push({ target: url, type: classified.type, error: classified.message });
          } finally {
            domainTracker.release(domain);
          }
        }
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    });

    return { pages, runtime_used: this.name, errors };
  }
}

// ---------------------------------------------------------------------------
// FetchFallbackRuntime
// ---------------------------------------------------------------------------

class FetchFallbackRuntime {
  constructor() {
    this.name = 'fetch';
  }

  async search({ query, domains, limit = 10 }) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const results = [];
    const errors = [];
    const normalizedDomains = Array.isArray(domains)
      ? domains.map(normalizeUrl).filter(Boolean)
      : [];

    // If specific domains given, fetch and check each
    if (normalizedDomains.length > 0) {
      for (const url of normalizedDomains) {
        if (results.length >= safeLimit) break;
        try {
          const html = await fetchFallbackPage(url);
          const title = extractTitle(html);
          const text = stripHtmlToText(html);
          const includeRow = !query || text.toLowerCase().includes(String(query).toLowerCase());
          if (includeRow) {
            results.push({
              title: title || new URL(url).hostname,
              url,
              snippet: extractSnippet(text)
            });
          }
        } catch (error) {
          const classified = classifyError(error);
          errors.push({ target: url, type: classified.type, error: classified.message });
        }
      }
      return { results, runtime_used: this.name, errors };
    }

    // No domains: use DuckDuckGo HTML search
    if (!query) {
      errors.push({ target: 'search', error: 'query_required' });
      return { results: [], runtime_used: this.name, errors };
    }

    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
      const html = await res.text();

      // Parse DDG results: <a class="result__a"> for title+url, <a class="result__snippet"> for snippet
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultPattern.exec(html)) !== null && results.length < safeLimit) {
        const rawUrl = match[1];
        const url = decodeURIComponent((rawUrl.match(/uddg=([^&]+)/) || [])[1] || rawUrl);
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
          results.push({ url, title, snippet });
        }
      }

      // Simpler fallback pattern
      if (results.length === 0) {
        const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = linkPattern.exec(html)) !== null && results.length < safeLimit) {
          const rawUrl = match[1];
          const url = decodeURIComponent((rawUrl.match(/uddg=([^&]+)/) || [])[1] || rawUrl);
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
            results.push({ url, title, snippet: title });
          }
        }
      }
    } catch (error) {
      errors.push({ target: 'duckduckgo', error: error.message });
    }

    return { results, runtime_used: `${this.name}+duckduckgo`, errors };
  }

  async crawl({ urls, depth = 1, pageLimit = 50, include, exclude }) {
    const safeDepth = Math.max(0, Math.min(Number(depth) || 1, 4));
    const safePageLimit = Math.max(1, Math.min(Number(pageLimit) || 50, 500));
    const queue = Array.isArray(urls)
      ? urls.map((u) => ({ url: normalizeUrl(u), currentDepth: 0 })).filter((x) => x.url)
      : [];

    const pages = [];
    const errors = [];
    const visited = new Set();

    while (queue.length > 0 && pages.length < safePageLimit) {
      const { url, currentDepth } = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);

      if (include && !matchesPattern(url, include)) continue;
      if (exclude && matchesPattern(url, exclude)) continue;

      try {
        const html = await fetchFallbackPage(url);
        const title = extractTitle(html);
        const text = stripHtmlToText(html);
        const wordCount = text.split(/\s+/).filter(w => w.length > 1).length;
        pages.push({ url, title: title || url, text, content: text, word_count: wordCount });

        if (currentDepth < safeDepth) {
          const links = extractLinksFromHtml(html, url);
          for (const link of links) {
            if (!visited.has(link) && queue.length + pages.length < safePageLimit * 3) {
              queue.push({ url: link, currentDepth: currentDepth + 1 });
            }
          }
        }
      } catch (error) {
        const classified = classifyError(error);
        errors.push({ target: url, type: classified.type, error: classified.message });
      }
    }

    return { pages, runtime_used: this.name, errors };
  }
}

// ---------------------------------------------------------------------------
// BrowserRuntime — public facade with circuit breaker + job timeout + telemetry
// ---------------------------------------------------------------------------

export class BrowserRuntime {
  constructor() {
    this.primary = new LightpandaRuntime();
    this.fallback = new FetchFallbackRuntime();
  }

  async search({ query, domains, limit }) {
    const start = Date.now();
    telemetry.totalJobs += 1;
    let fallbackApplied = false;
    let result;

    try {
      // Circuit breaker check — skip Lightpanda entirely if open
      if (circuitBreaker.isOpen()) {
        fallbackApplied = true;
        const classified = classifyError(null, { circuitOpen: true });
        try {
          result = await withJobTimeout(this.fallback.search({ query, domains, limit }));
          telemetry.fallbackSuccesses += 1;
          result.errors = result.errors || [];
          result.errors.unshift({ target: 'lightpanda', type: classified.type, error: classified.message });
        } catch (fallbackErr) {
          telemetry.fallbackFailures += 1;
          if (fallbackErr._jobTimeout) {
            return { results: [], runtime_used: 'none', fallback_applied: true, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
          }
          throw new Error(`Circuit open, fallback failed: ${fallbackErr.message}`);
        }
      } else {
        try {
          result = await withJobTimeout(this.primary.search({ query, domains, limit }));
          circuitBreaker.recordSuccess();
          telemetry.lightpandaSuccesses += 1;
        } catch (primaryErr) {
          if (primaryErr._jobTimeout) {
            telemetry.lightpandaFailures += 1;
            circuitBreaker.recordFailure();
            _recordDuration(Date.now() - start);
            return { results: [], runtime_used: 'none', fallback_applied: false, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
          }
          circuitBreaker.recordFailure();
          telemetry.lightpandaFailures += 1;
          fallbackApplied = true;
          try {
            result = await withJobTimeout(this.fallback.search({ query, domains, limit }));
            telemetry.fallbackSuccesses += 1;
          } catch (fallbackErr) {
            telemetry.fallbackFailures += 1;
            if (fallbackErr._jobTimeout) {
              _recordDuration(Date.now() - start);
              return { results: [], runtime_used: 'none', fallback_applied: true, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
            }
            throw new Error(`All runtimes failed. Primary: ${primaryErr.message}; Fallback: ${fallbackErr.message}`);
          }
        }
      }
    } finally {
      _recordDuration(Date.now() - start);
    }

    return {
      ...result,
      fallback_applied: fallbackApplied,
      duration_ms: Date.now() - start
    };
  }

  async crawl({ urls, depth, pageLimit, include, exclude }) {
    const start = Date.now();
    telemetry.totalJobs += 1;
    let fallbackApplied = false;
    let result;

    try {
      // Circuit breaker check — skip Lightpanda entirely if open
      if (circuitBreaker.isOpen()) {
        fallbackApplied = true;
        const classified = classifyError(null, { circuitOpen: true });
        try {
          result = await withJobTimeout(this.fallback.crawl({ urls, depth, pageLimit, include, exclude }));
          telemetry.fallbackSuccesses += 1;
          result.errors = result.errors || [];
          result.errors.unshift({ target: 'lightpanda', type: classified.type, error: classified.message });
        } catch (fallbackErr) {
          telemetry.fallbackFailures += 1;
          if (fallbackErr._jobTimeout) {
            return { pages: [], runtime_used: 'none', fallback_applied: true, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
          }
          throw new Error(`Circuit open, fallback failed: ${fallbackErr.message}`);
        }
      } else {
        try {
          result = await withJobTimeout(this.primary.crawl({ urls, depth, pageLimit, include, exclude }));
          circuitBreaker.recordSuccess();
          telemetry.lightpandaSuccesses += 1;
        } catch (primaryErr) {
          if (primaryErr._jobTimeout) {
            telemetry.lightpandaFailures += 1;
            circuitBreaker.recordFailure();
            _recordDuration(Date.now() - start);
            return { pages: [], runtime_used: 'none', fallback_applied: false, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
          }
          circuitBreaker.recordFailure();
          telemetry.lightpandaFailures += 1;
          fallbackApplied = true;
          try {
            result = await withJobTimeout(this.fallback.crawl({ urls, depth, pageLimit, include, exclude }));
            telemetry.fallbackSuccesses += 1;
          } catch (fallbackErr) {
            telemetry.fallbackFailures += 1;
            if (fallbackErr._jobTimeout) {
              _recordDuration(Date.now() - start);
              return { pages: [], runtime_used: 'none', fallback_applied: true, duration_ms: Date.now() - start, error: 'job_timeout', errors: [classifyError(null, { jobTimeout: true })] };
            }
            throw new Error(`All runtimes failed. Primary: ${primaryErr.message}; Fallback: ${fallbackErr.message}`);
          }
        }
      }
    } finally {
      _recordDuration(Date.now() - start);
    }

    return {
      ...result,
      fallback_applied: fallbackApplied,
      duration_ms: Date.now() - start
    };
  }
}

export { getTelemetry, DomainConcurrencyTracker, CircuitBreaker };
