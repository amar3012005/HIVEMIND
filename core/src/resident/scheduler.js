/**
 * Resident-agent scheduler.
 *
 * Phase 4: env-gated. When ENABLE_GOVERNANCE_SCHEDULER=true fires
 * Faraday → Feynman → Turing on each tick FOR EVERY ACTIVE ORG. Pulls
 * org list from prisma at tick time so newly onboarded tenants pick up
 * the cadence automatically.
 *
 * Concurrency is guarded by a row-level cycle lock inside run-manager.
 *
 * Phase 3: when EVOLUTION_ENABLED=true, a once-daily self-evolution pass runs
 * after the synthesis cycle — diagnoses retrieval from TaskOutcome stats,
 * proposes a RetrievalConfig delta, and commits only if Recall@K doesn't regress.
 */

import { isEvolutionEnabled, runEvolution } from '../memory/evolution-engine.js';
import { isPoolEnabled, affordTier } from './budget-pool.js';
import { ClusterIndex } from '../memory/cluster-index.js';

export class ResidentAgentScheduler {
  // NOTE (Phase D): post-Phase-D this scheduler's setInterval (started below,
  // gated by ENABLE_GOVERNANCE_SCHEDULER) is the SOLE owner of cognition cadence
  // — the standalone CognitionLoop timer is retired.
  constructor({ runManager, prisma = null, intervalMs = 60 * 60 * 1000, logger = console } = {}) {
    this.runManager = runManager;
    this.prisma = prisma;
    // Default tick = 1h (synthesis cadence). Compression / bridge fire on
    // multiples of 1h (4h / 12h) via tier flags in this._tickTier().
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.enabled = process.env.ENABLE_GOVERNANCE_SCHEDULER === 'true';
    this.tickInFlight = false;
    this.tickCount = 0;

    // WS1 — event-driven early dream. A fast poll reads cluster_index for
    // clusters whose dirty_count crossed a threshold (enough new evidence piled
    // up since their last synthesis) and runs an out-of-band synthesis cycle
    // instead of waiting for the next hourly tick. The hourly tick stays as a
    // baseline floor. Per-org cooldown prevents storms during bulk sync.
    this.clusterIndex = prisma ? new ClusterIndex({ prisma }) : null;
    this.dirtyThreshold = Number(process.env.COGNITION_DIRTY_THRESHOLD || 5);
    this.earlyPollMs = Number(process.env.COGNITION_DIRTY_POLL_MS || 5 * 60 * 1000);
    this.earlyCooldownMs = Number(process.env.COGNITION_EARLY_COOLDOWN_MS || 10 * 60 * 1000);
    this.earlyTimer = null;
    this._lastEarlyDream = new Map(); // orgId -> epoch ms
    this.earlyInFlight = false;
  }

  async _tickTier() {
    // Tier hint: every tick = synthesis; every 4 ticks = bridge; every 12
    // ticks = compression. Returns enabled tool names for this tick.
    const tools = ['canonical_synthesis'];
    if (this.tickCount % 4 === 0) tools.push('bridge_synthesis');
    if (this.tickCount % 12 === 0) tools.push('compression');

    // PHASE E: when the shared pool is enabled, drop tiers we cannot afford.
    // Synthesis always runs (it is the baseline cadence); bridge/compression
    // are downgraded out when their conservative estimate exceeds the pool.
    if (isPoolEnabled()) {
      const filtered = ['canonical_synthesis'];
      if (tools.includes('bridge_synthesis')) {
        if (await affordTier(this.prisma, 'bridge')) filtered.push('bridge_synthesis');
        else this.logger?.log?.('[gov-scheduler] tier downgraded: bridge_synthesis unaffordable (pool)');
      }
      if (tools.includes('compression')) {
        if (await affordTier(this.prisma, 'compaction')) filtered.push('compression');
        else this.logger?.log?.('[gov-scheduler] tier downgraded: compression unaffordable (pool)');
      }
      return filtered;
    }
    return tools;
  }

  start() {
    if (!this.enabled) {
      this.logger?.log?.('[gov-scheduler] disabled (ENABLE_GOVERNANCE_SCHEDULER!=true) — no-op start');
      return;
    }
    if (!this.intervalMs || this.timer || !this.runManager) return;

    this.logger?.log?.(`[gov-scheduler] starting, interval=${this.intervalMs}ms`);
    const jitter = Math.floor(Math.random() * 60_000);
    setTimeout(() => this._safeTick(), jitter);
    this.timer = setInterval(() => this._safeTick(), this.intervalMs);

    // WS1 early-dream poll (shares the scheduler's enable gate).
    if (this.clusterIndex) {
      this.logger?.log?.(`[gov-scheduler] early-dream poll every ${this.earlyPollMs}ms (dirty>=${this.dirtyThreshold})`);
      this.earlyTimer = setInterval(() => this._maybeEarlyDream(), this.earlyPollMs);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.earlyTimer) clearInterval(this.earlyTimer);
    this.earlyTimer = null;
  }

  /**
   * WS1 — event-driven early dream. For each active org with hot (dirty>=N)
   * clusters, run an out-of-band synthesis cycle now instead of at the next
   * hourly tick. Reuses runFullCycle (no duplicated synthesis path). Guards:
   * never overlap the hourly tick, per-org cooldown, synthesis tier only.
   */
  async _maybeEarlyDream() {
    if (!this.enabled || !this.clusterIndex || !this.runManager) return;
    if (this.tickInFlight || this.earlyInFlight) return; // never overlap a cycle
    if (typeof this.runManager.runFullCycle !== 'function') return;
    this.earlyInFlight = true;
    try {
      const orgs = await this._listActiveOrgs();
      const now = Date.now();
      for (const o of orgs) {
        const last = this._lastEarlyDream.get(o.id) || 0;
        if (now - last < this.earlyCooldownMs) continue; // cooldown — no storm
        let hot = [];
        try {
          hot = await this.clusterIndex.getDirtyClusters({ organizationId: o.id, minDirty: this.dirtyThreshold });
        } catch { hot = []; }
        if (!hot.length) continue;
        this._lastEarlyDream.set(o.id, now);
        this.logger?.log?.(`[gov-scheduler] early dream org=${o.id.slice(0,8)} — ${hot.length} hot cluster(s)`);
        try {
          await this.runManager.runFullCycle({
            orgId: o.id,
            scope: 'organization',
            trigger: 'early_dream',
            enabledCognitiveTools: ['canonical_synthesis'],
            tierName: 'synthesis',
          });
        } catch (err) {
          this.logger?.warn?.(`[gov-scheduler] early dream org=${o.id.slice(0,8)} failed: ${err?.message || err}`);
        }
      }
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] early-dream poll failed: ${err?.message || err}`);
    } finally {
      this.earlyInFlight = false;
    }
  }

  async _safeTick() {
    if (this.tickInFlight) {
      this.logger?.warn?.('[gov-scheduler] previous tick still in flight, skipping');
      return;
    }
    this.tickInFlight = true;
    try {
      if (typeof this.runManager?.runFullCycle !== 'function') {
        this.logger?.warn?.('[gov-scheduler] run-manager has no runFullCycle, skipping tick');
        return;
      }
      const orgs = await this._listActiveOrgs();
      if (orgs.length === 0) {
        this.logger?.log?.('[gov-scheduler] no active orgs — tick noop');
        return;
      }
      this.tickCount += 1;
      const enabledTools = await this._tickTier();
      // Derive the dominant tier for pool accounting: compaction > bridge >
      // synthesis (most expensive enabled tier this tick wins).
      const tierName = enabledTools.includes('compression')
        ? 'compaction'
        : enabledTools.includes('bridge_synthesis')
          ? 'bridge'
          : 'synthesis';
      this.logger?.log?.(`[gov-scheduler] tick ${this.tickCount}: ${orgs.length} org(s), tools=${enabledTools.join(',')}, tier=${tierName}`);
      for (const o of orgs) {
        try {
          const res = await this.runManager.runFullCycle({
            orgId: o.id,
            scope: 'organization',
            trigger: 'scheduler',
            enabledCognitiveTools: enabledTools,
            tierName,
          });
          if (res?.status === 'skipped_lock_busy') {
            this.logger?.log?.(`[gov-scheduler] org=${o.id.slice(0,8)} busy — skipped`);
          }
        } catch (err) {
          this.logger?.warn?.(`[gov-scheduler] org=${o.id.slice(0,8)} failed: ${err?.message || err}`);
        }
      }
      await this._maybeEvolve(orgs);
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] tick failed: ${err?.message || err}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  // Phase 3: once-daily self-evolution pass (gated). Diagnose→propose→replay-gate
  // →commit/revert per org. No-op unless EVOLUTION_ENABLED.
  async _maybeEvolve(orgs) {
    if (!isEvolutionEnabled() || !this.prisma) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this._lastEvolveDate === today) return; // once/day
    this._lastEvolveDate = today;
    const apiKey = process.env.MASTER_API_KEY || process.env.HM_API_KEY;
    if (!apiKey) { this.logger?.warn?.('[evolution] no MASTER_API_KEY — skipping'); return; }
    // PHASE E: skip the whole daily evolution pass when the pool can't afford it.
    if (isPoolEnabled() && !(await affordTier(this.prisma, 'evolution'))) {
      this.logger?.log?.('[evolution] skipped — evolution tier unaffordable (pool)');
      return;
    }
    this.logger?.log?.(`[evolution] daily pass over ${orgs.length} org(s)`);
    for (const o of orgs) {
      try {
        const m = await this.prisma.$queryRawUnsafe(
          `SELECT user_id FROM hivemind.user_organizations WHERE org_id=$1::uuid AND is_active=true LIMIT 1`,
          o.id,
        );
        const userId = m?.[0]?.user_id;
        if (!userId) continue;
        const res = await runEvolution({ orgId: o.id, userId, apiKey, logger: this.logger });
        if (res?.decision && res.decision !== 'no_signal') {
          this.logger?.log?.(`[evolution] org=${o.id.slice(0,8)} → ${res.decision}`);
        }
      } catch (err) {
        this.logger?.warn?.(`[evolution] org=${o.id.slice(0,8)} failed: ${err?.message || err}`);
      }
    }
  }

  async _listActiveOrgs() {
    if (!this.prisma) return [];
    try {
      // Active = at least one active membership AND at least 1 non-deleted
      // memory AND not an auto-test org (slug LIKE 'local-org-%' is the
      // sentinel ensureTenantContext uses for test-scaffold orgs). This
      // skips empty test artifacts that would burn token budget for nothing.
      const minMemories = Number(process.env.GOV_MIN_ORG_MEMORIES || 5);
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT DISTINCT o.id
           FROM hivemind.organizations o
           JOIN hivemind.user_organizations uo ON uo.org_id = o.id
          WHERE uo.is_active = true
            AND (o.slug IS NULL OR o.slug NOT LIKE 'local-org-%')
            AND EXISTS (
              SELECT 1 FROM hivemind.memories m
               WHERE m.org_id = o.id
                 AND m.deleted_at IS NULL
              OFFSET ${minMemories - 1} LIMIT 1
            )
          LIMIT 1000`
      );
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] org list failed: ${err.message}`);
      return [];
    }
  }
}
