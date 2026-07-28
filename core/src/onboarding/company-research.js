import { normalizeCompanyPageCandidates, selectCompanyResearchPages } from './company-discovery.js';

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2';

function compactText(value, max = 7000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function normalizedHost(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export function isFirstPartyUrl(url, websiteUrl) {
  const sourceHost = normalizedHost(url);
  const companyHost = normalizedHost(websiteUrl);
  return Boolean(sourceHost && companyHost && sourceHost === companyHost);
}

export function firstPartyResearchDigest(pages, { maxChars = 18000 } = {}) {
  let remaining = Math.max(0, maxChars);
  const chunks = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page?.url || !page?.content || remaining <= 0) continue;
    const header = `SOURCE: ${page.url}\nPURPOSE: ${page.purpose || 'company'}\n`;
    const body = compactText(page.content, Math.max(0, remaining - header.length));
    if (!body) continue;
    const chunk = `${header}${body}`;
    chunks.push(chunk);
    remaining -= chunk.length;
  }
  return chunks.join('\n\n---\n\n');
}

function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanList(value, { maxItems = 8, maxChars = 240 } = {}) {
  return (Array.isArray(value) ? value : []).map((item) => cleanString(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

export function normalizeCompanyProfile(raw, { fallbackName, websiteUrl, claimedLocation = '' } = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const evidenceUrl = cleanString(value.location_evidence_url, 500);
  const firstPartyLocation = evidenceUrl && isFirstPartyUrl(evidenceUrl, websiteUrl);
  const userLocation = cleanString(claimedLocation, 240);
  const location = firstPartyLocation ? cleanString(value.location, 240) : userLocation;
  const locationSource = firstPartyLocation ? 'first_party' : (userLocation ? 'user_claim' : 'unknown');
  return {
    name: cleanString(value.name, 120) || cleanString(fallbackName, 120),
    industry: cleanString(value.industry, 300),
    business_model: cleanString(value.business_model, 400),
    capabilities: cleanList(value.capabilities),
    tagline: cleanString(value.tagline, 300),
    what_it_does: cleanString(value.what_it_does, 700),
    icp: cleanString(value.icp, 700),
    offer: cleanString(value.offer, 500),
    positioning: cleanString(value.positioning, 700),
    competitors: cleanList(value.competitors, { maxItems: 8, maxChars: 180 }),
    tone: cleanString(value.tone, 300),
    opportunities: cleanList(value.opportunities),
    risks: cleanList(value.risks),
    location,
    location_city: location ? cleanString(value.location_city, 120) : '',
    location_region: location ? cleanString(value.location_region, 120) : '',
    location_country: location ? cleanString(value.location_country, 120) : '',
    location_evidence_url: firstPartyLocation ? evidenceUrl : (userLocation ? 'user-provided' : ''),
    location_source: locationSource,
    evidence_gaps: cleanList(value.evidence_gaps, { maxItems: 10, maxChars: 300 }),
  };
}

async function firecrawlRequest(path, body, { apiKey, timeoutMs = 65000 } = {}) {
  if (!apiKey) throw new Error('Firecrawl API key not configured');
  const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const error = new Error(payload?.error || `Firecrawl ${path} returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const COUNTRY_CODES = new Map(Object.entries({
  austria: 'AT', belgium: 'BE', bulgaria: 'BG', croatia: 'HR', cyprus: 'CY', czechia: 'CZ',
  denmark: 'DK', estonia: 'EE', finland: 'FI', france: 'FR', germany: 'DE', greece: 'GR',
  hungary: 'HU', ireland: 'IE', italy: 'IT', latvia: 'LV', lithuania: 'LT', luxembourg: 'LU',
  malta: 'MT', netherlands: 'NL', poland: 'PL', portugal: 'PT', romania: 'RO', slovakia: 'SK',
  slovenia: 'SI', spain: 'ES', sweden: 'SE', switzerland: 'CH', norway: 'NO',
  'united kingdom': 'UK', uk: 'UK', 'united states': 'US', usa: 'US', canada: 'CA',
}));

export async function searchCompanyMarket(query, {
  apiKey = process.env.FIRECRAWL_API_KEY,
  limit = 6,
  location = '',
  country = '',
  includeDomains = [],
} = {}) {
  if (!apiKey || !String(query || '').trim()) return [];
  const countryValue = cleanString(country, 80).toLowerCase();
  const countryCode = /^[a-z]{2}$/i.test(countryValue) ? countryValue.toUpperCase() : COUNTRY_CODES.get(countryValue);
  try {
    const payload = await firecrawlRequest('/search', {
      query: cleanString(query, 500),
      limit: Math.min(10, Math.max(1, Number(limit) || 6)),
      sources: ['web'],
      ignoreInvalidURLs: true,
      ...(cleanString(location, 200) ? { location: cleanString(location, 200) } : {}),
      ...(countryCode ? { country: countryCode } : {}),
      ...(Array.isArray(includeDomains) && includeDomains.length ? { includeDomains: includeDomains.slice(0, 10) } : {}),
      timeout: 45000,
    }, { apiKey, timeoutMs: 55000 });
    return (Array.isArray(payload?.data?.web) ? payload.data.web : []).map((item) => ({
      title: cleanString(item?.title || item?.metadata?.title, 300),
      url: cleanString(item?.url || item?.metadata?.sourceURL || item?.metadata?.url, 1000),
      snippet: cleanString(item?.description || item?.metadata?.description || item?.markdown, 700),
      provider: 'firecrawl',
    })).filter((item) => item.url);
  } catch {
    return [];
  }
}

export async function researchCompanyWebsite(websiteUrl, {
  apiKey = process.env.FIRECRAWL_API_KEY,
  maxPages = 6,
  onProgress = () => {},
  selectPages = null,
} = {}) {
  if (!apiKey) return { provider: 'fallback', pages: [], mapped: 0, error: 'not_configured' };
  try {
    onProgress('Mapping your website with Firecrawl');
    const mapped = await firecrawlRequest('/map', {
      url: websiteUrl,
      sitemap: 'include',
      includeSubdomains: false,
      ignoreQueryParameters: true,
      limit: 80,
      timeout: 45000,
    }, { apiKey, timeoutMs: 50000 });
    const links = Array.isArray(mapped?.links) ? mapped.links : [];
    const candidates = normalizeCompanyPageCandidates(links, websiteUrl);
    let semanticSelection = [];
    if (typeof selectPages === 'function') {
      try { semanticSelection = await selectPages(candidates, { maxPages }); } catch { semanticSelection = []; }
    }
    const selected = selectCompanyResearchPages(links, websiteUrl, { maxPages, semanticSelection });
    onProgress(`Firecrawl found ${links.length} pages; reading ${selected.length} high-signal pages`);
    const pages = [];
    // Keep provider concurrency modest: onboarding is interactive and Firecrawl
    // plans enforce per-team concurrent scrape limits.
    for (let i = 0; i < selected.length; i += 2) {
      const batch = selected.slice(i, i + 2);
      const results = await Promise.all(batch.map(async (page) => {
        try {
          const scraped = await firecrawlRequest('/scrape', {
            url: page.url,
            formats: ['markdown'],
            onlyMainContent: true,
            removeBase64Images: true,
            blockAds: true,
            maxAge: 86400000,
            timeout: 45000,
          }, { apiKey, timeoutMs: 55000 });
          const data = scraped?.data || {};
          return {
            ...page,
            url: data?.metadata?.sourceURL || data?.metadata?.url || page.url,
            title: data?.metadata?.title || page.label || '',
            description: data?.metadata?.description || '',
            content: compactText(data?.markdown || data?.content, 9000),
            provider: 'firecrawl',
          };
        } catch (error) {
          return { ...page, content: '', provider: 'firecrawl', error: error.message };
        }
      }));
      pages.push(...results.filter((page) => page.content && isFirstPartyUrl(page.url, websiteUrl)));
    }
    if (!pages.length) throw new Error('Firecrawl returned no usable first-party pages');
    return { provider: 'firecrawl', pages, mapped: links.length, error: null };
  } catch (error) {
    return { provider: 'fallback', pages: [], mapped: 0, error: error.message };
  }
}
