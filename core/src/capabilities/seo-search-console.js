import { ConnectorStore } from '../connectors/framework/connector-store.js';

export const SEO_SEARCH_CONSOLE = Object.freeze({
  id: 'seo.search-console',
  version: '1.0.0',
  rooms: ['seo'],
  worker_class: 'connector-read',
  cache_ttl_seconds: 21_600,
  retry_policy: 'safe_reads',
  network_policy: 'google_api_only',
});

const PROVIDER = 'google-search-console';
const API_BASE = 'https://www.googleapis.com/webmasters/v3';

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function comparisonPeriods(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const previousEnd = new Date(start);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - 27);
  return {
    current: { start_date: isoDate(start), end_date: isoDate(end) },
    previous: { start_date: isoDate(previousStart), end_date: isoDate(previousEnd) },
  };
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function metricRow(row = {}, dimensions = []) {
  const keys = Array.isArray(row.keys) ? row.keys : [];
  const item = {
    clicks: numeric(row.clicks), impressions: numeric(row.impressions),
    ctr: numeric(row.ctr), position: numeric(row.position),
  };
  dimensions.forEach((dimension, index) => { item[dimension] = String(keys[index] || ''); });
  return item;
}

function delta(current, previous) {
  if (!previous) return current ? null : 0;
  return (current - previous) / previous;
}

function keyed(rows, dimensions) {
  return new Map(rows.map((row) => [dimensions.map((key) => row[key]).join('\u0000'), row]));
}

export function compileSearchConsoleEvidence({ siteUrl, permissionLevel, periods, datasets, fetchedAt = new Date().toISOString() }) {
  const currentTotals = metricRow(datasets.currentTotals?.rows?.[0]);
  const previousTotals = metricRow(datasets.previousTotals?.rows?.[0]);
  const queries = (datasets.queries?.rows || []).map((row) => metricRow(row, ['query']));
  const previousQueries = (datasets.previousQueries?.rows || []).map((row) => metricRow(row, ['query']));
  const pages = (datasets.pages?.rows || []).map((row) => metricRow(row, ['page']));
  const previousPages = (datasets.previousPages?.rows || []).map((row) => metricRow(row, ['page']));
  const queryPages = (datasets.queryPages?.rows || []).map((row) => metricRow(row, ['query', 'page']));
  const daily = (datasets.daily?.rows || []).map((row) => metricRow(row, ['date']));
  const previousQueryMap = keyed(previousQueries, ['query']);
  const previousPageMap = keyed(previousPages, ['page']);

  const opportunities = [];
  for (const row of queries) {
    const before = previousQueryMap.get(row.query);
    const impressionDelta = delta(row.impressions, before?.impressions || 0);
    if (row.impressions >= 20 && row.position >= 4 && row.position <= 20) {
      opportunities.push({ type: 'striking_distance_query', priority: row.impressions, query: row.query,
        evidence: { impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, position: row.position } });
    }
    if (row.impressions >= 50 && row.position <= 10 && row.ctr < 0.02) {
      opportunities.push({ type: 'high_impression_low_ctr', priority: row.impressions, query: row.query,
        evidence: { impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, position: row.position } });
    }
    if (impressionDelta !== null && impressionDelta >= 0.5 && row.impressions - numeric(before?.impressions) >= 20) {
      opportunities.push({ type: 'emerging_query', priority: row.impressions - numeric(before?.impressions), query: row.query,
        evidence: { impressions: row.impressions, previous_impressions: numeric(before?.impressions), change: impressionDelta } });
    }
  }
  for (const row of pages) {
    const before = previousPageMap.get(row.page);
    const clickDelta = delta(row.clicks, before?.clicks || 0);
    if (before && before.clicks >= 5 && clickDelta !== null && clickDelta <= -0.2) {
      opportunities.push({ type: 'declining_page', priority: before.clicks - row.clicks, page: row.page,
        evidence: { clicks: row.clicks, previous_clicks: before.clicks, change: clickDelta, impressions: row.impressions } });
    }
  }
  opportunities.sort((a, b) => b.priority - a.priority);

  return {
    schema: 'seo-search-console-evidence-v1',
    capability: { id: SEO_SEARCH_CONSOLE.id, version: SEO_SEARCH_CONSOLE.version },
    status: 'connected', site_url: siteUrl, permission_level: permissionLevel,
    fetched_at: fetchedAt, data_state: 'final', periods,
    totals: {
      current: currentTotals, previous: previousTotals,
      change: {
        clicks: delta(currentTotals.clicks, previousTotals.clicks),
        impressions: delta(currentTotals.impressions, previousTotals.impressions),
        ctr: delta(currentTotals.ctr, previousTotals.ctr),
        position: currentTotals.position - previousTotals.position,
      },
    },
    queries, pages, query_pages: queryPages, daily,
    opportunities: opportunities.slice(0, 50),
    limitations: [
      'Search Analytics rows are returned by Google in click order and are not guaranteed to include every row.',
      'Google may omit anonymized queries; this evidence must not be treated as a complete query inventory.',
      'The current and previous windows use finalized data and end three days before collection.',
    ],
  };
}

export class SeoSearchConsoleService {
  constructor({ prisma, fetchImpl, connectorStoreFactory, now } = {}) {
    if (!prisma) throw new Error('prisma required');
    this.prisma = prisma;
    this.fetch = fetchImpl || globalThis.fetch;
    this.connectorStoreFactory = connectorStoreFactory || ((db) => new ConnectorStore(db));
    this.now = now || (() => new Date());
  }

  async _integration(userId) {
    return this.prisma.platformIntegration.findFirst({
      where: { userId, platformType: PROVIDER, isActive: true, syncStatus: { not: 'revoked' } },
      select: { id: true, userId: true, oauthScopes: true, platformUserId: true },
    });
  }

  async _token(userId) {
    const token = await this.connectorStoreFactory(this.prisma).getAccessToken(userId, PROVIDER);
    if (!token) throw Object.assign(new Error('Search Console is not connected'), { code: 'search_console_not_connected', status: 409 });
    return token;
  }

  async _google(path, { token, method = 'GET', body } = {}) {
    const response = await this.fetch(`${API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Google Search Console API ${response.status}`;
      throw Object.assign(new Error(message), { code: response.status === 401 ? 'search_console_reauth_required' : 'search_console_api_error', status: response.status });
    }
    return payload;
  }

  async listProperties({ userId }) {
    const integration = await this._integration(userId);
    if (!integration) return { connected: false, properties: [] };
    const token = await this._token(userId);
    const payload = await this._google('/sites', { token });
    const properties = (payload.siteEntry || []).map((entry) => ({
      site_url: String(entry.siteUrl || ''), permission_level: String(entry.permissionLevel || 'unknown'),
    })).filter((entry) => entry.site_url).sort((a, b) => a.site_url.localeCompare(b.site_url));
    return { connected: true, integration_id: integration.id, account: integration.platformUserId || null, properties };
  }

  async selectProperty({ orgId, userId, siteUrl }) {
    const membership = await this.prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId } } });
    if (!membership?.isActive) throw Object.assign(new Error('Active organization membership required'), { status: 403, code: 'organization_access_denied' });
    const roles = new Set([membership.role, ...(Array.isArray(membership.roles) ? membership.roles : [])]);
    if (!roles.has('owner') && !roles.has('admin')) {
      throw Object.assign(new Error('Organization admin access is required to select a Search Console property'), { status: 403, code: 'organization_admin_required' });
    }
    const listed = await this.listProperties({ userId });
    const selected = listed.properties.find((property) => property.site_url === siteUrl);
    if (!selected) throw Object.assign(new Error('Select a property returned by Google Search Console'), { status: 400, code: 'invalid_search_console_property' });
    return this.prisma.seoSearchConsoleProperty.upsert({
      where: { orgId },
      create: { orgId, connectedByUserId: userId, integrationId: listed.integration_id, siteUrl: selected.site_url, permissionLevel: selected.permission_level },
      update: { connectedByUserId: userId, integrationId: listed.integration_id, siteUrl: selected.site_url, permissionLevel: selected.permission_level, selectedAt: this.now() },
    });
  }

  async status({ orgId, userId }) {
    const property = await this.prisma.seoSearchConsoleProperty.findUnique({ where: { orgId } });
    const currentUserIntegration = await this._integration(userId);
    let orgConnectionValid = false;
    if (property) {
      const [ownerMembership, ownerIntegration] = await Promise.all([
        this.prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: property.connectedByUserId, orgId } } }),
        this._integration(property.connectedByUserId),
      ]);
      orgConnectionValid = Boolean(ownerMembership?.isActive && ownerIntegration?.id === property.integrationId);
    }
    return {
      connected: property ? orgConnectionValid : Boolean(currentUserIntegration),
      connected_by_current_user: Boolean(currentUserIntegration), property_selected: Boolean(property),
      property: property ? { site_url: property.siteUrl, permission_level: property.permissionLevel, selected_at: property.selectedAt } : null,
    };
  }

  async _query(token, siteUrl, period, dimensions = [], rowLimit = 1_000) {
    return this._google(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      token, method: 'POST', body: {
        startDate: period.start_date, endDate: period.end_date,
        dimensions, type: 'web', aggregationType: dimensions.includes('page') ? 'byPage' : 'auto',
        rowLimit, dataState: 'final',
      },
    });
  }

  async collect({ orgId, userId }) {
    const property = await this.prisma.seoSearchConsoleProperty.findUnique({ where: { orgId } });
    if (!property) {
      const integration = userId ? await this._integration(userId) : null;
      return integration
        ? { schema: 'seo-search-console-evidence-v1', capability: { id: SEO_SEARCH_CONSOLE.id, version: SEO_SEARCH_CONSOLE.version }, status: 'property_required', connected: true }
        : { schema: 'seo-search-console-evidence-v1', capability: { id: SEO_SEARCH_CONSOLE.id, version: SEO_SEARCH_CONSOLE.version }, status: 'not_connected', connected: false };
    }
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_orgId: { userId: property.connectedByUserId, orgId } },
    });
    const integration = await this._integration(property.connectedByUserId);
    if (!membership?.isActive || !integration || integration.id !== property.integrationId) {
      return { status: 'reauthorization_required', connected: false };
    }
    const token = await this._token(property.connectedByUserId);
    const periods = comparisonPeriods(this.now());
    const [currentTotals, previousTotals, queries, previousQueries, pages, previousPages, queryPages, daily] = await Promise.all([
      this._query(token, property.siteUrl, periods.current, [], 1),
      this._query(token, property.siteUrl, periods.previous, [], 1),
      this._query(token, property.siteUrl, periods.current, ['query'], 500),
      this._query(token, property.siteUrl, periods.previous, ['query'], 500),
      this._query(token, property.siteUrl, periods.current, ['page'], 500),
      this._query(token, property.siteUrl, periods.previous, ['page'], 500),
      this._query(token, property.siteUrl, periods.current, ['query', 'page'], 1_000),
      this._query(token, property.siteUrl, periods.current, ['date'], 100),
    ]);
    const evidence = compileSearchConsoleEvidence({
      siteUrl: property.siteUrl, permissionLevel: property.permissionLevel, periods,
      datasets: { currentTotals, previousTotals, queries, previousQueries, pages, previousPages, queryPages, daily },
      fetchedAt: this.now().toISOString(),
    });
    await this.prisma.seoSearchConsoleSnapshot.upsert({
      where: { orgId_propertyId_startDate_endDate: {
        orgId, propertyId: property.id,
        startDate: new Date(`${periods.current.start_date}T00:00:00.000Z`),
        endDate: new Date(`${periods.current.end_date}T00:00:00.000Z`),
      } },
      create: { orgId, propertyId: property.id, siteUrl: property.siteUrl,
        startDate: new Date(`${periods.current.start_date}T00:00:00.000Z`), endDate: new Date(`${periods.current.end_date}T00:00:00.000Z`), evidence },
      update: { evidence, fetchedAt: this.now() },
    });
    return evidence;
  }
}
