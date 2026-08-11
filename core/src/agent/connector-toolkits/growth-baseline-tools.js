import { runGrowthBaseline } from '../../growth/baseline.js';

const GROWTH_BASELINE_GROUP = 'growth_baseline';

const definitions = [
  {
    name: 'growth_baseline_latest',
    description: 'Read the latest source-backed company growth baseline: website, connected social accounts, content, analytics, execution context, and collection limitations. Use before recommending growth, SEO, marketing, outreach, or campaigns.',
    parameters: { type: 'object', properties: {} }, readOnly: true,
  },
  {
    name: 'growth_baseline_platform',
    description: 'Read the detailed retained baseline artifact for one connected platform: instagram, linkedin, or twitter/X. Includes provider-returned profile health, posts, analytics, timing, and limitations without exposing credentials.',
    parameters: { type: 'object', properties: { platform: { type: 'string', enum: ['instagram', 'linkedin', 'twitter'] } }, required: ['platform'] }, readOnly: true,
  },
  {
    name: 'growth_baseline_history',
    description: 'List recent dated growth baselines for this organization, so the Room can compare current state with previous evidence.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 12 } } }, readOnly: true,
  },
  {
    name: 'growth_baseline_collect',
    description: 'Collect fresh company growth evidence. Use depth=full_transfer only for onboarding, a reconnect, or an explicit audit. Use depth=refresh for a cheap, targeted update with selected platforms and metrics.',
    parameters: { type: 'object', properties: {
      depth: { type: 'string', enum: ['refresh', 'full_transfer'] },
      platforms: { type: 'array', items: { type: 'string', enum: ['instagram', 'linkedin', 'twitter'] } },
      metrics: { type: 'array', items: { type: 'string', enum: ['profile', 'followers', 'posts', 'analytics', 'performance'] } },
      days: { type: 'integer', minimum: 1, maximum: 88 },
      include_website: { type: 'boolean' },
    } }, readOnly: false,
  },
];

function compactBaseline(payload) {
  if (!payload) return null;
  return {
    resource_id: payload.resource_id || null, as_of: payload.as_of, scope: payload.scope,
    company: payload.company, website: payload.website,
    social_presence: payload.social_presence,
    execution: payload.execution, market_signals: payload.market_signals,
    data_gaps: payload.data_gaps, platform_resources: payload.platform_resources || [],
  };
}

async function execute(name, args, { prisma, orgId, userId }) {
  if (name === 'growth_baseline_collect') {
    const depth = args?.depth === 'full_transfer' ? 'full_all' : 'refresh';
    const baseline = await runGrowthBaseline({
      prisma, orgId, userId, mode: depth, platforms: args?.platforms || [], metrics: args?.metrics || [],
      days: args?.days, includeWebsite: args?.include_website !== false,
    });
    return { collected: true, mode: depth, resource_id: baseline.resource_id, platform_resources: baseline.platform_resources || [], baseline };
  }
  if (name === 'growth_baseline_latest') {
    const artifact = await prisma.sourceArtifact.findFirst({
      where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' },
      orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, payload: true, metadata: true },
    });
    return artifact ? { available: true, baseline: { ...compactBaseline(artifact.payload), resource_id: artifact.id, captured_at: artifact.createdAt } } : { available: false, reason: 'No growth baseline has been collected for this organization yet.' };
  }
  if (name === 'growth_baseline_platform') {
    const platform = String(args?.platform || '').toLowerCase();
    const artifact = await prisma.sourceArtifact.findFirst({
      where: { orgId, sourcePlatform: `growth_${platform}`, artifactType: 'api_response' },
      orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, payload: true, metadata: true },
    });
    return artifact ? { available: true, platform, resource_id: artifact.id, captured_at: artifact.createdAt, report: artifact.payload } : { available: false, platform, reason: `No ${platform} baseline artifact has been collected yet.` };
  }
  if (name === 'growth_baseline_history') {
    const limit = Math.min(12, Math.max(1, Number(args?.limit) || 6));
    const rows = await prisma.sourceArtifact.findMany({
      where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' }, orderBy: { createdAt: 'desc' }, take: limit,
      select: { id: true, createdAt: true, payload: true, metadata: true },
    });
    return { baselines: rows.map((row) => ({ resource_id: row.id, captured_at: row.createdAt, company: row.payload?.company?.name || null, mode: row.payload?.scope?.mode || 'standard', platforms: Object.keys(row.payload?.social_presence?.platform_reports || {}) })) };
  }
  throw new Error(`Unknown growth baseline tool: ${name}`);
}

export function getGrowthBaselineToolCatalog() {
  return { name: GROWTH_BASELINE_GROUP, description: 'Tenant-scoped company growth evidence collected from the website and connected social accounts. Read retained evidence or run a targeted refresh; full transfer is reserved for onboarding and reconnect audits.', tools: definitions.map(({ name, description, readOnly }) => ({ name, description, readOnly })) };
}

export function registerGrowthBaselineTools(toolkit, { prisma, orgId, userId, selectedGroups = [] } = {}) {
  if (!selectedGroups.includes(GROWTH_BASELINE_GROUP)) return;
  const catalog = getGrowthBaselineToolCatalog();
  toolkit.createToolGroup({ name: catalog.name, description: catalog.description, active: false, notes: 'Read retained baseline evidence before planning. growth_baseline_collect refreshes only selected platforms and metrics by default. Reserve full_transfer for onboarding, reconnection, or explicit full audit. Credentials never enter tool results.' });
  for (const definition of definitions) toolkit.registerToolFunction({ ...definition, groupName: GROWTH_BASELINE_GROUP, handler: (args) => execute(definition.name, args, { prisma, orgId, userId }) });
}
