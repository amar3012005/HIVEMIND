/**
 * Plan Enforcer — checks and enforces plan limits at the API level.
 *
 * Wraps UsageTracker + PlanStore to provide a single checkLimit() call
 * that endpoints use before processing.  Uses in-memory counters seeded
 * from the DB for fast hot-path checks and falls back to the existing
 * UsageTracker for durable recording.
 *
 * Field names match plans.js:
 *   tokensPerMonth, searchQueriesPerMonth, maxConnectors,
 *   maxUsers, knowledgeBasePagesPerMonth
 */

import crypto from 'node:crypto';
import { currentApiKey, currentUser } from '../db/prisma.js';
import { getOrgCounts } from '../memory/org-counts.js';
import { countQuotaHyperRooms } from '../employees/domain-rooms.js';

/**
 * Plan-tier ladder for upgrade suggestions.
 * free → pro → scale → enterprise → null (top).
 */
const PLAN_LADDER = { free: 'pro', pro: 'scale', scale: 'enterprise', enterprise: null };

const DAILY_LIMITS = {
  tokens: ['llmTokensPerDay', 'tokens', 'tokens'],
  searches: ['searchQueriesPerDay', 'searches', 'queries'],
  graphQueries: ['searchQueriesPerDay', 'graphQueries', 'queries'],
  kbPages: ['knowledgeBasePagesPerDay', 'kbPages', 'pages'],
  deepResearch: ['deepResearchPerDay', 'deepResearch', 'jobs'],
  webIntel: ['webIntelPerDay', 'webIntel', 'jobs'],
  taraSeconds: ['taraTalkSecondsPerDay', 'taraSeconds', 'seconds'],
  hyperAgentRuns: ['hyperAgentRunsPerDay', 'hyperAgentRuns', 'runs'],
};

/**
 * Build the canonical plan-limit-exceeded response body (the LIMIT-EXCEEDED
 * RESPONSE CONTRACT the frontend keys off). Pure function — no I/O.
 *
 * @param {{allowed:boolean, reason?:string, limit?:number, current?:number, plan?:string}} check
 *        The object returned by PlanEnforcer.checkLimit().
 * @param {'kbPages'|'memories'|'webIntel'|'deepResearch'|'searches'|'tokens'|'connectors'|'hyperRooms'|'users'} resource
 * @returns {object} Contract body to send with HTTP 402.
 */
export function planLimitBody(check, resource) {
  const c = check || {};
  if (c.status === 503) {
    return {
      error: 'usage_verification_unavailable',
      code: 'usage_verification_unavailable',
      message: c.reason || 'Usage verification is temporarily unavailable',
      resource,
      retryable: true,
    };
  }
  const plan = c.plan || 'free';
  const suggested = Object.prototype.hasOwnProperty.call(PLAN_LADDER, plan)
    ? PLAN_LADDER[plan]
    : 'pro';
  const credits = resource === 'credits';
  return {
    error: credits ? 'credits_exhausted' : 'plan_limit_exceeded',
    code: credits ? 'credits_exhausted' : 'plan_limit_exceeded',
    message: c.reason || 'Plan limit exceeded',
    resource,
    plan,
    limit: c.limit ?? null,
    current: c.current ?? null,
    remaining: c.remaining ?? null,
    suggested_plan: suggested,      // next tier up, or null at enterprise
    upgrade_url: '/hivemind/app/billing',
  };
}

function buildReminder(resource, used, limit, period) {
  if (!(limit > 0)) return null;
  const ratio = used / limit;
  if (ratio < 0.8) return null;
  const reached = ratio >= 1;
  return {
    resource,
    period,
    level: reached ? 'limit' : 'warning',
    used,
    limit,
    percent: Math.min(100, Math.round(ratio * 100)),
    message: reached
      ? `${resource} ${period} limit reached. Upgrade or wait for the limit to reset.`
      : `${resource} is at ${Math.round(ratio * 100)}% of the ${period} limit.`,
  };
}

export class PlanEnforcer {
  /**
   * @param {object} prisma       Prisma client
   * @param {object} planStore    PlanStore instance (getOrgPlan)
   * @param {object} usageTracker UsageTracker instance (getUsage, checkLimits, record*)
   */
  constructor(prisma, planStore, usageTracker) {
    this.prisma = prisma;
    this.planStore = planStore;
    this.usageTracker = usageTracker;

    // In-memory counters: orgId -> billable usage counters for the current month.
    this._counters = new Map();
    this.usageService = null;
    this.creditService = null;
  }

  setUsageService(service) { this.usageService = service; }
  setCreditService(service) { this.creditService = service; }

  // ── helpers ──────────────────────────────────────────────────────────

  _currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Get or create monthly counters for an org.
   * On first access each month the counters are seeded from the DB via
   * UsageTracker.getUsage() so we stay in sync after restarts.
   */
  async _getCounters(orgId) {
    const month = this._currentMonth();
    let c = this._counters.get(orgId);
    if (c && c.month === month) return c;

    // Seed from DB
    let dbUsage = {
      tokensProcessed: 0,
      searchQueries: 0,
      knowledgeBaseUploads: 0,
      knowledgeBasePages: 0,
      memoriesIngested: 0,
      deepResearchJobs: 0,
      webIntelJobs: 0,
      graphQueries: 0,
      taraUsage: 0,
      taraSeconds: 0,
      hyperAgentRuns: 0,
      connectorCount: 0,
    };
    if (this.usageTracker) {
      try { dbUsage = await this.usageTracker.getUsage(orgId); } catch {}
    }

    c = {
      tokens: dbUsage.tokensProcessed || 0,
      searches: dbUsage.searchQueries || 0,
      kbPages: dbUsage.knowledgeBasePages || 0,
      memories: dbUsage.memoriesIngested || 0,
      deepResearch: dbUsage.deepResearchJobs || 0,
      webIntel: dbUsage.webIntelJobs || 0,
      graphQueries: dbUsage.graphQueries || 0,
      tara: dbUsage.taraUsage || 0,
      taraSeconds: dbUsage.taraSeconds || 0,
      hyperAgentRuns: dbUsage.hyperAgentRuns || 0,
      connectors: dbUsage.connectorCount || 0,
      month,
    };
    this._counters.set(orgId, c);
    return c;
  }

  // ── public API ───────────────────────────────────────────────────────

  /**
   * Check whether an operation is allowed under the org's plan limits.
   *
   * @param {string} orgId
   * @param {'tokens'|'searches'|'connectors'|'uploads'|'kbPages'|'memories'|'deepResearch'|'webIntel'|'graphQueries'|'tara'} type
   * @param {number} amount  How many units to consume (default 1).
   * @returns {{ allowed: boolean, reason?: string, limit?: number, current?: number, plan?: string }}
   */
  async checkLimit(orgId, type, amount = 1) {
    if (!orgId) return { allowed: true };

    const planDef = await this.planStore.getOrgPlan(orgId);
    if (!planDef) return { allowed: true };

    const limits = planDef.limits || {};
    const counters = await this._getCounters(orgId);

    const dailyRule = DAILY_LIMITS[type];
    if (dailyRule) {
      const [limitKey, metric, unit] = dailyRule;
      const dailyLimit = limits[limitKey];
      if (dailyLimit > 0) {
        const snapshot = await this.usageTracker?.getDailySnapshot?.(orgId);
        if (snapshot == null) {
          return {
            allowed: false,
            reason: 'Usage verification is temporarily unavailable. Retry shortly.',
            plan: planDef.id,
            status: 503,
          };
        }
        const today = type === 'searches' || type === 'graphQueries'
          ? Number(snapshot.searches || 0) + Number(snapshot.graphQueries || 0)
          : Number(snapshot[metric] || 0);
        if (today + amount > dailyLimit) {
          return {
            allowed: false,
            reason: `Daily ${unit} limit exceeded (${planDef.name} plan: ${dailyLimit.toLocaleString()} ${unit}/day)`,
            limit: dailyLimit,
            current: today,
            plan: planDef.id,
            period: 'day',
          };
        }
      }
    }

    if (type === 'tokens') {
      const limit = limits.llmTokensPerMonth;
      if (!limit || limit === -1) return { allowed: true }; // unlimited
      if (counters.tokens + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly token limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} tokens/month)`,
          limit,
          current: counters.tokens,
          plan: planDef.id,
        };
      }
    }

    if (type === 'searches') {
      const limit = limits.searchQueriesPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      const used = counters.searches + counters.graphQueries;
      if (used + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly search limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} searches/month)`,
          limit,
          current: used,
          plan: planDef.id,
        };
      }
    }

    if (type === 'kbPages') {
      // Per-org page-budget guard. amount = pages in the doc about to ingest.
      const limit = limits.knowledgeBasePagesPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      const used = counters.kbPages || 0;
      if (used + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly KB pages limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} pages/month)`,
          limit,
          current: used,
          plan: planDef.id,
        };
      }
    }

    if (type === 'memories') {
      const limit = limits.maxMemories;
      if (!limit || limit === -1) return { allowed: true };
      const liveMemories = Number((await getOrgCounts(this.prisma, orgId)).memories) || 0;
      if (liveMemories + amount > limit) {
        return {
          allowed: false,
          reason: `Memory limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} memories)`,
          limit,
          current: liveMemories,
          plan: planDef.id,
        };
      }
    }

    // Meeting-notes minutes. DERIVED from meetings.duration_sec for the current
    // calendar month rather than kept in a counter column: the meetings rows are
    // the truth, so a derived number cannot drift from them, needs no schema
    // change, and self-heals if a transcription is deleted. Same reasoning as
    // 'memories', which reads its live count instead of a counter.
    if (type === 'meetingMinutes') {
      const limit = limits.meetingMinutesPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      let usedSeconds = 0;
      try {
        const rows = await this.prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM("duration_sec"), 0) AS secs
             FROM hivemind.meetings
            WHERE "org_id" = $1::uuid
              AND "deleted_at" IS NULL
              AND "created_at" >= date_trunc('month', CURRENT_DATE)`,
          orgId,
        );
        usedSeconds = Math.max(0, Number(rows?.[0]?.secs || 0));
      } catch (err) {
        console.warn('[plan-enforcer] meeting minutes read failed:', err.message);
        return { allowed: false, reason: 'Meeting usage verification is temporarily unavailable.', plan: planDef.id, status: 503 };
      }
      if (usedSeconds >= limit * 60 || usedSeconds + Math.max(0, Number(amount) || 0) * 60 > limit * 60) {
        return {
          allowed: false,
          reason: `Meeting notes limit reached (${planDef.name} plan: ${limit} minutes/month)`,
          limit,
          current: Math.ceil(usedSeconds / 60),
          currentSeconds: usedSeconds,
          plan: planDef.id,
          period: 'month',
        };
      }
    }

    if (type === 'deepResearch') {
      const limit = limits.deepResearchPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      if (counters.deepResearch + amount > limit) {
        return {
          allowed: false,
          reason: `Deep research limit exceeded (${planDef.name} plan: ${limit} jobs/month)`,
          limit,
          current: counters.deepResearch,
          plan: planDef.id,
        };
      }
    }

    if (type === 'webIntel') return { allowed: true };

    if (type === 'graphQueries') {
      const limit = limits.searchQueriesPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      const used = counters.searches + counters.graphQueries;
      if (used + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly query limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} queries/month)`,
          limit,
          current: used,
          plan: planDef.id,
        };
      }
    }

    if (type === 'taraSeconds' || type === 'hyperAgentRuns') {
      const limitKey = type === 'taraSeconds' ? 'taraTalkSecondsPerMonth' : 'hyperAgentRunsPerMonth';
      const unit = type === 'taraSeconds' ? 'TARA talk seconds' : 'HyperAgents runs';
      const limit = limits[limitKey];
      if (!limit || limit === -1) return { allowed: true };
      const used = counters[type] || 0;
      if (used + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly ${unit} limit exceeded (${planDef.name} plan: ${limit.toLocaleString()})`,
          limit,
          current: used,
          plan: planDef.id,
          period: 'month',
        };
      }
    }

    if (type === 'connectors') {
      const limit = limits.maxConnectors;
      if (!limit || limit === -1) return { allowed: true };
      try {
        // PlatformIntegration is keyed by userId; for org-level counting
        // we count all active integrations belonging to users in the org.
        const count = await this.prisma.platformIntegration.count({
          where: {
            user: { organizations: { some: { orgId, isActive: true } } },
            isActive: true,
          },
        });
        if (count >= limit) {
          return {
            allowed: false,
            reason: `Connector limit reached (${planDef.name} plan: ${limit} connectors)`,
            limit,
            current: count,
            plan: planDef.id,
          };
        }
      } catch {
        return { allowed: false, reason: 'Connector capacity verification is temporarily unavailable.', plan: planDef.id, status: 503 };
      }
    }

    if (type === 'hyperRooms') {
      const limit = limits.maxHyperRooms;
      if (!limit || limit === -1) return { allowed: true };
      try {
        const count = await countQuotaHyperRooms(this.prisma, orgId);
        if (count + amount > limit) {
          return {
            allowed: false,
            reason: `HyperAgents room limit reached (${planDef.name} plan: ${limit} rooms). Archive a room or upgrade.`,
            limit,
            current: count,
            plan: planDef.id,
          };
        }
      } catch {
        return { allowed: false, reason: 'Room capacity verification is temporarily unavailable.', plan: planDef.id, status: 503 };
      }
    }

    if (type === 'users') {
      const limit = limits.maxUsers;
      if (!limit || limit === -1) return { allowed: true };
      try {
        const count = await this.prisma.userOrganization.count({ where: { orgId, isActive: true } });
        if (count + amount > limit) {
          return {
            allowed: false,
            reason: `Seat limit reached (${planDef.name} plan: ${limit} ${limit === 1 ? 'user' : 'users'}). Upgrade to invite more.`,
            limit,
            current: count,
            plan: planDef.id,
          };
        }
      } catch {
        return { allowed: false, reason: 'Seat capacity verification is temporarily unavailable.', plan: planDef.id, status: 503 };
      }
    }

    return { allowed: true };
  }

  /**
   * Record usage after a successful operation.
   * Updates in-memory counters immediately and delegates durable
   * recording to UsageTracker (fire-and-forget).
   */
  recordUsage(orgId, type, amount = 1, opts = {}) {
    if (!orgId || amount <= 0) return;

    // Update in-memory counters (sync — fast path)
    const c = this._counters.get(orgId);
    if (c && c.month === this._currentMonth()) {
      if (type === 'tokens') c.tokens += amount;
      if (type === 'searches') c.searches += amount;
      if (type === 'memories') c.memories += amount;
      if (type === 'deepResearch') c.deepResearch += amount;
      if (type === 'webIntel') c.webIntel += amount;
      if (type === 'graphQueries') c.graphQueries += amount;
      if (type === 'tara') c.tara += amount;
      if (type === 'taraSeconds') c.taraSeconds = (c.taraSeconds || 0) + amount;
      if (type === 'hyperAgentRuns') c.hyperAgentRuns = (c.hyperAgentRuns || 0) + amount;
      if (type === 'connectors') c.connectors += amount;
      if (type === 'kbPages') c.kbPages = (c.kbPages || 0) + amount;
    }

    // New work uses the ledger. The legacy tracker remains the projection
    // backend only for processes that have not yet initialized the service.
    if (this.usageService) {
      const key = opts.idempotencyKey || opts.idempotency_key || crypto.randomUUID();
      this.usageService.record({ orgId, userId: opts.userId || currentUser() || null, apiKeyId: opts.apiKeyId || currentApiKey() || null,
        type, quantity: amount, source: opts.feature || opts.source || 'product', idempotencyKey: key,
        providerReceipt: opts.providerReceipt || null,
        metadata: {
          ...(opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {}),
          surface: opts.surface || null,
          model: opts.model || null,
          feature: opts.feature || null,
          prompt_tokens: Number(opts.promptTokens || opts.prompt_tokens || 0),
          completion_tokens: Number(opts.completionTokens || opts.completion_tokens || 0),
          cached_tokens: Number(opts.cachedTokens || opts.cached_tokens || 0),
          request_count: Number(opts.requestCount || opts.request_count || 1),
        } }).catch(() => {});
      return;
    }

    // Durable recording via UsageTracker (async — fire-and-forget)
    if (this.usageTracker) {
      if (type === 'tokens') {
        this.usageTracker.recordTokens(orgId, amount).catch(() => {});
        // Per-API-key attribution for direct-provider token spend (TARA, /chat) that bypasses the
        // litellm-client gateway. apiKeyId is read from opts or the current request's ALS context, so
        // existing recordUsage(orgId,'tokens',n) call sites attribute to the request key with no change.
        const _key = opts.apiKeyId ?? (() => { try { return currentApiKey(); } catch { return null; } })();
        this.usageTracker.recordKeyUsage?.(orgId, amount, _key, opts.model || null, opts.feature || null, {
          promptTokens: Number(opts.promptTokens || opts.prompt_tokens || 0),
          completionTokens: Number(opts.completionTokens || opts.completion_tokens || 0),
        }).catch(() => {});
      }
      if (type === 'searches') this.usageTracker.recordQuery(orgId).catch(() => {});
      // Upload count is retained as internal anti-abuse telemetry only; it is not a plan limit.
      if (type === 'uploads') this.usageTracker.recordUpload(orgId).catch(() => {});
      if (type === 'kbPages') this.usageTracker.recordKbPages?.(orgId, amount).catch(() => {});
      if (type === 'memories') this.usageTracker.recordMemory(orgId).catch(() => {});
      if (type === 'deepResearch') this.usageTracker.recordDeepResearch(orgId).catch(() => {});
      if (type === 'webIntel') this.usageTracker.recordWebIntel(orgId).catch(() => {});
      if (type === 'graphQueries') this.usageTracker.recordGraphQuery(orgId).catch(() => {});
      if (type === 'tara') this.usageTracker.recordTara(orgId).catch(() => {});
      if (type === 'taraSeconds') this.usageTracker.recordTaraSeconds?.(orgId, amount).catch(() => {});
      if (type === 'hyperAgentRuns') this.usageTracker.recordHyperAgentRun?.(orgId).catch(() => {});
      // Per-day rollup (powers the Usage page daily graphs) — same type vocab.
      if (!['taraSeconds', 'hyperAgentRuns'].includes(type)) {
        this.usageTracker.recordDaily?.(orgId, type, amount).catch(() => {});
      }
    }
  }

  /**
   * Get current usage summary for an org.
   */
  async getUsageSummary(orgId, opts = {}) {
    const planDef = await this.planStore.getOrgPlan(orgId);
    const limits = planDef?.limits || {};
    // Read the DURABLE OrgUsage row (DB) for display — NOT the per-replica
    // in-memory counters. With two cores, the in-memory map only re-seeds on
    // month-rollover, so it drifts and the displayed number depended on which
    // replica answered. The DB row is the single source of truth (60s cache).
    const dbUsage = (this.usageTracker
      ? await this.usageTracker.getUsage(orgId).catch(() => null)
      : null) || {};
    const month = dbUsage.month || this._currentMonth();
    const cumulative = this.usageTracker
      ? await this.usageTracker.getCumulativeUsage(orgId).catch(() => ({}))
      : {};
    const dailyUsage = this.usageTracker
      ? await this.usageTracker.getDailySnapshot(orgId).catch(() => ({}))
      : {};
    const safeDailyUsage = dailyUsage || {};

    // Live entity counts (not monthly counters) — connectors, hyper rooms, seats are point-in-time.
    let connectorsUsed = 0, hyperRoomsUsed = 0, usersUsed = 0;
    try { connectorsUsed = await this.prisma.platformIntegration.count({ where: { user: { organizations: { some: { orgId, isActive: true } } }, isActive: true } }); } catch { /* display zero */ }
    try { hyperRoomsUsed = await countQuotaHyperRooms(this.prisma, orgId); } catch { /* display zero */ }
    try { usersUsed = await this.prisma.userOrganization.count({ where: { orgId, isActive: true } }); } catch { /* display zero */ }

    // memories = TOTAL live memory count for the org (lifetime cap vs maxMemories),
    // NOT the monthly memoriesIngested counter. Prefer a caller-supplied total (avoids a
    // duplicate count when the endpoint already fetched it via getOrgCounts); otherwise
    // query the SAME uniform seam getOrgCounts uses (routes central-vs-agent internally).
    let memoriesUsed = Number(opts.memoriesTotal);
    if (!Number.isFinite(memoriesUsed)) {
      try { memoriesUsed = Number((await getOrgCounts(this.prisma, orgId)).memories) || 0; }
      catch { memoriesUsed = 0; }
    }

    let meetingSecondsUsed = 0;
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM("duration_sec"), 0) AS secs
           FROM hivemind.meetings
          WHERE "org_id" = $1::uuid
            AND "deleted_at" IS NULL
            AND "created_at" >= date_trunc('month', CURRENT_DATE)`,
        orgId,
      );
      meetingSecondsUsed = Math.max(0, Number(rows?.[0]?.secs || 0));
    } catch { /* display zero; admission still performs its own authoritative check */ }

    const credits = this.creditService ? await this.creditService.getSummary(orgId).catch(() => null) : null;
    const summary = {
      plan: planDef?.id || 'free',
      planName: planDef?.name || 'Free',
      credits,
      period: { month, day: new Date().toISOString().slice(0, 10) },
      tokens: { used: Number(dbUsage.tokensProcessed) || 0, limit: limits.llmTokensPerMonth ?? -1 },
      searches: { used: Number(dbUsage.searchQueries) || 0, limit: limits.searchQueriesPerMonth ?? -1 },
      kbPages: { used: Number(dbUsage.knowledgeBasePages) || 0, limit: limits.knowledgeBasePagesPerMonth ?? -1 },
      memories: { used: memoriesUsed, limit: limits.maxMemories ?? -1 },
      deepResearch: { used: Number(dbUsage.deepResearchJobs) || 0, limit: limits.deepResearchPerMonth ?? -1 },
      webIntel: { used: Number(safeDailyUsage.webIntel) || 0, limit: limits.webIntelPerDay ?? -1, isDaily: true },
      graphQueries: { used: Number(dbUsage.graphQueries) || 0, limit: limits.searchQueriesPerMonth ?? -1 },
      tara: { used: Number(dbUsage.taraUsage) || 0, limit: -1 },
      taraSeconds: { used: Number(dbUsage.taraSeconds) || 0, limit: limits.taraTalkSecondsPerMonth ?? -1 },
      hyperAgentRuns: { used: Number(dbUsage.hyperAgentRuns) || 0, limit: limits.hyperAgentRunsPerMonth ?? -1 },
      meetingMinutes: {
        used: Math.ceil(meetingSecondsUsed / 60),
        usedSeconds: meetingSecondsUsed,
        limit: limits.meetingMinutesPerMonth ?? -1,
      },
      connectors: { used: connectorsUsed, limit: limits.maxConnectors ?? -1 },
      hyperRooms: { used: hyperRoomsUsed, limit: limits.maxHyperRooms ?? -1 },
      users: { used: usersUsed, limit: limits.maxUsers ?? -1 },
      daily: {
        tokens: { used: Number(safeDailyUsage.tokens) || 0, limit: limits.llmTokensPerDay ?? -1 },
        searches: {
          used: Number(safeDailyUsage.searches || 0) + Number(safeDailyUsage.graphQueries || 0),
          limit: limits.searchQueriesPerDay ?? -1,
        },
        kbPages: { used: Number(safeDailyUsage.kbPages) || 0, limit: limits.knowledgeBasePagesPerDay ?? -1 },
        deepResearch: { used: Number(safeDailyUsage.deepResearch) || 0, limit: limits.deepResearchPerDay ?? -1 },
        webIntel: { used: Number(safeDailyUsage.webIntel) || 0, limit: limits.webIntelPerDay ?? -1 },
        taraSeconds: { used: Number(safeDailyUsage.taraSeconds) || 0, limit: limits.taraTalkSecondsPerDay ?? -1 },
        hyperAgentRuns: { used: Number(safeDailyUsage.hyperAgentRuns) || 0, limit: limits.hyperAgentRunsPerDay ?? -1 },
      },
      // Monotonic commercial/audit totals. These never decrease on deletion.
      cumulative,
      // honest scope: tokens are metered at chat + TARA today (full coverage =
      // the granular gateway). FE surfaces this so the number isn't mistaken
      // for total platform spend.
      tokensScope: 'chat+tara',
    };

    const reminders = [];
    const monthlyResources = ['tokens', 'searches', 'kbPages', 'memories', 'deepResearch', 'taraSeconds', 'hyperAgentRuns', 'meetingMinutes'];
    for (const resource of monthlyResources) {
      const reminder = buildReminder(resource, summary[resource].used, summary[resource].limit, resource === 'memories' ? 'total' : 'monthly');
      if (reminder) reminders.push(reminder);
    }
    if (credits && !credits.unlimited) {
      const reminder = buildReminder('credits', credits.used + credits.reserved, credits.included, 'monthly');
      if (reminder) reminders.unshift(reminder);
    }
    for (const [resource, value] of Object.entries(summary.daily)) {
      const reminder = buildReminder(resource, value.used, value.limit, 'daily');
      if (reminder) reminders.push(reminder);
    }
    summary.reminders = reminders;
    return summary;
  }
}
