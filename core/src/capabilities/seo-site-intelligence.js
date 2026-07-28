import crypto from 'node:crypto';
import { compileSeoAudit, inspectSeoSiteFiles } from '../web/seo-audit.js';
import { CapabilityRegistry } from './registry.js';

export const SEO_SITE_INTELLIGENCE = Object.freeze({
  id: 'seo.site-intelligence',
  version: '1.0.0',
  rooms: ['seo'],
  worker_class: 'browser',
  cache_ttl_seconds: 86400,
  retry_policy: 'safe_reads',
  resource_profile: { cpu: 'medium', memory: 'high', concurrency: 1 },
  network_policy: 'public_same_origin',
});

export const capabilityRegistry = new CapabilityRegistry([SEO_SITE_INTELLIGENCE]);

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function artifactId(manifest, seedUrl, scannedAt) {
  return crypto.createHash('sha256')
    .update(`${manifest.id}@${manifest.version}:${seedUrl}:${scannedAt}`)
    .digest('hex')
    .slice(0, 24);
}

export async function runSeoSiteIntelligence({ seedUrl, depth = 2, pageLimit = 25, browserRuntime, fetchImpl, searchConsoleService, userId, orgId, onStage } = {}) {
  const manifest = capabilityRegistry.resolve('seo.site-intelligence');
  if (!manifest || !browserRuntime) throw new Error('SEO capability runtime is unavailable');
  const scannedAt = new Date().toISOString();
  const stages = [];
  const emit = async (stage, status, details = {}) => {
    const event = { stage, status, at: new Date().toISOString(), ...details };
    stages.push(event);
    if (onStage) await onStage(event);
  };

  await emit('site_discovery', 'running');
  const siteFiles = await inspectSeoSiteFiles(seedUrl, fetchImpl);
  await emit('site_discovery', 'succeeded', {
    sitemap_urls_found: siteFiles.discovery?.sitemap_urls_found || 0,
    sitemap_present: Boolean(siteFiles.sitemap?.present),
  });

  const sitemapCandidates = siteFiles.discovery?.urls || [];
  const crawlSeeds = [...new Set([seedUrl, ...sitemapCandidates].map(canonicalUrl).filter(Boolean))]
    .slice(0, pageLimit);
  await emit('rendered_crawl', 'running', { seeds: crawlSeeds.length, page_limit: pageLimit });
  const crawl = await browserRuntime.seoAudit({ urls: crawlSeeds, depth, pageLimit });
  await emit('rendered_crawl', 'succeeded', {
    pages_scanned: crawl.pages?.length || 0,
    crawl_errors: crawl.errors?.length || 0,
    runtime: crawl.runtime_used,
  });

  let searchConsole = null;
  if (searchConsoleService && orgId) {
    await emit('search_performance', 'running');
    try {
      searchConsole = await searchConsoleService.collect({ orgId, userId });
      await emit('search_performance', searchConsole.status === 'connected' ? 'succeeded' : 'skipped', { connection_status: searchConsole.status });
    } catch (error) {
      searchConsole = {
        schema: 'seo-search-console-evidence-v1',
        capability: { id: 'seo.search-console', version: '1.0.0' },
        status: error.code || 'unavailable', connected: false,
      };
      await emit('search_performance', 'failed', { connection_status: searchConsole.status });
    }
  }

  await emit('evidence_compilation', 'running');
  const capability = {
    schema: 'capability-artifact-v1',
    id: manifest.id,
    version: manifest.version,
    artifact_id: artifactId(manifest, seedUrl, scannedAt),
    worker_class: manifest.worker_class,
    stages,
  };
  const audit = compileSeoAudit({
    seedUrl,
    pages: crawl.pages,
    errors: crawl.errors,
    runtimeUsed: crawl.runtime_used,
    scannedAt,
    siteFiles, searchConsole,
    capability,
  });
  await emit('evidence_compilation', 'succeeded', {
    findings: audit.findings.length,
    templates: audit.templates.length,
  });
  capability.stages = stages;

  return {
    manifest,
    audit,
    runtime_used: crawl.runtime_used,
    fallback_applied: crawl.fallback_applied,
    duration_ms: crawl.duration_ms,
  };
}
