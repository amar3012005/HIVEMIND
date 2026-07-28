const SKIP_EXTENSIONS = /\.(?:avif|css|csv|docx?|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|pptx?|svg|webm|webp|xlsx?|xml|zip)$/i;
const PAGE_PURPOSES = new Set(['identity', 'offering', 'location', 'proof', 'team', 'commercial', 'company']);

function decodeAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

function anchorAttributes(tag) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of String(tag || '').matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function normalizePageCandidate(item, base) {
  const rawUrl = typeof item === 'string' ? item : item?.url;
  let url;
  try { url = new URL(rawUrl, base); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || normalizedHost(url.hostname) !== normalizedHost(base.hostname)) return null;
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (SKIP_EXTENSIONS.test(url.pathname)) return null;
  const title = String(item?.title || '').trim().slice(0, 300);
  const description = String(item?.description || '').trim().slice(0, 500);
  const label = String(item?.label || title || description || url.pathname).trim().slice(0, 500);
  return {
    url: url.href,
    label,
    title,
    description,
    purpose: 'company',
    depth: url.pathname.split('/').filter(Boolean).length,
  };
}

export function normalizeCompanyPageCandidates(links, homepageUrl, { maxCandidates = 80 } = {}) {
  let base;
  try { base = new URL(homepageUrl); } catch { return []; }
  const candidates = new Map();
  for (const item of Array.isArray(links) ? links : []) {
    const candidate = normalizePageCandidate(item, base);
    if (!candidate) continue;
    const current = candidates.get(candidate.url);
    const detail = candidate.title.length + candidate.description.length + candidate.label.length;
    const currentDetail = current ? current.title.length + current.description.length + current.label.length : -1;
    if (!current || detail > currentDetail) candidates.set(candidate.url, candidate);
  }
  const homepage = normalizePageCandidate({ url: new URL('/', base).href, label: 'Homepage' }, base);
  candidates.set(homepage.url, homepage);
  return [...candidates.values()]
    .sort((a, b) => a.depth - b.depth
      || (b.title.length + b.description.length + b.label.length) - (a.title.length + a.description.length + a.label.length)
      || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, maxCandidates));
}

function structuralFallback(candidates, maxPages) {
  const selected = [];
  const pathFamilies = new Set();
  for (const page of candidates) {
    if (selected.length >= maxPages) break;
    let family = '';
    try { family = new URL(page.url).pathname.split('/').filter(Boolean)[0] || '/'; } catch { continue; }
    if (page.depth > 0 && pathFamilies.has(family)) continue;
    selected.push(page);
    pathFamilies.add(family);
  }
  for (const page of candidates) {
    if (selected.length >= maxPages) break;
    if (!selected.some((picked) => picked.url === page.url)) selected.push(page);
  }
  return selected;
}

export function selectCompanyResearchPages(links, homepageUrl, { maxPages = 6, semanticSelection = [] } = {}) {
  const limit = Math.max(1, maxPages);
  const candidates = normalizeCompanyPageCandidates(links, homepageUrl);
  if (!candidates.length) return [];
  const byUrl = new Map(candidates.map((page) => [page.url, page]));
  const selected = [];
  for (const item of Array.isArray(semanticSelection) ? semanticSelection : []) {
    let normalized;
    try {
      const url = new URL(typeof item === 'string' ? item : item?.url, homepageUrl);
      url.hash = '';
      url.search = '';
      url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
      normalized = url.href;
    } catch { continue; }
    const candidate = byUrl.get(normalized);
    if (!candidate || selected.some((page) => page.url === candidate.url)) continue;
    const requestedPurpose = String(item?.purpose || '').toLowerCase();
    selected.push({ ...candidate, purpose: PAGE_PURPOSES.has(requestedPurpose) ? requestedPurpose : 'company' });
    if (selected.length >= limit) break;
  }

  if (selected.length) {
    const homepage = candidates.find((page) => page.depth === 0);
    if (homepage && !selected.some((page) => page.url === homepage.url)) {
      selected.unshift({ ...homepage, purpose: 'identity' });
    }
    return selected.slice(0, limit);
  }
  return structuralFallback(candidates, limit);
}

export function discoverCompanyPages(homepageHtml, homepageUrl, { maxPages = 40 } = {}) {
  let base;
  try { base = new URL(homepageUrl); } catch { return []; }
  const candidates = new Map();
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const anchor of String(homepageHtml || '').matchAll(anchorPattern)) {
    const openTag = anchor[0].match(/^<a\b[^>]*>/i)?.[0] || '';
    const href = anchorAttributes(openTag).href;
    if (!href || /^(?:#|data:|javascript:|mailto:|tel:)/i.test(href)) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || normalizedHost(url.hostname) !== normalizedHost(base.hostname)) continue;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    if (url.pathname === '/' || SKIP_EXTENSIONS.test(url.pathname)) continue;
    const label = anchor[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const key = url.href;
    const candidate = normalizePageCandidate({ url: key, label, title: label }, base);
    if (!candidate) continue;
    const current = candidates.get(key);
    if (!current || candidate.label.length > current.label.length) candidates.set(key, candidate);
  }
  return [...candidates.values()]
    .sort((a, b) => a.depth - b.depth || b.label.length - a.label.length || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, maxPages));
}

const DOMAIN_ROSTERS = [
  {
    pattern: /brand|branding|creative|design agency|marketing agency|werbeagentur|markenagentur|studio/,
    field: 'Creative & Brand',
    roles: [
      ['Creative Director', 'strategist', 'creative direction, positioning, and brand systems'],
      ['Brand & Audience Researcher', 'investigator', 'audience evidence, cultural insight, and category research'],
      ['Brand Quality Lead', 'skeptic', 'brief integrity, differentiation, and creative quality control'],
    ],
  },
  {
    pattern: /law firm|legal|lawyer|attorney|kanzlei|rechtsanwalt/,
    field: 'Legal',
    roles: [
      ['Legal Strategy Director', 'strategist', 'practice positioning and client-value strategy'],
      ['Legal Market Researcher', 'investigator', 'matter, client, and regulatory evidence'],
      ['Regulatory / Compliance Counsel', 'skeptic', 'legal accuracy, obligations, and claim risk'],
    ],
  },
  {
    pattern: /fintech|bank|payment|insurance|investment|finance/,
    field: 'Fintech',
    roles: [
      ['Financial Product Strategist', 'strategist', 'market positioning and financial product strategy'],
      ['Quantitative Analyst', 'investigator', 'pricing, performance, and unit economics'],
      ['Compliance Officer', 'skeptic', 'regulatory, KYC, AML, and operational risk'],
    ],
  },
  {
    pattern: /health|medical|clinic|pharma|biotech|care/,
    field: 'Healthcare',
    roles: [
      ['Healthcare Strategy Lead', 'strategist', 'care-market strategy and stakeholder value'],
      ['Clinical Market Researcher', 'investigator', 'patient, practitioner, and clinical evidence'],
      ['Clinical Quality & Compliance Lead', 'skeptic', 'safety, evidence quality, and regulatory risk'],
    ],
  },
  {
    pattern: /manufactur|industrial|logistics|supply chain|construction|energy/,
    field: 'Industry & Operations',
    roles: [
      ['Industrial Strategy Lead', 'strategist', 'commercial strategy and operational advantage'],
      ['Operations & Market Analyst', 'investigator', 'process, demand, and market evidence'],
      ['Quality & Risk Lead', 'skeptic', 'delivery, safety, quality, and supplier risk'],
    ],
  },
  {
    pattern: /software|saas|platform|technology|app|artificial intelligence|\bai\b/,
    field: 'Software & Product',
    roles: [
      ['Product Strategy Lead', 'strategist', 'product positioning, roadmap, and differentiation'],
      ['User & Market Researcher', 'investigator', 'user needs, competition, and adoption evidence'],
      ['Product Risk & Quality Lead', 'skeptic', 'claims, reliability, privacy, and delivery risk'],
    ],
  },
];

export function fallbackDomainHires(profile = {}) {
  const text = [profile.industry, profile.business_model, profile.what_it_does, profile.offer, ...(profile.capabilities || [])]
    .filter(Boolean).join(' ').toLowerCase();
  const roster = DOMAIN_ROSTERS.find((entry) => entry.pattern.test(text)) || {
    field: profile.industry || 'Business',
    roles: [
      ['Industry Strategy Lead', 'strategist', 'domain strategy, positioning, and priorities'],
      ['Customer & Market Researcher', 'investigator', 'customer, competitor, and market evidence'],
      ['Quality & Risk Lead', 'skeptic', 'assumption testing, delivery quality, and business risk'],
    ],
  };
  const names = ['Lena', 'Omar', 'Priya'];
  return roster.roles.map(([title, archetype, blurb], index) => ({
    name: names[index], title, archetype, blurb, focus: blurb, field: roster.field,
  }));
}
