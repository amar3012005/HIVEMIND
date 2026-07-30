import crypto from 'node:crypto';
import { getSharedProfileStore } from '../memory/profile-store.js';
import { researchCompanyWebsite, scrapePublicPages, searchCompanyMarket, verifiedSocialProfiles } from '../onboarding/company-research.js';
import { requestZernio } from '../campaigns/zernio-execution.js';
import { scheduleHqWake } from '../hq-runtime/repository.js';

function text(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function factMap(facts) {
  return new Map((Array.isArray(facts) ? facts : [])
    .filter((fact) => String(fact?.key || '').startsWith('company:') || fact?.key === 'company')
    .map((fact) => [String(fact.key).toLowerCase(), text(fact.value, 3000)]));
}

function knownSocialUrls(facts, requestedUrls) {
  const fromProfile = String(facts.get('company:social_profiles') || '')
    .split(/\r?\n/)
    .map((line) => line.split(': ').slice(1).join(': ').trim())
    .filter(Boolean);
  return [...new Set([...fromProfile, ...(Array.isArray(requestedUrls) ? requestedUrls : [])]
    .map((value) => text(value, 1000))
    .filter((value) => /^https:\/\//i.test(value)))].slice(0, 5);
}

function publicProfileSummary(rows) {
  return rows.map((row) => ({
    url: row.url,
    status: row.status,
    title: row.title || null,
    description: row.description || null,
    observed_content: row.content ? row.content.slice(0, 600) : null,
    source: row.provider,
    ...(row.reason ? { limitation: row.reason } : {}),
  }));
}

function channelCoverage(connection) {
  return (Array.isArray(connection?.channels) ? connection.channels : []).map((channel) => ({
    channel: channel.id,
    connected: Boolean(channel.connected),
    publishing_ready: Boolean(channel.execution_ready),
    source: 'zernio',
    ...(channel.reason ? { limitation: channel.reason } : {}),
  }));
}

async function cachedZernioState(prisma, orgId) {
  // Core owns provider synchronization. The control plane reads only its
  // tenant-scoped durable snapshot, keeping Firecrawl and Zernio credentials in
  // their respective services.
  const rows = await prisma.$queryRawUnsafe(
    'SELECT status, capabilities, connected_accounts FROM hivemind.zernio_org_profiles WHERE org_id = $1::uuid LIMIT 1',
    orgId,
  ).catch(() => []);
  const row = rows[0];
  const capabilities = row?.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {};
  const result = {
    status: row?.status || 'UNPROVISIONED',
    channels: Array.isArray(capabilities.channels) ? capabilities.channels : [],
    can_read_analytics: Boolean(capabilities.can_read_analytics),
  };
  return result;
}

function numericTotals(posts) {
  return posts.reduce((total, post) => {
    for (const metric of ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks', 'views', 'follows']) total[metric] += Number(post?.analytics?.[metric]) || 0;
    return total;
  }, { impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, views: 0, follows: 0 });
}

async function zernioSnapshot(prisma, orgId, { platforms = [], days = 30, metrics = ['profile', 'followers', 'posts'] } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT zernio_profile_id FROM hivemind.zernio_org_profiles WHERE org_id = $1::uuid LIMIT 1', orgId,
  ).catch(() => []);
  const profileId = rows[0]?.zernio_profile_id;
  if (!profileId) return { status: 'UNPROVISIONED', accounts: [], followers: [], posts: [], totals: numericTotals([]), limitation: 'No Zernio profile is connected.' };
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - Math.max(1, Math.min(366, Number(days) || 90)) * 86_400_000).toISOString().slice(0, 10);
  const requested = new Set((metrics || []).map((value) => String(value).toLowerCase()));
  const wantsFollowers = requested.has('followers');
  const wantsPosts = requested.has('posts') || requested.has('analytics') || requested.has('performance');
  const [healthResult, followersResult, analyticsResult] = await Promise.allSettled([
    requestZernio(`/accounts/health?profileId=${encodeURIComponent(profileId)}`),
    wantsFollowers ? requestZernio(`/accounts/follower-stats?profileId=${encodeURIComponent(profileId)}&fromDate=${from}&toDate=${today}&granularity=daily`) : Promise.resolve(null),
    wantsPosts ? requestZernio(`/analytics?profileId=${encodeURIComponent(profileId)}&fromDate=${from}&toDate=${today}&limit=100&source=all`) : Promise.resolve(null),
  ]);
  const value = (result) => result.status === 'fulfilled' ? result.value : null;
  const health = value(healthResult);
  const healthAccounts = health?.accounts || health?.data?.accounts || [];
  const accepted = new Set((platforms || []).map((item) => String(item).toLowerCase()).filter(Boolean));
  const accounts = healthAccounts.filter((account) => !accepted.size || accepted.has(String(account.platform).toLowerCase())).map((account) => ({
    platform: account.platform, username: account.username || null, status: account.status || 'unknown',
    can_publish: Boolean(account.canPost), can_fetch_analytics: Boolean(account.canFetchAnalytics),
    needs_reconnect: Boolean(account.needsReconnect), issues: Array.isArray(account.issues) ? account.issues : [],
  }));
  const followerRows = (value(followersResult)?.accounts || value(followersResult)?.data?.accounts || [])
    .filter((account) => !accepted.size || accepted.has(String(account.platform).toLowerCase()))
    .map((account) => ({ platform: account.platform, username: account.username || null, current_followers: Number(account.currentFollowers || 0), growth: Number(account.growth || 0), growth_percentage: Number(account.growthPercentage || 0), data_points: Number(account.dataPoints || 0) }));
  const posts = (value(analyticsResult)?.posts || value(analyticsResult)?.data?.posts || [])
    .filter((post) => !accepted.size || accepted.has(String(post.platform).toLowerCase()))
    .map((post) => ({ platform: post.platform, published_at: post.publishedAt || null, status: post.status || null, content: text(post.content, 600), is_external: Boolean(post.isExternal), analytics: post.analytics || {} }));
  const errors = [healthResult, followersResult, analyticsResult].filter((result) => result?.status === 'rejected').map((result) => String(result.reason?.message || 'Zernio read failed').slice(0, 300));
  return { status: errors.length ? 'PARTIAL' : 'AVAILABLE', period: { from, to: today }, accounts, followers: followerRows, posts, totals: numericTotals(posts), overview: value(analyticsResult)?.overview || value(analyticsResult)?.data?.overview || null, requested_metrics: [...requested], limitations: errors };
}

function dateWindow(days, maxDays = 88) {
  // Zernio's detailed platform endpoints currently accept at most 88 inclusive
  // calendar days. Keeping the window inside that contract avoids losing an
  // otherwise valid whole baseline to a date-validation error.
  const to = new Date();
  const span = Math.max(1, Math.min(maxDays, Number(days) || maxDays));
  const from = new Date(to.getTime() - Math.max(0, span - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function accountId(account) {
  return String(account?._id || account?.id || account?.accountId || '').trim();
}

function platformName(account) {
  return String(account?.platform || '').trim().toLowerCase();
}

function safeProviderError(error) {
  return {
    available: false,
    code: String(error?.code || 'provider_read_failed').slice(0, 100),
    message: String(error?.message || 'The provider did not return this source.').slice(0, 500),
  };
}

async function zernioRead(path) {
  try { return { available: true, payload: await requestZernio(path) }; }
  catch (error) { return safeProviderError(error); }
}

async function detailedZernioTransfer(prisma, orgId, { platforms = [], days = 88 } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT zernio_profile_id FROM hivemind.zernio_org_profiles WHERE org_id = $1::uuid LIMIT 1', orgId,
  ).catch(() => []);
  const profileId = rows[0]?.zernio_profile_id;
  if (!profileId) return { status: 'UNPROVISIONED', accounts: [], limitations: ['No Zernio profile is connected.'], platform_reports: {} };

  const period = dateWindow(days);
  const query = (values) => new URLSearchParams(values).toString();
  const root = await Promise.all([
    zernioRead(`/accounts?${query({ profileId, includeOverLimit: 'true' })}`),
    zernioRead(`/accounts/health?${query({ profileId })}`),
    zernioRead(`/accounts/follower-stats?${query({ profileId, fromDate: period.from, toDate: period.to, granularity: 'daily' })}`),
    zernioRead(`/analytics?${query({ profileId, fromDate: period.from, toDate: period.to, limit: '100', source: 'all' })}`),
    zernioRead(`/analytics/daily-metrics?${query({ profileId, fromDate: period.from, toDate: period.to, source: 'all', attribution: 'received' })}`),
  ]);
  const [accountsResult, healthResult, followerResult, postAnalyticsResult, dailyResult] = root;
  const allowed = new Set((platforms || []).map((value) => String(value).toLowerCase()).filter(Boolean));
  const readableSocial = new Set(['instagram', 'linkedin', 'twitter']);
  const rawAccounts = (accountsResult.payload?.accounts || []).filter((account) => {
    const platform = platformName(account);
    return readableSocial.has(platform) && (!allowed.size || allowed.has(platform));
  });
  const allHealth = healthResult.payload?.accounts || healthResult.payload?.data?.accounts || [];
  const healthById = new Map(allHealth.map((item) => [String(item.accountId || item.id || item._id || ''), item]));
  const reports = await Promise.all(rawAccounts.map(async (account) => {
    const id = accountId(account);
    const platform = platformName(account);
    const base = { profileId, platform };
    const reads = await Promise.all([
      zernioRead(`/accounts/${encodeURIComponent(id)}/health`),
      zernioRead(`/accounts/${encodeURIComponent(id)}/posts`),
      zernioRead(`/analytics/daily-metrics?${query({ ...base, fromDate: period.from, toDate: period.to, source: 'all', attribution: 'received' })}`),
      zernioRead(`/analytics/best-time?${query(base)}`),
      zernioRead(`/analytics/content-decay?${query(base)}`),
      zernioRead(`/analytics/posting-frequency?${query(base)}`),
      platform === 'instagram'
        ? zernioRead(`/analytics/instagram/account-insights?${query({ accountId: id, since: period.from, until: period.to, metricType: 'total_value' })}`)
        : Promise.resolve(null),
      platform === 'instagram'
        ? zernioRead(`/analytics/instagram/follower-history?${query({ accountId: id, since: period.from, until: period.to, metricType: 'time_series' })}`)
        : Promise.resolve(null),
      platform === 'linkedin'
        ? zernioRead(`/analytics/linkedin/org-aggregate-analytics?${query({ accountId: id, since: period.from, until: period.to, metricType: 'total_value' })}`)
        : Promise.resolve(null),
    ]);
    const [health, posts, daily, bestTime, decay, frequency, instagramInsights, instagramFollowers, linkedinOrganization] = reads;
    const limitations = reads.filter((result) => result && !result.available).map((result) => result.message);
    return {
      account: { ...account, id },
      health: health?.available ? health.payload : (healthById.get(id) || health),
      posts: posts?.available ? posts.payload : posts,
      analytics: {
        daily: daily?.available ? daily.payload : daily,
        best_time: bestTime?.available ? bestTime.payload : bestTime,
        content_decay: decay?.available ? decay.payload : decay,
        posting_frequency: frequency?.available ? frequency.payload : frequency,
        ...(instagramInsights ? { instagram_account_insights: instagramInsights.available ? instagramInsights.payload : instagramInsights } : {}),
        ...(instagramFollowers ? { instagram_follower_history: instagramFollowers.available ? instagramFollowers.payload : instagramFollowers } : {}),
        ...(linkedinOrganization ? { linkedin_organization: linkedinOrganization.available ? linkedinOrganization.payload : linkedinOrganization } : {}),
      },
      limitations,
    };
  }));
  const posts = postAnalyticsResult.payload?.posts || postAnalyticsResult.payload?.data?.posts || [];
  const followerRows = followerResult.payload?.accounts || followerResult.payload?.data?.accounts || [];
  const limitations = root.filter((result) => !result.available).map((result) => result.message).concat(reports.flatMap((report) => report.limitations));
  return {
    status: limitations.length ? 'PARTIAL' : 'AVAILABLE', profile_id: profileId, period,
    accounts: reports.map((report) => ({
      platform: report.platform || platformName(report.account),
      account_id: report.account.id,
      username: report.account.username || report.health?.username || null,
      display_name: report.account.displayName || report.health?.displayName || null,
      health: report.health,
    })),
    followers: followerRows, posts, overview: postAnalyticsResult.payload?.overview || null,
    daily_metrics: dailyResult.available ? dailyResult.payload : dailyResult,
    platform_reports: Object.fromEntries(reports.map((report) => [platformName(report.account), report])),
    limitations,
  };
}

async function persistPlatformArtifacts(prisma, { orgId, userId, baselineId, transfer }) {
  const artifacts = [];
  for (const [platform, report] of Object.entries(transfer.platform_reports || {})) {
    const payload = { kind: 'growth_baseline_platform_transfer', baseline_id: baselineId, as_of: new Date().toISOString(), period: transfer.period, ...report };
    const checksum = baselineChecksum({ orgId, baselineId, platform, payload });
    const artifact = await prisma.sourceArtifact.create({ data: {
      userId, orgId, artifactType: 'api_response', sourcePlatform: `growth_${platform}`, sourceId: `${baselineId}:${platform}`,
      contentType: 'application/json', sizeBytes: Buffer.byteLength(JSON.stringify(payload)), checksum,
      storageLocation: `inline:growth_baseline:${baselineId}:${platform}`, payload,
      metadata: { baseline_id: baselineId, platform, profile_id: transfer.profile_id, full_transfer: true },
    } });
    artifacts.push({ id: artifact.id, platform, source_platform: `growth_${platform}` });
  }
  return artifacts;
}

async function outreachSummary(prisma, orgId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE oa.sent_at IS NOT NULL)::int AS sent,
       COUNT(*) FILTER (WHERE oa.outcome = 'replied')::int AS replies,
       COUNT(*) FILTER (WHERE oa.outcome IN ('booked', 'completed'))::int AS meetings
       FROM hivemind.outreach_targets t JOIN hivemind.outreach_campaigns c ON c.id=t.campaign_id
       LEFT JOIN hivemind.outbound_actions oa ON oa.org_id=c.org_id AND ((c.channel='email' AND oa.channel='email' AND lower(oa.recipient)=lower(t.email)) OR (c.channel='call' AND oa.channel='call' AND oa.recipient=regexp_replace(t.phone, '[^0-9+]', '', 'g')))
       WHERE c.org_id=$1::uuid`, orgId,
  ).catch(() => []);
  const row = rows[0];
  return row ? { available: true, total: Number(row.total || 0), sent: Number(row.sent || 0), replies: Number(row.replies || 0), meetings: Number(row.meetings || 0) } : { available: false, limitation: 'No outreach ledger is available.' };
}

function baselineChecksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function listGrowthBaselines({ prisma, orgId, limit = 12 }) {
  return prisma.sourceArtifact.findMany({
    where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' },
    select: { id: true, createdAt: true, payload: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: Math.min(50, Math.max(1, Number(limit) || 12)),
  }).catch(() => []);
}

/**
 * A short, source-backed company position snapshot. It deliberately does not
 * use an LLM: downstream Rooms can reason from this object, but cannot turn
 * absent social analytics into fabricated growth metrics.
 */
export async function runGrowthBaseline({ prisma, orgId, userId, websiteUrl, socialUrls = [], platforms = [], metrics = [], days = null, mode = 'refresh', includeWebsite = true, persist = true, scheduleRuntimeWake = true }) {
  const profile = await getSharedProfileStore(prisma).getProfile(userId, orgId);
  const facts = factMap(profile);
  const website = text(websiteUrl || facts.get('company:website'), 1000);
  if (!website || !/^https?:\/\//i.test(website)) {
    throw Object.assign(new Error('A company website is required to establish a growth baseline'), {
      status: 400, code: 'growth_baseline_website_required',
    });
  }

  const requestedProfiles = knownSocialUrls(facts, socialUrls);
  const companyName = facts.get('company') || new URL(website).hostname;
  const platformScope = (platforms || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const runWebsite = Boolean(includeWebsite) && !platformScope.length;
  const [websiteResearch, publicProfiles, connection, campaignCounts, social, market, outreach] = await Promise.all([
    runWebsite ? researchCompanyWebsite(website, { maxPages: 5, includeCrawl: true }) : Promise.resolve({ provider: 'not_requested', pages: [], mapped: 0, error: null }),
    runWebsite ? scrapePublicPages(requestedProfiles, { maxPages: 5 }) : Promise.resolve([]),
    cachedZernioState(prisma, orgId),
    // Campaign tables are additive and the generated Prisma client can lag a
    // deployed migration, so avoid requiring prisma.campaign here.
    prisma.$queryRawUnsafe(
      'SELECT status, COUNT(*)::int AS count FROM hivemind.campaigns WHERE org_id = $1::uuid GROUP BY status',
      orgId,
    ).catch(() => []),
    mode === 'full_all'
      ? detailedZernioTransfer(prisma, orgId, { platforms: platformScope, days })
      : zernioSnapshot(prisma, orgId, { platforms: platformScope, days, metrics: metrics.length ? metrics : ['profile', 'followers', 'posts'] }),
    runWebsite ? searchCompanyMarket(`${companyName} ${facts.get('industry') || ''} competitors market`, { limit: 6, location: facts.get('company:location') || '' }) : Promise.resolve([]),
    outreachSummary(prisma, orgId),
  ]);

  const discoveredProfiles = verifiedSocialProfiles(websiteResearch.pages || []).map((item) => item.url);
  const observedProfiles = publicProfileSummary(publicProfiles);
  const readyChannels = channelCoverage(connection);
  const fullTransfer = mode === 'full_all';
  const metricsAvailable = fullTransfer
    ? social.accounts.some((account) => Boolean(account.health?.canFetchAnalytics || account.health?.permissions?.canFetchAnalytics))
    : social.accounts.some((account) => account.can_fetch_analytics);
  const campaignSummary = Object.fromEntries(campaignCounts.map((row) => [row.status, Number(row.count || 0)]));
  const dataGaps = [
    ...(metricsAvailable ? [] : ['Follower, impression, engagement, click, and profile-visit metrics are not available for the selected connected accounts.']),
    ...(publicProfiles.filter((item) => item.status !== 'observed').map((item) => `Public profile could not be observed: ${item.url}`)),
    ...(social.limitations || []),
  ];

  const result = {
    kind: 'growth_baseline',
    status: 'COMPLETE',
    as_of: new Date().toISOString(),
    scope: platformScope.length ? { type: 'platforms', platforms: platformScope, mode } : { type: 'company', mode },
    company: {
      name: companyName,
      website,
      location: facts.get('company:location') || null,
      positioning: facts.get('company:positioning') || null,
      icp: facts.get('company:icp') || null,
    },
    website: {
      provider: websiteResearch.provider,
      pages_observed: (websiteResearch.pages || []).map((page) => ({ url: page.url, title: page.title || null, description: page.description || null })),
      mapped_pages: websiteResearch.mapped || 0,
      limitation: websiteResearch.error || null,
    },
    social_presence: {
      official_profiles: [...new Set([...requestedProfiles, ...discoveredProfiles])],
      public_observations: observedProfiles,
      metrics: metricsAvailable ? 'available_from_connected_zernio_account' : 'not_connected',
      accounts: social.accounts,
      followers: social.followers,
      recent_posts: social.posts,
      totals: fullTransfer ? numericTotals(social.posts || []) : social.totals,
      analytics_window: social.period,
      ...(social.requested_metrics ? { requested_metrics: social.requested_metrics } : {}),
      ...(fullTransfer ? {
        full_transfer: true,
        overview: social.overview || null,
        daily_metrics: social.daily_metrics || null,
        platform_reports: social.platform_reports || {},
      } : {}),
      note: 'Zernio is the performance source. Public page reading establishes observable content and identity only.',
    },
    execution: {
      zernio_profile_status: connection.status,
      channels: readyChannels,
      campaigns_by_status: campaignSummary,
      outreach,
    },
    market_signals: market,
    data_gaps: dataGaps,
    sources: [
      { type: 'company_profile', status: 'available', count: profile.length },
      { type: 'firecrawl_website', status: websiteResearch.provider === 'firecrawl' ? 'available' : 'limited', count: (websiteResearch.pages || []).length },
      { type: 'firecrawl_public_social', status: observedProfiles.length ? 'available' : 'not_requested', count: observedProfiles.length },
      { type: 'zernio', status: social.status, analytics_available: metricsAvailable },
    ],
  };
  if (!persist) return result;
  const checksum = baselineChecksum({ orgId, userId, snapshot: result });
  const artifact = await prisma.sourceArtifact.create({ data: {
    userId, orgId, artifactType: 'api_response', sourcePlatform: 'growth_baseline', sourceId: result.as_of,
    contentType: 'application/json', sizeBytes: Buffer.byteLength(JSON.stringify(result)), checksum,
    storageLocation: `inline:growth_baseline:${result.as_of}`, payload: result,
    metadata: { scope: result.scope, website: result.company.website, providers: result.sources.map((source) => source.type), full_transfer: fullTransfer },
  } });
  const platformArtifacts = fullTransfer
    ? await persistPlatformArtifacts(prisma, { orgId, userId, baselineId: artifact.id, transfer: social })
    : [];
  const response = { ...result, resource_id: artifact.id, platform_resources: platformArtifacts };
  if (fullTransfer) {
    await prisma.sourceArtifact.update({ where: { id: artifact.id }, data: {
      payload: response,
      metadata: { scope: result.scope, website: result.company.website, providers: result.sources.map((source) => source.type), full_transfer: true, platform_resource_count: platformArtifacts.length },
    } });
  }
  const runtime = await prisma.hqRuntime.findUnique({ where: { orgId } }).catch(() => null);
  if (scheduleRuntimeWake && runtime && !['INACTIVE', 'PAUSED'].includes(runtime.state)) {
    await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId,
      idempotencyKey: `baseline-updated:${artifact.id}`,
      triggerType: 'baseline_updated', dueAt: new Date(),
      payload: { baseline_id: artifact.id, mode },
    }).catch(() => {});
  }
  return response;
}
