/**
 * SyncScheduler
 *
 * Per-connector sync engine. Ticks every TICK_INTERVAL (1 min) and runs sync
 * for each connector whose due-time has elapsed. Each connector's cadence is:
 *
 *   syncIntervalMinutes column on platform_integrations (if set) — per-connector override
 *   OR global HIVEMIND_SYNC_INTERVAL_MS env (default 1 hour)
 *
 * Examples:
 *   syncIntervalMinutes = 15  → poll every 15 min (high-priority Gmail)
 *   syncIntervalMinutes = 1440 → poll once a day (low-priority Notion)
 *   syncIntervalMinutes = NULL → use global default
 *
 * Errors logged, never block scheduler. Skipped if previous tick still running.
 */

const TICK_INTERVAL_MS = 60 * 1000; // check every 1 min for due connectors
const DEFAULT_GLOBAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (was 4h)
const MIN_PER_CONNECTOR_MINUTES = 15;

export class SyncScheduler {
  constructor({ connectorStore, syncEngine, prisma, interval = DEFAULT_GLOBAL_INTERVAL_MS }) {
    this.connectorStore = connectorStore;
    this.syncEngine = syncEngine;
    this.prisma = prisma;
    this.globalInterval = Math.max(interval, MIN_PER_CONNECTOR_MINUTES * 60 * 1000);
    this._timer = null;
    this._running = false;
    this._lastRun = null;
    this._stats = { runs: 0, synced: 0, failed: 0, skipped: 0 };
  }

  start() {
    if (this._timer) return;
    console.log(`[sync-scheduler] Started — checks due connectors every ${TICK_INTERVAL_MS / 1000}s. Global cadence ${this.globalInterval / 60000}min (env override per connector via syncIntervalMinutes).`);
    // Run first tick after 30 seconds (let server warm up)
    setTimeout(() => this._tick(), 30000);
    this._timer = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getStats() {
    return {
      ...this._stats,
      lastRun: this._lastRun,
      running: this._running,
      globalIntervalMs: this.globalInterval,
      tickIntervalMs: TICK_INTERVAL_MS,
    };
  }

  _isDue(connector, now) {
    const lastRun = connector.lastSchedulerRunAt
      ? new Date(connector.lastSchedulerRunAt).getTime()
      : 0;
    const perConnectorMs = connector.syncIntervalMinutes
      ? Math.max(connector.syncIntervalMinutes, MIN_PER_CONNECTOR_MINUTES) * 60 * 1000
      : this.globalInterval;
    return now - lastRun >= perConnectorMs;
  }

  async _tick() {
    if (this._running) return;
    this._running = true;
    this._stats.runs++;
    this._lastRun = new Date().toISOString();

    try {
      const now = Date.now();
      const connectors = await this.prisma.platformIntegration.findMany({
        where: { isActive: true, syncStatus: { not: 'revoked' } },
        select: {
          userId: true,
          platformType: true,
          targetScope: true,
          syncIntervalMinutes: true,
          lastSchedulerRunAt: true,
        },
      });

      const due = connectors.filter(c => this._isDue(c, now));
      if (due.length === 0) {
        this._stats.skipped++;
        return; // nothing to do this tick
      }

      console.log(`[sync-scheduler] ${due.length}/${connectors.length} connectors due`);

      for (const connector of due) {
        try {
          const adapterModule = await import(`../providers/${connector.platformType}/adapter.js`);
          const AdapterClass = adapterModule.default
            || adapterModule.GmailAdapter
            || Object.values(adapterModule).find(v => typeof v === 'function');
          if (!AdapterClass) continue;

          const adapter = new AdapterClass();

          await this.syncEngine.runSync({
            adapter,
            userId: connector.userId,
            orgId: null,
            provider: connector.platformType,
            incremental: true,
            targetScope: connector.targetScope || 'personal',
          });

          // Stamp last-run regardless of outcome (avoids tight loops on errors)
          await this.prisma.platformIntegration.update({
            where: {
              userId_platformType: {
                userId: connector.userId,
                platformType: connector.platformType,
              },
            },
            data: { lastSchedulerRunAt: new Date() },
          });

          this._stats.synced++;
        } catch (err) {
          this._stats.failed++;
          console.warn(`[sync-scheduler] Sync failed for ${connector.platformType}:${connector.userId}: ${err.message}`);
          // Stamp anyway so we don't retry every minute
          try {
            await this.prisma.platformIntegration.update({
              where: {
                userId_platformType: {
                  userId: connector.userId,
                  platformType: connector.platformType,
                },
              },
              data: { lastSchedulerRunAt: new Date() },
            });
          } catch (_e) { /* noop */ }
        }
      }
    } catch (err) {
      console.error('[sync-scheduler] Tick failed:', err.message);
    } finally {
      this._running = false;
    }
  }
}
