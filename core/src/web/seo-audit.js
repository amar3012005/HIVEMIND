import crypto from 'crypto';

const AUDIT_VERSION = 'seo-audit-v1';
const WEIGHTS = { critical: 30, high: 15, medium: 6, low: 2 };

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pathnameOf(value) {
  try { return new URL(value).pathname || '/'; } catch { return '/'; }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return text(value);
  }
}

function templateFor(url) {
  const parts = pathnameOf(url).split('/').filter(Boolean);
  if (!parts.length) return 'homepage';
  const normalized = parts.map((part, index) => (
    /^\d+$/.test(part) || /^[0-9a-f-]{16,}$/i.test(part) || (parts.length > 1 && index === parts.length - 1)
      ? ':slug' : part
  ));
  return `/${normalized.slice(0, 2).join('/')}`;
}

function pageSignal(page, key, fallback = null) {
  if (page?.seo && page.seo[key] !== undefined) return page.seo[key];
  if (page?.metadata && page.metadata[key] !== undefined) return page.metadata[key];
  if (page && page[key] !== undefined) return page[key];
  return fallback;
}

function finding(rule, severity, category, title, recommendation, page, evidence) {
  const url = text(page?.url);
  return {
    id: crypto.createHash('sha256').update(`${rule}:${url}`).digest('hex').slice(0, 16),
    rule,
    severity,
    category,
    title,
    recommendation,
    url,
    template: templateFor(url),
    evidence,
    effort: severity === 'critical' ? 'engineering' : severity === 'high' ? 'moderate' : 'quick_win',
  };
}

function auditPage(page) {
  const findings = [];
  const title = text(pageSignal(page, 'title'));
  const description = text(pageSignal(page, 'description'));
  const canonical = text(pageSignal(page, 'canonical'));
  const robots = text(pageSignal(page, 'robots')).toLowerCase();
  const h1 = asArray(pageSignal(page, 'h1', pageSignal(page, 'headings', [])?.h1));
  const status = Number(pageSignal(page, 'status', 200));
  const wordCount = Number(pageSignal(page, 'wordCount', 0));
  const jsonLd = pageSignal(page, 'jsonLd');
  const images = asArray(pageSignal(page, 'images'));
  const links = asArray(pageSignal(page, 'links'));
  const url = text(page.url);
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const internalLinkTargets = [...new Set(links.map((link) => {
    try {
      const target = new URL(typeof link === 'string' ? link : link?.href, url);
      target.hash = '';
      return target.origin === origin ? target.href : null;
    } catch { return null; }
  }).filter(Boolean))];

  if (status >= 400) findings.push(finding('http_status', 'critical', 'crawlability', `Page returns HTTP ${status}`, 'Repair or remove internal links to this URL and restore the intended destination.', page, { status }));
  if (robots.includes('noindex')) findings.push(finding('noindex', 'critical', 'indexability', 'Page is marked noindex', 'Confirm intent. Remove the noindex directive from pages that should appear in search.', page, { robots }));
  if (!title) findings.push(finding('title_missing', 'high', 'on_page', 'Title element is missing', 'Add a unique title aligned with the page intent and primary search need.', page, {}));
  else if (title.length < 20 || title.length > 65) findings.push(finding('title_length', 'medium', 'on_page', 'Title length is outside the useful range', 'Rewrite the title to be specific and scannable without truncating its main value.', page, { length: title.length, title }));
  if (!description) findings.push(finding('description_missing', 'medium', 'on_page', 'Meta description is missing', 'Write a unique description that explains the page value and supports search-result click-through.', page, {}));
  if (h1.length === 0) findings.push(finding('h1_missing', 'high', 'on_page', 'No primary H1 was detected', 'Add one descriptive H1 that clearly states the page topic.', page, {}));
  if (h1.length > 1) findings.push(finding('h1_multiple', 'low', 'on_page', 'Multiple H1 headings were detected', 'Use one primary H1 and move subordinate headings to H2/H3.', page, { count: h1.length }));
  if (!canonical) findings.push(finding('canonical_missing', 'medium', 'indexability', 'Canonical URL is not declared', 'Add a self-referencing canonical unless another canonical destination is intentional.', page, {}));
  else if (canonical !== url) findings.push(finding('canonical_difference', 'medium', 'indexability', 'Canonical points to another URL', 'Verify that the declared canonical represents the preferred indexable version.', page, { canonical }));
  if (wordCount > 0 && wordCount < 120) findings.push(finding('thin_content', 'medium', 'content', 'Page has very little indexable content', 'Confirm the page satisfies a distinct search intent; consolidate or add useful original information.', page, { word_count: wordCount }));
  const missingAlt = images.filter((image) => typeof image === 'object' && !text(image.alt)).length;
  if (missingAlt) findings.push(finding('image_alt_missing', 'low', 'accessibility', 'Images are missing alternative text', 'Add concise contextual alt text to meaningful images and leave decorative images empty.', page, { affected_images: missingAlt, total_images: images.length }));
  if (!jsonLd) findings.push(finding('structured_data_absent', 'low', 'structured_data', 'No structured data was detected', 'Evaluate eligible Organization, Product, Article, Breadcrumb, or other supported schema for this page.', page, {}));

  return {
    url,
    title,
    description,
    canonical,
    status,
    word_count: wordCount,
    internal_links: internalLinkTargets.length,
    internal_link_targets: internalLinkTargets,
    discovery: page?.discovery || null,
    template: templateFor(url),
    findings,
  };
}

function aggregateFindings(findings) {
  const grouped = new Map();
  for (const item of findings) {
    const key = `${item.rule}:${item.template}`;
    const row = grouped.get(key) || { ...item, id: key, affected_urls: [], instances: 0 };
    row.instances += 1;
    if (row.affected_urls.length < 5) row.affected_urls.push(item.url);
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => WEIGHTS[b.severity] - WEIGHTS[a.severity] || b.instances - a.instances);
}

export function compileSeoAudit({ seedUrl, pages = [], errors = [], runtimeUsed = null, scannedAt = new Date().toISOString(), siteFiles = null, capability = null, searchConsole = null } = {}) {
  const auditedPages = asArray(pages).filter((page) => text(page?.url)).map(auditPage);
  const discoveredUrls = new Set([
    canonicalUrl(seedUrl),
    ...asArray(siteFiles?.discovery?.urls).map(canonicalUrl),
    ...auditedPages.map((page) => canonicalUrl(page.url)),
  ].filter(Boolean));
  const auditedUrls = new Set(auditedPages.map((page) => page.url));
  const incomingLinks = new Map(auditedPages.map((page) => [page.url, 0]));
  for (const page of auditedPages) {
    for (const target of page.internal_link_targets) {
      if (auditedUrls.has(target)) incomingLinks.set(target, (incomingLinks.get(target) || 0) + 1);
    }
  }
  const findings = auditedPages.flatMap((page) => page.findings);
  const penalty = findings.reduce((sum, item) => sum + WEIGHTS[item.severity], 0);
  const denominator = Math.max(1, auditedPages.length);
  const score = Math.max(0, Math.round(100 - penalty / denominator));
  const severity = Object.fromEntries(['critical', 'high', 'medium', 'low'].map((key) => [key, findings.filter((item) => item.severity === key).length]));
  const categories = {};
  for (const item of findings) categories[item.category] = (categories[item.category] || 0) + 1;
  const templates = {};
  for (const page of auditedPages) {
    const row = templates[page.template] || { template: page.template, pages: 0, issues: 0 };
    row.pages += 1;
    row.issues += page.findings.length;
    templates[page.template] = row;
  }
  const normalizedErrors = asArray(errors).map((error) => ({
    url: text(error?.target || error?.url),
    type: text(error?.type || 'crawl_error'),
    message: text(error?.error || error?.message || 'Unable to inspect URL'),
  }));
  const renderedEvidence = ['playwright-service', 'lightpanda', 'playwright'].includes(runtimeUsed);
  const evidenceQuality = renderedEvidence
    ? { level: 'rendered', score_status: 'comparable', reason: 'Pages were inspected from a browser-rendered DOM.' }
    : { level: 'degraded', score_status: 'provisional', reason: 'The browser renderer was unavailable; static HTML can miss client-rendered content and links.' };

  return {
    schema: AUDIT_VERSION,
    capability,
    seed_url: text(seedUrl || auditedPages[0]?.url),
    scanned_at: scannedAt,
    runtime: runtimeUsed,
    score,
    evidence_quality: evidenceQuality,
    coverage: {
      pages_scanned: auditedPages.length,
      pages_discovered: discoveredUrls.size,
      sitemap_urls_found: Number(siteFiles?.discovery?.sitemap_urls_found || 0),
      crawl_errors: normalizedErrors.length,
    },
    severity,
    categories,
    findings: aggregateFindings(findings),
    pages: auditedPages.map(({ findings: pageFindings, internal_link_targets: _targets, ...page }) => ({
      ...page,
      crawl_depth: page.discovery?.depth ?? null,
      discovery_source: page.discovery?.source || 'unknown',
      internal_inlinks: incomingLinks.get(page.url) || 0,
      orphan_candidate: page.url !== text(seedUrl) && page.discovery?.source === 'sitemap' && !(incomingLinks.get(page.url) > 0),
      issue_count: pageFindings.length,
    })),
    architecture: {
      orphan_candidates: auditedPages.filter((page) => page.url !== text(seedUrl) && page.discovery?.source === 'sitemap' && !(incomingLinks.get(page.url) > 0)).length,
      max_crawl_depth: auditedPages.reduce((max, page) => Math.max(max, Number(page.discovery?.depth || 0)), 0),
      pages_without_internal_inlinks: auditedPages.filter((page) => page.url !== text(seedUrl) && !(incomingLinks.get(page.url) > 0)).length,
    },
    templates: Object.values(templates).sort((a, b) => b.issues - a.issues),
    crawl_errors: normalizedErrors,
    site_files: siteFiles,
    search_console: searchConsole || {
      schema: 'seo-search-console-evidence-v1',
      capability: { id: 'seo.search-console', version: '1.0.0' },
      status: 'not_connected', connected: false,
    },
    limitations: [
      ...(renderedEvidence ? [] : ['This is a degraded static-HTML audit. Treat its health score, content depth, internal-link graph, and orphan-page signals as provisional.']),
      ...(searchConsole?.status === 'connected' ? [] : ['Public crawl evidence does not prove Google index status or search demand.']),
      'Core Web Vitals require field or Lighthouse measurements and are not inferred from HTML.',
      ...(searchConsole?.status === 'connected' ? [] : ['Connect Search Console to add first-party query, page, click, impression, CTR, and position evidence.']),
    ],
  };
}

export async function inspectSeoSiteFiles(seedUrl, fetchImpl = globalThis.fetch) {
  const origin = new URL(seedUrl).origin;
  async function read(target) {
    try {
      const url = new URL(target, origin);
      if (url.origin !== origin) throw new Error('cross_origin_site_file');
      const response = await fetchImpl(url.href, {
        redirect: 'follow',
        headers: { 'User-Agent': 'HIVEMIND SEO Audit/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!sameOrigin(response.url || url.href)) throw new Error('cross_origin_redirect');
      return { url: response.url, status: response.status, body: response.ok ? await response.text() : '' };
    } catch (error) {
      return { url: new URL(target, origin).href, status: 0, body: '', error: error.message };
    }
  }
  function sitemapLocations(xml) {
    return [...String(xml || '').matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)]
      .map((match) => match[1].replace(/&amp;/g, '&').trim())
      .filter(Boolean);
  }
  function sameOrigin(url) {
    try { return new URL(url, origin).origin === origin; } catch { return false; }
  }

  const robots = await read('/robots.txt');
  const declared = [...robots.body.matchAll(/^sitemap:\s*(\S+)/gim)].map((match) => match[1]);
  const sitemapTargets = (declared.length ? declared : ['/sitemap.xml']).filter(sameOrigin).slice(0, 5);
  const sitemapFiles = await Promise.all(sitemapTargets.map(read));
  const childTargets = sitemapFiles
    .flatMap((file) => /<sitemapindex[\s>]/i.test(file.body) ? sitemapLocations(file.body) : [])
    .filter(sameOrigin)
    .slice(0, 10);
  const childFiles = await Promise.all(childTargets.map(read));
  const allSitemaps = [...sitemapFiles, ...childFiles];
  const discoveredUrls = [...new Set(allSitemaps
    .flatMap((file) => sitemapLocations(file.body))
    .filter((url) => sameOrigin(url) && !/\.xml(?:$|[?#])/i.test(url)))]
    .slice(0, 500);
  const primarySitemap = sitemapFiles[0] || { url: `${origin}/sitemap.xml`, status: 0 };
  return {
    robots: { url: robots.url, status: robots.status, present: robots.status === 200, sitemap_urls: declared.slice(0, 10) },
    sitemap: {
      url: primarySitemap.url,
      status: primarySitemap.status,
      present: allSitemaps.some((file) => file.status === 200),
      declared_in_robots: declared.length > 0,
      files_checked: allSitemaps.length,
    },
    discovery: {
      source: discoveredUrls.length ? 'sitemap_and_rendered_links' : 'rendered_links',
      urls_found: discoveredUrls.length,
      sitemap_urls_found: discoveredUrls.length,
      urls: discoveredUrls,
    },
  };
}

export { AUDIT_VERSION };
