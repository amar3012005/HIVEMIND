/**
 * Resident-agent scheduler.
 *
 * Phase 4: env-gated. When ENABLE_GOVERNANCE_SCHEDULER=true fires
 * Faraday → Feynman → Turing on each tick FOR EVERY ACTIVE ORG. Pulls
 * org list from prisma at tick time so newly onboarded tenants pick up
 * the cadence automatically.
 *
 * Concurrency is guarded by a row-level cycle lock inside run-manager.
 */

export class ResidentAgentScheduler {
  constructor({ runManager, prisma = null, intervalMs = 30 * 60 * 1000, logger = console } = {}) {
    this.runManager = runManager;
    this.prisma = prisma;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.enabled = process.env.ENABLE_GOVERNANCE_SCHEDULER === 'true';
    this.tickInFlight = false;
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
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      this.logger?.log?.(`[gov-scheduler] tick: ${orgs.length} org(s)`);
      for (const o of orgs) {
        try {
          const res = await this.runManager.runFullCycle({
            orgId: o.id,
            scope: 'organization',
            trigger: 'scheduler',
          });
          if (res?.status === 'skipped_lock_busy') {
            this.logger?.log?.(`[gov-scheduler] org=${o.id.slice(0,8)} busy — skipped`);
          }
        } catch (err) {
          this.logger?.warn?.(`[gov-scheduler] org=${o.id.slice(0,8)} failed: ${err?.message || err}`);
        }
      }
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] tick failed: ${err?.message || err}`);
    } finally {
      this.tickInFlight = false;
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
