import { validateDomain } from './web-policy.js';

const DEFAULT_ENDPOINT = 'http://hm-playwright:8932/v1/crawl';
const DEFAULT_SETTLE_MS = 350;
const DEFAULT_TIMEOUT_MS = 270_000;

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function validateResult(payload) {
  if (!payload || !Array.isArray(payload.pages)) throw new Error('Playwright service returned an invalid response');
  const pages = payload.pages.filter((page) => page && normalizeUrl(page.url)).map((page) => ({
    ...page,
    rendered: true,
    links: Array.isArray(page.links) ? page.links : [],
    images: Array.isArray(page.images) ? page.images : [],
    seo: page.seo && typeof page.seo === 'object' ? page.seo : {},
    discovery: page.discovery && typeof page.discovery === 'object' ? page.discovery : {},
  }));
  if (!pages.length) throw new Error(payload.errors?.[0]?.error || 'Playwright service returned no pages');
  return {
    pages, errors: Array.isArray(payload.errors) ? payload.errors : [], runtime_used: 'playwright-service',
    session_used: payload.session_used ?? null,
    session_requested_but_missing: payload.session_requested_but_missing ?? null,
  };
}

export class PlaywrightServiceRuntime {
  constructor({ endpoint, token, settleMs, timeoutMs, fetchImpl } = {}) {
    this.name = 'playwright-service';
    this.endpoint = endpoint || process.env.HIVEMIND_PLAYWRIGHT_CRAWL_URL || DEFAULT_ENDPOINT;
    this.token = token ?? process.env.PLAYWRIGHT_SERVICE_TOKEN ?? '';
    this.settleMs = Math.max(0, Number(settleMs ?? process.env.HIVEMIND_PLAYWRIGHT_SETTLE_MS ?? DEFAULT_SETTLE_MS));
    this.timeoutMs = Math.max(3_000, Number(timeoutMs ?? process.env.HIVEMIND_PLAYWRIGHT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async crawl({ urls, depth = 2, pageLimit = 25, captureScreenshot = false, allowSubdomains = false, session = null, orgId = null } = {}) {
    const seeds = (Array.isArray(urls) ? urls : []).map(normalizeUrl).filter(Boolean);
    if (!seeds.length) throw new Error('No valid URLs provided');
    const allowedOrigin = new URL(seeds[0]).origin;
    if (!seeds.every((url) => new URL(url).origin === allowedOrigin && validateDomain(url).allowed)) {
      throw new Error('Playwright crawl seeds violate the same-origin public-web policy');
    }
    if (!this.token) throw new Error('Playwright service credential is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          urls: seeds,
          depth: Math.max(0, Math.min(Number(depth) || 0, 4)),
          page_limit: Math.max(1, Math.min(Number(pageLimit) || 25, 100)),
          settle_ms: this.settleMs,
          capture_screenshot: Boolean(captureScreenshot),
          allow_subdomains: Boolean(allowSubdomains),
          // Named, pre-captured session (LinkedIn/X/Instagram) — see
          // services/hm-playwright/sessions/README.md. hm-playwright validates
          // the name against its own allowlist before touching its filesystem;
          // an unknown/expired name degrades to an anonymous context there, so
          // no validation is duplicated here.
          ...(session ? { session: String(session).slice(0, 40), org_id: String(orgId || '') } : {}),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Playwright service failed (${response.status}): ${payload?.error || 'unknown error'}`);
      return validateResult(payload);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Playwright service timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export { validateResult };
