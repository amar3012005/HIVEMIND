/**
 * Browser Runtime Abstraction for Web Intelligence
 *
 * Provides search and crawl capabilities with runtime fallback:
 *   LightpandaRuntime (primary) -> ChromiumRuntime (fallback)
 *
 * Both runtimes currently use fetch + HTML-to-text extraction.
 * Actual Lightpanda/Chromium binary integration is stubbed for future work.
 */

function stripHtmlToText(html) {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#039;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function extractSnippet(text, maxLength = 300) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s\S*$/, '') + '...';
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href;
      if (resolved.startsWith('http')) {
        links.push(resolved);
      }
    } catch {
      // skip invalid URLs
    }
  }
  return [...new Set(links)];
}

function matchesPattern(url, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }
    return url.includes(pattern);
  });
}

async function fetchPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HivemindBot/1.0 (+https://hivemind.davinciai.eu)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    return html;
  } finally {
    clearTimeout(timer);
  }
}

class LightpandaRuntime {
  constructor() {
    this.name = 'lightpanda';
  }

  async search({ query, domains, limit = 10 }) {
    // Build a search URL using a public search engine scrape
    // For now: fetch pages from provided domains with query as context
    const results = [];
    const searchDomains = domains && domains.length > 0 ? domains : [];

    if (searchDomains.length > 0) {
      for (const domain of searchDomains) {
        if (results.length >= limit) break;
        try {
          const url = `https://${domain}`;
          const html = await fetchPage(url);
          const title = extractTitle(html);
          const text = stripHtmlToText(html);
          const snippet = extractSnippet(text);
          results.push({ title: title || domain, url, snippet });
        } catch {
          // skip unreachable domains
        }
      }
    }

    return { results: results.slice(0, limit), runtime_used: this.name };
  }

  async crawl({ urls, depth = 1, pageLimit = 50, include, exclude }) {
    const pages = [];
    const visited = new Set();
    const queue = urls.map(u => ({ url: u, currentDepth: 0 }));

    while (queue.length > 0 && pages.length < pageLimit) {
      const { url, currentDepth } = queue.shift();

      if (visited.has(url)) continue;
      visited.add(url);

      if (include && !matchesPattern(url, include)) continue;
      if (exclude && matchesPattern(url, exclude)) continue;

      try {
        const html = await fetchPage(url);
        const title = extractTitle(html);
        const content = stripHtmlToText(html);
        pages.push({ url, title: title || url, content });

        if (currentDepth < depth) {
          const links = extractLinks(html, url);
          for (const link of links) {
            if (!visited.has(link) && pages.length + queue.length < pageLimit * 2) {
              queue.push({ url: link, currentDepth: currentDepth + 1 });
            }
          }
        }
      } catch {
        // skip pages that fail to fetch
      }
    }

    return { pages, runtime_used: this.name };
  }
}

class ChromiumRuntime {
  constructor() {
    this.name = 'chromium';
  }

  async search(params) {
    // Fallback implementation — same as Lightpanda for now
    const runtime = new LightpandaRuntime();
    const result = await runtime.search(params);
    return { ...result, runtime_used: this.name };
  }

  async crawl(params) {
    const runtime = new LightpandaRuntime();
    const result = await runtime.crawl(params);
    return { ...result, runtime_used: this.name };
  }
}

export class BrowserRuntime {
  constructor() {
    this.primary = new LightpandaRuntime();
    this.fallback = new ChromiumRuntime();
  }

  async search({ query, domains, limit }) {
    const start = Date.now();
    let fallbackApplied = false;
    let result;

    try {
      result = await this.primary.search({ query, domains, limit });
    } catch (primaryErr) {
      fallbackApplied = true;
      try {
        result = await this.fallback.search({ query, domains, limit });
      } catch (fallbackErr) {
        throw new Error(`All runtimes failed. Primary: ${primaryErr.message}; Fallback: ${fallbackErr.message}`);
      }
    }

    return {
      ...result,
      fallback_applied: fallbackApplied,
      duration_ms: Date.now() - start,
    };
  }

  async crawl({ urls, depth, pageLimit, include, exclude }) {
    const start = Date.now();
    let fallbackApplied = false;
    let result;

    try {
      result = await this.primary.crawl({ urls, depth, pageLimit, include, exclude });
    } catch (primaryErr) {
      fallbackApplied = true;
      try {
        result = await this.fallback.crawl({ urls, depth, pageLimit, include, exclude });
      } catch (fallbackErr) {
        throw new Error(`All runtimes failed. Primary: ${primaryErr.message}; Fallback: ${fallbackErr.message}`);
      }
    }

    return {
      ...result,
      fallback_applied: fallbackApplied,
      duration_ms: Date.now() - start,
    };
  }
}
