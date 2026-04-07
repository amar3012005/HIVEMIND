/**
 * TavilyClient - Production-grade web search and extraction for HIVEMIND
 *
 * Uses Tavily API as primary runtime for:
 * - Search: AI-optimized search with answers, snippets, images
 * - Extract: Full page content extraction (handles JS rendering)
 * - Crawl: Graph-based website traversal
 * - Map: URL discovery for targeted crawling
 *
 * Fallback: LightPanda/fetch for resilience when Tavily unavailable
 */

import { tavily } from '@tavily/core';

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || process.env.TAVILY_KEY;

// Credit-optimized defaults
const SEARCH_DEFAULTS = {
  max_results: 10,
  search_depth: 'basic', // 1 credit
  include_answer: false,
  include_raw_content: false,
  include_images: false,
  include_favicon: true,
  include_usage: true,
};

const EXTRACT_DEFAULTS = {
  format: 'markdown',
  extract_depth: 'basic', // 1 credit per 5 URLs
  include_images: false,
  include_favicon: false,
  include_usage: true,
  timeout: 15, // seconds
};

const CRAWL_DEFAULTS = {
  max_depth: 2,
  max_breadth: 20,
  limit: 50,
  extract_depth: 'basic',
  format: 'markdown',
  include_favicon: false,
  include_usage: true,
  timeout: 120, // seconds
};

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

const telemetry = {
  totalRequests: 0,
  searchRequests: 0,
  extractRequests: 0,
  crawlRequests: 0,
  mapRequests: 0,
  successes: 0,
  failures: 0,
  creditsUsed: 0,
  avgResponseTimeMs: 0,
  _responseTimes: [],

  recordRequest(type, success, credits, responseTimeMs) {
    this.totalRequests++;
    this.successes += success ? 1 : 0;
    this.failures += success ? 0 : 1;
    this.creditsUsed += credits || 0;

    if (type === 'search') this.searchRequests++;
    if (type === 'extract') this.extractRequests++;
    if (type === 'crawl') this.crawlRequests++;
    if (type === 'map') this.mapRequests++;

    this._responseTimes.push(responseTimeMs);
    if (this._responseTimes.length > 200) this._responseTimes.shift();
    this.avgResponseTimeMs = Math.round(
      this._responseTimes.reduce((a, b) => a + b, 0) / this._responseTimes.length
    );
  },

  getSnapshot() {
    return {
      ...this,
      _responseTimes: undefined, // internal only
    };
  },
};

// ---------------------------------------------------------------------------
// TavilyClient Class
// ---------------------------------------------------------------------------

export class TavilyClientWrapper {
  constructor(options = {}) {
    this.apiKey = options.apiKey || TAVILY_API_KEY;

    if (!this.apiKey) {
      console.warn('[TavilyClient] No API key configured. Tavily features will be unavailable.');
      this.client = null;
    } else {
      this.client = tavily({ apiKey: this.apiKey });
    }

    this.telemetry = telemetry;
  }

  /**
   * Check if Tavily is configured and available
   */
  isAvailable() {
    return this.client !== null;
  }

  /**
   * Search the web using Tavily Search API
   *
   * @param {Object} params
   * @param {string} params.query - Search query
   * @param {number} [params.maxResults=10] - Max results (0-20)
   * @param {'basic'|'advanced'|'fast'|'ultra-fast'} [params.searchDepth='basic']
   * @param {string} [params.topic='general'] - 'general' or 'news'
   * @param {string[]} [params.includeDomains] - Only include these domains
   * @param {string[]} [params.excludeDomains] - Exclude these domains
   * @param {string} [params.country] - Boost results from country
   * @param {boolean} [params.includeAnswer=false] - Include LLM-generated answer
   * @param {boolean|'markdown'|'text'} [params.includeRawContent=false] - Include parsed content
   * @param {boolean} [params.includeImages=false] - Include images
   * @param {boolean} [params.includeUsage=false] - Include credit usage
   * @returns {Promise<TavilySearchResult>}
   */
  async search(params) {
    const startTime = Date.now();

    if (!this.client) {
      throw new Error('Tavily API key not configured');
    }

    const {
      query,
      maxResults = SEARCH_DEFAULTS.max_results,
      searchDepth = SEARCH_DEFAULTS.search_depth,
      topic = SEARCH_DEFAULTS.topic,
      includeDomains = [],
      excludeDomains = [],
      country = null,
      includeAnswer = SEARCH_DEFAULTS.include_answer,
      includeRawContent = SEARCH_DEFAULTS.include_raw_content,
      includeImages = SEARCH_DEFAULTS.include_images,
      includeFavicon = SEARCH_DEFAULTS.include_favicon,
      includeUsage = SEARCH_DEFAULTS.include_usage,
      timeRange = null,
      startDate = null,
      endDate = null,
    } = params;

    if (!query || typeof query !== 'string') {
      throw new Error('Search query is required');
    }

    try {
      const response = await this.client.search(query, {
        max_results: Math.min(Math.max(maxResults, 0), 20),
        search_depth: searchDepth,
        topic,
        include_domains: includeDomains,
        exclude_domains: excludeDomains,
        country,
        include_answer: includeAnswer,
        include_raw_content: includeRawContent,
        include_images: includeImages,
        include_favicon: includeFavicon,
        include_usage: includeUsage,
        time_range: timeRange,
        start_date: startDate,
        end_date: endDate,
      });

      const responseTime = Date.now() - startTime;
      const credits = response.usage?.credits || 1;

      telemetry.recordRequest('search', true, credits, responseTime);

      return {
        query: response.query,
        answer: response.answer || null,
        results: (response.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score,
          favicon: r.favicon,
          images: r.images || [],
          rawContent: r.raw_content || null,
        })),
        images: response.images || [],
        responseTimeMs: response.response_time || responseTime,
        creditsUsed: credits,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      telemetry.recordRequest('search', false, 0, responseTime);

      throw this._wrapError(error, 'search');
    }
  }

  /**
   * Extract content from URLs using Tavily Extract API
   *
   * @param {Object} params
   * @param {string|string[]} params.urls - Single URL or array of URLs
   * @param {string} [params.query] - Optional query for chunk reranking
   * @param {number} [params.chunksPerSource=3] - Max chunks per source (1-5)
   * @param {'basic'|'advanced'} [params.extractDepth='basic']
   * @param {'markdown'|'text'} [params.format='markdown']
   * @param {boolean} [params.includeImages=false]
   * @param {boolean} [params.includeFavicon=false]
   * @param {number} [params.timeout] - Timeout in seconds (1-60)
   * @param {boolean} [params.includeUsage=false]
   * @returns {Promise<TavilyExtractResult>}
   */
  async extract(params) {
    const startTime = Date.now();

    if (!this.client) {
      throw new Error('Tavily API key not configured');
    }

    const {
      urls,
      query = null,
      chunksPerSource = EXTRACT_DEFAULTS.chunks_per_source,
      extractDepth = EXTRACT_DEFAULTS.extract_depth,
      format = EXTRACT_DEFAULTS.format,
      includeImages = EXTRACT_DEFAULTS.include_images,
      includeFavicon = EXTRACT_DEFAULTS.include_favicon,
      timeout = EXTRACT_DEFAULTS.timeout,
      includeUsage = EXTRACT_DEFAULTS.include_usage,
    } = params;

    const urlArray = Array.isArray(urls) ? urls : [urls];

    if (urlArray.length === 0 || urlArray.length > 20) {
      throw new Error('Must provide 1-20 URLs for extraction');
    }

    try {
      const response = await this.client.extract(urlArray, {
        query,
        chunks_per_source: query ? Math.min(Math.max(chunksPerSource, 1), 5) : undefined,
        extract_depth: extractDepth,
        format,
        include_images: includeImages,
        include_favicon: includeFavicon,
        timeout,
        include_usage: includeUsage,
      });

      const responseTime = Date.now() - startTime;
      const credits = response.usage?.credits || Math.ceil(urlArray.length / 5);

      telemetry.recordRequest('extract', true, credits, responseTime);

      return {
        results: (response.results || []).map((r) => ({
          url: r.url,
          rawContent: r.raw_content,
          images: r.images || [],
          favicon: r.favicon,
        })),
        failedResults: (response.failed_results || []).map((r) => ({
          url: r.url,
          error: r.error,
        })),
        responseTimeMs: response.response_time || responseTime,
        creditsUsed: credits,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      telemetry.recordRequest('extract', false, 0, responseTime);

      throw this._wrapError(error, 'extract');
    }
  }

  /**
   * Crawl a website using Tavily Crawl API
   *
   * @param {Object} params
   * @param {string} params.url - Root URL to start crawling
   * @param {string} [params.instructions] - Natural language instructions
   * @param {number} [params.maxDepth=2] - Max crawl depth (1-5)
   * @param {number} [params.maxBreadth=20] - Max links per level (1-500)
   * @param {number} [params.limit=50] - Total URLs to process (1-500)
   * @param {string[]} [params.selectPaths] - Regex patterns for URL paths
   * @param {string[]} [params.selectDomains] - Regex patterns for domains
   * @param {string[]} [params.excludePaths] - Regex patterns to exclude paths
   * @param {string[]} [params.excludeDomains] - Regex patterns to exclude domains
   * @param {'basic'|'advanced'} [params.extractDepth='basic']
   * @param {'markdown'|'text'} [params.format='markdown']
   * @param {number} [params.timeout=120] - Timeout in seconds (10-150)
   * @param {boolean} [params.includeUsage=false]
   * @returns {Promise<TavilyCrawlResult>}
   */
  async crawl(params) {
    const startTime = Date.now();

    if (!this.client) {
      throw new Error('Tavily API key not configured');
    }

    const {
      url,
      instructions = null,
      maxDepth = CRAWL_DEFAULTS.max_depth,
      maxBreadth = CRAWL_DEFAULTS.max_breadth,
      limit = CRAWL_DEFAULTS.limit,
      selectPaths = null,
      selectDomains = null,
      excludePaths = null,
      excludeDomains = null,
      extractDepth = CRAWL_DEFAULTS.extract_depth,
      format = CRAWL_DEFAULTS.format,
      timeout = CRAWL_DEFAULTS.timeout,
      includeUsage = CRAWL_DEFAULTS.include_usage,
    } = params;

    if (!url || typeof url !== 'string') {
      throw new Error('Crawl URL is required');
    }

    try {
      const response = await this.client.crawl(url, {
        instructions,
        max_depth: Math.min(Math.max(maxDepth, 1), 5),
        max_breadth: Math.min(Math.max(maxBreadth, 1), 500),
        limit: Math.min(Math.max(limit, 1), 500),
        select_paths: selectPaths,
        select_domains: selectDomains,
        exclude_paths: excludePaths,
        exclude_domains: excludeDomains,
        extract_depth: extractDepth,
        format,
        timeout: Math.min(Math.max(timeout, 10), 150),
        include_usage: includeUsage,
      });

      const responseTime = Date.now() - startTime;
      const credits = response.usage?.credits || Math.ceil((response.results?.length || 0) / 5);

      telemetry.recordRequest('crawl', true, credits, responseTime);

      return {
        baseUrl: response.base_url,
        results: (response.results || []).map((r) => ({
          url: r.url,
          rawContent: r.raw_content,
        })),
        responseTimeMs: response.response_time || responseTime,
        creditsUsed: credits,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      telemetry.recordRequest('crawl', false, 0, responseTime);

      throw this._wrapError(error, 'crawl');
    }
  }

  /**
   * Map/discover URLs from a domain using Tavily Map API
   *
   * @param {Object} params
   * @param {string} params.url - Root URL to discover URLs from
   * @param {string} [params.search] - Optional search query to filter URLs
   * @param {number} [params.limit=10] - Max URLs to return (1-5000)
   * @param {string[]} [params.includeDomains] - Only include these domains
   * @param {string[]} [params.excludeDomains] - Exclude these domains
   * @param {boolean} [params.includeUsage=false]
   * @returns {Promise<TavilyMapResult>}
   */
  async map(params) {
    const startTime = Date.now();

    if (!this.client) {
      throw new Error('Tavily API key not configured');
    }

    const {
      url,
      search = null,
      limit = 10,
      includeDomains = [],
      excludeDomains = [],
      includeUsage = false,
    } = params;

    if (!url || typeof url !== 'string') {
      throw new Error('Map URL is required');
    }

    try {
      const response = await this.client.map(url, {
        search,
        limit: Math.min(Math.max(limit, 1), 5000),
        include_domains: includeDomains,
        exclude_domains: excludeDomains,
        include_usage: includeUsage,
      });

      const responseTime = Date.now() - startTime;
      const credits = response.usage?.credits || 0;

      telemetry.recordRequest('map', true, credits, responseTime);

      return {
        url: response.url,
        results: response.results || [],
        responseTimeMs: response.response_time || responseTime,
        creditsUsed: credits,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      telemetry.recordRequest('map', false, 0, responseTime);

      throw this._wrapError(error, 'map');
    }
  }

  /**
   * Get telemetry snapshot
   */
  getTelemetry() {
    return this.telemetry.getSnapshot();
  }

  /**
   * Wrap Tavily errors with context
   * @private
   */
  _wrapError(error, operation) {
    const statusCode = error.response?.status;
    const errorMessage = error.response?.data?.detail?.error || error.message;

    const wrapped = new Error(`Tavily ${operation} failed: ${errorMessage}`);
    wrapped.originalError = error;
    wrapped.statusCode = statusCode;
    wrapped.isRateLimit = statusCode === 429;
    wrapped.isAuthError = statusCode === 401;
    wrapped.isQuotaExceeded = statusCode === 432 || statusCode === 433;

    return wrapped;
  }
}

// ---------------------------------------------------------------------------
// Export singleton for module-level access
// ---------------------------------------------------------------------------

let _instance = null;

export function getTavilyClient() {
  if (!_instance) {
    _instance = new TavilyClientWrapper();
  }
  return _instance;
}

export { telemetry };
