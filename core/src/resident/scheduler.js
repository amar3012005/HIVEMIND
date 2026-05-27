/**
 * Resident-agent scheduler.
 *
 * Phase 1: env-gated and OFF by default. When ENABLE_GOVERNANCE_SCHEDULER=true
 * AND a positive intervalMs is configured, fires Faraday → Feynman → Turing
 * on each tick. Until the env flag is set, .start() is a no-op so production
 * behavior is unchanged from V1.
 *
 * Concurrency is guarded by a Postgres advisory lock inside run-manager so
 * multiple hm-core instances can boot the scheduler without colliding.
 */

export class ResidentAgentScheduler {
  constructor({ runManager, intervalMs = 30 * 60 * 1000, logger = console } = {}) {
    this.runManager = runManager;
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
      if (typeof this.runManager?.runFullCycle === 'function') {
        await this.runManager.runFullCycle({ trigger: 'scheduler' });
      } else {
        this.logger?.warn?.('[gov-scheduler] run-manager has no runFullCycle, skipping tick');
      }
    } catch (err) {
      this.logger?.warn?.(`[gov-scheduler] tick failed: ${err?.message || err}`);
    } finally {
      this.tickInFlight = false;
    }
  }
}
