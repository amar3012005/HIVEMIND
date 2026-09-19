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
    onProgress(`Reading the official homepage and crawling first-party pages with Cloudflare Browser Rendering`);

    // ALL fetching is parallel: the direct homepage markdown fetch starts
    // immediately (fast path, ~2-4s) and the crawl job starts at the same
    // time. Whichever finishes first wins; the crawl only contributes
    // additional pages. No sequential waits anywhere.
    const homepagePromise = browserRenderingRequest('markdown', {
      url: websiteUrl,
      gotoOptions: { waitUntil: 'load', timeout: 30000 },
    }, { timeoutMs: 60_000 })
      .then((response) => response.json().catch(() => ({})))
      .then((data) => String(data?.result || '').replace(/\u0000/g, '').trim())
      .catch(() => '');

    const crawlPromise = browserRenderingRequest('crawl', {
      url: websiteUrl,
      limit: Math.min(10, Math.max(3, Number(limit) || 6)),
      depth: 1,
      formats: ['markdown'],
      render: true,
      crawlPurposes: ['search', 'ai-input'],
      contentUse: 'reference',
      options: { includeExternalLinks: false, includeSubdomains: false },
    }, { timeoutMs: 15_000 })
      .then((response) => response.json().catch(() => ({})))
      .then((startData) => String(startData?.result || '') || null)
      .catch(() => null);

    const homepageMarkdown = await homepagePromise;
    const jobId = await crawlPromise;

    const sameOrigin = (link) => {
      try {
        return new URL(link).hostname.replace(/^www\./, '') === new URL(websiteUrl).hostname.replace(/^www\./, '')
          && !/\.(png|jpe?g|svg|gif|css|js|pdf|ico|webp)$/i.test(link);
      } catch { return false; }
    };

    // Parallel page fetchers: extract same-site nav links from the homepage
    // markdown and fetch every one concurrently via /markdown.
    const fetchPagesInParallel = async (links, seen) => {
      const targets = [...new Set(links)]
        .filter((link) => link && !seen.has(link.replace(/\/$/, '')))
        .slice(0, Math.max(0, wanted - seen.size));
      const fetched = await Promise.all(targets.map(async (pageUrl) => {
        try {
          const response = await browserRenderingRequest('markdown', {
            url: pageUrl,
            gotoOptions: { waitUntil: 'load', timeout: 20000 },
          }, { timeoutMs: 45_000 });
          const data = await response.json().catch(() => ({}));
          const content = String(data?.result || '').replace(/\u0000/g, '').trim();
          if (!content) return null;
          return { url: pageUrl, title: '', description: '', content: content.slice(0, 9000), links: [], purpose: 'company', provider: 'cf-browser-rendering' };
        } catch { return null; }
      }));
      return fetched.filter(Boolean);
    };

    const wanted = Math.min(10, Math.max(3, Number(limit) || 6));
    const pages = [];
    const seen = new Set();
    if (homepageMarkdown) {
      pages.push({ url: websiteUrl, title: '', description: '', content: homepageMarkdown.slice(0, 9000), links: [], purpose: 'company', provider: 'cf-browser-rendering' });
      seen.add(websiteUrl.replace(/\/$/, ''));
    }

    const result = { total: wanted, browserSecondsUsed: 0, status: homepageMarkdown ? 'completed' : null };

    // Crawl job results (may be empty — the job can complete with most URLs
    // still queued; the direct fetches above already cover the gap).
    if (jobId && homepageMarkdown) {
      // Extract nav links from the homepage markdown and fetch pages
      // in parallel NOW, concurrent with the crawl job polling.
      const navLinks = [...homepageMarkdown.matchAll(/\((https?:\/\/[^)\s]+)\)/g)]
        .map((match) => match[1])
        .filter(sameOrigin);
      const parallelFetchPromise = fetchPagesInParallel(navLinks, seen);

      // Poll the crawl job concurrently.
      const boundedPollDelays = (Array.isArray(pollDelays) && pollDelays.length ? pollDelays : Array(10).fill(2000))
        .slice(0, 12).map((value) => Math.max(0, Number(value) || 0));
      let crawlResult = null;
      for (const delayMs of boundedPollDelays) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          const pollResponse = await fetch(
            `${BROWSER_RENDERING_BASE}/${cfConfig().accountId}/browser-rendering/crawl/${encodeURIComponent(jobId)}?limit=100&status=completed`,
            { headers: { Authorization: `Bearer ${cfConfig().apiToken}` }, signal: AbortSignal.timeout(15_000) },
          );
          if (!pollResponse.ok) break;
          const pollData = await pollResponse.json().catch(() => ({}));
          crawlResult = pollData?.result || null;
          if (crawlResult?.status === 'completed') break;
          if (['errored', 'cancelled_by_user', 'cancelled_due_to_limits', 'cancelled_due_to_timeout'].includes(crawlResult?.status || '')) break;
        } catch { break; }
      }
      if (crawlResult?.status === 'completed') {
        result.total = Number(crawlResult.total || result.total);
        result.browserSecondsUsed = Number(crawlResult.browserSecondsUsed || 0);
        for (const record of (Array.isArray(crawlResult.records) ? crawlResult.records : [])) {
          const url = record?.url || record?.metadata?.url || '';
          const content = String(record?.markdown || '').replace(/\u0000/g, '').trim().slice(0, 9000);
          if (url && content && !seen.has(url.replace(/\/$/, ''))) {
            pages.push({ url, title: String(record?.metadata?.title || '').slice(0, 300), description: String(record?.metadata?.description || '').slice(0, 500), content, links: [], purpose: 'company', provider: 'cf-browser-rendering' });
            seen.add(url.replace(/\/$/, ''));
          }
        }
      }
      // Merge the parallel direct fetches (they raced the crawl polling).
      const extra = await parallelFetchPromise;
      for (const page of extra) {
        if (!seen.has(page.url.replace(/\/$/, ''))) {
          pages.push(page);
          seen.add(page.url.replace(/\/$/, ''));
        }
      }
    } else if (homepageMarkdown) {
      // No crawl job — still fetch nav pages in parallel.
      const navLinks = [...homepageMarkdown.matchAll(/\((https?:\/\/[^)\s]+)\)/g)]
        .map((match) => match[1])
        .filter(sameOrigin);
      const extra = await fetchPagesInParallel(navLinks, seen);
      pages.push(...extra);
    }

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
      gotoOptions: { waitUntil: 'load', timeout: 30_000 },
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
