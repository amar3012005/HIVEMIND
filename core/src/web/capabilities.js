/**
 * Canonical public vocabulary for Web Intelligence. Every caller may choose a
 * capability, but only the server chooses the provider and records settlement.
 */
export const WEB_CAPABILITIES = Object.freeze({
  search: Object.freeze({
    id: 'search',
    scope: 'web_search',
    input: ['query', 'domains', 'limit'],
    result: 'search_results',
    providerOrder: ['tavily', 'firecrawl', 'lightpanda'],
  }),
  research: Object.freeze({
    id: 'research',
    scope: 'web_research',
    input: ['input', 'model', 'citation_format'],
    result: 'research_report',
    providerOrder: ['tavily-research', 'tavily-search-firecrawl'],
  }),
  crawl: Object.freeze({
    id: 'crawl',
    scope: 'web_crawl',
    input: ['urls', 'depth', 'page_limit', 'include', 'exclude'],
    result: 'extracted_pages',
    providerOrder: ['firecrawl', 'lightpanda', 'fetch'],
  }),
});

export function getWebCapability(kind) {
  return WEB_CAPABILITIES[String(kind || '').toLowerCase()] || null;
}

export function listWebCapabilities() {
  return Object.values(WEB_CAPABILITIES).map(({ id, scope, input, result }) => ({ id, scope, input, result }));
}
