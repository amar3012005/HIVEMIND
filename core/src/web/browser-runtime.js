/**
 * Browser Runtime Abstraction for Web Intelligence
 *
 * Primary: Tavily API (search, extract, crawl) - production-grade, no infrastructure
 * Secondary: Lightpanda via CDP (local process or cloud websocket) - for edge cases
 * Fallback: Lightweight fetch-based runtime for resiliency
 *
 * Reliability controls:
 * - Tavily API as default (handles JS rendering, anti-bot, etc.)
 * - Per-domain concurrency cap (DomainConcurrencyTracker)
 * - Circuit breaker for Lightpanda failures (CircuitBreaker)
 * - Per-job timeout via HIVEMIND_WEB_JOB_TIMEOUT_MS
 * - Fallback telemetry (getTelemetry)
 * - Structured error classification
 */
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { getTavilyClient } from './tavily-client.js';

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
  tavilySuccesses: 0,
  tavilyFailures: 0,
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
      tavilySuccesses: this.tavilySuccesses,
      tavilyFailures: this.tavilyFailures,
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
// LightpandaRuntime — Enhanced with Tavily-like features
// ---------------------------------------------------------------------------

class LightpandaRuntime {
  constructor() {
    this.name = 'lightpanda';
    this.navigationTimeoutMs = Number(process.env.HIVEMIND_WEB_NAV_TIMEOUT_MS || 15000);
    this.waitForNetworkIdle = process.env.HIVEMIND_WEB_WAIT_NETWORK_IDLE !== 'false';
    this.extractImages = process.env.HIVEMIND_WEB_EXTRACT_IMAGES === 'true';
    this.extractLinks = process.env.HIVEMIND_WEB_EXTRACT_LINKS !== 'false';
  }

  /**
   * Enhanced search with Tavily-like features:
   * - Multiple search engines (DuckDuckGo, StartPage, Qwant)
   * - Rich snippet extraction
   * - Relevance scoring
   * - Favicon extraction
   * - Image extraction
   * - Domain authority estimation
   */
  async search({ query, domains, limit = 10 }) {
    const normalizedDomains = Array.isArray(domains)
      ? domains.map(normalizeUrl).filter(Boolean)
      : [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const errors = [];

    const results = await withLightpandaBrowser(async (browser) => {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);

      const records = [];
      const pushRecord = (record) => {
        if (!record?.url) return;
        records.push(record);
      };

      try {
        if (normalizedDomains.length > 0) {
          // Domain-specific search mode
          for (const targetUrl of normalizedDomains) {
            if (records.length >= safeLimit) break;

            const domain = extractDomain(targetUrl);
            if (!domainTracker.acquire(domain)) {
              telemetry.domainConcurrencyRejections += 1;
              errors.push({ target: targetUrl, ...classifyError(null, { concurrencyLimit: true, domain }) });
              continue;
            }

            try {
              await page.goto(targetUrl, {
                waitUntil: this.waitForNetworkIdle ? 'networkidle' : 'domcontentloaded',
                timeout: this.navigationTimeoutMs
              });

              // Enhanced content extraction (Tavily-like)
              const data = await page.evaluate(() => {
                const body = document.body || document.documentElement;
                const text = (body.innerText || '').replace(/\s+/g, ' ').trim();
                const title = (document.title || '').trim();
                const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
                const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
                const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
                const favicon = document.querySelector('link[rel="icon"]')?.getAttribute('href') ||
                               document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') || '';

                // Extract canonical URL
                const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || window.location.href;

                // Extract structured data if available
                let jsonLd = null;
                const ldJson = document.querySelector('script[type="application/ld+json"]');
                if (ldJson) {
                  try {
                    jsonLd = JSON.parse(ldJson.textContent);
                  } catch {}
                }

                return {
                  title: ogTitle || title,
                  text,
                  meta: ogDescription || meta,
                  ogImage,
                  favicon: favicon ? new URL(favicon, window.location.href).href : '',
                  url: canonical,
                  jsonLd
                };
              });

              const combinedText = `${data.text} ${data.meta}`.toLowerCase();
              if (data.url === 'about:blank' || /navigation failed/i.test(combinedText)) {
                errors.push({ target: targetUrl, type: 'navigation_failed', error: 'navigation_failed' });
                continue;
              }

              // Tavily-like relevance scoring
              const queryTerms = query?.toLowerCase().split(/\s+/).filter(t => t.length > 2) || [];
              let relevanceScore = 0;
              if (queryTerms.length > 0) {
                const matches = queryTerms.filter(term => combinedText.includes(term)).length;
                relevanceScore = matches / queryTerms.length;
              }

              // Domain authority estimation (simple heuristic)
              const domainAuthority = this._estimateDomainAuthority(data.url);

              pushRecord({
                title: data.title || new URL(data.url).hostname,
                url: data.url,
                snippet: extractSnippet(data.meta || data.text),
                content: data.text.slice(0, 2000), // Tavily-like raw content
                score: relevanceScore * 0.7 + domainAuthority * 0.3,
                favicon: data.favicon,
                image: data.ogImage,
                domainAuthority
              });
            } catch (error) {
              const classified = classifyError(error);
              errors.push({ target: targetUrl, type: classified.type, error: classified.message });
            } finally {
              domainTracker.release(domain);
            }
          }
        } else {
          // Web search mode - Try multiple engines for better coverage
          const searchEngines = [
            { name: 'duckduckgo', url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, selector: 'article h2 a, .result__a, a[data-testid="result-title-a"]' },
            { name: 'qwant', url: `https://www.qwant.com/?q=${encodeURIComponent(query)}`, selector: 'a.result-link, .result-item a' },
          ];

          let allResults = [];

          for (const engine of searchEngines) {
            try {
              await page.goto(engine.url, {
                waitUntil: 'domcontentloaded',
                timeout: this.navigationTimeoutMs
              });

              // Wait for results to load
              await page.waitForSelector(engine.selector, { timeout: 5000 }).catch(() => {});

              const engineResults = await page.evaluate((selector) => {
                const items = Array.from(document.querySelectorAll(selector));
                return items.slice(0, 15).map((node) => {
                  const href = node.getAttribute('href') || '';
                  const title = (node.textContent || '').trim();
                  // Try to find snippet/description
                  let snippet = '';
                  const parent = node.parentElement || node.closest('article') || node.closest('.result-item');
                  if (parent) {
                    snippet = (parent.querySelector('.snippet, .result__snippet, .result-desc, p')?.textContent || '').trim();
                  }
                  return { title, url: href, snippet };
                }).filter((item) => item.url && item.title && !item.url.includes('qwant.com') && !item.url.includes('duckduckgo.com'));
              }, engine.selector);

              allResults = [...allResults, ...engineResults];
            } catch (err) {
              console.warn(`[Lightpanda] Search engine ${engine.name} failed:`, err.message);
            }
          }

          // Deduplicate and limit results
          const uniqueByUrl = new Map();
          for (const item of allResults) {
            if (!uniqueByUrl.has(item.url)) {
              // Enhanced snippet extraction
              const urlObj = new URL(item.url);
              const domainAuthority = this._estimateDomainAuthority(item.url);

              uniqueByUrl.set(item.url, {
                title: item.title,
                url: item.url,
                snippet: item.snippet || extractSnippet(item.title),
                score: domainAuthority, // Score based on domain authority for web search
                favicon: `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`,
                domainAuthority
              });
            }
          }

          const sortedResults = [...uniqueByUrl.values()]
            .sort((a, b) => (b.score || 0) - (a.score || 0));

          for (const item of sortedResults.slice(0, safeLimit)) {
            pushRecord(item);
          }
        }
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }

      return [...records].slice(0, safeLimit);
    });

    return {
      results,
      runtime_used: this.name,
      errors,
      answer: null, // Lightpanda doesn't generate answers
    };
  }

  /**
   * Estimate domain authority using simple heuristics
   * (Tavily-like feature for result ranking)
   */
  _estimateDomainAuthority(url) {
    try {
      const domain = new URL(url).hostname.toLowerCase();

      // High-authority domains
      const highAuthority = [
        'wikipedia.org', 'github.com', 'stackoverflow.com', 'medium.com',
        'nytimes.com', 'washingtonpost.com', 'reuters.com', 'apnews.com',
        'bbc.com', 'theguardian.com', 'forbes.com', 'wsj.com',
        '.edu', '.gov', '.org'
      ];

      // Check for high-authority TLDs and domains
      for (const auth of highAuthority) {
        if (domain.endsWith(auth) || domain === auth) return 0.9;
      }

      // Medium authority (news, tech sites)
      const mediumAuthority = ['cnn.com', 'techcrunch.com', 'theverge.com', 'wired.com'];
      for (const auth of mediumAuthority) {
        if (domain.endsWith(auth) || domain === auth) return 0.7;
      }

      // Default authority
      return 0.5;
    } catch {
      return 0.5;
    }
  }

  /**
   * Enhanced crawl with Tavily-like features:
   * - Rich content extraction (markdown-like structure)
   * - Image extraction
   * - Link extraction with context
   * - Metadata extraction (OpenGraph, JSON-LD)
   * - Word count and reading time
   * - Content quality scoring
   */
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
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
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
            await page.goto(url, {
              waitUntil: this.waitForNetworkIdle ? 'networkidle' : 'domcontentloaded',
              timeout: this.navigationTimeoutMs
            });

            // Enhanced content extraction (Tavily-like)
            const data = await page.evaluate(() => {
              // Get main content (try article tag first, then body)
              const mainContent = document.querySelector('article, main, [role="main"]') || document.body;

              // Extract title
              const title = (document.title || '').trim();
              const h1 = document.querySelector('h1')?.textContent?.trim() || '';

              // Extract metadata
              const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
              const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
              const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
              const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
              const author = document.querySelector('meta[name="author"]')?.getAttribute('content') ||
                            document.querySelector('.byline, .author')?.textContent?.trim() || '';
              const publishedTime = document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
                                   document.querySelector('time[datetime]')?.getAttribute('datetime') || '';

              // Extract images
              const images = Array.from(mainContent.querySelectorAll('img[src]'))
                .map(img => {
                  const src = img.getAttribute('src') || '';
                  const alt = img.getAttribute('alt') || '';
                  if (!src || src.startsWith('data:')) return null;
                  return {
                    src: src.startsWith('http') ? src : new URL(src, window.location.href).href,
                    alt,
                    width: img.width,
                    height: img.height
                  };
                })
                .filter(Boolean)
                .slice(0, 20);

              // Extract links with context
              const links = Array.from(mainContent.querySelectorAll('a[href]'))
                .map(a => {
                  const href = a.getAttribute('href') || '';
                  const text = a.textContent?.trim() || '';
                  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
                  return {
                    href: href.startsWith('http') ? href : new URL(href, window.location.href).href,
                    text,
                    title: a.getAttribute('title') || ''
                  };
                })
                .filter(Boolean)
                .slice(0, 50);

              // Extract content as markdown-like structure
              let markdown = `# ${ogTitle || h1 || title}\n\n`;

              if (description) {
                markdown += `> ${description}\n\n`;
              }

              // Extract headings and paragraphs
              const headings = Array.from(mainContent.querySelectorAll('h2, h3, h4, h5, h6'));
              const paragraphs = Array.from(mainContent.querySelectorAll('p, li'));

              for (const heading of headings.slice(0, 20)) {
                const tag = heading.tagName.toLowerCase();
                const text = heading.textContent?.trim();
                if (text) {
                  const prefix = tag === 'h2' ? '##' : tag === 'h3' ? '###' : '####';
                  markdown += `${prefix} ${text}\n\n`;
                }
              }

              for (const para of paragraphs.slice(0, 100)) {
                const text = para.textContent?.trim();
                if (text && text.length > 20) {
                  markdown += `${text}\n\n`;
                }
              }

              // Extract JSON-LD structured data
              let jsonLd = null;
              const ldJsonScript = document.querySelector('script[type="application/ld+json"]');
              if (ldJsonScript) {
                try {
                  jsonLd = JSON.parse(ldJsonScript.textContent);
                } catch {}
              }

              // Calculate word count and reading time
              const textContent = mainContent.innerText || '';
              const wordCount = textContent.split(/\s+/).filter(w => w.length > 1).length;
              const readingTime = Math.ceil(wordCount / 200); // ~200 words per minute

              // Content quality score
              const hasImages = images.length > 0;
              const hasStructuredData = !!jsonLd;
              const hasAuthor = !!author;
              const hasPublishDate = !!publishedTime;
              const qualityScore = (
                (hasImages ? 0.2 : 0) +
                (hasStructuredData ? 0.2 : 0) +
                (hasAuthor ? 0.2 : 0) +
                (hasPublishDate ? 0.2 : 0) +
                (wordCount > 500 ? 0.2 : 0)
              );

              return {
                url: window.location.href,
                title: ogTitle || h1 || title,
                description: ogDescription || description,
                content: markdown,
                text: textContent.replace(/\s+/g, ' ').trim(),
                images,
                links,
                author,
                publishedTime,
                jsonLd,
                wordCount,
                readingTime,
                qualityScore,
                favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || ''
              };
            });

            const normalizedContent = (data.text || '').toLowerCase();
            if (data.url === 'about:blank' || normalizedContent.includes('navigation failed')) {
              errors.push({ target: url, type: 'navigation_failed', error: 'navigation_failed' });
              domainTracker.release(domain);
              continue;
            }

            pages.push({
              url: data.url,
              title: data.title || data.url,
              content: data.content, // Markdown format (Tavily-like)
              text: data.text,
              description: data.description,
              images: data.images,
              links: data.links,
              author: data.author,
              publishedTime: data.publishedTime,
              wordCount: data.wordCount,
              readingTime: data.readingTime,
              qualityScore: data.qualityScore,
              favicon: data.favicon ? new URL(data.favicon, data.url).href : null,
              jsonLd: data.jsonLd ? JSON.stringify(data.jsonLd).slice(0, 1000) : null,
            });

            // Queue links for crawling if depth allows
            if (currentDepth < safeDepth) {
              const sameDomainLinks = data.links
                .filter(link => {
                  try {
                    const linkDomain = new URL(link.href).hostname;
                    return linkDomain === domain || linkDomain.endsWith('.' + domain);
                  } catch {
                    return false;
                  }
                })
                .map(link => ({ url: link.href, currentDepth: currentDepth + 1 }));

              // Add to queue (avoid exceeding limit)
              for (const link of sameDomainLinks) {
                if (!visited.has(link.url) && queue.length + pages.length < safePageLimit * 3) {
                  queue.push(link);
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

    return {
      pages,
      runtime_used: this.name,
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// FetchFallbackRuntime — Enhanced with Tavily-like features
// ---------------------------------------------------------------------------

class FetchFallbackRuntime {
  constructor() {
    this.name = 'fetch';
  }

  /**
   * Enhanced search with Tavily-like features:
   * - Multiple search engines
   * - Domain authority scoring
   * - Rich snippets
   * - Favicon extraction
   */
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

          // Extract metadata
          const description = this._extractMeta(html, 'description');
          const ogTitle = this._extractMeta(html, 'og:title');
          const ogDescription = this._extractMeta(html, 'og:description');
          const ogImage = this._extractMeta(html, 'og:image');
          const favicon = this._extractFavicon(html, url);

          // Domain authority
          const domainAuthority = this._estimateDomainAuthority(url);

          // Relevance scoring
          const queryTerms = query?.toLowerCase().split(/\s+/).filter(t => t.length > 2) || [];
          let relevanceScore = 0;
          if (queryTerms.length > 0) {
            const matches = queryTerms.filter(term => text.toLowerCase().includes(term)).length;
            relevanceScore = matches / queryTerms.length;
          }

          if (!query || text.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              title: ogTitle || title || new URL(url).hostname,
              url,
              snippet: extractSnippet(ogDescription || description || text),
              content: text.slice(0, 2000),
              score: relevanceScore * 0.7 + domainAuthority * 0.3,
              favicon,
              image: ogImage,
              domainAuthority
            });
          }
        } catch (error) {
          const classified = classifyError(error);
          errors.push({ target: url, type: classified.type, error: classified.message });
        }
      }

      // Sort by score
      results.sort((a, b) => (b.score || 0) - (a.score || 0));
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

      // Parse DDG results with enhanced extraction
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultPattern.exec(html)) !== null && results.length < safeLimit) {
        const rawUrl = match[1];
        const url = decodeURIComponent((rawUrl.match(/uddg=([^&]+)/) || [])[1] || rawUrl);
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();

        if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
          const urlObj = new URL(url);
          results.push({
            url,
            title,
            snippet,
            favicon: `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`,
            score: this._estimateDomainAuthority(url),
            domainAuthority: this._estimateDomainAuthority(url)
          });
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
            const urlObj = new URL(url);
            results.push({
              url,
              title,
              snippet: title,
              favicon: `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`,
              score: this._estimateDomainAuthority(url),
              domainAuthority: this._estimateDomainAuthority(url)
            });
          }
        }
      }
    } catch (error) {
      errors.push({ target: 'duckduckgo', error: error.message });
    }

    return { results, runtime_used: `${this.name}+duckduckgo`, errors };
  }

  /**
   * Enhanced crawl with Tavily-like features
   */
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

        // Enhanced extraction
        const title = extractTitle(html);
        const description = this._extractMeta(html, 'description');
        const ogTitle = this._extractMeta(html, 'og:title');
        const ogDescription = this._extractMeta(html, 'og:description');
        const ogImage = this._extractMeta(html, 'og:image');
        const author = this._extractMeta(html, 'author');
        const text = stripHtmlToText(html);
        const wordCount = text.split(/\s+/).filter(w => w.length > 1).length;
        const readingTime = Math.ceil(wordCount / 200);

        // Extract images
        const images = this._extractImages(html, url);

        // Extract links
        const links = extractLinksFromHtml(html, url).slice(0, 50);

        // Quality score
        const qualityScore = this._calculateQualityScore(html, wordCount, images.length);

        pages.push({
          url,
          title: ogTitle || title || url,
          description: ogDescription || description,
          text,
          content: text,
          word_count: wordCount,
          readingTime,
          images,
          links: links.map(href => ({ href, text: '' })),
          author,
          favicon: this._extractFavicon(html, url),
          qualityScore
        });

        if (currentDepth < safeDepth) {
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

  /**
   * Extract meta tag content
   */
  _extractMeta(html, name) {
    // Handle both name and property attributes
    const patterns = [
      new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]*property=["']og:${name}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${name}["'][^>]*>`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return '';
  }

  /**
   * Extract favicon URL
   */
  _extractFavicon(html, baseUrl) {
    const patterns = [
      /<link[^>]*rel=["']icon["'][^>]*href=["']([^"']*)["'][^>]*>/i,
      /<link[^>]*href=["']([^"']*)["'][^>]*rel=["']icon["'][^>]*>/i,
      /<link[^>]*rel=["']shortcut icon["'][^>]*href=["']([^"']*)["'][^>]*>/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        try {
          return new URL(match[1], baseUrl).href;
        } catch {
          return match[1];
        }
      }
    }

    // Fallback to Google's favicon service
    try {
      const domain = new URL(baseUrl).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return '';
    }
  }

  /**
   * Extract images from HTML
   */
  _extractImages(html, baseUrl) {
    const images = [];
    const pattern = /<img[^>]*src=["']([^"']*)["'][^>]*>/gi;
    let match;

    while ((match = pattern.exec(html)) !== null && images.length < 20) {
      const src = match[1];
      const altPattern = /alt=["']([^"']*)["']/i;
      const altMatch = match[0].match(altPattern);
      const alt = altMatch ? altMatch[1] : '';

      if (src && !src.startsWith('data:')) {
        try {
          images.push({
            src: src.startsWith('http') ? src : new URL(src, baseUrl).href,
            alt
          });
        } catch {
          // Skip invalid URLs
        }
      }
    }

    return images;
  }

  /**
   * Estimate domain authority (same as LightpandaRuntime)
   */
  _estimateDomainAuthority(url) {
    try {
      const domain = new URL(url).hostname.toLowerCase();
      const highAuthority = [
        'wikipedia.org', 'github.com', 'stackoverflow.com', 'medium.com',
        'nytimes.com', 'washingtonpost.com', 'reuters.com', 'apnews.com',
        'bbc.com', 'theguardian.com', 'forbes.com', 'wsj.com',
        '.edu', '.gov', '.org'
      ];

      for (const auth of highAuthority) {
        if (domain.endsWith(auth) || domain === auth) return 0.9;
      }

      const mediumAuthority = ['cnn.com', 'techcrunch.com', 'theverge.com', 'wired.com'];
      for (const auth of mediumAuthority) {
        if (domain.endsWith(auth) || domain === auth) return 0.7;
      }

      return 0.5;
    } catch {
      return 0.5;
    }
  }

  /**
   * Calculate content quality score
   */
  _calculateQualityScore(html, wordCount, imageCount) {
    let score = 0;

    // Word count contribution (max 0.4)
    if (wordCount > 1000) score += 0.4;
    else if (wordCount > 500) score += 0.3;
    else if (wordCount > 200) score += 0.2;
    else if (wordCount > 50) score += 0.1;

    // Image contribution (max 0.2)
    if (imageCount > 5) score += 0.2;
    else if (imageCount > 2) score += 0.15;
    else if (imageCount > 0) score += 0.1;

    // Has structured data (max 0.2)
    if (html.includes('application/ld+json')) score += 0.2;

    // Has OpenGraph tags (max 0.2)
    if (html.includes('og:title') && html.includes('og:description')) score += 0.2;

    return Math.min(score, 1.0);
  }
}

// ---------------------------------------------------------------------------
// BrowserRuntime — public facade with Tavily primary + Lightpanda/fetch fallback
// ---------------------------------------------------------------------------

export class BrowserRuntime {
  constructor() {
    this.primary = new TavilyRuntime();
    this.lightpanda = new LightpandaRuntime();
    this.fallback = new FetchFallbackRuntime();
    this._tavilyUnavailable = false;
  }

  async search({ query, domains, limit }) {
    const start = Date.now();
    telemetry.totalJobs += 1;
    let fallbackApplied = false;
    let runtimeUsed = this.primary.name;
    let result;

    // Try Tavily first (primary)
    if (!this._tavilyUnavailable) {
      try {
        result = await withJobTimeout(this.primary.search({ query, domains, limit }));
        telemetry.tavilySuccesses = (telemetry.tavilySuccesses || 0) + 1;
        return {
          ...result,
          fallback_applied: false,
          duration_ms: Date.now() - start,
        };
      } catch (primaryErr) {
        // Check if Tavily is unavailable (auth error or not configured)
        if (primaryErr.isAuthError || primaryErr.message.includes('not configured')) {
          this._tavilyUnavailable = true;
          console.warn('[BrowserRuntime] Tavily unavailable, falling back to Lightpanda');
        } else if (primaryErr.isRateLimit || primaryErr.isQuotaExceeded) {
          // Rate limited or quota exceeded — try fallback
          fallbackApplied = true;
          runtimeUsed = 'lightpanda';
        } else {
          // Other errors — try fallback
          fallbackApplied = true;
          runtimeUsed = 'lightpanda';
        }
      }
    }

    // Tavily unavailable or failed — try Lightpanda
    if (fallbackApplied || this._tavilyUnavailable) {
      try {
        result = await withJobTimeout(this.lightpanda.search({ query, domains, limit }));
        telemetry.lightpandaSuccesses = (telemetry.lightpandaSuccesses || 0) + 1;
        return {
          ...result,
          fallback_applied: true,
          runtime_used: 'lightpanda',
          duration_ms: Date.now() - start,
          errors: result.errors || [],
        };
      } catch (lpErr) {
        if (lpErr._jobTimeout) {
          _recordDuration(Date.now() - start);
          return {
            results: [],
            runtime_used: 'none',
            fallback_applied: true,
            duration_ms: Date.now() - start,
            error: 'job_timeout',
            errors: [classifyError(null, { jobTimeout: true })],
          };
        }
        // Lightpanda failed — try fetch fallback
        runtimeUsed = 'fetch';
      }
    }

    // Last resort: fetch fallback
    try {
      result = await withJobTimeout(this.fallback.search({ query, domains, limit }));
      telemetry.fallbackSuccesses = (telemetry.fallbackSuccesses || 0) + 1;
    } catch (fallbackErr) {
      telemetry.fallbackFailures = (telemetry.fallbackFailures || 0) + 1;
      if (fallbackErr._jobTimeout) {
        _recordDuration(Date.now() - start);
        return {
          results: [],
          runtime_used: 'none',
          fallback_applied: true,
          duration_ms: Date.now() - start,
          error: 'job_timeout',
          errors: [classifyError(null, { jobTimeout: true })],
        };
      }
      throw new Error(`All runtimes failed. Tavily: ${primaryErr?.message || 'skipped'}; Lightpanda: ${lpErr?.message || 'skipped'}; Fallback: ${fallbackErr.message}`);
    }

    _recordDuration(Date.now() - start);
    return {
      ...result,
      fallback_applied: true,
      runtime_used: runtimeUsed,
      duration_ms: Date.now() - start,
    };
  }

  async crawl({ urls, depth, pageLimit, include, exclude }) {
    const start = Date.now();
    telemetry.totalJobs += 1;
    let fallbackApplied = false;
    let runtimeUsed = this.primary.name;
    let result;

    // Try Tavily first (primary)
    if (!this._tavilyUnavailable) {
      try {
        result = await withJobTimeout(this.primary.crawl({ urls, depth, pageLimit, include, exclude }));
        telemetry.tavilySuccesses = (telemetry.tavilySuccesses || 0) + 1;
        return {
          ...result,
          fallback_applied: false,
          duration_ms: Date.now() - start,
        };
      } catch (primaryErr) {
        if (primaryErr.isAuthError || primaryErr.message.includes('not configured')) {
          this._tavilyUnavailable = true;
          console.warn('[BrowserRuntime] Tavily unavailable, falling back to Lightpanda');
        } else {
          fallbackApplied = true;
          runtimeUsed = 'lightpanda';
        }
      }
    }

    // Tavily unavailable or failed — try Lightpanda
    if (fallbackApplied || this._tavilyUnavailable) {
      try {
        result = await withJobTimeout(this.lightpanda.crawl({ urls, depth, pageLimit, include, exclude }));
        telemetry.lightpandaSuccesses = (telemetry.lightpandaSuccesses || 0) + 1;
        return {
          ...result,
          fallback_applied: true,
          runtime_used: 'lightpanda',
          duration_ms: Date.now() - start,
        };
      } catch (lpErr) {
        if (lpErr._jobTimeout) {
          _recordDuration(Date.now() - start);
          return {
            pages: [],
            runtime_used: 'none',
            fallback_applied: true,
            duration_ms: Date.now() - start,
            error: 'job_timeout',
            errors: [classifyError(null, { jobTimeout: true })],
          };
        }
        runtimeUsed = 'fetch';
      }
    }

    // Last resort: fetch fallback
    try {
      result = await withJobTimeout(this.fallback.crawl({ urls, depth, pageLimit, include, exclude }));
      telemetry.fallbackSuccesses = (telemetry.fallbackSuccesses || 0) + 1;
    } catch (fallbackErr) {
      telemetry.fallbackFailures = (telemetry.fallbackFailures || 0) + 1;
      if (fallbackErr._jobTimeout) {
        _recordDuration(Date.now() - start);
        return {
          pages: [],
          runtime_used: 'none',
          fallback_applied: true,
          duration_ms: Date.now() - start,
          error: 'job_timeout',
          errors: [classifyError(null, { jobTimeout: true })],
        };
      }
      throw new Error(`All runtimes failed`);
    }

    _recordDuration(Date.now() - start);
    return {
      ...result,
      fallback_applied: true,
      runtime_used: runtimeUsed,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Check if Tavily is the active runtime
   */
  isTavilyActive() {
    return !this._tavilyUnavailable && this.primary.client?.isAvailable();
  }
}

// ---------------------------------------------------------------------------
// TavilyRuntime — Primary runtime using Tavily API
// ---------------------------------------------------------------------------

export class TavilyRuntime {
  constructor() {
    this.name = 'tavily';
    this.client = getTavilyClient();
  }

  async search({ query, domains, limit = 10 }) {
    if (!this.client.isAvailable()) {
      throw new Error('Tavily API not configured');
    }

    const normalizedDomains = Array.isArray(domains)
      ? domains.map((d) => {
          try {
            return new URL(d.startsWith('http') ? d : `https://${d}`).hostname;
          } catch {
            return null;
          }
        }).filter(Boolean)
      : [];

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));

    const result = await this.client.search({
      query,
      maxResults: safeLimit,
      searchDepth: 'basic',
      includeAnswer: true,
      includeRawContent: false,
      includeImages: false,
      includeFavicon: true,
      includeDomains: normalizedDomains.length > 0 ? normalizedDomains : undefined,
    });

    return {
      results: result.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content || r.snippet || '',
        score: r.score,
        favicon: r.favicon,
      })),
      answer: result.answer,
      runtime_used: this.name,
      duration_ms: result.responseTimeMs,
      credits_used: result.creditsUsed,
      errors: [],
    };
  }

  async crawl({ urls, depth = 1, pageLimit = 50, include, exclude }) {
    if (!this.client.isAvailable()) {
      throw new Error('Tavily API not configured');
    }

    const validUrls = Array.isArray(urls)
      ? urls.map((u) => {
          try {
            return new URL(u.startsWith('http') ? u : `https://${u}`).href;
          } catch {
            return null;
          }
        }).filter(Boolean)
      : [];

    if (validUrls.length === 0) {
      throw new Error('No valid URLs provided');
    }

    const safeDepth = Math.max(1, Math.min(Number(depth) || 1, 5));
    const safePageLimit = Math.max(1, Math.min(Number(pageLimit) || 50, 500));

    // If single URL with depth > 1, use crawl endpoint
    if (validUrls.length === 1 && depth > 1) {
      const result = await this.client.crawl({
        url: validUrls[0],
        maxDepth: safeDepth,
        limit: safePageLimit,
        extractDepth: 'basic',
        format: 'markdown',
      });

      return {
        pages: result.results.map((r) => ({
          url: r.url,
          title: r.url,
          content: r.rawContent,
          text: r.rawContent,
        })),
        runtime_used: this.name,
        duration_ms: result.responseTimeMs,
        credits_used: result.creditsUsed,
        errors: [],
      };
    }

    // Multiple URLs: use extract endpoint
    const result = await this.client.extract({
      urls: validUrls.slice(0, 20), // Tavily limit
      format: 'markdown',
      extractDepth: 'basic',
    });

    const failedErrors = (result.failedResults || []).map((f) => ({
      target: f.url,
      type: 'extraction_failed',
      error: f.error,
    }));

    return {
      pages: result.results.map((r) => ({
        url: r.url,
        title: r.url,
        content: r.rawContent,
        text: r.rawContent,
      })),
      runtime_used: this.name,
      duration_ms: result.responseTimeMs,
      credits_used: result.creditsUsed,
      errors: failedErrors,
    };
  }

  getTelemetry() {
    return this.client.getTelemetry();
  }
}

export { getTelemetry, DomainConcurrencyTracker, CircuitBreaker };
