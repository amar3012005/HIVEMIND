/**
 * Optional resident-agent scheduler.
 * V1 keeps this deliberately minimal: the scheduler can be started later if
 * we want periodic Faraday sweeps, but on-demand runs are the product surface.
 */
export class ResidentAgentScheduler {
  constructor({ runManager, intervalMs = 0, logger = console } = {}) {
    this.runManager = runManager;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (!this.intervalMs || this.timer || !this.runManager) return;
    this.timer = setInterval(() => {
      // Future hook: schedule scoped scans here.
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
