/**
 * Cloudflare Browser Rendering + AI Gateway Parallel transport for onboarding
 * research. Replaces Firecrawl (scrape/crawl/search) and Playwright with
 * first-party Cloudflare endpoints:
 *
 *   crawl      → POST /browser-rendering/crawl  (async job, poll to completion)
 *   screenshot → POST /browser-rendering/screenshot (sync PNG)
 *   search     → POST gateway.ai.cloudflare.com/.../parallel/v1beta/search
 *
 * Every function is best-effort: a failure returns null/[] and the caller's
 * existing fallback chain (direct fetch → og:image) still applies. The
 * Firecrawl implementations remain available as the explicit rollback path.
 */

const BROWSER_RENDERING_BASE = 'https://api.cloudflare.com/client/v4/accounts';

function cfConfig() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  return { accountId, apiToken, enabled: Boolean(accountId && apiToken) };
}

export function cloudflareBrowserEnabled() { return cfConfig().enabled; }

function parallelConfig() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const gatewayId = String(process.env.CLOUDFLARE_AI_GATEWAY_ID || '').trim();
  // The gateway token doubles as the Parallel provider credential when the
  // account stores the Parallel key BYOK-side (verified live: gateway token
  // as x-api-key returns 200 from /parallel/v1beta/search). A dedicated
  // PARALLEL_API_KEY still takes precedence when set.
  const apiKey = String(process.env.PARALLEL_API_KEY || process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '').trim();
  return { accountId, gatewayId, apiKey, enabled: Boolean(accountId && gatewayId && apiKey) };
}

export function cloudflareParallelSearchEnabled() { return parallelConfig().enabled; }

async function browserRenderingRequest(path, body, { timeoutMs = 30_000 } = {}) {
  const { accountId, apiToken } = cfConfig();
  const response = await fetch(`${BROWSER_RENDERING_BASE}/${accountId}/browser-rendering/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`browser_rendering_${path}_${response.status}`);
  return response;
}

/**
 * Crawl up to `limit` first-party pages as markdown. One async job replaces
 * the Firecrawl scrape+crawl pair. Polls to completion (≤ ~40s budget).
 */
export async function cfCrawlWebsite(websiteUrl, {
  limit = 6,
  onProgress = () => {},
  pollDelays = Array(10).fill(2000),
} = {}) {
  if (!cloudflareBrowserEnabled()) return { provider: 'fallback', pages: [], mapped: 0, error: 'not_configured' };
  try {
    const { accountId, apiToken } = cfConfig();
    onProgress(`Crawling up to ${limit} first-party pages with Cloudflare Browser Rendering`);
    const startResponse = await browserRenderingRequest('crawl', {
      url: websiteUrl,
      limit: Math.min(10, Math.max(3, Number(limit) || 6)),
      depth: 1,
      formats: ['markdown'],
      render: true,
      crawlPurposes: ['search', 'ai-input'],
      contentUse: 'reference',
      options: { includeExternalLinks: false, includeSubdomains: false },
    }, { timeoutMs: 15_000 });
    const startData = await startResponse.json().catch(() => ({}));
    const jobId = startData?.result;
    if (!jobId) throw new Error('crawl_job_not_created');

    const boundedPollDelays = (Array.isArray(pollDelays) && pollDelays.length ? pollDelays : Array(10).fill(2000))
      .slice(0, 12).map((value) => Math.max(0, Number(value) || 0));
    let status = null;
    for (const delayMs of boundedPollDelays) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const pollResponse = await fetch(
        `${BROWSER_RENDERING_BASE}/${cfConfig().accountId}/browser-rendering/crawl/${encodeURIComponent(jobId)}?limit=100`,
        { headers: { Authorization: `Bearer ${cfConfig().apiToken}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!pollResponse.ok) throw new Error(`crawl_poll_${pollResponse.status}`);
      status = await pollResponse.json().catch(() => ({}));
      const result = status?.result || {};
      if (result.status === 'completed') break;
      if (['errored', 'cancelled_by_user', 'cancelled_due_to_limits', 'cancelled_due_to_timeout'].includes(result.status)) {
        throw new Error(`crawl_${result.status}`);
      }
    }
    const result = status?.result || {};
    if (result.status !== 'completed') throw new Error('crawl_poll_timeout');
    const records = Array.isArray(result.records) ? result.records : [];
    const pages = records.map((record) => ({
      url: record?.url || record?.metadata?.url || '',
      title: String(record?.metadata?.title || '').slice(0, 300),
      description: String(record?.metadata?.description || '').slice(0, 500),
      content: String(record?.markdown || '').replace(/\u0000/g, '').trim().slice(0, 9000),
      links: [],
      purpose: 'company',
      provider: 'cf-browser-rendering',
    })).filter((page) => page.content && page.url);
    if (!pages.length) throw new Error('crawl_returned_no_usable_pages');
    onProgress(`Read ${pages.length} first-party pages in one bounded crawl`);
    return {
      provider: 'cf-browser-rendering',
      pages,
      mapped: Number(result.total || pages.length),
      social_profiles: [],
      contacts: null,
      screenshot: null,
      credits_used: Number(result.browserSecondsUsed || 0),
      error: null,
    };
  } catch (error) {
    return { provider: 'fallback', pages: [], mapped: 0, error: error.message };
  }
}

/** Sync PNG screenshot via Browser Rendering. Returns a data URI or null. */
export async function cfCaptureScreenshot(websiteUrl) {
  if (!cloudflareBrowserEnabled()) return null;
  try {
    const response = await browserRenderingRequest('screenshot', {
      url: websiteUrl,
      screenshotOptions: { fullPage: false },
      viewport: { width: 1280, height: 720 },
      gotoOptions: { waitUntil: 'networkidle2', timeout: 45_000 },
    }, { timeoutMs: 60_000 });
    const buffer = await response.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:image/png;base64,${btoa(binary)}`;
  } catch (error) {
    console.warn('[onboarding-cf] screenshot failed:', error.message);
    return null;
  }
}

/**
 * Market/social search via Parallel Search API through AI Gateway.
 * Single request — replaces the Tavily submit+poll loop.
 */
export async function cfParallelSearch(objective, { limit = 10 } = {}) {
  if (!cloudflareParallelSearchEnabled()) return [];
  const { accountId, gatewayId, apiKey } = parallelConfig();
  try {
    const response = await fetch(
      `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/parallel/v1beta/search`,
      {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: String(objective || '').slice(0, 500),
          processor: 'base',
          max_results: Math.min(10, Math.max(1, Number(limit) || 10)),
          max_chars_per_result: 700,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`parallel_search_${response.status}`);
    const data = await response.json().catch(() => ({}));
    return (Array.isArray(data.results) ? data.results : []).map((item) => ({
      title: String(item?.title || '').slice(0, 300),
      url: String(item?.url || '').slice(0, 1000),
      snippet: String(item?.text || item?.content || '').slice(0, 700),
      provider: 'parallel-ai-gateway',
    })).filter((item) => item.url);
  } catch (error) {
    console.warn('[onboarding-cf] parallel search failed:', error.message);
    return [];
  }
}
