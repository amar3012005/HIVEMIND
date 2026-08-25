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
import { withGovernanceLock } from './advisory-lock.js';

export class ResidentAgentScheduler {
  // NOTE (Phase D): post-Phase-D this scheduler's setInterval (started below,
  // gated by ENABLE_GOVERNANCE_SCHEDULER) is the SOLE owner of cognition cadence
  // — the standalone CognitionLoop timer is retired.
  constructor({ runManager, prisma = null, intervalMs = 60 * 60 * 1000, logger = console, cognitionLoopRef = null } = {}) {
    this.runManager = runManager;
    this.prisma = prisma;
    // WS3: getter for the live CognitionLoop (built lazily in server.js via
    // setImmediate). A getter, not the instance, so we read the live binding
    // at tick time rather than a null snapshot. Drives the retroactive re-sweep.
    this.cognitionLoopRef = cognitionLoopRef;
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

    // Scheduled deep dream (replaces the 1h-window-only cadence). When enabled,
    // each org fires ONE wide-lookback dream per day inside its configured window
    // (night-mode=midnight, or an interval). GA: the PER-ORG cognition settings are
    // the driver (only orgs with cognition_org_enabled=true + a non-continuous mode
    // dream; users control it from the cognition tab). The env var is now a GLOBAL
    // KILL-SWITCH (default ON) — set COGNITION_SCHEDULE_ENABLED=false to disable the
    // scheduled-dream path platform-wide. Safe to default-on: blockers shipped
    // alongside (skipCompaction:true on the scheduled path + cross-replica
    // withGovernanceLock + cross-replica once/day dedup via cognition_run).
    this.scheduleEnabled = process.env.COGNITION_SCHEDULE_ENABLED !== 'false';
    this.schedulePollMs = Number(process.env.COGNITION_SCHEDULE_POLL_MS || 15 * 60 * 1000);
    this.scheduleLookbackHours = Number(process.env.COGNITION_SCHEDULE_LOOKBACK_HOURS || 24);
    this.scheduleTimer = null;
    this._lastScheduledDreamDate = new Map(); // orgId -> 'YYYY-MM-DD' (in org tz)
    this.scheduleInFlight = false;
  }

  // Local hour (0-23) and YYYY-MM-DD for an IANA timezone, computed from now.
  _localClock(tz) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || 'UTC', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
      let hour = parseInt(parts.hour, 10);
      if (hour === 24) hour = 0; // some engines emit '24' for midnight
      return { hour, date: `${parts.year}-${parts.month}-${parts.day}` };
    } catch {
      const d = new Date();
      return { hour: d.getUTCHours(), date: d.toISOString().slice(0, 10) };
    }
  }

  // Is `hour` inside this org's dream window? night-mode → midnight hour (0).
  // interval → [startHour, endHour) with wraparound (e.g. 22→6 spans midnight).
  _withinDreamWindow(sched, hour) {
    const mode = (sched.mode || 'nightmode').toLowerCase();
    if (mode === 'continuous') return false; // event-driven only, no scheduled dream
    if (mode === 'interval') {
      const s = Number.isInteger(sched.startHour) ? sched.startHour : 0;
      const e = Number.isInteger(sched.endHour) ? sched.endHour : 6;
      if (s === e) return hour === s;
      return s < e ? (hour >= s && hour < e) : (hour >= s || hour < e); // wraparound
    }
    // nightmode (default): fire at midnight, or a custom startHour if set.
    const target = Number.isInteger(sched.startHour) ? sched.startHour : 0;
    return hour === target;
  }

  /**
   * Scheduled deep dream — once/day per org inside its window, wide lookback so
   * the dream connects dots across the whole period (cross-time). Reuses the
   * cognition loop's runOnce with skipCompaction:TRUE — a scheduled wide-lookback
   * run must NOT trigger the destructive full-window drift-compaction over live org
   * data (the §10 hazard that hard-removed KB chunks). Compaction stays on the
   * separate governance-tick cadence, never the auto scheduled-dream path.
   */
  async _maybeScheduledDream() {
    if (!this.scheduleEnabled || this.scheduleInFlight || this.tickInFlight) return;
    const loop = typeof this.cognitionLoopRef === 'function' ? this.cognitionLoopRef() : null;
    if (!loop || typeof loop.runOnce !== 'function') return;
    this.scheduleInFlight = true;
    try {
      const scheds = await this._orgSchedules();
      for (const sched of scheds) {
        const { hour, date } = this._localClock(sched.tz);
        if (!this._withinDreamWindow(sched, hour)) continue;
        if (this._lastScheduledDreamDate.get(sched.id) === date) continue; // cheap per-process pre-filter
        try {
          // Cross-replica mutual exclusion. The advisory lock is SESSION-scoped, so
          // (per advisory-lock.js) we hold it inside a $transaction — that pins ONE
          // connection for acquire→run→release, otherwise the pool would release on
          // a different connection and leak the lock. The for-loop is sequential
          // (one dream at a time per replica), so at most one connection is parked.
          // Backstop: even if the lock drops mid-dream, the once/20h cognition_run
          // dedup below stops a second replica from re-dreaming (defense in depth).
          await this.prisma.$transaction(async (tx) => {
            await withGovernanceLock(tx, { orgId: sched.id, agentName: 'scheduled-dream' }, async () => {
              // Cross-replica + cross-restart once/day guard: a scheduled run started
              // in the last 20h means today's dream already happened (per-process
              // date map only guards one process). 20h < 24h so tomorrow isn't blocked.
              // H7: read the dedup row on the LOCKED tx connection, not the pooled
              // client — otherwise the once/20h check isn't serialized with the
              // advisory lock and a second replica can miss a just-committed run.
              const recent = tx.cognitionRun
                ? await tx.cognitionRun.findFirst({
                    where: { orgId: sched.id, trigger: 'scheduled', startedAt: { gte: new Date(Date.now() - 20 * 3600 * 1000) } },
                    select: { id: true },
                  }).catch(() => null)
                : null;
              if (recent) return; // already dreamed today
              this._lastScheduledDreamDate.set(sched.id, date);
              this.logger?.log?.(`[gov-scheduler] scheduled dream org=${sched.id.slice(0,8)} mode=${sched.mode} hour=${hour} lookback=${this.scheduleLookbackHours}h`);
              // skipCompaction:TRUE — never run destructive drift-compaction on the
              // auto scheduled path (§10 hazard). runOnce uses its own (pooled) prisma,
              // so the dream's writes don't block on the lock connection.
              await loop.runOnce(sched.id, { lookbackHours: this.scheduleLookbackHours, trigger: 'scheduled', skipCompaction: true });
              // Dream retention / fast-tier: evict dead dream vectors. Flag-gated off.
              if (process.env.DREAM_RETENTION_ENABLED === 'true' && typeof loop.dreamRetentionForOrg === 'function') {
                try {
                  const r = await loop.dreamRetentionForOrg(sched.id, { apply: true });
                  if (r?.evicted || r?.hardDeleted) this.logger?.log?.(`[gov-scheduler] retention org=${sched.id.slice(0,8)} evicted=${r.evicted} hardDeleted=${r.hardDeleted}`);
                } catch (rErr) {
                  this.logger?.warn?.(`[gov-scheduler] retention org=${sched.id.slice(0,8)} failed: ${rErr?.message || rErr}`);
                }
              }
            });
          }, { timeout: Number(process.env.COGNITION_SCHEDULE_TXN_TIMEOUT_MS || 35 * 60 * 1000), maxWait: 8000 });
        } catch (err) {
          if (err?.code === 'GOVERNANCE_LOCK_BUSY') continue; // other replica owns this org's dream
          this.logger?.warn?.(`[gov-scheduler] scheduled dream org=${sched.id.slice(0,8)} failed: ${err?.message || err}`);
        }
      }
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] scheduled-dream poll failed: ${err?.message || err}`);
    } finally {
      this.scheduleInFlight = false;
    }
  }

  // Per-org dream schedule rows (only cognition-enabled, real orgs).
  async _orgSchedules() {
    if (!this.prisma) return [];
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT o.id,
                COALESCE(o.cognition_schedule_mode, 'nightmode') AS mode,
                o.cognition_window_start_hour AS "startHour",
                o.cognition_window_end_hour   AS "endHour",
                COALESCE(o.cognition_schedule_tz, 'UTC') AS tz
           FROM hivemind.organizations o
          WHERE o.cognition_org_enabled = true
            AND (o.slug IS NULL OR o.slug NOT LIKE 'local-org-%')
          LIMIT 1000`
      );
      return Array.isArray(rows) ? rows.map(r => ({
        ...r,
        startHour: r.startHour == null ? null : Number(r.startHour),
        endHour: r.endHour == null ? null : Number(r.endHour),
      })) : [];
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] schedule read failed: ${err.message}`);
      return [];
    }
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

    // Scheduled deep-dream poll (flag-gated). Checks each org's window every
    // schedulePollMs and fires one wide-lookback dream/day inside it.
    if (this.scheduleEnabled) {
      this.logger?.log?.(`[gov-scheduler] scheduled-dream poll every ${this.schedulePollMs}ms (lookback=${this.scheduleLookbackHours}h)`);
      this.scheduleTimer = setInterval(() => this._maybeScheduledDream(), this.schedulePollMs);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.earlyTimer) clearInterval(this.earlyTimer);
    this.earlyTimer = null;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
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
        if (now - last < this.earlyCooldownMs) continue; // cheap per-process pre-filter
        let hot = [];
        try {
          hot = await this.clusterIndex.getDirtyClusters({ organizationId: o.id, minDirty: this.dirtyThreshold });
        } catch { hot = []; }
        if (!hot.length) continue;
        // H4: cross-replica cooldown is the AUTHORITATIVE gate — the per-process
        // Map above only saves a DB round-trip. Without this, each replica has its
        // own Map and both fire the same hot org (duplicate synthesis, wasted
        // tokens). Atomic claim via governance_agent_state (same idiom as the
        // run-manager cycle lock): only the replica that wins the row fires.
        const claimed = await this._claimEarlyDream(o.id);
        this._lastEarlyDream.set(o.id, now);
        if (!claimed) continue; // another replica already fired within the window
        if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
          this.logger?.log?.(`[gov-scheduler] early dream org=${o.id.slice(0,8)} — ${hot.length} hot cluster(s)`);
        }
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

  /**
   * H4: atomically claim the early-dream cooldown window for an org across
   * replicas. Reuses the governance_agent_state row idiom (agent_name keyed,
   * circuit_breaker_until as the cooldown expiry). The conditional ON CONFLICT
   * UPDATE only fires when no live claim exists, so exactly one replica wins.
   * @returns {Promise<boolean>} true if THIS replica won the window (should fire).
   */
  async _claimEarlyDream(orgId) {
    if (!this.prisma) return true; // no DB to coordinate (dev) → allow
    try {
      const until = new Date(Date.now() + this.earlyCooldownMs).toISOString();
      const affected = await this.prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.governance_agent_state
           (agent_name, circuit_breaker_until, updated_at)
         VALUES ($1, $2::timestamptz, now())
         ON CONFLICT (agent_name) DO UPDATE
           SET circuit_breaker_until = EXCLUDED.circuit_breaker_until,
               updated_at = now()
           WHERE governance_agent_state.circuit_breaker_until IS NULL
              OR governance_agent_state.circuit_breaker_until < now()`,
        `early-dream:${orgId}`,
        until,
      );
      return affected === 1;
    } catch (err) {
      // Fail OPEN — a stalled claim must not block dreaming entirely.
      this.logger?.warn?.(`[gov-scheduler] early-dream claim failed org=${orgId.slice(0,8)}: ${err.message}`);
      return true;
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
      // WS3: retroactive re-sweep on the slow (every-12-tick) cadence — temper
      // stale syntheses against late contradictions. Cheap (no LLM), capped.
      if (this.tickCount % 12 === 0) {
        const loop = typeof this.cognitionLoopRef === 'function' ? this.cognitionLoopRef() : null;
        if (loop && typeof loop.reweightStaleForOrg === 'function') {
          for (const o of orgs) {
            try {
              const n = await loop.reweightStaleForOrg(o.id);
              if (n) this.logger?.log?.(`[gov-scheduler] reweight org=${o.id.slice(0,8)} tempered=${n}`);
            } catch (err) {
              this.logger?.warn?.(`[gov-scheduler] reweight org=${o.id.slice(0,8)} failed: ${err?.message || err}`);
            }
          }
        }
        // Orphaned-cognition safety sweep (same slow cadence). The delete handlers
        // prune event-driven, but this catches orphans left by direct DB deletes
        // or any unwired delete path — a self-healing backstop.
        if (this.prisma && process.env.ORPHAN_SWEEP_ENABLED !== 'false') {
          try {
            const { sweepOrphanedCognition } = await import('../memory/orphan-pruner.js');
            for (const o of orgs) {
              const r = await sweepOrphanedCognition({ prisma: this.prisma, orgId: o.id, logger: this.logger });
              if (r.prunedIds?.length) this.logger?.log?.(`[gov-scheduler] orphan-sweep org=${o.id.slice(0,8)} pruned=${r.prunedIds.length}`);
            }
          } catch (err) {
            this.logger?.warn?.(`[gov-scheduler] orphan-sweep failed: ${err?.message || err}`);
          }
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
