import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getSharedProfileStore } from '../memory/profile-store.js';
import { researchCompanyWebsite, scrapePublicPages, searchCompanyMarket, verifiedSocialProfiles } from '../onboarding/company-research.js';
import { requestZernio } from '../campaigns/zernio-execution.js';
import { scheduleHqWake } from '../hq-runtime/repository.js';

const recognitionSourceKeys = JSON.parse(readFileSync(
  new URL('./fixtures/baseline-recognition.v1.json', import.meta.url), 'utf8',
)).sources;

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

async function persistBaselineObservation(prisma, { orgId, userId, baselineRunId, sourceKey, status, facts, limitations = [] }) {
  const payload = {
    kind: 'growth_baseline_observation',
    baseline_run_id: baselineRunId,
    source_key: sourceKey,
    status,
    facts,
    limitations,
    observed_at: new Date().toISOString(),
  };
  const checksum = baselineChecksum({ orgId, userId, baselineRunId, sourceKey, status, facts, limitations });
  try {
    return await prisma.sourceArtifact.create({ data: {
      userId,
      orgId,
      artifactType: 'api_response',
      sourcePlatform: 'growth_baseline_observation',
      sourceId: `${baselineRunId}:${sourceKey}`,
      contentType: 'application/json',
      sizeBytes: Buffer.byteLength(JSON.stringify(payload)),
      checksum,
      storageLocation: `inline:growth_baseline_observation:${baselineRunId}:${sourceKey}`,
      payload,
      metadata: { baseline_run_id: baselineRunId, source_key: sourceKey, status },
    } });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    return prisma.sourceArtifact.findFirst({
      where: { userId, orgId, sourcePlatform: 'growth_baseline_observation', checksum },
      orderBy: { createdAt: 'desc' },
    });
  }
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
export async function runGrowthBaseline({ prisma, orgId, userId, websiteUrl, socialUrls = [], platforms = [], metrics = [], days = null, mode = 'refresh', includeWebsite = true, persist = true, scheduleRuntimeWake = true, baselineRunId = crypto.randomUUID(), onObservation = null }) {
  const profile = await getSharedProfileStore(prisma).getProfile(userId, orgId);
  const facts = factMap(profile);
  const website = text(websiteUrl || facts.get('company:website'), 1000);
  const hasWebsite = /^https?:\/\//i.test(website);
  const companyName = facts.get('company') || (hasWebsite ? new URL(website).hostname : '');
  if (!companyName) {
    throw Object.assign(new Error('A consistent company identity is required to establish a growth baseline'), {
      status: 400, code: 'growth_baseline_identity_required',
    });
  }

  const observationRefs = [];
  const observe = async (sourceKey, promise, project) => {
    const value = await promise;
    const observation = project(value);
    if (persist) {
      const artifact = await persistBaselineObservation(prisma, {
        orgId, userId, baselineRunId, sourceKey, ...observation,
      });
      if (artifact) {
        observationRefs.push(artifact.id);
        if (typeof onObservation === 'function') await onObservation({
          ...observation,
          source_key: sourceKey,
          artifact_id: artifact.id,
          baseline_run_id: baselineRunId,
        });
      }
    }
    return value;
  };

  await observe(recognitionSourceKeys.company_identity, Promise.resolve({ profile }), () => ({
    status: 'observed',
    facts: {
      name: companyName,
      website: hasWebsite ? website : null,
      location: facts.get('company:location') || null,
      profile_fact_count: profile.length,
    },
  }));

  const requestedProfiles = knownSocialUrls(facts, socialUrls);
  const platformScope = (platforms || []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const runWebsite = hasWebsite && Boolean(includeWebsite) && !platformScope.length;
  const websitePromise = runWebsite
    ? researchCompanyWebsite(website, { maxPages: 5, includeCrawl: true }).catch((error) => ({
      provider: 'unavailable', pages: [], mapped: null, error: String(error?.message || error),
    }))
    : Promise.resolve({ provider: 'not_requested', pages: [], mapped: null, error: hasWebsite ? null : 'No company website was supplied.' });
  const publicProfilesPromise = runWebsite
    ? scrapePublicPages(requestedProfiles, { maxPages: 5 }).catch((error) => [{
      url: null, status: 'limited', provider: 'public_profile_read', reason: String(error?.message || error),
    }])
    : Promise.resolve([]);
  const connectionPromise = cachedZernioState(prisma, orgId);
  const campaignPromise = prisma.$queryRawUnsafe(
      'SELECT status, COUNT(*)::int AS count FROM hivemind.campaigns WHERE org_id = $1::uuid GROUP BY status',
      orgId,
    ).then((rows) => ({ available: true, rows })).catch((error) => ({ available: false, rows: [], limitation: error.message }));
  const socialPromise = mode === 'full_all'
      ? detailedZernioTransfer(prisma, orgId, { platforms: platformScope, days })
      : zernioSnapshot(prisma, orgId, { platforms: platformScope, days, metrics: metrics.length ? metrics : ['profile', 'followers', 'posts'] });
  const safeSocialPromise = socialPromise.catch((error) => ({
    status: 'PARTIAL', accounts: [], followers: [], posts: [], totals: null,
    limitations: [String(error?.message || error)], platform_reports: {},
  }));
  const marketPromise = runWebsite
    ? searchCompanyMarket(`${companyName} ${facts.get('industry') || ''} competitors market`, { limit: 6, location: facts.get('company:location') || '' }).catch(() => [])
    : Promise.resolve([]);
  const outreachPromise = outreachSummary(prisma, orgId);
  const [websiteBundle, channelBundle, campaignResult, outreach, market] = await Promise.all([
    observe(recognitionSourceKeys.website, Promise.all([websitePromise, publicProfilesPromise]), ([research, pages]) => {
      const status = !hasWebsite ? 'not_observed' : research.error || research.provider === 'fallback' ? 'limited' : 'observed';
      return {
        status,
        facts: {
          website: hasWebsite ? website : null,
          page_count: status === 'observed' && Number.isFinite(Number(research.mapped)) ? Number(research.mapped) : null,
          observed_urls: (research.pages || []).map((page) => page.url),
          public_profile_count: status === 'observed' ? pages.length : null,
        },
        limitations: [research.error].filter(Boolean),
      };
    }),
    observe(recognitionSourceKeys.connected_channels, Promise.all([connectionPromise, safeSocialPromise]), ([connectionState, socialState]) => {
      const accountMetricsAvailable = (socialState.accounts || []).some((account) => Boolean(
        account.can_fetch_analytics || account.health?.canFetchAnalytics || account.health?.permissions?.canFetchAnalytics,
      ));
      return {
        status: connectionState.status === 'UNPROVISIONED' ? 'not_observed'
          : socialState.status === 'PARTIAL' ? 'limited' : 'observed',
        facts: {
          provider_status: connectionState.status,
          channels: channelCoverage(connectionState),
          accounts: socialState.accounts || [],
          followers: accountMetricsAvailable ? (socialState.followers || []) : null,
          totals: accountMetricsAvailable ? (socialState.totals || numericTotals(socialState.posts || [])) : null,
        },
        limitations: socialState.limitations || (socialState.limitation ? [socialState.limitation] : []),
      };
    }),
    observe(recognitionSourceKeys.campaign_activity, campaignPromise, (result) => ({
      status: result.available ? 'observed' : 'limited',
      facts: { campaigns_by_status: result.available ? Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count || 0)])) : null },
      limitations: [result.limitation].filter(Boolean),
    })),
    observe(recognitionSourceKeys.lead_customer_activity, outreachPromise, (result) => ({
      status: result.available ? 'observed' : 'limited',
      facts: result.available ? { total: result.total, sent: result.sent, replies: result.replies, meetings: result.meetings } : null,
      limitations: [result.limitation].filter(Boolean),
    })),
    marketPromise,
  ]);
  const [websiteResearch, publicProfiles] = websiteBundle;
  const [connection, social] = channelBundle;
  const campaignCounts = campaignResult.rows;

  const discoveredProfiles = verifiedSocialProfiles(websiteResearch.pages || []).map((item) => item.url);
  const observedProfiles = publicProfileSummary(publicProfiles);
  const readyChannels = channelCoverage(connection);
  const fullTransfer = mode === 'full_all';
  const metricsAvailable = fullTransfer
    ? social.accounts.some((account) => Boolean(account.health?.canFetchAnalytics || account.health?.permissions?.canFetchAnalytics))
    : social.accounts.some((account) => account.can_fetch_analytics);
  const campaignSummary = Object.fromEntries(campaignCounts.map((row) => [row.status, Number(row.count || 0)]));
  const dataGaps = [
    ...(!hasWebsite ? ['A company website was not observed.'] : []),
    ...(websiteResearch.error ? [`Website evidence is limited: ${websiteResearch.error}`] : []),
    ...(metricsAvailable ? [] : ['Follower, impression, engagement, click, and profile-visit metrics are not available for the selected connected accounts.']),
    ...(publicProfiles.filter((item) => item.status !== 'observed').map((item) => `Public profile could not be observed: ${item.url || item.reason || 'source unavailable'}`)),
    ...(social.limitations || []),
  ];

  const result = {
    kind: 'growth_baseline',
    status: 'COMPLETE',
    as_of: new Date().toISOString(),
    scope: platformScope.length ? { type: 'platforms', platforms: platformScope, mode } : { type: 'company', mode },
    company: {
      name: companyName,
      website: hasWebsite ? website : null,
      location: facts.get('company:location') || null,
      positioning: facts.get('company:positioning') || null,
      icp: facts.get('company:icp') || null,
    },
    website: {
      provider: websiteResearch.provider,
      pages_observed: (websiteResearch.pages || []).map((page) => ({ url: page.url, title: page.title || null, description: page.description || null })),
      mapped_pages: Number.isFinite(Number(websiteResearch.mapped)) ? Number(websiteResearch.mapped) : null,
      limitation: websiteResearch.error || null,
    },
    social_presence: {
      official_profiles: [...new Set([...requestedProfiles, ...discoveredProfiles])],
      public_observations: observedProfiles,
      metrics: metricsAvailable ? 'available_from_connected_zernio_account' : 'not_connected',
      accounts: social.accounts,
      followers: social.followers,
      recent_posts: social.posts,
      totals: metricsAvailable ? (fullTransfer ? numericTotals(social.posts || []) : social.totals) : null,
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
    observation_refs: observationRefs,
  };
  if (dataGaps.length) await observe(recognitionSourceKeys.explicit_limitations, Promise.resolve(dataGaps), (limitations) => ({
    status: 'limited', facts: { count: limitations.length }, limitations,
  }));
  result.observation_refs = [...observationRefs];
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
