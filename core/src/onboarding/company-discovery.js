const SKIP_EXTENSIONS = /\.(?:avif|css|csv|docx?|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|pptx?|svg|webm|webp|xlsx?|xml|zip)$/i;
const SKIP_PATHS = /\/(?:agb|auth|cart|checkout|cookie|datenschutz(?:erklaerung)?|impressum|legal|login|logout|privacy|register|signin|signup|terms|widerruf)(?:\/|$)/i;
const LOCATION_EVIDENCE_PATHS = /\/(?:impressum|legal-notice|contact|kontakt|location|standort|office)(?:\/|$)/i;

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

const RESEARCH_PAGE_SIGNALS = [
  [/about|company|story|agency|studio|unternehmen|agentur|ueber|über/, 100, 'identity'],
  [/service|solution|expertise|leistung|angebot|capabilit|product|platform|software|produkt/, 95, 'offering'],
  [/contact|kontakt|impressum|legal-notice|location|standort|office/, 92, 'location'],
  [/work|arbeit|case|customer|client|project|portfolio|referenz/, 86, 'proof'],
  [/team|people|founder|leadership/, 82, 'team'],
  [/pricing|plans|preise/, 76, 'commercial'],
];

export function selectCompanyResearchPages(links, homepageUrl, { maxPages = 6 } = {}) {
  let base;
  try { base = new URL(homepageUrl); } catch { return []; }
  const candidates = new Map();
  for (const item of Array.isArray(links) ? links : []) {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    let url;
    try { url = new URL(rawUrl, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || normalizedHost(url.hostname) !== normalizedHost(base.hostname)) continue;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    if (SKIP_EXTENSIONS.test(url.pathname)) continue;
    const label = [item?.title, item?.description, url.pathname].filter(Boolean).join(' ');
    const match = RESEARCH_PAGE_SIGNALS.find(([pattern]) => pattern.test(label.toLowerCase()));
    if (!match && url.pathname !== '/') continue;
    const candidate = {
      url: url.href,
      label: String(item?.title || item?.description || url.pathname),
      purpose: match?.[2] || 'identity',
      score: match?.[1] || 110,
    };
    const current = candidates.get(candidate.url);
    if (!current || current.score < candidate.score) candidates.set(candidate.url, candidate);
  }
  const homepage = { url: new URL('/', base).href, label: 'Homepage', purpose: 'identity', score: 110 };
  candidates.set(homepage.url, homepage);

  // Preserve evidence breadth before filling remaining slots by score. This
  // prevents six product pages from crowding out the legal/contact page that
  // usually contains the strongest company-location evidence.
  const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const selected = [];
  for (const purpose of ['identity', 'offering', 'location', 'proof', 'team', 'commercial']) {
    const next = ordered.find((page) => page.purpose === purpose && !selected.some((picked) => picked.url === page.url));
    if (next) selected.push(next);
  }
  for (const page of ordered) {
    if (selected.length >= Math.max(1, maxPages)) break;
    if (!selected.some((picked) => picked.url === page.url)) selected.push(page);
  }
  return selected.slice(0, Math.max(1, maxPages));
}

function pageScore(url, label) {
  const signal = `${url.pathname} ${label}`.toLowerCase();
  const priorities = [
    [/about|company|story|agency|studio|unternehmen|agentur|ueber|über/, 100],
    [/service|solution|expertise|leistung|angebot|capabilit/, 95],
    [/product|platform|software|produkt/, 90],
    [/work|arbeit|case|customer|client|project|portfolio|referenz/, 85],
    [/team|people|founder|leadership|karriere|career/, 80],
    [/pricing|plans|preise/, 75],
    [/contact|kontakt/, 45],
    [/blog|news|insight|magazin|journal/, 25],
  ];
  const matched = priorities.find(([pattern]) => pattern.test(signal));
  const depth = url.pathname.split('/').filter(Boolean).length;
  return (matched?.[1] || 50) - Math.max(0, depth - 1) * 8;
}

export function discoverCompanyPages(homepageHtml, homepageUrl, { maxPages = 5, includeLocationPages = false } = {}) {
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
    if (SKIP_PATHS.test(url.pathname) && !(includeLocationPages && LOCATION_EVIDENCE_PATHS.test(url.pathname))) continue;
    const label = anchor[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const key = url.href;
    const score = pageScore(url, label);
    if (!candidates.has(key) || candidates.get(key).score < score) candidates.set(key, { url: key, label, score });
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
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
