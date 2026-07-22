/**
 * Usage Tracker
 *
 * Tracks tokens processed and search queries per org per month.
 * Lightweight — single table, no external billing system needed.
 * Enforces soft (80%) and hard limits.
 *
 * Tracks: tokens, searches, internal KB upload telemetry, KB pages, memories, deep research, web intel,
 *         connectors, graph queries, TARA usage
 */

import { getPlan } from './plans.js';

// ── Module singleton + fire-and-forget meters ───────────────────────────────
// The UsageTracker is constructed once in server.js with prisma, but the LLM /
// ingest / recall chokepoints live in deep modules that don't have it in scope.
// server.js calls setUsageTracker(t) at boot; chokepoints import the meter*
// helpers and call them fire-and-forget (a metering failure never affects the
// request — matches "never let metering break a call").
let _tracker = null;
export function setUsageTracker(t) { _tracker = t; }
export function getUsageTrackerInstance() { return _tracker; }

const _safe = (p) => { try { p?.catch?.(() => {}); } catch { /* ignore */ } };
// meterTokens now records BOTH the org-wide monthly total (recordTokens — unchanged, keeps existing
// dashboards byte-stable) AND, when apiKeyId/model/feature are supplied, a per-API-key/per-model
// rollup (recordKeyUsage). apiKeyId may be null for system/background/master-key calls — those fold
// into a single per-(org,month,model) system row via the COALESCE unique index. Fully backward
// compatible: existing meterTokens(orgId, n) callers still work and just skip the per-key write.
export function meterTokens(orgId, n, apiKeyId = null, model = null, feature = null, parts = null) {
  if (!_tracker || !orgId || !(n > 0)) return;
  _safe(_tracker.recordTokens(orgId, n));
  _safe(_tracker.recordDaily(orgId, 'tokens', n));
  _safe(_tracker.recordKeyUsage(orgId, n, apiKeyId, model, feature, parts));
}
export function meterQuery(orgId)      { if (_tracker && orgId) _safe(_tracker.recordQuery(orgId)); }
export function meterUpload(orgId)     { if (_tracker && orgId) _safe(_tracker.recordUpload(orgId)); }
export function meterKbPages(orgId, n = 1) { if (_tracker && orgId && n > 0) _safe(_tracker.recordKbPages(orgId, n)); }
export function meterMemory(orgId)     { if (_tracker && orgId) _safe(_tracker.recordMemory(orgId)); }
export function meterDeepResearch(orgId) { if (_tracker && orgId) _safe(_tracker.recordDeepResearch(orgId)); }
export function meterWebIntel(orgId)   { if (_tracker && orgId) _safe(_tracker.recordWebIntel(orgId)); }
export function meterGraphQuery(orgId) { if (_tracker && orgId) _safe(_tracker.recordGraphQuery(orgId)); }
export function meterTara(orgId)       { if (_tracker && orgId) _safe(_tracker.recordTara(orgId)); }
export function meterTaraSeconds(orgId, seconds) {
  if (_tracker && orgId && seconds > 0) _safe(_tracker.recordTaraSeconds(orgId, seconds));
}
export function meterHyperAgentRun(orgId) {
  if (_tracker && orgId) _safe(_tracker.recordHyperAgentRun(orgId));
}
// Value-action meter: one approved outbound email actually sent (closed loop).
// Called ONLY on gmail_send success — never on approval emission or deny.
export function meterEmailSend(orgId)  { if (_tracker && orgId) { _safe(_tracker.recordEmailSend(orgId)); _safe(_tracker.recordDaily(orgId, 'emailSends')); } }

export class UsageTracker {
  constructor(prisma) {
    this.prisma = prisma;
    this._cache = new Map(); // orgId:month → usage object (60s TTL)
    this._cacheTTL = 60_000;
  }

  // Commercial totals are intentionally monotonic. Active memory/storage
  // counts are queried separately; a delete never rewrites historical usage.
  async _recordCumulative(orgId, metric, amount = 1) {
    const columns = {
      tokens: 'tokens_processed', searches: 'search_queries', uploads: 'knowledge_base_uploads',
      kbPages: 'knowledge_base_pages', memories: 'memories_ingested', deepResearch: 'deep_research_jobs',
      webIntel: 'web_intel_jobs', graphQueries: 'graph_queries', tara: 'tara_usage',
      taraSeconds: 'tara_seconds', hyperAgentRuns: 'hyper_agent_runs',
    };
    const column = columns[metric];
    if (!this.prisma || !orgId || !column || !(amount > 0)) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.org_usage_cumulative (org_id, "${column}") VALUES ($1::uuid, $2)
         ON CONFLICT (org_id) DO UPDATE SET "${column}" = hivemind.org_usage_cumulative."${column}" + $2, updated_at = NOW()`,
        orgId, amount,
      );
    } catch (err) {
      console.warn('[usage-tracker] Record cumulative usage failed:', err.message);
    }
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
      await this._recordCumulative(orgId, 'tokens', tokenCount);
    } catch (err) {
      console.warn('[usage-tracker] Record tokens failed:', err.message);
    }
  }

  /**
   * Record one LLM call against the org's HIVEMIND API key — the per-key / per-model / per-feature
   * monthly rollup that powers per-key spend attribution. orgId is required; apiKeyId is NULL for
   * system / background / master-key calls (they fold into one sentinel row per org/month/model/feature
   * via the unique index uq_api_key_usage_org_key_month_model_feature). Best-effort: a failure here must
   * never affect the completion (called fire-and-forget through meterTokens).
   */
  async recordKeyUsage(orgId, tokenCount, apiKeyId = null, model = null, feature = null, parts = null) {
    if (!this.prisma || !orgId || !(tokenCount > 0)) return;
    const month = this._currentMonth();
    // System / background / master-key calls have no request key → fold into the all-zero sentinel so
    // the plain unique index dedupes them per (org, month, model) instead of inserting unbounded rows.
    const key = apiKeyId || '00000000-0000-0000-0000-000000000000';
    const m = String(model || '').slice(0, 128);
    const f = String(feature || '').slice(0, 64);
    const pt = Number(parts?.promptTokens || 0);
    const ct = Number(parts?.completionTokens || 0);
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "api_key_usage" ("org_id", "api_key_id", "month", "model", "feature", "tokens_processed", "prompt_tokens", "completion_tokens", "requests", "last_used_at", "updated_at")
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 1, NOW(), NOW())
         ON CONFLICT ("org_id", "api_key_id", "month", "model", "feature")
         DO UPDATE SET "tokens_processed" = "api_key_usage"."tokens_processed" + $6,
                       "prompt_tokens" = "api_key_usage"."prompt_tokens" + $7,
                       "completion_tokens" = "api_key_usage"."completion_tokens" + $8,
                       "requests" = "api_key_usage"."requests" + 1,
                       "feature" = CASE WHEN "api_key_usage"."feature" = '' THEN EXCLUDED."feature" ELSE "api_key_usage"."feature" END,
                       "last_used_at" = NOW(), "updated_at" = NOW()`,
        orgId, key, month, m, f, tokenCount, pt, ct
      );
    } catch (err) {
      console.warn('[usage-tracker] Record key usage failed:', err.message);
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
      await this._recordCumulative(orgId, 'searches');
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
      await this._recordCumulative(orgId, 'uploads');
    } catch (err) {
      console.warn('[usage-tracker] Record upload failed:', err.message);
    }
  }

  /**
   * Record N knowledge-base pages ingested this month (DURABLE).
   * Mirrors recordUpload's upsert exactly, incrementing the knowledgeBasePages
   * column by `pages` instead of the upload counter by 1. This makes the kbPages
   * plan gate + Usage summary read a persisted value instead of a per-replica
   * in-memory counter that reset on restart.
   */
  async recordKbPages(orgId, pages = 1) {
    if (!this.prisma || !orgId || !(pages > 0)) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "knowledgeBasePages", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "updatedAt")
         VALUES ($1::uuid, $2, 0, 0, 0, $3, 0, 0, 0, 0, 0, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "knowledgeBasePages" = "OrgUsage"."knowledgeBasePages" + $3, "updatedAt" = NOW()`,
        orgId, month, pages
      );
      this._invalidateCache(orgId);
      await this._recordCumulative(orgId, 'kbPages', pages);
    } catch (err) {
      console.warn('[usage-tracker] Record KB pages failed:', err.message);
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
      await this._recordCumulative(orgId, 'memories');
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
      await this._recordCumulative(orgId, 'deepResearch');
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
         VALUES ($1::uuid, $2, 0, 0, 0, 0, 0, 1, 0, 0, $3::date, NOW())
         ON CONFLICT ("orgId", "webIntelDay")
         DO UPDATE SET "webIntelJobs" = "OrgUsage"."webIntelJobs" + 1, "updatedAt" = NOW()`,
        orgId, this._currentMonth(), today
      );
      this._invalidateCache(orgId);
      await this._recordCumulative(orgId, 'webIntel');
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
      await this._recordCumulative(orgId, 'graphQueries');
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
      await this._recordCumulative(orgId, 'tara');
    } catch (err) {
      console.warn('[usage-tracker] Record TARA failed:', err.message);
    }
  }

  async _recordMeteredMetric(orgId, type, amount) {
    const columns = { taraSeconds: 'taraSeconds', hyperAgentRuns: 'hyperAgentRuns' };
    const column = columns[type];
    if (!this.prisma || !orgId || !column || !(amount > 0)) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "${column}", "updatedAt")
         VALUES ($1::uuid, $2, $3, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "${column}" = "OrgUsage"."${column}" + $3, "updatedAt" = NOW()`,
        orgId, this._currentMonth(), Math.round(amount),
      );
      await this.recordDaily(orgId, type, Math.round(amount));
      await this._recordCumulative(orgId, type, Math.round(amount));
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn(`[usage-tracker] Record ${type} failed:`, err.message);
    }
  }

  async recordTaraSeconds(orgId, seconds) {
    return this._recordMeteredMetric(orgId, 'taraSeconds', seconds);
  }

  async recordHyperAgentRun(orgId) {
    return this._recordMeteredMetric(orgId, 'hyperAgentRuns', 1);
  }

  /**
   * Record one approved outbound email send (closed-loop value action).
   * Success-path only — the caller meters AFTER gmail_send returned ok.
   */
  async recordEmailSend(orgId) {
    if (!this.prisma || !orgId) return;
    const month = this._currentMonth();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsage" ("orgId", "month", "emailSends", "updatedAt")
         VALUES ($1::uuid, $2, 1, NOW())
         ON CONFLICT ("orgId", "month")
         DO UPDATE SET "emailSends" = "OrgUsage"."emailSends" + 1, "updatedAt" = NOW()`,
        orgId, month
      );
      this._invalidateCache(orgId);
    } catch (err) {
      console.warn('[usage-tracker] Record email send failed:', err.message);
    }
  }

  // type → OrgUsageDaily column. (Internal constant — safe to interpolate.)
  static _DAILY_COL = {
    tokens: 'tokensProcessed', searches: 'searchQueries', uploads: 'knowledgeBaseUploads',
    kbPages: 'knowledgeBasePages',
    memories: 'memoriesIngested', deepResearch: 'deepResearchJobs', webIntel: 'webIntelJobs',
    graphQueries: 'graphQueries', tara: 'taraUsage', taraSeconds: 'taraSeconds',
    hyperAgentRuns: 'hyperAgentRuns',
    graphQueries: 'graphQueries', tara: 'taraUsage', emailSends: 'emailSends',
  };

  /**
   * Record one day's usage for an org (powers the Usage page daily graphs).
   * Wide upsert into OrgUsageDaily keyed by (orgId, day). Same type vocabulary
   * as PlanEnforcer.recordUsage so it can be called right alongside it.
   */
  async recordDaily(orgId, type, amount = 1) {
    const col = UsageTracker._DAILY_COL[type];
    if (!this.prisma || !orgId || !col || amount <= 0) return;
    const day = this._currentDay();
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "OrgUsageDaily" ("orgId", "day", "${col}", "updatedAt")
         VALUES ($1::uuid, $2::date, $3, NOW())
         ON CONFLICT ("orgId", "day")
         DO UPDATE SET "${col}" = "OrgUsageDaily"."${col}" + $3, "updatedAt" = NOW()`,
        orgId, day, amount
      );
    } catch (err) {
      console.warn('[usage-tracker] Record daily failed:', err.message);
    }
  }

  /**
   * Get the last N days of usage for an org (for the daily graphs).
   * Returns rows ascending by day with all metrics; gaps are NOT filled here
   * (the FE fills missing days with zero against its date axis).
   */
  async getDailyUsage(orgId, days = 30) {
    if (!this.prisma || !orgId) return [];
    const n = Math.max(1, Math.min(120, Number(days) || 30));
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT to_char("day", 'YYYY-MM-DD') AS day,
                "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "knowledgeBasePages", "memoriesIngested",
                "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "taraSeconds", "hyperAgentRuns"
           FROM "OrgUsageDaily"
          WHERE "orgId" = $1::uuid AND "day" >= (CURRENT_DATE - ($2 || ' days')::interval)
          ORDER BY "day" ASC`,
        orgId, String(n)
      );
      return (rows || []).map(r => ({
        day: r.day,
        tokens: Number(r.tokensProcessed || 0),
        searches: Number(r.searchQueries || 0),
        uploads: Number(r.knowledgeBaseUploads || 0),
        kbPages: Number(r.knowledgeBasePages || 0),
        memories: Number(r.memoriesIngested || 0),
        deepResearch: Number(r.deepResearchJobs || 0),
        webIntel: Number(r.webIntelJobs || 0),
        graphQueries: Number(r.graphQueries || 0),
        tara: Number(r.taraUsage || 0),
        taraSeconds: Number(r.taraSeconds || 0),
        hyperAgentRuns: Number(r.hyperAgentRuns || 0),
      }));
    } catch (err) {
      console.warn('[usage-tracker] Get daily usage failed:', err.message);
      return [];
    }
  }

  async getDailySnapshot(orgId) {
    if (!this.prisma || !orgId) return {};
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "knowledgeBasePages",
                "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "taraSeconds", "hyperAgentRuns"
           FROM "OrgUsageDaily" WHERE "orgId" = $1::uuid AND "day" = $2::date LIMIT 1`,
        orgId, this._currentDay(),
      );
      const row = rows[0] || {};
      return {
        tokens: Number(row.tokensProcessed || 0),
        searches: Number(row.searchQueries || 0),
        uploads: Number(row.knowledgeBaseUploads || 0),
        kbPages: Number(row.knowledgeBasePages || 0),
        memories: Number(row.memoriesIngested || 0),
        deepResearch: Number(row.deepResearchJobs || 0),
        webIntel: Number(row.webIntelJobs || 0),
        graphQueries: Number(row.graphQueries || 0),
        tara: Number(row.taraUsage || 0),
        taraSeconds: Number(row.taraSeconds || 0),
        hyperAgentRuns: Number(row.hyperAgentRuns || 0),
      };
    } catch (err) {
      console.warn('[usage-tracker] Get daily snapshot failed:', err.message);
      return null;
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
        `SELECT "tokensProcessed", "searchQueries", "knowledgeBaseUploads", "knowledgeBasePages", "memoriesIngested", "deepResearchJobs", "webIntelJobs", "graphQueries", "taraUsage", "taraSeconds", "hyperAgentRuns", "connectorCount"
         FROM "OrgUsage" WHERE "orgId" = $1::uuid AND "month" = $2 LIMIT 1`,
        orgId, month
      );
      const usage = rows[0] || this._emptyUsage();
      const data = {
        tokensProcessed: Number(usage.tokensProcessed || 0),
        searchQueries: Number(usage.searchQueries || 0),
        knowledgeBaseUploads: Number(usage.knowledgeBaseUploads || 0),
        knowledgeBasePages: Number(usage.knowledgeBasePages || 0),
        memoriesIngested: Number(usage.memoriesIngested || 0),
        deepResearchJobs: Number(usage.deepResearchJobs || 0),
        webIntelJobs: Number(usage.webIntelJobs || 0),
        graphQueries: Number(usage.graphQueries || 0),
        taraUsage: Number(usage.taraUsage || 0),
        taraSeconds: Number(usage.taraSeconds || 0),
        hyperAgentRuns: Number(usage.hyperAgentRuns || 0),
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
        `SELECT "webIntelJobs" FROM "OrgUsage" WHERE "orgId" = $1::uuid AND "webIntelDay" = $2::date LIMIT 1`,
        orgId, today
      );
      return rows[0]?.webIntelJobs || 0;
    } catch (err) {
      console.warn('[usage-tracker] Get web intel today failed:', err.message);
      return 0;
    }
  }

  async getDailyMetricToday(orgId, metric) {
    const snapshot = await this.getDailySnapshot(orgId);
    return Number(snapshot?.[metric] || 0);
  }

  async getCumulativeUsage(orgId) {
    const empty = {
      tokensProcessed: 0, searchQueries: 0, knowledgeBaseUploads: 0,
      knowledgeBasePages: 0, memoriesIngested: 0, deepResearchJobs: 0,
      webIntelJobs: 0, graphQueries: 0, taraUsage: 0, taraSeconds: 0, hyperAgentRuns: 0,
    };
    if (!this.prisma || !orgId) return empty;
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        'SELECT * FROM hivemind.org_usage_cumulative WHERE org_id = $1::uuid LIMIT 1', orgId,
      );
      const row = rows[0] || {};
      return {
        tokensProcessed: Number(row.tokens_processed || 0), searchQueries: Number(row.search_queries || 0),
        knowledgeBaseUploads: Number(row.knowledge_base_uploads || 0), knowledgeBasePages: Number(row.knowledge_base_pages || 0),
        memoriesIngested: Number(row.memories_ingested || 0), deepResearchJobs: Number(row.deep_research_jobs || 0),
        webIntelJobs: Number(row.web_intel_jobs || 0), graphQueries: Number(row.graph_queries || 0),
        taraUsage: Number(row.tara_usage || 0),
        taraSeconds: Number(row.tara_seconds || 0),
        hyperAgentRuns: Number(row.hyper_agent_runs || 0),
      };
    } catch (err) {
      // The migration may not yet exist during a rolling deployment.
      if (!/org_usage_cumulative.*does not exist/i.test(err.message || '')) console.warn('[usage-tracker] Get cumulative usage failed:', err.message);
      return empty;
    }
  }

  /**
   * Check if an org has exceeded their plan limits.
   * Returns { allowed, warnings, exceeded }
   */
  async checkLimits(orgId, planOrId) {
    const usage = await this.getUsage(orgId);
    const plan = planOrId && typeof planOrId === 'object' ? planOrId : getPlan(planOrId);

    const tokenLimit = plan.limits.llmTokensPerMonth;
    const queryLimit = plan.limits.searchQueriesPerMonth;
    const deepResearchLimit = plan.limits.deepResearchPerMonth;
    const taraSecondsLimit = plan.limits.taraTalkSecondsPerMonth;
    const hyperRunsLimit = plan.limits.hyperAgentRunsPerMonth;

    const result = { allowed: true, warnings: [], exceeded: [] };

    // Check tokens
    if (tokenLimit > 0) {
      const pct = usage.tokensProcessed / tokenLimit;
      if (pct >= 1.0) {
        result.allowed = false;
        result.exceeded.push('llmTokensPerMonth');
      } else if (pct >= 0.8) {
        result.warnings.push(`80% of token budget used (${usage.tokensProcessed.toLocaleString()}/${tokenLimit.toLocaleString()}).`);
      }
    }

    // Check queries
    if (queryLimit > 0) {
      const queryUsage = usage.searchQueries + usage.graphQueries;
      const pct = queryUsage / queryLimit;
      if (pct >= 1.0) {
        result.allowed = false;
        result.exceeded.push('searchQueriesPerMonth');
      } else if (pct >= 0.8) {
        result.warnings.push(`80% of query budget used.`);
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

    for (const [limitKey, used, limit, label] of [
      ['taraTalkSecondsPerMonth', usage.taraSeconds || 0, taraSecondsLimit, 'TARA talk time'],
      ['hyperAgentRunsPerMonth', usage.hyperAgentRuns || 0, hyperRunsLimit, 'HyperAgents runs'],
    ]) {
      if (!(limit > 0)) continue;
      if (used >= limit) {
        result.allowed = false;
        result.exceeded.push(limitKey);
      } else if (used / limit >= 0.8) {
        result.warnings.push(`80% of monthly ${label} used (${used.toLocaleString()}/${limit.toLocaleString()}).`);
      }
    }

    const daily = await this.getDailySnapshot(orgId) || {};
    const dailyChecks = [
      ['llmTokensPerDay', daily.tokens || 0, 'daily token'],
      ['searchQueriesPerDay', (daily.searches || 0) + (daily.graphQueries || 0), 'daily query'],
      ['knowledgeBasePagesPerDay', daily.kbPages || 0, 'daily KB page'],
      ['deepResearchPerDay', daily.deepResearch || 0, 'daily deep research'],
      ['webIntelPerDay', daily.webIntel || 0, 'daily web intel'],
      ['taraTalkSecondsPerDay', daily.taraSeconds || 0, 'daily TARA talk time'],
      ['hyperAgentRunsPerDay', daily.hyperAgentRuns || 0, 'daily HyperAgents run'],
    ];
    for (const [limitKey, used, label] of dailyChecks) {
      const limit = plan.limits[limitKey];
      if (!(limit > 0)) continue;
      if (used >= limit) {
        result.allowed = false;
        result.exceeded.push(limitKey);
      } else if (used / limit >= 0.8) {
        result.warnings.push(`80% of ${label} limit used (${used.toLocaleString()}/${limit.toLocaleString()}).`);
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
      knowledgeBasePages: 0,
      memoriesIngested: 0,
      deepResearchJobs: 0,
      webIntelJobs: 0,
      graphQueries: 0,
      taraUsage: 0,
      taraSeconds: 0,
      hyperAgentRuns: 0,
      connectorCount: 0,
      month: this._currentMonth(),
    };
  }

  _invalidateCache(orgId) {
    this._cache.delete(`${orgId}:${this._currentMonth()}`);
  }
}
