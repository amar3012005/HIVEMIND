/**
 * SyncScheduler
 *
 * Runs incremental sync for all active connectors every N hours.
 * Each connector gets its own sync cycle. Errors are logged but never
 * stop the scheduler.
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min minimum

export class SyncScheduler {
  constructor({ connectorStore, syncEngine, prisma, interval = DEFAULT_INTERVAL_MS }) {
    this.connectorStore = connectorStore;
    this.syncEngine = syncEngine;
    this.prisma = prisma;
    this.interval = Math.max(interval, MIN_INTERVAL_MS);
    this._timer = null;
    this._running = false;
    this._lastRun = null;
    this._stats = { runs: 0, synced: 0, failed: 0, skipped: 0 };
  }

  start() {
    if (this._timer) return;
    console.log(`[sync-scheduler] Starting with ${this.interval / 60000}min interval`);
    // Run first sync after 30 seconds (let server warm up)
    setTimeout(() => this._tick(), 30000);
    this._timer = setInterval(() => this._tick(), this.interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getStats() {
    return { ...this._stats, lastRun: this._lastRun, running: this._running, intervalMs: this.interval };
  }

  async _tick() {
    if (this._running) return; // skip if previous run still going
    this._running = true;
    this._stats.runs++;
    this._lastRun = new Date().toISOString();

    try {
      // Find all active connectors across all users
      const connectors = await this.prisma.platformIntegration.findMany({
        where: { isActive: true, syncStatus: { not: 'revoked' } },
        select: { userId: true, platformType: true, targetScope: true },
      });

      console.log(`[sync-scheduler] Found ${connectors.length} active connectors`);

      for (const connector of connectors) {
        try {
          // Dynamically import the provider adapter
          const adapterModule = await import(`../providers/${connector.platformType}/adapter.js`);
          const AdapterClass = adapterModule.default || adapterModule.GmailAdapter || Object.values(adapterModule)[0];
          if (!AdapterClass) continue;

          const adapter = new AdapterClass();

          await this.syncEngine.runSync({
            adapter,
            userId: connector.userId,
            orgId: null, // resolved from connector
            provider: connector.platformType,
            incremental: true,
            targetScope: connector.targetScope || 'personal',
          });

          this._stats.synced++;
        } catch (err) {
          this._stats.failed++;
          console.warn(`[sync-scheduler] Sync failed for ${connector.platformType}:${connector.userId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error('[sync-scheduler] Tick failed:', err.message);
    } finally {
      this._running = false;
    }
  }
}
