/**
 * Usage Tracker
 *
 * Tracks tokens processed and search queries per org per month.
 * Lightweight — single table, no external billing system needed.
 * Enforces soft (80%) and hard limits.
 *
 * Tracks: tokens, searches, KB uploads, memories, deep research, web intel,
 *         connectors, graph queries, TARA usage
 */

import { getPlan } from './plans.js';

export class UsageTracker {
  constructor(prisma) {
    this.prisma = prisma;
    this._cache = new Map(); // orgId:month → usage object (60s TTL)
    this._cacheTTL = 60_000;
  }

  /**
   * Record token usage for an org.
   * Called on every API request that processes tokens.
   */
  async recordTokens(orgId, tokenCount) {
    if (!this.prisma || !orgId || tokenCount <= 0) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, $3, 0, 0, 0, 0, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "tokensProcessed" = "OrgUsage"."tokensProcessed" + $3, "updatedAt" = NOW()`,
        orgId, month, tokenCount
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record tokens failed:', err.message);
    }
  }

  /**
   * Record a search query for an org.
   */
  async recordQuery(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 1, 0, 0, 0, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "searchQueries" = "OrgUsage"."searchQueries" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record query failed:', err.message);
    }
  }

  /**
   * Record a knowledge base upload.
   */
  async recordUpload(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 1, 0, 0, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "knowledgeBaseUploads" = "OrgUsage"."knowledgeBaseUploads" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record upload failed:', err.message);
    }
  }

  /**
   * Record a memory ingestion.
   */
  async recordMemory(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, 1, 0, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "memoriesIngested" = "OrgUsage"."memoriesIngested" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record memory failed:', err.message);
    }
  }

  /**
   * Record a deep research job.
   */
  async recordDeepResearch(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, 0, 1, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "deepResearchJobs" = "OrgUsage"."deepResearchJobs" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record deep research failed:', err.message);
    }
  }

  /**
   * Record a web intel job (daily tracking).
   */
  async recordWebIntel(orgId) {
    if (!this.prisma || !orgId) return;
    const today = this._currentDay();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "webIntelDay", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, 0, 0, 1, 0, 0, $3, NOW())
         ON CONFLICT ("orgId", "webIntelDay")
         DO UPDATE SET "webIntelJobs" = "OrgUsage"."webIntelJobs" + 1, "updatedAt" = NOW()`,
        orgId, this._currentMonth(), today
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record web intel failed:', err.message);
    }
  }

  /**
   * Record a graph query.
   */
  async recordGraphQuery(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, 0, 0, 0, 1, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "graphQueries" = "OrgUsage"."graphQueries" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record graph query failed:', err.message);
    }
  }

  /**
   * Record TARA voice agent usage.
   */
  async recordTara(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, 0, 0, 0, 0, 1, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "taraUsage" = "OrgUsage"."taraUsage" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record TARA failed:', err.message);
    }
  }

  /**
   * Get current usage for an org this month.
   */
  async getUsage(orgId) {
    if (!this.prisma || !orgId) return this._emptyUsage();

    const cacheKey = `${orgId}:${this._currentMonth()}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._cacheTTL) return cached.data;

    const month = this._currentMonth();
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "connectorCount"
         FROM "OrgUsage" WHERE "orgId" = $1::uuid AND "month" = $2 LIMIT 1`,
        orgId, month
      );
      const usage = rows[0] || this._emptyUsage();
      const data = {
        tokensProcessed: Number(usage.tokensProcessed || 0),
        searchQueries: Number(usage.searchQueries || 0),
        knowledgeBaseUploads: Number(usage.knowledgeBaseUploads || 0),
        memoriesIngested: Number(usage.memoriesIngested || 0),
        deepResearchJobs: Number(usage.deepResearchJobs || 0),
        webIntelJobs: Number(usage.webIntelJobs || 0),
        graphQueries: Number(usage.graphQueries || 0),
        taraUsage: Number(usage.taraUsage || 0),
        connectorCount: Number(usage.connectorCount || 0),
        month,
      };
      this._cache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch (err) {
      console.warn('[usage-tracker] Get usage failed:', err.message);
      return this._emptyUsage();
    }
  }

  /**
   * Get web intel usage for today (daily limit tracking).
   */
  async getWebIntelToday(orgId) {
    if (!this.prisma || !orgId) return 0;
    const today = this._currentDay();
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT "webIntelJobs" FROM "OrgUsage" WHERE "orgId" = $1::uuid AND "webIntelDay" = $2 LIMIT 1`,
        orgId, today
      );
      return rows[0]?.webIntelJobs || 0;
    } catch (err) {
      console.warn('[usage-tracker] Get web intel today failed:', err.message);
      return 0;
    }
  }

  /**
   * Check if an org has exceeded their plan limits.
   * Returns { allowed, warnings, exceeded }
   */
  async checkLimits(orgId, planId) {
    const usage = await this.getUsage(orgId);
    const plan = getPlan(planId);

    const tokenLimit = plan.limits.llmTokensPerMonth;
    const queryLimit = plan.limits.searchQueriesPerMonth;
    const uploadLimit = plan.limits.knowledgeBaseUploadsPerMonth;
    const memoryLimit = plan.limits.maxMemories;
    const deepResearchLimit = plan.limits.deepResearchPerMonth;
    const webIntelDayLimit = plan.limits.webIntelPerDay;

    const result = { allowed: true, warnings: [], exceeded: [] };

    // Check tokens
    if (tokenLimit > 0) {
      const pct = usage.tokensProcessed / tokenLimit;
      if (pct >= 1.0) {
        if (plan.overage) {
          result.warnings.push(`Token limit reached (${usage.tokensProcessed.toLocaleString()}/${tokenLimit.toLocaleString()}). Overage billing active.`);
        } else {
          result.allowed = false;
          result.exceeded.push('llmTokensPerMonth');
        }
      } else if (pct >= 0.8) {
        result.warnings.push(`80% of token budget used (${usage.tokensProcessed.toLocaleString()}/${tokenLimit.toLocaleString()}).`);
      }
    }

    // Check queries
    if (queryLimit > 0) {
      const pct = usage.searchQueries / queryLimit;
      if (pct >= 1.0) {
        if (plan.overage) {
          result.warnings.push(`Query limit reached. Overage billing active.`);
        } else {
          result.allowed = false;
          result.exceeded.push('searchQueriesPerMonth');
        }
      } else if (pct >= 0.8) {
        result.warnings.push(`80% of query budget used.`);
      }
    }

    // Check uploads
    if (uploadLimit > 0) {
      if (usage.knowledgeBaseUploads >= uploadLimit) {
        result.allowed = false;
        result.exceeded.push('knowledgeBaseUploadsPerMonth');
      }
    }

    // Check memories
    if (memoryLimit > 0) {
      if (usage.memoriesIngested >= memoryLimit) {
        result.allowed = false;
        result.exceeded.push('maxMemories');
      } else if (usage.memoriesIngested / memoryLimit >= 0.8) {
        result.warnings.push(`80% of memory limit used (${usage.memoriesIngested}/${memoryLimit}).`);
      }
    }

    // Check deep research
    if (deepResearchLimit > 0) {
      if (usage.deepResearchJobs >= deepResearchLimit) {
        result.allowed = false;
        result.exceeded.push('deepResearchPerMonth');
      } else if (usage.deepResearchJobs / deepResearchLimit >= 0.8) {
        result.warnings.push(`80% of deep research limit used (${usage.deepResearchJobs}/${deepResearchLimit}).`);
      }
    }

    // Check web intel (daily)
    if (webIntelDayLimit > 0) {
      const todayCount = await this.getWebIntelToday(orgId);
      if (todayCount >= webIntelDayLimit) {
        result.allowed = false;
        result.exceeded.push('webIntelPerDay');
      } else if (todayCount / webIntelDayLimit >= 0.8) {
        result.warnings.push(`80% of daily web intel limit used (${todayCount}/${webIntelDayLimit}).`);
      }
    }

    return { ...result, usage, plan: plan.id };
  }

  _currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  _currentDay() {
    const d = new Date();
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  _emptyUsage() {
    return {
      tokensProcessed: 0,
      searchQueries: 0,
      knowledgeBaseUploads: 0,
      memoriesIngested: 0,
      deepResearchJobs: 0,
      webIntelJobs: 0,
      graphQueries: 0,
      taraUsage: 0,
      connectorCount: 0,
      month: this._currentMonth(),
    };
  }

  _invalidateCache(orgId) {
    this._cache.delete(`${orgId}:${this._currentMonth()}`);
  }
}
