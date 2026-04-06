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
 *   maxUsers, knowledgeBaseUploadsPerMonth
 */

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

    // In-memory counters: orgId -> { tokens, searches, uploads, month }
    this._counters = new Map();
  }

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
      memoriesIngested: 0,
      deepResearchJobs: 0,
      webIntelJobs: 0,
      graphQueries: 0,
      taraUsage: 0,
      connectorCount: 0,
    };
    if (this.usageTracker) {
      try { dbUsage = await this.usageTracker.getUsage(orgId); } catch {}
    }

    c = {
      tokens: dbUsage.tokensProcessed || 0,
      searches: dbUsage.searchQueries || 0,
      uploads: dbUsage.knowledgeBaseUploads || 0,
      memories: dbUsage.memoriesIngested || 0,
      deepResearch: dbUsage.deepResearchJobs || 0,
      webIntel: dbUsage.webIntelJobs || 0,
      graphQueries: dbUsage.graphQueries || 0,
      tara: dbUsage.taraUsage || 0,
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
   * @param {'tokens'|'searches'|'connectors'|'uploads'|'memories'|'deepResearch'|'webIntel'|'graphQueries'|'tara'} type
   * @param {number} amount  How many units to consume (default 1).
   * @returns {{ allowed: boolean, reason?: string, limit?: number, current?: number, plan?: string }}
   */
  async checkLimit(orgId, type, amount = 1) {
    if (!orgId) return { allowed: true };

    const planDef = await this.planStore.getOrgPlan(orgId);
    if (!planDef) return { allowed: true };

    const limits = planDef.limits || {};
    const hasOverage = !!planDef.overage;
    const counters = await this._getCounters(orgId);

    if (type === 'tokens') {
      const limit = limits.llmTokensPerMonth;
      if (!limit || limit === -1) return { allowed: true }; // unlimited
      if (counters.tokens + amount > limit) {
        if (hasOverage) return { allowed: true, overage: true }; // overage plan — allow but flag
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
      if (counters.searches + amount > limit) {
        if (hasOverage) return { allowed: true, overage: true };
        return {
          allowed: false,
          reason: `Monthly search limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} searches/month)`,
          limit,
          current: counters.searches,
          plan: planDef.id,
        };
      }
    }

    if (type === 'uploads') {
      const limit = limits.knowledgeBaseUploadsPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      if (counters.uploads + amount > limit) {
        return {
          allowed: false,
          reason: `Monthly upload limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} uploads/month)`,
          limit,
          current: counters.uploads,
          plan: planDef.id,
        };
      }
    }

    if (type === 'memories') {
      const limit = limits.maxMemories;
      if (!limit || limit === -1) return { allowed: true };
      if (counters.memories + amount > limit) {
        return {
          allowed: false,
          reason: `Memory limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} memories)`,
          limit,
          current: counters.memories,
          plan: planDef.id,
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

    if (type === 'webIntel') {
      const limit = limits.webIntelPerDay;
      if (!limit || limit === -1) return { allowed: true };
      // Web intel is tracked daily, so we need to check today's usage
      const todayUsage = await this.usageTracker?.getWebIntelToday(orgId) || 0;
      if (todayUsage + amount > limit) {
        return {
          allowed: false,
          reason: `Daily web intel limit exceeded (${planDef.name} plan: ${limit} jobs/day)`,
          limit,
          current: todayUsage,
          plan: planDef.id,
        };
      }
    }

    if (type === 'graphQueries') {
      const limit = limits.searchQueriesPerMonth;
      if (!limit || limit === -1) return { allowed: true };
      if (counters.graphQueries + amount > limit) {
        if (hasOverage) return { allowed: true, overage: true };
        return {
          allowed: false,
          reason: `Monthly graph query limit exceeded (${planDef.name} plan: ${limit.toLocaleString()} queries/month)`,
          limit,
          current: counters.graphQueries,
          plan: planDef.id,
        };
      }
    }

    if (type === 'tara') {
      // TARA usage is tracked but not limited (uses token budget)
      return { allowed: true };
    }

    if (type === 'connectors') {
      const limit = limits.maxConnectors;
      if (!limit || limit === -1) return { allowed: true };
      try {
        // PlatformIntegration is keyed by userId; for org-level counting
        // we count all active integrations belonging to users in the org.
        const count = await this.prisma.platformIntegration.count({
          where: {
            user: { organizationMemberships: { some: { organizationId: orgId } } },
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
        // If the query fails (e.g. no membership table), skip enforcement
      }
    }

    return { allowed: true };
  }

  /**
   * Record usage after a successful operation.
   * Updates in-memory counters immediately and delegates durable
   * recording to UsageTracker (fire-and-forget).
   */
  recordUsage(orgId, type, amount = 1) {
    if (!orgId || amount <= 0) return;

    // Update in-memory counters (sync — fast path)
    const c = this._counters.get(orgId);
    if (c && c.month === this._currentMonth()) {
      if (type === 'tokens') c.tokens += amount;
      if (type === 'searches') c.searches += amount;
      if (type === 'uploads') c.uploads += amount;
      if (type === 'memories') c.memories += amount;
      if (type === 'deepResearch') c.deepResearch += amount;
      if (type === 'webIntel') c.webIntel += amount;
      if (type === 'graphQueries') c.graphQueries += amount;
      if (type === 'tara') c.tara += amount;
      if (type === 'connectors') c.connectors += amount;
    }

    // Durable recording via UsageTracker (async — fire-and-forget)
    if (this.usageTracker) {
      if (type === 'tokens') this.usageTracker.recordTokens(orgId, amount).catch(() => {});
      if (type === 'searches') this.usageTracker.recordQuery(orgId).catch(() => {});
      if (type === 'uploads') this.usageTracker.recordUpload(orgId).catch(() => {});
      if (type === 'memories') this.usageTracker.recordMemory(orgId).catch(() => {});
      if (type === 'deepResearch') this.usageTracker.recordDeepResearch(orgId).catch(() => {});
      if (type === 'webIntel') this.usageTracker.recordWebIntel(orgId).catch(() => {});
      if (type === 'graphQueries') this.usageTracker.recordGraphQuery(orgId).catch(() => {});
      if (type === 'tara') this.usageTracker.recordTara(orgId).catch(() => {});
    }
  }

  /**
   * Get current usage summary for an org.
   */
  async getUsageSummary(orgId) {
    const planDef = await this.planStore.getOrgPlan(orgId);
    const limits = planDef?.limits || {};
    const counters = await this._getCounters(orgId);

    return {
      plan: planDef?.id || 'free',
      planName: planDef?.name || 'Free',
      period: { month: counters.month },
      tokens: { used: counters.tokens, limit: limits.llmTokensPerMonth ?? -1 },
      searches: { used: counters.searches, limit: limits.searchQueriesPerMonth ?? -1 },
      uploads: { used: counters.uploads, limit: limits.knowledgeBaseUploadsPerMonth ?? -1 },
      memories: { used: counters.memories, limit: limits.maxMemories ?? -1 },
      deepResearch: { used: counters.deepResearch, limit: limits.deepResearchPerMonth ?? -1 },
      webIntel: { used: counters.webIntel, limit: limits.webIntelPerDay ?? -1, isDaily: true },
      graphQueries: { used: counters.graphQueries, limit: limits.searchQueriesPerMonth ?? -1 },
      tara: { used: counters.tara, limit: -1 }, // Not limited, tracked for analytics
      connectors: { limit: limits.maxConnectors ?? -1 },
      users: { limit: limits.maxUsers ?? -1 },
    };
  }
}
