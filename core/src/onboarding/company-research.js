import { PlaywrightServiceRuntime } from '../web/playwright-service-runtime.js';

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2';
const SOCIAL_PLATFORMS = [
  ['linkedin', /(^|\.)linkedin\.com$/i, /^\/(?:company|showcase)\/[^/]+/i],
  ['x', /(^|\.)(?:x|twitter)\.com$/i, /^\/(?!home|share|intent|search|i\/)[^/]+\/?$/i],
  ['instagram', /(^|\.)instagram\.com$/i, /^\/(?!accounts|explore|p\/|reel\/)[^/]+\/?$/i],
  ['facebook', /(^|\.)facebook\.com$/i, /^\/(?!sharer|share|plugins|dialog)[^/]+/i],
  ['youtube', /(^|\.)youtube\.com$/i, /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/i],
  ['tiktok', /(^|\.)tiktok\.com$/i, /^\/@[^/]+\/?$/i],
  ['threads', /(^|\.)threads\.net$/i, /^\/@[^/]+\/?$/i],
  ['bluesky', /(^|\.)bsky\.app$/i, /^\/profile\/[^/]+/i],
  ['github', /(^|\.)github\.com$/i, /^\/(?!features|topics|marketplace|login|signup)[^/]+\/?$/i],
];

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

export function mergeCompanyResearchPages(primaryPages, fallbackPages, websiteUrl, { limit = 6 } = {}) {
  const merged = new Map();
  for (const page of [...(Array.isArray(primaryPages) ? primaryPages : []), ...(Array.isArray(fallbackPages) ? fallbackPages : [])]) {
    if (!page?.url || !isFirstPartyUrl(page.url, websiteUrl)) continue;
    let normalizedUrl;
    try {
      const parsed = new URL(page.url);
      parsed.hostname = parsed.hostname.replace(/^www\./i, '');
      parsed.hash = '';
      normalizedUrl = parsed.href.replace(/\/$/, '') || parsed.href;
    } catch { continue; }
    const previous = merged.get(normalizedUrl);
    if (!previous) {
      merged.set(normalizedUrl, { ...page, links: [...new Set(Array.isArray(page.links) ? page.links : [])] });
      continue;
    }
    merged.set(normalizedUrl, {
      ...previous,
      title: previous.title || page.title || '',
      description: previous.description || page.description || '',
      content: previous.content || page.content || '',
      links: [...new Set([...(previous.links || []), ...(Array.isArray(page.links) ? page.links : [])])].slice(0, 400),
    });
  }
  return [...merged.values()].slice(0, Math.max(1, Number(limit) || 6));
}

export function buildCompanyOperatingContext({ company, website, profile = {}, mission = '' } = {}, { maxChars = 2400 } = {}) {
  const contacts = profile.contact_details || {};
  const lines = [
    `COMPANY: ${cleanString(company || profile.name, 140)}`,
    `WEBSITE: ${cleanString(website, 500)}`,
    profile.tagline && `TAGLINE: ${cleanString(profile.tagline, 300)}`,
    profile.what_it_does && `DOES: ${cleanString(profile.what_it_does, 700)}`,
    profile.industry && `INDUSTRY: ${cleanString(profile.industry, 300)}`,
    profile.business_model && `BUSINESS MODEL: ${cleanString(profile.business_model, 400)}`,
    cleanList(profile.capabilities).length && `CAPABILITIES: ${cleanList(profile.capabilities).join('; ')}`,
    profile.offer && `OFFER: ${cleanString(profile.offer, 500)}`,
    profile.icp && `ICP: ${cleanString(profile.icp, 700)}`,
    profile.positioning && `POSITIONING: ${cleanString(profile.positioning, 700)}`,
    mission && `MISSION: ${cleanString(mission, 800)}`,
    profile.location && `HQ: ${cleanString(profile.location, 240)} (${profile.location_source || 'unknown source'})`,
    Array.isArray(profile.social_profiles) && profile.social_profiles.length
      && `SOCIAL PROFILES: ${profile.social_profiles.slice(0, 10).map((item) => `${cleanString(item?.platform, 40)}: ${cleanString(item?.url, 500)}`).filter((item) => item !== ': ').join('; ')}`,
    cleanList(contacts.emails, { maxItems: 5, maxChars: 200 }).length && `CONTACT EMAILS: ${contacts.emails.slice(0, 5).join('; ')}`,
    cleanList(contacts.phones, { maxItems: 5, maxChars: 100 }).length && `CONTACT PHONES: ${contacts.phones.slice(0, 5).join('; ')}`,
    profile.tone && `VOICE: ${cleanString(profile.tone, 300)}`,
    cleanList(profile.opportunities).length && `OPPORTUNITIES: ${cleanList(profile.opportunities).join('; ')}`,
    cleanList(profile.risks).length && `RISKS: ${cleanList(profile.risks).join('; ')}`,
    cleanList(profile.evidence_gaps, { maxItems: 10, maxChars: 300 }).length
      && `EVIDENCE GAPS: ${cleanList(profile.evidence_gaps, { maxItems: 10, maxChars: 300 }).join('; ')}`,
  ].filter(Boolean);
  return lines.join('\n').slice(0, Math.max(500, Number(maxChars) || 2400));
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

async function firecrawlGet(path, { apiKey, timeoutMs = 65000 } = {}) {
  if (!apiKey) throw new Error('Firecrawl API key not configured');
  const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const error = new Error(payload?.error || `Firecrawl ${path} returned ${response.status}`);
    error.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    throw error;
  }
  return payload;
}

/**
 * Read a bounded set of public pages without treating the result as account
 * analytics. This is used by short operating workflows that need observable
 * profile/content evidence, while platform metrics remain connector-owned.
 */
export async function scrapePublicPages(urls, {
  apiKey = process.env.FIRECRAWL_API_KEY,
  maxPages = 5,
} = {}) {
  const targets = [...new Set((Array.isArray(urls) ? urls : [])
    .map((value) => cleanString(value, 1000))
    .filter((value) => /^https:\/\//i.test(value)))]
    .slice(0, Math.max(1, Math.min(8, Number(maxPages) || 5)));
  if (!apiKey || !targets.length) return [];

  const rows = await Promise.all(targets.map(async (url) => {
    try {
      const payload = await firecrawlRequest('/scrape', {
        url,
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        waitFor: 0,
        timeout: 20_000,
        maxAge: 86_400_000,
      }, { apiKey, timeoutMs: 25_000 });
      const data = payload?.data || payload || {};
      return {
        url: cleanString(data?.metadata?.sourceURL || data?.metadata?.url || url, 1000),
        title: cleanString(data?.metadata?.title, 300),
        description: cleanString(data?.metadata?.description, 500),
        content: compactText(data?.markdown || data?.content, 5000),
        status: 'observed',
        provider: 'firecrawl',
      };
    } catch (error) {
      return {
        url,
        title: '',
        description: '',
        content: '',
        status: 'unavailable',
        provider: 'firecrawl',
        reason: String(error?.message || 'public_page_unavailable').slice(0, 300),
      };
    }
  }));
  return rows;
}

function normalizedSocialProfile(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  url.hostname = url.hostname.replace(/^www\./i, '');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  const match = SOCIAL_PLATFORMS.find(([, hostPattern, pathPattern]) => hostPattern.test(url.hostname) && pathPattern.test(url.pathname));
  if (!match) return null;
  return { platform: match[0], url: url.href };
}

export function verifiedSocialProfiles(pages, searchResults = [], { includeSearchCandidates = false, companyName = '', websiteUrl = '' } = {}) {
  const firstParty = new Map();
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const rawUrl of Array.isArray(page?.links) ? page.links : []) {
      const profile = normalizedSocialProfile(rawUrl);
      if (profile && !firstParty.has(profile.platform)) {
        firstParty.set(profile.platform, { ...profile, source_url: page.url, verified_by: ['first_party'] });
      }
    }
  }
  const searched = new Set((Array.isArray(searchResults) ? searchResults : [])
    .map((item) => normalizedSocialProfile(item?.url))
    .filter(Boolean)
    .map((item) => item.url));
  const profiles = [...firstParty.values()].map((profile) => searched.has(profile.url)
    ? { ...profile, verified_by: ['first_party', 'search'] }
    : profile);
  if (!includeSearchCandidates) return profiles;

  const identityTokens = new Set([
    normalizedHost(websiteUrl).split('.')[0],
    String(companyName || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  ].filter((token) => token && token.length >= 4));
  const knownUrls = new Set(profiles.map((profile) => profile.url));
  for (const result of Array.isArray(searchResults) ? searchResults : []) {
    const profile = normalizedSocialProfile(result?.url);
    if (!profile || knownUrls.has(profile.url)) continue;
    const evidence = `${result?.title || ''} ${result?.snippet || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (![...identityTokens].some((token) => evidence.includes(token))) continue;
    profiles.push({ ...profile, source_url: result.url, verified_by: ['search_candidate'] });
    knownUrls.add(profile.url);
  }
  return profiles;
}

export function extractCompanyContacts(pages) {
  const emails = new Set();
  const phones = new Set();
  const addEmail = (value) => {
    const email = String(value || '').trim().toLowerCase().replace(/[),.;]+$/, '');
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(email)) emails.add(email);
  };
  const addPhone = (value) => {
    const phone = decodeURIComponent(String(value || '')).replace(/^tel:/i, '').trim().replace(/[).,;]+$/, '').trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 16) phones.add(phone.replace(/\s+/g, ' '));
  };
  for (const page of Array.isArray(pages) ? pages : []) {
    const content = String(page?.content || '');
    for (const match of content.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) addEmail(match[0]);
    for (const match of content.matchAll(/(?:tel:|phone:\s*)(\+?[\d][\d\s()./-]{7,20})/gi)) addPhone(match[1]);
    for (const match of content.matchAll(/(?:^|[^\w])((?:\+|00)\d[\d\s()./-]{7,20})/g)) addPhone(match[1]);
    for (const rawLink of Array.isArray(page?.links) ? page.links : []) {
      if (/^mailto:/i.test(rawLink)) addEmail(rawLink.replace(/^mailto:/i, '').split('?')[0]);
      if (/^tel:/i.test(rawLink)) addPhone(rawLink);
    }
  }
  return { emails: [...emails].slice(0, 5), phones: [...phones].slice(0, 5) };
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
      timeout: 15000,
    }, { apiKey, timeoutMs: 20000 });
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

export async function captureWebsiteScreenshot(websiteUrl, {
  apiKey = process.env.FIRECRAWL_API_KEY,
} = {}) {
  if (!apiKey) return null;
  try {
    const payload = await firecrawlRequest('/scrape', {
      url: websiteUrl,
      formats: [{ type: 'screenshot', fullPage: false, quality: 70, viewport: { width: 1280, height: 720 } }],
      waitFor: 0,
      timeout: 25000,
      maxAge: 86400000,
    }, { apiKey, timeoutMs: 30000 });
    return cleanString((payload?.data || payload)?.screenshot, 2000000) || null;
  } catch {
    return null;
  }
}

export async function captureWebsiteScreenshotWithPlaywright(websiteUrl, {
  timeoutMs = Number(process.env.HIVEMIND_ONBOARDING_SCREENSHOT_TIMEOUT_MS || 12_000),
  settleMs = Number(process.env.HIVEMIND_ONBOARDING_SCREENSHOT_SETTLE_MS || 150),
  runtime,
} = {}) {
  if (!websiteUrl) return null;
  try {
    const screenshotRuntime = runtime || new PlaywrightServiceRuntime({ timeoutMs, settleMs });
    const result = await screenshotRuntime.crawl({ urls: [websiteUrl], depth: 0, pageLimit: 1, captureScreenshot: true });
    return compactText(result.pages?.[0]?.screenshot, 7_000_000) || null;
  } catch (error) {
    console.warn('[hyper-onboarding] Playwright screenshot skipped:', error.message);
    return null;
  }
}

export async function researchCompanyWebsite(websiteUrl, {
  apiKey = process.env.FIRECRAWL_API_KEY,
  maxPages = 5,
  includeCrawl = true,
  onProgress = () => {},
  pollDelays = Array(10).fill(2000),
} = {}) {
  if (!apiKey) return { provider: 'fallback', pages: [], mapped: 0, error: 'not_configured' };
  try {
    const limit = Math.min(6, Math.max(3, Number(maxPages) || 5));
    onProgress(includeCrawl ? `Crawling up to ${limit} first-party pages with Firecrawl` : 'Reading the official homepage with Firecrawl');
    const homepagePromise = firecrawlRequest('/scrape', {
      url: websiteUrl,
      formats: ['markdown', 'links'],
      onlyMainContent: false,
      removeBase64Images: true,
      blockAds: true,
      waitFor: 0,
      timeout: 25000,
      maxAge: 86400000,
    }, { apiKey, timeoutMs: 30000 }).catch(() => null);
    const started = includeCrawl ? await firecrawlRequest('/crawl', {
      url: websiteUrl,
      limit,
      maxDiscoveryDepth: 1,
      crawlEntireDomain: false,
      sitemap: 'include',
      allowSubdomains: false,
      allowExternalLinks: false,
      ignoreQueryParameters: true,
      maxConcurrency: 3,
      scrapeOptions: {
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        maxAge: 86400000,
      },
    }, { apiKey, timeoutMs: 10000 }).catch(() => null) : null;
    const jobId = started?.id;
    if (!jobId) {
      const homepagePayload = await homepagePromise;
      const homepageData = homepagePayload?.data || homepagePayload;
      const homepage = homepageData?.markdown ? {
        url: homepageData?.metadata?.sourceURL || homepageData?.metadata?.url || websiteUrl,
        title: cleanString(homepageData?.metadata?.title, 300),
        description: cleanString(homepageData?.metadata?.description, 500),
        content: compactText(homepageData.markdown, 9000),
        links: Array.isArray(homepageData?.links) ? homepageData.links.slice(0, 300) : [],
        purpose: 'company',
        provider: 'firecrawl',
      } : null;
      if (!homepage?.content || !isFirstPartyUrl(homepage.url, websiteUrl)) throw new Error('Firecrawl returned no usable first-party pages');
      return {
        provider: 'firecrawl', pages: [homepage], mapped: 1,
        social_profiles: verifiedSocialProfiles([homepage]),
        contacts: extractCompanyContacts([homepage]),
        screenshot: null,
        credits_used: 1, error: null,
      };
    }
    let status = null;
    const boundedPollDelays = (Array.isArray(pollDelays) && pollDelays.length ? pollDelays : Array(10).fill(2000))
      .slice(0, 12)
      .map((value) => Math.max(0, Number(value) || 0));
    for (const delayMs of boundedPollDelays) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        status = await firecrawlGet(`/crawl/${encodeURIComponent(jobId)}`, { apiKey, timeoutMs: 15000 });
      } catch (error) {
        if (error?.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(error.retryAfterMs || 0, 1500), 4000)));
          continue;
        }
        throw error;
      }
      const dataComplete = Array.isArray(status?.data)
        && status.data.length > 0
        && Number(status?.total) > 0
        && Number(status?.completed) >= Number(status.total);
      if (status?.status === 'completed' || dataComplete) break;
      if (status?.status === 'failed' || status?.status === 'cancelled') throw new Error(status?.error || `Firecrawl crawl ${status.status}`);
    }
    const homepagePayload = await homepagePromise;
    const homepageData = homepagePayload?.data || homepagePayload;
    const dataComplete = Array.isArray(status?.data)
      && status.data.length > 0
      && Number(status?.total) > 0
      && Number(status?.completed) >= Number(status.total);
    const crawlRows = status?.status === 'completed' || dataComplete ? (Array.isArray(status?.data) ? status.data : []) : [];
    const rows = [
      ...(homepageData?.markdown ? [{ ...homepageData, metadata: { ...(homepageData.metadata || {}), sourceURL: homepageData.metadata?.sourceURL || websiteUrl } }] : []),
      ...crawlRows,
    ];
    const seen = new Set();
    const pages = rows.map((data) => ({
      url: data?.metadata?.sourceURL || data?.metadata?.url || '',
      title: cleanString(data?.metadata?.title, 300),
      description: cleanString(data?.metadata?.description, 500),
      content: compactText(data?.markdown || data?.content, 9000),
      links: Array.isArray(data?.links) ? data.links.slice(0, 300) : [],
      purpose: 'company',
      provider: 'firecrawl',
    })).filter((page) => {
      if (!page.content || !isFirstPartyUrl(page.url, websiteUrl) || seen.has(page.url)) return false;
      seen.add(page.url);
      return true;
    }).slice(0, limit);
    if (!pages.length) throw new Error('Firecrawl returned no usable first-party pages');
    onProgress(`Read ${pages.length} first-party pages in one bounded crawl`);
    return {
      provider: 'firecrawl',
      pages,
      mapped: Number(status?.total || pages.length),
      social_profiles: verifiedSocialProfiles(pages),
      contacts: extractCompanyContacts(pages),
      screenshot: null,
      credits_used: Number(status?.creditsUsed || pages.length),
      error: null,
    };
  } catch (error) {
    return { provider: 'fallback', pages: [], mapped: 0, error: error.message };
  }
}
