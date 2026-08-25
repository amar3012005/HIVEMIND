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
  constructor({ connectorStore, syncEngine, prisma, tokenResolver = null, logger = console, interval = DEFAULT_GLOBAL_INTERVAL_MS }) {
    this.connectorStore = connectorStore;
    this.syncEngine = syncEngine;
    this.prisma = prisma;
    this.tokenResolver = tokenResolver;
    this.logger = logger;
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

      if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`[sync-scheduler] ${due.length}/${connectors.length} connectors due`);
      }

      // Provider → adapter path mapping. New per-service Google adapters
      // live under providers/google/{service}-adapter.js with different
      // export names + constructor dependencies (workspace-mcp bridge needs
      // prisma + decryptToken).
      // Adapter lookup table. Keys cover BOTH hyphen ('google-drive') and
      // underscore ('google_drive') forms so DB rows written by either
      // historical OAuth callback path resolve to the same adapter.
      const _googleDocsAdapter = { path: '../providers/google/drive-docs-adapter.js', exportName: 'GoogleDriveDocsAdapter', mcpBridge: true };
      const _googleCalAdapter  = { path: '../providers/google/calendar-adapter.js',   exportName: 'GoogleCalendarAdapter', mcpBridge: true };
      const _googleContAdapter = { path: '../providers/google/contacts-adapter.js',   exportName: 'GoogleContactsAdapter', mcpBridge: true };
      const ADAPTER_DISPATCH = {
        gmail:            { path: '../providers/gmail/adapter.js', exportName: 'GmailAdapter', mcpBridge: false },
        // Underscore form (legacy)
        google_drive:     _googleDocsAdapter,
        google_docs:      _googleDocsAdapter,
        google_sheets:    _googleDocsAdapter,
        google_slides:    _googleDocsAdapter,
        google_calendar:  _googleCalAdapter,
        google_contacts:  _googleContAdapter,
        // Hyphen form (canonical — matches connector catalog)
        'google-drive':    _googleDocsAdapter,
        'google-docs':     _googleDocsAdapter,
        'google-sheets':   _googleDocsAdapter,
        'google-slides':   _googleDocsAdapter,
        'google-calendar': _googleCalAdapter,
        'google-contacts': _googleContAdapter,
        slack:            { path: '../adapters/slack/slack-adapter.js',        exportName: 'SlackAdapter', nango: true },
        notion:           { path: '../adapters/notion/notion-adapter.js',      exportName: 'NotionAdapter', nango: true },
        github:           { path: '../adapters/github/github-adapter.js',      exportName: 'GitHubAdapter', nango: true },
        linear:           { path: '../adapters/linear/linear-adapter.js',      exportName: 'LinearAdapter', nango: true },
      };

      // Lazy-load decryptToken once for all MCP-bridged adapters
      let decryptTokenFn = null;
      let refreshOAuthTokenFn = null;

      for (const connector of due) {
        try {
          const dispatch = ADAPTER_DISPATCH[connector.platformType];
          let adapter;

          if (dispatch) {
            const adapterModule = await import(dispatch.path);
            const AdapterClass = adapterModule[dispatch.exportName]
              || adapterModule.default
              || Object.values(adapterModule).find(v => typeof v === 'function');
            if (!AdapterClass) {
              console.warn(`[sync-scheduler] No adapter export for ${connector.platformType}`);
              continue;
            }
            if (dispatch.nango) {
              adapter = new AdapterClass({
                providerKey: connector.platformType,
                tokenResolver: this.tokenResolver,
                prisma: this.prisma,
                logger: this.logger,
              });
            } else if (dispatch.mcpBridge) {
              if (!decryptTokenFn) {
                const cs = await import('./connector-store.js');
                decryptTokenFn = cs.decryptToken;
                refreshOAuthTokenFn = cs.refreshOAuthToken || null;
              }
              adapter = new AdapterClass({
                prisma: this.prisma,
                decryptToken: decryptTokenFn,
                refreshOAuthToken: refreshOAuthTokenFn,
              });
            } else {
              adapter = new AdapterClass();
            }
          } else {
            // Fallback: legacy dynamic path
            const adapterModule = await import(`../providers/${connector.platformType}/adapter.js`).catch(() => null);
            if (!adapterModule) continue;
            const AdapterClass = adapterModule.default
              || adapterModule.GmailAdapter
              || Object.values(adapterModule).find(v => typeof v === 'function');
            if (!AdapterClass) continue;
            adapter = new AdapterClass();
          }

          // PlatformIntegration rows carry no org column — resolve the user's
          // org membership so ingestion + Nango lookups are org-scoped instead
          // of passing a null orgId downstream (null used to crash the
          // NangoConnection lookup: "Argument orgId must not be null").
          let connectorOrgId = null;
          try {
            const membership = await this.prisma.userOrganization?.findFirst({
              where: { userId: connector.userId },
              select: { orgId: true },
            });
            connectorOrgId = membership?.orgId || null;
          } catch { /* org optional — personal-scope users have none */ }

          await this.syncEngine.runSync({
            adapter,
            userId: connector.userId,
            orgId: connectorOrgId,
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
