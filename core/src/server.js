/**
 * HIVE-MIND Simple HTTP Server
 * Serves the client.html and provides REST API
 * 
 * Multi-tenant isolation: org_id, user_id, project scoping
 * Validation: Zod schemas for request validation
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(PROJECT_ROOT, '..');
const CORE_SCRIPTS_ROOT = path.join(PROJECT_ROOT, 'scripts');
const require = createRequire(import.meta.url);

function loadLocalEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv(path.join(PROJECT_ROOT, '.env'));

const { MemoryEngine } = await import('./engine.local.js');
const { getGroqClient } = await import('../config/groq.js');
const { getPrismaClient, ensureTenantContext } = await import('./db/prisma.js');
const { captureLogs, streamDockerLogs, getLogBuffer } = await import('./log-streamer.js');

// Start capturing logs for this container (hm-core)
captureLogs('hm-core');

const { MemoryGraphEngine } = await import('./memory/graph-engine.js');
const { getEnrichmentQueue } = await import('./memory/enrichment-queue.js');
const { PrismaGraphStore } = await import('./memory/prisma-graph-store.js');
const { CognitiveOperator, detectQueryIntent, computeDynamicWeights, getMemoryTypeBoost } = await import('./memory/operator-layer.js');
const { ContextAutopilot, scoreForRetention } = await import('./memory/context-autopilot.js');
const { BiTemporalEngine } = await import('./memory/bi-temporal.js');
const { StigmergicCoT } = await import('./memory/stigmergic-cot.js');
const { ByzantineConsensus } = await import('./memory/byzantine-consensus.js');
const { IngestTracker } = await import('./memory/ingest-tracker.js');
const { rewriteQuery } = await import('./search/query-rewriter.js');
const { deduplicateResults } = await import('./search/result-dedup.js');
const { queryPersistedMemories, recallPersistedMemories, crossClusterEntityBoost } = await import('./memory/persisted-retrieval.js');
const { ClusterIndex } = await import('./memory/cluster-index.js');
const { expandTemporalQuery } = await import('./search/time-aware-expander.js');
const {
  authenticatePersistedApiKey,
  createPersistedApiKey,
  hasEntitlement,
  hashApiKey: hashPersistedApiKey,
  resolveKeyAccess
} = await import('./auth/api-keys.js');
const { encryptToken, decryptToken } = await import('./connectors/framework/connector-store.js');
const {
  ControlPlaneSessionStore,
  buildSessionCookie,
  verifySessionCookie
} = await import('./control-plane/session-store.js');
const { ZitadelOidcClient } = await import('./control-plane/zitadel.js');
const { WebJobStore } = await import('./web/web-job-store.js');
const { BrowserRuntime, getTelemetry } = await import('./web/browser-runtime.js');
const { validateDomain, filterContent, UserRateLimiter, detectAbuse, getRobotsWarning, normalizeWebUrl } = await import('./web/web-policy.js');

// Derive a one-line title for a Tavily research report. Prefer the first
// non-empty H1/H2 in the markdown; fall back to the original input
// trimmed to a sane length.
function deriveResearchTitle(input, markdown) {
  if (typeof markdown === 'string') {
    const m = markdown.match(/^\s*#{1,2}\s+(.+?)\s*$/m);
    if (m?.[1] && m[1].length <= 140) return m[1].replace(/[*_`]/g, '').trim();
  }
  const fallback = (input || '').trim().replace(/\s+/g, ' ');
  return fallback.length > 120 ? fallback.slice(0, 117) + '…' : fallback;
}
const webRateLimiter = new UserRateLimiter({ maxPerMinute: 60, maxPerHour: 500 });
const { getQdrantClient } = await import('./vector/qdrant-client.js');
const { getQdrantCollections } = await import('./vector/collections.js');
const { MCPIngestionService } = await import('./connectors/mcp/service.js');
const {
  normalizeWebappPlatform,
  buildWebappContextResponse,
  buildWebappSavePayload,
  buildPromptEnvelope
} = await import('./integrations/webapp-middleware.js');
const {
  validateCreateMemory,
  validateSearchMemory,
  validateMemoryQueryParams,
  updateMemorySchema
} = await import('./api/validators/memory.validators.js');
const {
  installConsoleCapture,
  getRecentLogs,
  getLogSummary,
} = await import('./admin/live-log-store.js');
const { renderAdminLogsPage } = await import('./admin/logs-dashboard.js');

// Billing / usage tracking
const { UsageTracker } = await import('./billing/usage-tracker.js');
const { PlanStore } = await import('./billing/plan-store.js');
const { PlanEnforcer } = await import('./billing/plan-enforcer.js');

// Audit logging (Scale / Enterprise plans)
const { AuditLogger } = await import('./audit/audit-logger.js');

// Webhook notification system (Scale / Enterprise plans)
const { WebhookManager } = await import('./webhooks/webhook-manager.js');

// Smart type-aware ingest routing
const { SmartIngestRouter } = await import('./memory/smart-ingest-router.js');

// Connector sync scheduler
const { SyncScheduler } = await import('./connectors/framework/sync-scheduler.js');

// Three-Tier Retrieval imports
const { ThreeTierRetrieval } = await import('./external/search/three-tier-retrieval.js');

// Hosted MCP Service imports
const {
  createHostedApiClient,
  generateHostedServer,
  getConnectionContext,
  getHostedServerByToken,
  validateConnectionToken,
  revokeAllConnections,
  handleInitialize,
  handleToolsList,
  handleResourcesList,
  handlePromptsList,
  handleReadResource,
  handleGetPrompt,
  handleToolCall
} = await import('./mcp/hosted-service.js');

// Trail Executor imports
const { TrailExecutor } = await import('./executor/execution-loop.js');
const { ForceRouter } = await import('./executor/force-router.js');
const { TrailSelector } = await import('./executor/trail-selector.js');
const { ActionBinder } = await import('./executor/action-binder.js');
const { ToolRegistry } = await import('./executor/tool-registry.js');
const { ToolRunner } = await import('./executor/tool-runner.js');
const { OutcomeWriter } = await import('./executor/outcome-writer.js');
const { LeaseManager } = await import('./executor/lease-manager.js');
const { ChainMiner } = await import('./executor/chain-miner.js');
const { WeightUpdater } = await import('./executor/weight-updater.js');
const { PromotionMux } = await import('./executor/promotion-mux.js');
const { ReputationEngine } = await import('./executor/reputation-engine.js');
const { ParameterRegistry } = await import('./executor/parameter-registry.js');
const { Dashboard } = await import('./executor/dashboard.js');
const { MetaEvaluator } = await import('./executor/meta-evaluator.js');
const { InMemoryStore } = await import('./executor/stores/in-memory-store.js');
const { ResidentRunManager } = await import('./resident/run-manager.js');
const { createResidentRoutes } = await import('./resident/routes.js');

// Graph Hygiene Scanner
const { GraphHygieneScanner } = await import('./resident/graph-hygiene-scanner.js');
const { EnterpriseChatService } = await import('./enterprise/chat/service.js');
const { createEnterpriseChatRoutes } = await import('./enterprise/chat/routes.js');

// TARA Voice Agent imports
const { TaraStreamHandler } = await import('./tara/stream-handler.js');
const { TaraConfigStore } = await import('./tara/config-store.js');
const { SessionManager } = await import('./tara/session-manager.js');
const { SessionAnalytics } = await import('./tara/session-analytics.js');
const { isTaraRoute } = await import('./tara/routes.js');

// Phase 1: Document-Backed Memory Architecture
const { DocumentFirstIngestionService } = await import('./knowledge/document-first-ingestion.js');
const { EvidenceRetrievalService } = await import('./knowledge/evidence-retrieval.js');
const { parseWithDocling, chunkWithDocling } = await import('./knowledge/enterprise/docling-adapter.js');

// Session analytics instance (lazy init)
let taraAnalytics = null;

// Evaluation imports
const { RetrievalEvaluator } = await import('./external/evaluation/retrieval-evaluator.js');
const { TEST_QUERIES, getSampleQueries, getQueriesByCategory, getQueriesByDifficulty, getQueriesForDataset } = await import('./external/evaluation/test-dataset.js');
const { generateEvalQueries } = await import('./evaluation/auto-dataset-generator.js');

// Decision Intelligence imports
const { detectDecisionCandidate } = await import('./executor/decision/detect-heuristics.js');
const { classifyDecision } = await import('./executor/decision/classify-decision.js');
const { linkEvidence } = await import('./executor/decision/link-evidence.js');
const { storeDecision } = await import('./executor/decision/store-decision.js');
const { recallDecision } = await import('./executor/decision/recall-decision.js');
const { generateDecisionKey } = await import('./executor/decision/decision-key.js');
const { checkMerge } = await import('./executor/decision/merge-check.js');
const { scoreEvidence } = await import('./executor/decision/score-evidence.js');
const { assembleAnswer } = await import('./executor/decision/assemble-answer.js');

const CLIENT_HTML_CANDIDATES = [
  path.join(REPO_ROOT, 'client.html'),
  path.join(PROJECT_ROOT, 'client.html'),
  // Log streamer
  path.join(REPO_ROOT, 'log-streamer.html'),
  path.join(PROJECT_ROOT, 'log-streamer.html'),
];

const LOG_STREAMER_HTML_CANDIDATES = [
  path.join(PROJECT_ROOT, 'src', 'log-streamer.html'),
  path.join(REPO_ROOT, 'log-streamer.html'),
  path.join(PROJECT_ROOT, 'log-streamer.html'),
];
const UX_TEST_HTML_CANDIDATES = [
  path.join(REPO_ROOT, 'ui-testing.html'),
  path.join(PROJECT_ROOT, 'ui-testing.html')
];
const WEBAPP_WRAPPER_HTML_CANDIDATES = [
  path.join(REPO_ROOT, 'web', 'webapp-wrapper.html'),
  path.join(PROJECT_ROOT, 'web', 'webapp-wrapper.html')
];
const WEB_SDK_CANDIDATES = [
  path.join(REPO_ROOT, 'web', 'hivemind-web-sdk.js'),
  path.join(PROJECT_ROOT, 'web', 'hivemind-web-sdk.js')
];
const TAMPERMONKEY_USER_SCRIPT_CANDIDATES = [
  path.join(REPO_ROOT, 'scripts', 'tampermonkey-hivemind-web.user.js'),
  path.join(PROJECT_ROOT, 'scripts', 'tampermonkey-hivemind-web.user.js')
];
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const API_KEYS_FILE_PATH = path.join(DATA_DIR, 'api-keys.json');
const EVALUATION_REPORTS_DIR = path.join(DATA_DIR, 'evaluation-reports');
const OAUTH_CLIENTS_FILE_PATH = path.join(DATA_DIR, 'oauth-clients.json');
const OAUTH_REFRESH_TOKENS_FILE_PATH = path.join(DATA_DIR, 'oauth-refresh-tokens.json');

// Web Intelligence
const WEB_JOBS_FILE = path.join(DATA_DIR, 'web-jobs.json');
const webJobStore = new WebJobStore(WEB_JOBS_FILE);
const browserRuntime = new BrowserRuntime();
const WEB_SEARCH_DAILY_LIMIT = Number(process.env.HIVEMIND_WEB_SEARCH_DAILY_LIMIT || 50);
const WEB_CRAWL_DAILY_LIMIT = Number(process.env.HIVEMIND_WEB_CRAWL_DAILY_LIMIT || 100);

installConsoleCapture('core');

// Initialize memory engine with SQLite
const engine = new MemoryEngine('./hivemind.db');
const prisma = getPrismaClient();
const usageTracker = prisma ? new UsageTracker(prisma) : null;
const planStore = prisma ? new PlanStore(prisma) : null;
const planEnforcer = (prisma && planStore && usageTracker) ? new PlanEnforcer(prisma, planStore, usageTracker) : null;
const auditLogger = prisma ? new AuditLogger(prisma) : null;
const webhookManager = prisma ? new WebhookManager(prisma) : null;
const ingestTracker = new IngestTracker();
const persistentMemoryStore = prisma ? new PrismaGraphStore(prisma) : null;

// Lazy TeamStore singleton — used by all recall paths to build access_context
let _teamStoreCache = null;
let _teamStoreHooked = false;
async function getTeamStore() {
  if (!prisma) return null;
  if (_teamStoreCache) return _teamStoreCache;
  const mod = await import('./teams/team-store.js');
  _teamStoreCache = new mod.TeamStore(prisma);
  if (!_teamStoreHooked && typeof _teamStoreCache.onMembershipChange === 'function') {
    _teamStoreCache.onMembershipChange((userId, orgId) => {
      invalidateAccessContextCache(userId, orgId);
    });
    _teamStoreHooked = true;
  }
  return _teamStoreCache;
}

// Cached per-request access context: { projectIds, teamIds }
// Cache TTL 60s to avoid hitting DB on every recall in tight loops.
const _accessContextCache = new Map();
async function buildAccessContext(userId, orgId) {
  if (!userId || !orgId) return null;
  const key = `${userId}:${orgId}`;
  const cached = _accessContextCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const ts = await getTeamStore();
  if (!ts) return null;
  try {
    const [projectIds, teamIds] = await Promise.all([
      ts.accessibleProjectIds({ userId, orgId }),
      ts.accessibleTeamIds({ userId, orgId }),
    ]);
    const value = { projectIds, teamIds };
    _accessContextCache.set(key, { value, expiresAt: now + 60_000 });
    return value;
  } catch (err) {
    console.warn('[access-context] build failed:', err.message);
    return null;
  }
}

/**
 * Invalidate cached access context for a user.
 * Call after membership changes (team join/leave, project add/remove).
 */
export function invalidateAccessContextCache(userId, orgId) {
  if (!userId) return;
  const key = orgId ? `${userId}:${orgId}` : null;
  if (key) {
    _accessContextCache.delete(key);
  } else {
    for (const k of _accessContextCache.keys()) {
      if (k.startsWith(`${userId}:`)) _accessContextCache.delete(k);
    }
  }
}

const persistentMemoryEngine = persistentMemoryStore ? new MemoryGraphEngine({
  store: persistentMemoryStore,
  vectorStore: null, // Qdrant client injected after initialization (see below)
  predictCalibrate: true,
  predictCalibrateOptions: {
    strongMatchThreshold: 0.70,
    partialMatchThreshold: 0.50,
    sentenceNoveltyThreshold: 0.35,
    topK: 5,
    minSimilarityForComparison: 0.15
  }
}) : null;
// Enrichment queue — decouples LLM structured enrichment from save hot path.
// Concurrency-capped, idempotent via source_metadata.enrichment_status.
const enrichmentQueue = persistentMemoryEngine ? getEnrichmentQueue(persistentMemoryEngine) : null;
if (enrichmentQueue) {
  console.log(`[boot] EnrichmentQueue ready (concurrency=${enrichmentQueue.concurrency})`);
}

// External-ref store + entity resolver — Salesforce / cross-system memory.
const { ExternalRefStore } = await import('./memory/external-ref-store.js');
const { EntityResolver } = await import('./memory/entity-resolver.js');
const externalRefStore = prisma ? new ExternalRefStore({ prisma }) : null;
const entityResolver = prisma ? new EntityResolver({ prisma }) : null;
if (externalRefStore && entityResolver) {
  console.log('[boot] ExternalRefStore + EntityResolver ready');
}
const cognitiveOperator = persistentMemoryStore ? new CognitiveOperator({ store: persistentMemoryStore }) : null;
const biTemporalEngine = persistentMemoryStore ? new BiTemporalEngine({ store: persistentMemoryStore, prisma }) : null;
const stigmergicCoT = persistentMemoryStore ? new StigmergicCoT({ store: persistentMemoryStore, traceTTLMinutes: 30 }) : null;
const byzantineConsensus = new ByzantineConsensus({ commitThreshold: 80 });

// Profile store
const { ProfileStore } = await import('./memory/profile-store.js');
const profileStore = prisma ? new ProfileStore(prisma) : null;

// Smart ingest router (type-aware preprocessing + triple operator annotation)
let smartIngestRouter = null;
if (persistentMemoryStore) {
  smartIngestRouter = new SmartIngestRouter({ memoryStore: persistentMemoryStore });
  // Wire router into engine so EVERY ingestMemory() caller — including
  // direct callers that don't go through buildRoutedIngestPayloads — gets
  // canonical recall→operator inference→entity/temporal extraction. Opt-out
  // via { smartIngest: false } on the payload (used by re-entrant calls).
  if (persistentMemoryEngine && typeof persistentMemoryEngine.setSmartIngestRouter === 'function') {
    persistentMemoryEngine.setSmartIngestRouter(smartIngestRouter);
  }
}

// Graph Hygiene Scanner
let hygieneScanner = null;
if (persistentMemoryStore) {
  hygieneScanner = new GraphHygieneScanner(persistentMemoryStore, prisma);
}

// Scheduled connector sync
let syncScheduler = null;
// Shared module-level ConnectorStore — used by both the scheduler and the
// per-request handlers for /api/connectors/* dispatch. Single instance is
// safe because ConnectorStore is stateless (all state lives in Prisma).
// Hoisted Phase1 service handle (initialized lower, referenced by webhookProcessor)
let documentFirstIngestion = null;

// Hoisted Nango token resolver — used by syncScheduler + webhookProcessor
const nangoTokenResolver = async ({ userId, orgId, providerKey }) => {
  const { getConnectionId, fetchBearerFromNango } = await import('./connectors/mcp/nango-service.js');
  const connId = await getConnectionId({ userId, orgId, providerKey }, { db: prisma });
  if (!connId) throw new Error(`no nango connection for ${providerKey}`);
  return fetchBearerFromNango(providerKey, connId);
};

let connectorStore = null;
if (persistentMemoryEngine && persistentMemoryStore && prisma) {
  const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
  const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
  const schedulerConnStore = new ConnectorStore(prisma);
  connectorStore = schedulerConnStore;
  const schedulerSyncEngine = new SyncEngine({
    connectorStore: schedulerConnStore,
    memoryEngine: persistentMemoryEngine,
    memoryStore: persistentMemoryStore,
    prisma,
    smartIngestRouter,
    externalRefStore,
    entityResolver,
  });
  syncScheduler = new SyncScheduler({
    connectorStore: schedulerConnStore,
    syncEngine: schedulerSyncEngine,
    prisma,
    tokenResolver: nangoTokenResolver,
    logger: console,
    interval: Number(process.env.HIVEMIND_SYNC_INTERVAL_MS || 60 * 60 * 1000), // 1h default
  });
  syncScheduler.start();
}

// ─── WebhookProcessor boot ───────────────────────────────────────────────────
{
  const { WebhookProcessor } = await import('./connectors/framework/webhook-processor.js');
  const adapterRegistryModule = await import('./connectors/framework/adapter-registry.js');
  const adapterRegistry = adapterRegistryModule.default;

  // Self-register adapters (triggers registry.register at bottom of each file)
  await import('./connectors/adapters/notion/notion-adapter.js');
  await import('./connectors/adapters/slack/slack-adapter.js');
  await import('./connectors/adapters/github/github-adapter.js');
  await import('./connectors/adapters/linear/linear-adapter.js');
  await import('./connectors/adapters/jira/jira-adapter.js');
  await import('./connectors/adapters/confluence/confluence-adapter.js');

  const webhookProcessor = new WebhookProcessor({
    prisma,
    adapterRegistry,
    tokenResolver: nangoTokenResolver,
    smartIngestRouter,
    // Late-bound: documentFirstIngestion is initialized below; provide a
    // getter so the processor sees the populated reference at tick time.
    getDocumentFirstIngestion: () => documentFirstIngestion,
    logger: console,
    intervalMs: 5000,
  });
  webhookProcessor.start();
  console.log('[webhook-processor] started');
}

// ─── Cognition Loop (continuous synthesis + drift compaction) ────────────
// Hourly cron. Walks recent memories + edges, asks LLM for emergent insights,
// compresses oversized clusters into canonical summaries.
// Defaults to ON when prisma is wired. Opt out with ENABLE_COGNITION_LOOP=false
// (was opt-in; legacy ENABLE_COGNITION_LOOP=true still works).
const COGNITION_LOOP_ENABLED = process.env.ENABLE_COGNITION_LOOP !== 'false';
let cognitionLoop = null;
if (COGNITION_LOOP_ENABLED && prisma) {
  setImmediate(async () => {
    try {
      const { CognitionLoop } = await import('./memory/cognition-loop.js');
      cognitionLoop = new CognitionLoop({
        prisma,
        memoryGraphEngine: persistentMemoryEngine,
        persistentMemoryStore,
        logger: console,
      });
      cognitionLoop.start();
      console.log('[cognition] loop started');
    } catch (err) {
      console.warn('[cognition] init failed:', err.message);
    }
  });
}

// ─── Memory Promotion Jobs cron (Wave 5 / P1 #5) ────────────────────────────
// Late-resolution: documentFirstIngestion is initialized later (line ~1028).
// Use setImmediate so this block runs after module-init completes.
if (process.env.ENABLE_MEMORY_PROMOTION_JOBS === 'true' && prisma) {
  const PROMOTION_INTERVAL_MS = Number(process.env.PROMOTION_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
  const PROMOTION_BATCH = Number(process.env.PROMOTION_BATCH || 50);
  const STALE_AFTER_DAYS = Number(process.env.MEMORY_STALE_AFTER_DAYS || 90);
  const runPromotion = async () => {
    if (!documentFirstIngestion) {
      console.warn('[promotion-cron] documentFirstIngestion not yet initialized — skipping tick');
      return;
    }
    try {
      // Find segments without any linked memory_evidence_link — re-evaluate them
      const orphans = await prisma.knowledgeSegment.findMany({
        where: { memoryLinks: { none: {} } },
        select: { id: true, documentId: true, userId: true, orgId: true, content: true },
        take: PROMOTION_BATCH,
        orderBy: { createdAt: 'desc' },
      });
      let promoted = 0;
      for (const seg of orphans) {
        try {
          const result = await documentFirstIngestion._promoteMemories({
            documentId: seg.documentId,
            segments: [{ id: seg.id, content: seg.content, segmentIndex: 0 }],
            userId: seg.userId,
            orgId: seg.orgId,
            metadata: {},
            promotionStrategy: 'background_reevaluation',
          });
          promoted += result.memories.filter(m => m?.id).length;
        } catch (err) {
          console.warn(`[promotion-cron] segment ${seg.id} failed: ${err.message}`);
        }
      }
      // Mark memories without recent reinforcement as stale
      const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);
      const stale = await prisma.memory.updateMany({
        where: { isLatest: true, updatedAt: { lt: cutoff }, strength: { gt: 0.2 } },
        data: { strength: { decrement: 0.1 } },
      }).catch(() => ({ count: 0 }));
      globalThis.__hmMetrics = globalThis.__hmMetrics || {};
      globalThis.__hmMetrics.promotion_runs_total = (globalThis.__hmMetrics.promotion_runs_total || 0) + 1;
      globalThis.__hmMetrics.promotion_promoted_total = (globalThis.__hmMetrics.promotion_promoted_total || 0) + promoted;
      globalThis.__hmMetrics.promotion_stale_total = (globalThis.__hmMetrics.promotion_stale_total || 0) + (stale.count || 0);
      console.log(`[promotion-cron] ${orphans.length} orphan segments scanned, ${promoted} promoted, ${stale.count} memories aged`);
    } catch (err) {
      console.error('[promotion-cron] tick failed:', err.message);
    }
  };
  setTimeout(runPromotion, 10 * 60 * 1000); // first run +10min
  setInterval(runPromotion, PROMOTION_INTERVAL_MS);
  console.log(`[promotion-cron] scheduled — every ${PROMOTION_INTERVAL_MS / 3600000}h`);
}

// ─── Memory Synthesizer cron (P3 #21) ────────────────────────────────────────
if (process.env.ENABLE_MEMORY_SYNTHESIS === 'true' && prisma) {
  const SYNTH_INTERVAL_MS = Number(process.env.SYNTHESIS_INTERVAL_MS || 24 * 60 * 60 * 1000);
  let synthesizer = null;
  const runSynth = async () => {
    if (!persistentMemoryEngine) {
      console.warn('[memory-synth] memoryGraphEngine not ready');
      return;
    }
    try {
      if (!synthesizer) {
        const { MemorySynthesizer } = await import('./resident/memory-synthesizer.js');
        synthesizer = new MemorySynthesizer({ prisma, memoryGraphEngine: persistentMemoryEngine, logger: console });
      }
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const orgs = await prisma.memory.groupBy({
        by: ['orgId'],
        where: { deletedAt: null, isLatest: true, updatedAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { orgId: 'desc' } },
        take: 10,
      });
      let totalSynthesized = 0;
      for (const { orgId: oid } of orgs) {
        const n = await synthesizer.synthesizeForOrg(oid).catch(() => 0);
        totalSynthesized += n;
      }
      globalThis.__hmMetrics = globalThis.__hmMetrics || {};
      globalThis.__hmMetrics.synthesis_runs_total = (globalThis.__hmMetrics.synthesis_runs_total || 0) + 1;
      globalThis.__hmMetrics.synthesis_emitted_total = (globalThis.__hmMetrics.synthesis_emitted_total || 0) + totalSynthesized;
      console.log(`[memory-synth] ${orgs.length} orgs scanned, ${totalSynthesized} synthesis memories created`);
    } catch (err) {
      console.error('[memory-synth] tick failed:', err.message);
    }
  };
  setTimeout(runSynth, 20 * 60 * 1000);
  setInterval(runSynth, SYNTH_INTERVAL_MS);
  console.log(`[memory-synth] scheduled — every ${SYNTH_INTERVAL_MS / 3600000}h`);
}

// ─── Contradiction Scanner cron (Wave 5 / P1 5.2) ───────────────────────────
if (process.env.ENABLE_CONTRADICTION_SCAN === 'true' && prisma) {
  const CONTRADICTION_INTERVAL_MS = Number(process.env.CONTRADICTION_INTERVAL_MS || 24 * 60 * 60 * 1000);
  let contradictionScanner = null;
  const runContradictions = async () => {
    try {
      if (!contradictionScanner) {
        const { ContradictionScanner } = await import('./resident/contradiction-scanner.js');
        contradictionScanner = new ContradictionScanner({ prisma, logger: console });
      }
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const orgs = await prisma.memory.groupBy({
        by: ['orgId'],
        where: { deletedAt: null, isLatest: true, updatedAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { orgId: 'desc' } },
        take: 20,
      });
      let totalProposals = 0;
      let totalEmitted = 0;
      for (const { orgId: oid } of orgs) {
        try {
          const proposals = await contradictionScanner.scanForOrg(oid);
          if (proposals.length) {
            totalProposals += proposals.length;
            const written = await contradictionScanner.emitProposals(proposals);
            totalEmitted += written;
          }
        } catch (err) {
          console.warn(`[contradiction-cron] org ${oid} failed: ${err.message}`);
        }
      }
      globalThis.__hmMetrics = globalThis.__hmMetrics || {};
      globalThis.__hmMetrics.contradiction_runs_total = (globalThis.__hmMetrics.contradiction_runs_total || 0) + 1;
      globalThis.__hmMetrics.contradiction_emitted_total = (globalThis.__hmMetrics.contradiction_emitted_total || 0) + totalEmitted;
      console.log(`[contradiction-cron] ${orgs.length} orgs scanned, ${totalProposals} proposed, ${totalEmitted} Contradicts edges emitted`);
    } catch (err) {
      console.error('[contradiction-cron] tick failed:', err.message);
    }
  };
  setTimeout(runContradictions, 15 * 60 * 1000);
  setInterval(runContradictions, CONTRADICTION_INTERVAL_MS);
  console.log(`[contradiction-cron] scheduled — every ${CONTRADICTION_INTERVAL_MS / 3600000}h`);
}

// ─── Hygiene Scanner cron (P1 #7) ────────────────────────────────────────────
// Runs nightly across recently active tenants. Generates proposals only —
// nothing auto-executes (executeProposals still requires admin approval).
if (process.env.ENABLE_HYGIENE_CRON === 'true' && hygieneScanner && prisma) {
  const HYGIENE_INTERVAL_MS = Number(process.env.HYGIENE_INTERVAL_MS || 24 * 60 * 60 * 1000); // 24h
  const HYGIENE_USER_LIMIT = Number(process.env.HYGIENE_USER_LIMIT || 25);
  const runHygieneCron = async () => {
    try {
      // Fetch most-recently-active users by latest memory write
      const recent = await prisma.memory.groupBy({
        by: ['userId', 'orgId'],
        where: { deletedAt: null, isLatest: true },
        _max: { updatedAt: true },
        orderBy: { _max: { updatedAt: 'desc' } },
        take: HYGIENE_USER_LIMIT,
      });
      console.log(`[hygiene-cron] scanning ${recent.length} active tenants`);
      let totalProposals = 0;
      for (const { userId, orgId } of recent) {
        try {
          const { proposals } = await hygieneScanner.scan(userId, orgId, { limit: 100 });
          totalProposals += proposals.length;
        } catch (err) {
          console.warn(`[hygiene-cron] scan failed for ${userId}/${orgId}: ${err.message}`);
        }
      }
      // Cross-source entity resolution sweep (#8) — alongside hygiene
      if (process.env.ENABLE_ENTITY_EXTRACTION === 'true') {
        try {
          const { CrossSourceEntityResolver } = await import('./knowledge/cross-source-entity-resolver.js');
          const resolver = new CrossSourceEntityResolver({ prisma, logger: console });
          let totalMerged = 0;
          for (const { orgId: oid } of recent) {
            const merged = await resolver.resolveOrg(oid).catch(() => 0);
            totalMerged += merged;
          }
          console.log(`[entity-resolver] cross-source sweep merged ${totalMerged} entities`);
        } catch (err) {
          console.warn(`[entity-resolver] sweep failed: ${err.message}`);
        }
      }
      globalThis.__hmMetrics = globalThis.__hmMetrics || {};
      globalThis.__hmMetrics.hygiene_runs_total = (globalThis.__hmMetrics.hygiene_runs_total || 0) + 1;
      globalThis.__hmMetrics.hygiene_proposals_total = (globalThis.__hmMetrics.hygiene_proposals_total || 0) + totalProposals;
      console.log(`[hygiene-cron] done — ${totalProposals} proposals generated`);
    } catch (err) {
      console.error('[hygiene-cron] tick failed:', err.message);
    }
  };
  // First run after 5min (post-boot warm-up), then every interval
  setTimeout(runHygieneCron, 5 * 60 * 1000);
  setInterval(runHygieneCron, HYGIENE_INTERVAL_MS);
  console.log(`[hygiene-cron] scheduled — every ${HYGIENE_INTERVAL_MS / 3600000}h, top ${HYGIENE_USER_LIMIT} tenants`);
}

// ─── Audit logging helper ────────────────────────────────────────────────────
// Writes are always recorded regardless of plan tier. Plan gating now happens
// at the READ side (/v1/audit/logs, /v1/audit/export.csv) so paying customers
// see audit history while non-paying orgs still leave an immutable trail.
async function auditLog(event) {
  if (!auditLogger) return;
  try {
    await auditLogger.log(event);
  } catch {
    // Never let audit logging break the main flow
  }
}

// ─── Trail Executor Runtime ───────────────────────────────────────────────────
// Uses PrismaStore when available, falls back to InMemoryStore for dev/testing
let trailExecutor = null;
try {
  let executorStore;
  try {
    const { PrismaStore } = await import('./executor/stores/prisma-store.js');
    executorStore = prisma ? new PrismaStore(prisma) : new InMemoryStore();
  } catch {
    executorStore = new InMemoryStore();
  }

  const trailToolRegistry = new ToolRegistry();
  const trailToolRunner = new ToolRunner(trailToolRegistry);
  const forceRouter = new ForceRouter({
    forceWeights: {
      goalAttraction: 1.0,
      affordanceAttraction: 1.0,
      conflictRepulsion: 1.0,
      congestionRepulsion: 1.0,
      costRepulsion: 1.0,
    }
  });
  const leaseManager = new LeaseManager(executorStore);
  const trailSelector = new TrailSelector(executorStore, leaseManager, forceRouter);
  const actionBinder = new ActionBinder(trailToolRegistry);
  const outcomeWriter = new OutcomeWriter(executorStore);
  const weightUpdater = new WeightUpdater(executorStore);
  const promotionMux = new PromotionMux(executorStore);

  // Register initial tools (minimal V1 set)
  trailToolRegistry.register({
    name: 'graph_query',
    description: 'Query the knowledge graph for facts',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
      limit: { type: 'number', required: false, description: 'Max results' },
    },
    maxTokens: 5000,
    timeoutMs: 15000,
  });
  trailToolRegistry.register({
    name: 'http_request',
    description: 'Make an HTTP API request',
    params: {
      url: { type: 'string', required: true, description: 'Target URL' },
      method: { type: 'string', required: false, description: 'HTTP method' },
    },
    maxTokens: 10000,
    timeoutMs: 30000,
  });
  trailToolRegistry.register({
    name: 'write_observation',
    description: 'Write an observation to the operational graph',
    params: {
      kind: { type: 'string', required: true, description: 'Observation kind' },
      content: { type: 'string', required: true, description: 'Observation content' },
    },
    maxTokens: 2000,
    timeoutMs: 5000,
  });

  // Decision Intelligence tools
  trailToolRegistry.register({
    name: 'detect_decision_candidate',
    description: 'Heuristic scan for decision signals in content',
    params: {
      content: { type: 'string', required: true, description: 'Raw content to scan' },
      platform: { type: 'string', required: true, description: 'Source platform (gmail/slack/github)' },
    },
    maxTokens: 1000, timeoutMs: 5000,
  });
  trailToolRegistry.register({
    name: 'classify_decision',
    description: 'LLM-based decision confirmation and structured extraction',
    params: {
      content: { type: 'string', required: true, description: 'Content to classify' },
      platform: { type: 'string', required: true, description: 'Source platform' },
    },
    maxTokens: 2000, timeoutMs: 15000,
  });
  trailToolRegistry.register({
    name: 'link_evidence',
    description: 'Cross-platform evidence search for decision corroboration',
    params: {
      decision_statement: { type: 'string', required: true, description: 'Decision to find evidence for' },
    },
    maxTokens: 5000, timeoutMs: 15000,
  });
  trailToolRegistry.register({
    name: 'store_decision',
    description: 'Store a structured decision object with merge-on-key',
    params: {
      decision_statement: { type: 'string', required: true, description: 'The decision statement' },
      decision_type: { type: 'string', required: true, description: 'Type of decision' },
    },
    maxTokens: 2000, timeoutMs: 10000,
  });
  trailToolRegistry.register({
    name: 'recall_decision',
    description: 'Provenance-aware decision retrieval',
    params: {
      query: { type: 'string', required: true, description: 'Natural language recall query' },
    },
    maxTokens: 5000, timeoutMs: 10000,
  });

  // ─── Register real tool executors ──────────────────────────────────────────

  // write_observation — writes to op/observations (self-reporting)
  trailToolRunner.register('write_observation', async (params) => {
    const id = crypto.randomUUID();
    const obs = {
      id,
      agent_id: params._agentId || 'unknown',
      kind: params.kind,
      content: typeof params.content === 'string' ? { text: params.content } : params.content,
      certainty: params.certainty ?? 0.7,
      source_event_id: params._eventId || null,
      related_to_trail: params._trailId || null,
    };
    if (executorStore.writeObservation) {
      await executorStore.writeObservation(obs);
    }
    return { observation_id: id, kind: params.kind, status: 'written', done: true };
  });

  // graph_query — read-only search of canonical knowledge (kg/*)
  trailToolRunner.register('graph_query', async (params) => {
    if (!persistentMemoryStore) {
      return { results: [], error: 'Memory store unavailable' };
    }
    const results = await persistentMemoryStore.searchMemories({
      query: params.query,
      n_results: Math.min(params.limit || 5, 20),
    });
    return {
      results: results.map((r) => ({
        id: r.id,
        content: r.content?.substring(0, 500),
        score: r.score,
        tags: r.tags,
        memory_type: r.memory_type,
      })),
      count: results.length,
    };
  });

  // http_request — sandboxed external HTTP (allowlist, timeout, size cap)
  trailToolRunner.register('http_request', async (params) => {
    const url = params.url;
    if (!url || typeof url !== 'string') {
      return { error: 'url is required' };
    }
    // Safety: reject internal targets
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname) ||
        parsed.hostname.endsWith('.internal')) {
      return { error: 'Internal targets not allowed' };
    }
    const method = (params.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      return { error: 'Only GET and HEAD methods allowed in V1' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, { method, signal: controller.signal });
      const text = await resp.text();
      return {
        status: resp.status,
        body: text.substring(0, 2000),
        content_type: resp.headers.get('content-type'),
      };
    } catch (err) {
      return { error: err.message };
    } finally {
      clearTimeout(timeout);
    }
  });

  // Decision tool executors
  trailToolRunner.register('detect_decision_candidate', async (params) => {
    return detectDecisionCandidate({
      content: params.content,
      platform: params.platform,
      metadata: params.metadata || {},
    });
  });

  trailToolRunner.register('classify_decision', async (params) => {
    return classifyDecision({
      content: params.content,
      platform: params.platform,
      context: { signals: params.signals || [], thread_context: params.thread_context },
    }, groqClient);
  });

  trailToolRunner.register('link_evidence', async (params) => {
    const result = await linkEvidence({
      decision_statement: params.decision_statement,
      tags: params.tags || [],
      source_platform: params.source_platform || 'unknown',
      scope: params.scope,
    }, persistentMemoryStore);

    // LLM-based evidence relevance scoring
    if (groqClient?.isAvailable() && result.supporting?.length > 0) {
      try {
        const scored = await scoreEvidence(
          params.decision_statement,
          result.supporting.map(e => ({ id: e.ref_id, content: e.snippet, platform: e.platform })),
          groqClient
        );
        result.supporting = result.supporting.filter((e, i) => {
          const score = scored.find(s => s.id === e.ref_id || scored.indexOf(s) === i);
          return score ? score.llm_relevant !== false : true;
        });
        // Recalculate evidence strength with LLM scores
        if (scored.length > 0) {
          const avgStrength = scored.reduce((s, e) => s + (e.llm_strength || 0.5), 0) / scored.length;
          result.evidence_strength = Math.min(result.evidence_strength, avgStrength);
        }
      } catch { /* best-effort scoring */ }
    }

    return result;
  });

  trailToolRunner.register('store_decision', async (params) => {
    const dKey = generateDecisionKey(
      params.scope?.project || 'default',
      params.decision_type || 'choice',
      params.decision_statement,
    );
    const decisionObject = {
      decision_key: dKey,
      decision_statement: params.decision_statement,
      decision_type: params.decision_type || 'choice',
      rationale: params.rationale,
      alternatives_rejected: params.alternatives_rejected || [],
      participants: params.participants || [],
      evidence: params.evidence || { supporting: [], conflicting: [] },
      confidence: params.confidence || 0.5,
      evidence_strength: params.evidence_strength || 0,
      source_platform: params.source_platform || 'unknown',
      tags: params.tags || [],
      scope: params.scope,
      detected_at: new Date().toISOString(),
    };

    // LLM-based cross-platform merge check
    if (groqClient?.isAvailable() && persistentMemoryStore && decisionObject.decision_statement) {
      try {
        const existingMemories = await persistentMemoryStore.searchMemories({
          query: decisionObject.decision_statement,
          memory_type: 'decision',
          n_results: 10,
        });
        const existingDecisions = existingMemories
          .filter(m => m.metadata?.decision_statement)
          .map(m => ({ id: m.id, decision_statement: m.metadata.decision_statement, scope: m.metadata?.scope }));

        if (existingDecisions.length > 0) {
          const mergeResult = await checkMerge(
            decisionObject.decision_statement,
            existingDecisions,
            groqClient
          );
          if (mergeResult.is_same_decision && mergeResult.matches_id) {
            decisionObject._mergeTargetId = mergeResult.matches_id;
            decisionObject._mergeRelationship = mergeResult.relationship;
            decisionObject._mergeConfidence = mergeResult.confidence;
          }
        }
      } catch { /* merge check is best-effort */ }
    }

    return storeDecision({ decision_object: decisionObject }, persistentMemoryStore);
  });

  trailToolRunner.register('recall_decision', async (params) => {
    const result = await recallDecision({
      query: params.query,
      scope: params.scope,
      project: params.project,
      top_k: params.top_k || 5,
    }, persistentMemoryStore);

    // LLM answer assembly
    if (groqClient?.isAvailable() && result.decisions?.length > 0 && params.query) {
      try {
        result.assembled_answer = await assembleAnswer(params.query, result.decisions, groqClient);
      } catch { /* best-effort assembly */ }
    }

    return result;
  });

  const reputationEngine = new ReputationEngine(executorStore);

  trailExecutor = new TrailExecutor({
    trailSelector,
    actionBinder,
    toolRunner: trailToolRunner,
    outcomeWriter,
    leaseManager,
    weightUpdater,
    promotionMux,
    reputationEngine,
    store: executorStore,
  });
  trailExecutor._store = executorStore;
  trailExecutor._toolRegistry = trailToolRegistry;
  trailExecutor._toolRunner = trailToolRunner;

  const chainMiner = new ChainMiner(executorStore, {
    minOccurrences: 3,
    minSuccessRate: 0.9,
    maxAvgLatencyMs: 5000,
    lookbackRuns: 50,
    autoActivate: true,
  });
  trailExecutor._chainMiner = chainMiner;
  trailExecutor._reputationEngine = reputationEngine;

  const parameterRegistry = new ParameterRegistry(executorStore);
  parameterRegistry.seedDefaults().catch(err => console.warn('[ParameterRegistry] Seed failed:', err.message));
  trailExecutor._parameterRegistry = parameterRegistry;

  const dashboard = new Dashboard(executorStore);
  trailExecutor._dashboard = dashboard;

  const metaEvaluator = new MetaEvaluator(executorStore, parameterRegistry);
  trailExecutor._metaEvaluator = metaEvaluator;

  // Seed decision intelligence trails (idempotent — trails are checked by goalId)
  const decisionTrails = [
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['gmail', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['slack', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'detect_decision_candidate', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['github', 'detect'], weight: 0.75, confidence: 0.8 },
    { goalId: 'capture_decision', tool: 'classify_decision', params: { content: '$ctx.rawContent', platform: '$ctx.platform' }, tags: ['classify'], weight: 0.7, confidence: 0.7 },
    { goalId: 'capture_decision', tool: 'link_evidence', params: { decision_statement: '$ctx.decision_statement' }, tags: ['link', 'evidence'], weight: 0.65, confidence: 0.7 },
    { goalId: 'capture_decision', tool: 'store_decision', params: { decision_statement: '$ctx.decision_statement', decision_type: '$ctx.decision_type' }, tags: ['store', 'decision'], weight: 0.6, confidence: 0.7 },
    { goalId: 'recall_decision', tool: 'recall_decision', params: { query: '$ctx.query' }, tags: ['recall', 'query'], weight: 0.8, confidence: 0.8 },
    { goalId: 'recall_decision', tool: 'recall_decision', params: { query: '$ctx.query', project: '$ctx.project' }, tags: ['recall', 'scope'], weight: 0.75, confidence: 0.8 },
  ];

  for (const t of decisionTrails) {
    const existing = await executorStore.getCandidateTrails(t.goalId);
    const alreadyExists = existing.some(e => e.nextAction?.tool === t.tool && JSON.stringify(e.tags) === JSON.stringify(t.tags));
    if (!alreadyExists) {
      await executorStore.putTrail({
        id: crypto.randomUUID(),
        goalId: t.goalId,
        agentId: 'system',
        status: 'active',
        kind: 'raw',
        nextAction: { tool: t.tool, paramsTemplate: t.params },
        steps: [],
        executionEventIds: [],
        successScore: 0,
        confidence: t.confidence,
        weight: t.weight,
        decayRate: 0.05,
        tags: t.tags,
        createdAt: new Date().toISOString(),
      });
    }
  }
  console.log('[DecisionIntelligence] Decision tools registered, trails seeded');

  console.log('[TrailExecutor] Cognitive runtime initialized',
    executorStore.constructor.name === 'PrismaStore' ? '(Prisma persistence)' : '(in-memory)');
} catch (err) {
  console.warn('[TrailExecutor] Failed to initialize:', err.message);
}
const residentRunManager = new ResidentRunManager({
  store: trailExecutor?._store || new InMemoryStore(),
  graphStore: persistentMemoryStore,
  reputationEngine: trailExecutor?._reputationEngine || null,
  chainMiner: trailExecutor?._chainMiner || null,
  logger: console,
});
residentRunManager.seedAgents().catch((error) => {
  console.warn('[Resident] Failed to seed resident agents:', error.message);
});
const residentRoutes = createResidentRoutes(residentRunManager);
const enterpriseChatService = persistentMemoryStore ? new EnterpriseChatService({
  memoryStore: persistentMemoryStore,
}) : null;
const enterpriseChatRoutes = createEnterpriseChatRoutes(enterpriseChatService);
const taraHandler = persistentMemoryStore ? new TaraStreamHandler({
  memoryStore: persistentMemoryStore,
  recallFn: recallPersistedMemories,
  qdrantClient: null, // Set after qdrantClient init
  llmBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  llmApiKey: process.env.GROQ_API_KEY || '',
  defaultModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
}) : null;
const contextAutopilot = persistentMemoryStore ? new ContextAutopilot({
  store: persistentMemoryStore,
  maxContextTokens: 128_000,
  compactionThreshold: 0.80,
  criticalMemoryCount: 15
}) : null;
const qdrantClient = getQdrantClient();
const qdrantCollections = getQdrantCollections();
const groqClient = getGroqClient();

// Inject qdrantClient into TARA handler (created before qdrantClient was available)
if (taraHandler) taraHandler.qdrantClient = qdrantClient;

// Inject qdrantClient into MemoryGraphEngine for semantic similarity during ingestion
// (triple operator detection: Updates/Extends/Derives need vector search, not just FTS)
if (persistentMemoryEngine) persistentMemoryEngine.vectorStore = qdrantClient;

// ─── Phase 1: Document-Backed Memory Services ───────────────────────────────────
// Feature-flagged: enabled via ENABLE_DOCUMENT_FIRST_INGEST and ENABLE_EVIDENCE_RECALL env vars
let evidenceRetrieval = null;

// Docling adapter wrapper: converts buffer→file→parse→cleanup
let doclingAdapter = null;
if (process.env.DOCLING_URL) {
  doclingAdapter = {
    parseBuffer: async (fileBuffer, { filename, contentType, smart = false, picture_descriptions = false } = {}) => {
      const tempDir = '/tmp/hivemind-docling';
      fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, `${crypto.randomUUID()}_${filename}`);

      try {
        fs.writeFileSync(tempPath, fileBuffer);
        const ext = (filename || '').split('.').pop()?.toLowerCase();
        const tParse = Date.now();

        // ── Audio (mp3/wav/m4a/ogg/flac) → Groq Whisper transcription ──
        if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext) && process.env.GROQ_API_KEY) {
          try {
            const fd = new FormData();
            fd.append('file', new Blob([fs.readFileSync(tempPath)]), filename);
            fd.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
            fd.append('response_format', 'verbose_json');
            const wRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
              body: fd,
              signal: AbortSignal.timeout(180_000),
            });
            if (!wRes.ok) throw new Error(`Whisper ${wRes.status}: ${(await wRes.text()).slice(0, 200)}`);
            const wJson = await wRes.json();
            const transcript = wJson.text || '';
            const segments = Array.isArray(wJson.segments) ? wJson.segments : [];
            // One chunk per Whisper segment so timestamps survive into memory.
            const hybridChunks = segments.length
              ? segments.map(s => ({
                  text: s.text.trim(),
                  headings: [`${Math.round(s.start)}s–${Math.round(s.end)}s`],
                  page: 1,
                }))
              : [{ text: transcript.trim(), headings: [filename], page: 1 }];
            console.log(`[docling-adapter] tier=whisper file=${filename} chars=${transcript.length} segs=${hybridChunks.length} ms=${Date.now() - tParse}`);
            return {
              text: transcript, markdown: transcript, json: { segments: wJson.segments, language: wJson.language },
              tables: [], pages: 1, confidence: null, error: null,
              hybridChunks, chunkerError: null, engine: 'groq-whisper',
            };
          } catch (audioErr) {
            console.warn(`[docling-adapter] whisper failed: ${audioErr.message}`);
          }
        }

        // ── Plain text (txt/md/markdown/html) → skip Docling entirely ──
        // Saves the 2s Docling round-trip on already-readable formats.
        if (['txt', 'md', 'markdown', 'html', 'htm'].includes(ext)) {
          try {
            const raw = fileBuffer.toString('utf-8');
            if (raw.length > 0) {
              const CHUNK = 1500;
              const OVERLAP = 200;
              const hybridChunks = [];
              // Split on headings (markdown # or ## or ###); fall back to size.
              const headingRe = /^(#{1,6})\s+(.+)$/m;
              if (headingRe.test(raw)) {
                const parts = raw.split(/^(#{1,6}\s+.+)$/m);
                let curHeading = filename;
                for (const part of parts) {
                  if (!part || !part.trim()) continue;
                  const m = part.match(/^(#{1,6})\s+(.+)$/);
                  if (m) { curHeading = m[2].trim().slice(0, 120); continue; }
                  hybridChunks.push({ text: part.trim(), headings: [curHeading], page: 1 });
                }
              } else {
                for (let i = 0; i < raw.length; i += (CHUNK - OVERLAP)) {
                  const piece = raw.slice(i, i + CHUNK).trim();
                  if (piece.length < 20) continue;
                  hybridChunks.push({ text: piece, headings: [filename], page: 1 });
                }
                if (!hybridChunks.length && raw.trim().length >= 1) {
                  hybridChunks.push({ text: raw.trim(), headings: [filename], page: 1 });
                }
              }
              console.log(`[docling-adapter] tier=plain-text file=${filename} chars=${raw.length} chunks=${hybridChunks.length} ms=${Date.now() - tParse}`);
              return {
                text: raw, markdown: raw, json: null,
                tables: [], pages: 1, confidence: null, error: null,
                hybridChunks, chunkerError: null, engine: 'plain-text',
              };
            }
          } catch (txtErr) {
            console.warn(`[docling-adapter] plain-text parse failed: ${txtErr.message}`);
          }
        }

        // ── Image-only files (PNG/JPG/TIFF/WebP) → direct Groq vision OCR ──
        // Cheaper + faster than full Docling pipeline for a single bitmap.
        if (['png', 'jpg', 'jpeg', 'tiff', 'tif', 'webp'].includes(ext) && process.env.GROQ_API_KEY) {
          try {
            const { ocrSingleImage } = await import('./knowledge/enterprise/groq-vision-parser.js');
            if (typeof ocrSingleImage === 'function') {
              const out = await ocrSingleImage(tempPath);
              if (!out.error && out.text.length > 20) {
                console.log(`[docling-adapter] tier=image-vision file=${filename} chars=${out.text.length} ms=${Date.now() - tParse}`);
                return {
                  text: out.text, markdown: out.markdown || out.text, json: null,
                  tables: [], pages: 1, confidence: null, error: null,
                  hybridChunks: [{ text: out.text, headings: [filename], page: 1 }],
                  chunkerError: null, engine: 'groq-image',
                };
              }
            }
          } catch (imgErr) {
            console.warn(`[docling-adapter] image vision failed: ${imgErr.message} — falling through to Docling`);
          }
        }

        // ── CSV/TSV → row-as-segment (no LLM, structure-preserving) ──
        if (['csv', 'tsv'].includes(ext)) {
          try {
            const raw = fileBuffer.toString('utf-8');
            const delim = ext === 'tsv' ? '\t' : ',';
            const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
            if (lines.length > 0) {
              const headers = lines[0].split(delim).map(h => h.trim());
              const hybridChunks = [];
              for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(delim);
                const row = headers.map((h, j) => `${h}: ${(cols[j] || '').trim()}`).join('\n');
                hybridChunks.push({
                  text: row,
                  headings: [`Row ${i}`],
                  page: 1,
                });
              }
              console.log(`[docling-adapter] tier=csv file=${filename} rows=${hybridChunks.length} ms=${Date.now() - tParse}`);
              return {
                text: raw, markdown: raw, json: { headers, rowCount: hybridChunks.length },
                tables: [{ sheet: 'sheet1', headers, rows: lines.slice(1).map(l => l.split(delim)) }],
                pages: 1, confidence: null, error: null,
                hybridChunks, chunkerError: null, engine: 'csv-direct',
              };
            }
          } catch (csvErr) {
            console.warn(`[docling-adapter] csv parse failed: ${csvErr.message}`);
          }
        }

        // ── Tier 1: pdf-parse (text-native PDFs, 1-2s) — skip when smart=true ──
        if (ext === 'pdf' && !smart) {
          try {
            const { fastPdfExtract } = await import('./knowledge/enterprise/fast-pdf-parser.js');
            const fast = await fastPdfExtract(tempPath);
            if (!fast.error && !fast.isImageHeavy && fast.text.length > 200) {
              // Page-aware chunking: pdf-parse v2 inserts `-- N of M --` page markers.
              // Split by page → smaller mid-page chunks (~1500 chars) so segments
              // map cleanly to pages. Heading derived from first line of each page.
              let hybridChunks = [];
              try {
                const PAGE_SPLIT = /\n?-- (\d+) of \d+ --\n?/;
                const parts = fast.text.split(PAGE_SPLIT);
                // parts = [pre, '1', 'pageText', '2', 'pageText', ...]
                const pageBlocks = [];
                for (let i = 1; i < parts.length; i += 2) {
                  const pageNum = Number(parts[i]);
                  const pageText = (parts[i + 1] || '').trim();
                  if (pageText.length < 20) continue;
                  pageBlocks.push({ page: pageNum, text: pageText });
                }
                // Fallback: no page markers → treat whole doc as one block
                if (pageBlocks.length === 0) {
                  pageBlocks.push({ page: 1, text: fast.text.trim() });
                }
                const CHUNK_TARGET = 1500;
                const CHUNK_OVERLAP = 200;
                // Heading detector: skip running-header/footer noise (date stamps,
                // doc IDs, "Technische Änderungen", etc.) and pick first
                // semantically interesting line.
                const NOISE_RE = /^(dokument[-\s]?nr|technische|preisliste|seite|page|stand|art\.?-nr|©|copyright|all rights|alle rechte|tabelle|table\b)/i;
                const looksLikeRunningText = (l) => l.length >= 10 && l.length <= 100 && !NOISE_RE.test(l.trim()) && /[a-zA-ZäöüÄÖÜß]/.test(l);
                for (const block of pageBlocks) {
                  const lines = block.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                  // Prefer a line that looks like a title (short, non-noise);
                  // fall back to first non-empty line, then "Page N".
                  let heading = lines.find(looksLikeRunningText) || lines[0] || `Page ${block.page}`;
                  heading = heading.slice(0, 120);
                  if (block.text.length <= CHUNK_TARGET) {
                    hybridChunks.push({ text: block.text, headings: [heading], page: block.page });
                  } else {
                    for (let i = 0; i < block.text.length; i += (CHUNK_TARGET - CHUNK_OVERLAP)) {
                      const piece = block.text.slice(i, i + CHUNK_TARGET).trim();
                      if (piece.length < 50) continue;
                      hybridChunks.push({
                        text: piece,
                        headings: [heading],
                        page: block.page,
                      });
                    }
                  }
                }
              } catch (chkErr) {
                console.warn(`[fast-pdf] page-chunk failed: ${chkErr.message}`);
              }
              console.log(`[docling-adapter] tier=fast-pdf file=${filename} pages=${fast.pages} chars=${fast.text.length} chunks=${hybridChunks.length} ms=${Date.now() - tParse}`);
              return {
                text: fast.text, markdown: fast.text, json: null,
                tables: [], pages: fast.pages, confidence: null, error: null,
                hybridChunks, chunkerError: null, engine: 'pdf-parse',
              };
            }
            // ── Tier 3: Groq vision OCR (image-heavy PDFs) ──
            if (fast.isImageHeavy && process.env.GROQ_API_KEY && !smart) {
              const { parsePdfWithGroqVision } = await import('./knowledge/enterprise/groq-vision-parser.js');
              const vision = await parsePdfWithGroqVision(tempPath);
              if (!vision.error && vision.text.length > 200) {
                console.log(`[docling-adapter] tier=groq-vision file=${filename} pages=${vision.pages} chars=${vision.text.length} ms=${Date.now() - tParse}`);
                return {
                  text: vision.text, markdown: vision.markdown, json: null,
                  tables: [], pages: vision.pages, confidence: null, error: null,
                  hybridChunks: [], chunkerError: null, engine: 'groq-vision',
                };
              }
              console.warn(`[docling-adapter] groq-vision failed: ${vision.error || 'empty'} — falling back to Docling`);
            }
          } catch (tierErr) {
            console.warn(`[docling-adapter] tier1/3 error: ${tierErr.message}`);
          }
        }

        // ── Tier 2: Docling (smart=true via enterprise upload only) ──
        const useSmart = smart === true;
        const [parseResult, chunkResult] = await Promise.all([
          parseWithDocling(tempPath, filename, { smart: useSmart, picture_descriptions }),
          chunkWithDocling(tempPath, filename).catch(e => ({ chunks: [], error: e.message })),
        ]);
        console.log(`[docling-adapter] tier=docling file=${filename} smart=${useSmart} chunks=${chunkResult?.chunks?.length || 0} ms=${Date.now() - tParse} parseError=${parseResult?.error || 'none'} chunkerError=${chunkResult?.error || 'none'}`);
        // Smart-mode timeout fallback: if Docling failed AND we still have a
        // PDF, try Tier 1 fast-pdf so the upload isn't lost.
        if ((parseResult?.error || (parseResult?.text || '').length < 200) && ext === 'pdf') {
          try {
            const { fastPdfExtract } = await import('./knowledge/enterprise/fast-pdf-parser.js');
            const fb = await fastPdfExtract(tempPath);
            if (!fb.error && fb.text.length > 200) {
              console.warn(`[docling-adapter] tier=docling failed/empty → falling back to fast-pdf for ${filename}`);
              return {
                text: fb.text, markdown: fb.text, json: null,
                tables: [], pages: fb.pages, confidence: null, error: null,
                hybridChunks: chunkResult?.chunks?.length ? chunkResult.chunks : [],
                chunkerError: chunkResult?.error || null,
                engine: 'docling-fallback-fastpdf',
              };
            }
          } catch (fbErr) {
            console.warn(`[docling-adapter] fallback fast-pdf also failed: ${fbErr.message}`);
          }
        }
        return {
          ...parseResult,
          hybridChunks: chunkResult?.chunks || [],
          chunkerError: chunkResult?.error || null,
        };
      } finally {
        // Cleanup temp file
        try {
          fs.unlinkSync(tempPath);
        } catch (cleanupErr) {
          console.warn('[Docling] Failed to cleanup temp file:', cleanupErr.message);
        }
      }
    }
  };
  console.log('[Phase1] Docling adapter enabled');
}

if (process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true' && prisma && persistentMemoryStore && persistentMemoryEngine) {
  try {
    documentFirstIngestion = new DocumentFirstIngestionService({
      db: prisma,
      smartIngestRouter,
      memoryGraphEngine: persistentMemoryEngine,
      doclingAdapter, // Pass Docling adapter if DOCLING_URL is set, null otherwise
      embeddingService: {
        embed: async (text) => {
          // Use the existing Qdrant client's embedding pipeline
          return qdrantClient.generateEmbedding(String(text).slice(0, 8000));
        },
        storeVector: async ({ collectionName, id, vector, payload }) => {
          // qdrantClient has no .upsert() method — call REST endpoint directly
          const qUrl = process.env.QDRANT_URL || 'http://qdrant:6333';
          const qKey = process.env.QDRANT_API_KEY || '';
          const hdrs = { 'Content-Type': 'application/json' };
          if (qKey) hdrs['api-key'] = qKey;
          const r = await fetch(`${qUrl}/collections/${collectionName}/points?wait=true`, {
            method: 'PUT', headers: hdrs,
            body: JSON.stringify({ points: [{ id, vector, payload }] })
          });
          if (!r.ok) throw new Error(`Qdrant upsert ${r.status}: ${await r.text()}`);
        },
      }
    });
    // P1 #9 entity extractor — wired only if ENABLE_ENTITY_EXTRACTION=true
    if (process.env.ENABLE_ENTITY_EXTRACTION === 'true') {
      try {
        const { EntityExtractor } = await import('./knowledge/entity-extractor.js');
        documentFirstIngestion.entityExtractor = new EntityExtractor({ prisma, logger: console });
        console.log('[Phase1] EntityExtractor enabled');
      } catch (err) {
        console.warn('[Phase1] EntityExtractor failed to init:', err.message);
      }
    }
    // P1 #11 topic state writer
    if (process.env.ENABLE_TOPIC_STATE === 'true') {
      try {
        const { TopicStateWriter } = await import('./knowledge/topic-state-writer.js');
        documentFirstIngestion.topicStateWriter = new TopicStateWriter({ prisma, logger: console });
        console.log('[Phase1] TopicStateWriter enabled');
      } catch (err) {
        console.warn('[Phase1] TopicStateWriter failed to init:', err.message);
      }
    }
    // Expose globally so connector adapters (Slack file ingest, etc) can
    // call into the KB pipeline without dragging the service through ctx
    // plumbing in sync-engine.
    globalThis.__hivemindDocumentFirstIngestion = documentFirstIngestion;
    console.log('[Phase1] DocumentFirstIngestionService enabled (exposed via globalThis)');
  } catch (err) {
    console.warn('[Phase1] DocumentFirstIngestionService failed to init:', err.message);
  }
}

if (process.env.ENABLE_EVIDENCE_RECALL === 'true' && prisma && qdrantClient) {
  try {
    evidenceRetrieval = new EvidenceRetrievalService({
      db: prisma,
      qdrantClient
    });
    console.log('[Phase1] EvidenceRetrievalService enabled');
  } catch (err) {
    console.warn('[Phase1] EvidenceRetrievalService failed to init:', err.message);
  }
}

// Initialize Three-Tier Retrieval
const threeTierRetrieval = new ThreeTierRetrieval({
  vectorStore: qdrantClient,
  graphStore: persistentMemoryStore,
  llmClient: groqClient.isAvailable() ? groqClient : null
});

// Initialize PageIndex Searcher (optional optimization layer)
let pageindexSearcher = null;
try {
  const { PageIndexSearcher } = await import('./search/pageindex-searcher.js');
  pageindexSearcher = new PageIndexSearcher({
    prisma: getPrismaClient(),
    vectorDB: qdrantClient,
  });
  console.log('[server] PageIndexSearcher initialized');
} catch (err) {
  console.log('[server] PageIndexSearcher not available, using fallback search:', err.message);
}

// Initialize PageIndex ingestion hook (optional optimization layer)
let pageindexHook = null;
try {
  // core/src/ingestion is CommonJS, so the module exports live under `.default`.
  const mod = await import('./ingestion/pageindex-hook.js');
  const { PageIndexIntegration } = mod.default || mod;
  pageindexHook = PageIndexIntegration ? new PageIndexIntegration({ prisma: getPrismaClient() }) : null;
  console.log('[server] PageIndexIntegration initialized');
} catch (err) {
  console.log('[server] PageIndexIntegration not available, skipping PageIndex ingestion:', err.message);
}

// Initialize Retrieval Evaluator
const retrievalEvaluator = new RetrievalEvaluator({
  vectorStore: qdrantClient,
  graphStore: persistentMemoryStore,
  llmClient: groqClient.isAvailable() ? groqClient : null
});

// Default user/org for local mode
const DEFAULT_USER = process.env.HIVEMIND_DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001';
const DEFAULT_ORG = process.env.HIVEMIND_DEFAULT_ORG_ID || '00000000-0000-4000-8000-000000000002';
const ADMIN_SECRET = process.env.HIVEMIND_ADMIN_SECRET || 'local-admin-secret-change-me';
const CONTROL_PLANE_ADMIN_BASE_URL = process.env.HIVEMIND_CONTROL_PLANE_BASE_URL || 'https://api.hivemind.davinciai.eu:8040';
const API_KEY_REQUIRED = process.env.HIVEMIND_API_KEY_REQUIRED !== 'false';
const MASTER_API_KEY = process.env.HIVEMIND_MASTER_API_KEY || '';
// Test API key for development/testing (accepted when NODE_ENV is not 'production')
// Must be set via HIVEMIND_TEST_API_KEY environment variable in non-production environments
const TEST_API_KEY = process.env.HIVEMIND_TEST_API_KEY || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REQUIRE_PERSISTED_MEMORY = IS_PRODUCTION || process.env.HIVEMIND_REQUIRE_PERSISTED_MEMORY === 'true';
const INGESTION_MODULE_CANDIDATES = [
  path.join(__dirname, 'ingestion'),
  path.join(PROJECT_ROOT, 'src', 'ingestion'),
  path.join(REPO_ROOT, 'src', 'ingestion'),
  path.join(PROJECT_ROOT, 'ingestion')
];
const CONTEXT_CACHE_TTL_MS = Number(process.env.HIVEMIND_CONTEXT_CACHE_TTL_MS || 15000);
const aggregateCache = new Map();

// OAuth 2.1 authorization code + refresh token stores
const OAUTH_BASE_URL = process.env.HIVEMIND_OAUTH_BASE_URL || 'https://core.hivemind.davinciai.eu:8050';
const OAUTH_SCOPES_SUPPORTED = ['memory.read', 'memory.write', 'web.search', 'tools.invoke', 'workspace.connect', 'mcp.connect'];
const OAUTH_SCOPE_TO_INTERNAL = {
  'memory.read': 'memory:read',
  'memory.write': 'memory:write',
  'web.search': 'web:search',
  'tools.invoke': 'mcp',
  'workspace.connect': 'mcp',
  'mcp.connect': 'mcp'
};
// Accept both dot-style (memory.read) and colon-style (memory:read) on the
// authorization request so ChatGPT / Custom GPTs (colon convention) work
// alongside the original MCP clients (dot convention).
const OAUTH_SCOPE_ALIASES = {
  'memory:read': 'memory.read',
  'memory:write': 'memory.write',
  'web:search': 'web.search',
  mcp: 'mcp.connect',
};
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = Number(process.env.HIVEMIND_OAUTH_ACCESS_TOKEN_TTL_SECONDS || 15 * 60);
const OAUTH_REFRESH_TOKEN_TTL_SECONDS = Number(process.env.HIVEMIND_OAUTH_REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 60 * 60);
const OAUTH_SESSION_COOKIE_NAME = process.env.HIVEMIND_OAUTH_SESSION_COOKIE || 'hm_oauth_session';
const OAUTH_SESSION_SECRET = process.env.HIVEMIND_OAUTH_SESSION_SECRET || process.env.SESSION_SECRET || 'change-me';
const OAUTH_AUTH_STATE_TTL_SECONDS = Number(process.env.HIVEMIND_OAUTH_AUTH_STATE_TTL_SECONDS || 10 * 60);
const OAUTH_RESOURCE_DEFAULT = process.env.HIVEMIND_OAUTH_RESOURCE_DEFAULT || OAUTH_BASE_URL;
const oauthCodeStore = new Map(); // code -> { clientId, redirectUri, scopes, codeChallenge, codeChallengeMethod, userId, orgId, workspaceId, resource, expiresAt, state }
const oauthRefreshStore = new Map(); // refreshHash -> { ...metadata, expiresAt, revokedAt, rotatedFrom, accessTokenHash }
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const oauthSessionStore = new ControlPlaneSessionStore({
  sessionTtlSeconds: Number(process.env.HIVEMIND_OAUTH_SESSION_TTL_SECONDS || 60 * 60 * 8),
  authStateTtlSeconds: OAUTH_AUTH_STATE_TTL_SECONDS,
  redisUrl: process.env.HIVEMIND_OAUTH_REDIS_URL || process.env.REDIS_URL || null,
  redisHost: process.env.REDIS_HOST || null,
  redisPort: Number(process.env.REDIS_PORT || 6379),
  redisPassword: process.env.REDIS_PASSWORD || null
});
const oauthZitadelClient = (
  process.env.ZITADEL_ISSUER_URL
  && process.env.ZITADEL_CLIENT_ID
  && process.env.ZITADEL_CLIENT_SECRET
  && process.env.ZITADEL_REDIRECT_URI
)
  ? new ZitadelOidcClient({
      issuerUrl: process.env.ZITADEL_ISSUER_URL,
      clientId: process.env.ZITADEL_CLIENT_ID,
      clientSecret: process.env.ZITADEL_CLIENT_SECRET,
      redirectUri: process.env.ZITADEL_REDIRECT_URI,
      scope: process.env.ZITADEL_SCOPE || 'openid profile email offline_access'
    })
  : null;
const LOCAL_DEFAULT_OAUTH_CLIENTS = [
  {
    client_id: 'hivemind-local-dev',
    client_name: 'HiveMind Local Development Client',
    redirect_uris: ['http://localhost:3000/api/hivemind/callback'],
    allowed_scopes: OAUTH_SCOPES_SUPPORTED,
    is_public: true,
    status: 'active'
  }
];
let oauthClientRegistryCache = {
  expiresAt: 0,
  clients: LOCAL_DEFAULT_OAUTH_CLIENTS
};

function cleanExpiredOAuthCodes() {
  const now = Date.now();
  for (const [code, entry] of oauthCodeStore) {
    if (now > entry.expiresAt) oauthCodeStore.delete(code);
  }
  for (const [refreshHash, entry] of oauthRefreshStore) {
    if (entry.revokedAt || now > entry.expiresAt) oauthRefreshStore.delete(refreshHash);
  }
}
setInterval(cleanExpiredOAuthCodes, 60_000);

// Audit retention purge — daily at midnight UTC. Uses session GUC to unblock
// the delete trigger that protects audit_logs from ad-hoc DELETE.
const AUDIT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function runAuditRetentionPurge() {
  if (!prisma) return;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.audit_retention_purge = 'on'`);
      const count = await tx.$executeRawUnsafe(
        `DELETE FROM "audit_logs" WHERE "retention_until" IS NOT NULL AND "retention_until" < NOW()`
      );
      return count;
    });
    if (result > 0) console.log(`[audit-retention] Purged ${result} expired audit rows`);
  } catch (err) {
    console.warn('[audit-retention] Purge failed:', err.message);
  }
}
setInterval(runAuditRetentionPurge, AUDIT_PURGE_INTERVAL_MS);
setTimeout(runAuditRetentionPurge, 60_000); // first run 60s after boot

const ALLOWED_ORIGINS = (process.env.HIVEMIND_ALLOWED_ORIGINS || 'https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu,https://claude.ai,https://www.claude.ai,https://anthropic.com,https://chatgpt.com,https://chat.openai.com')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

function loadIngestionPipeline() {
  for (const candidate of INGESTION_MODULE_CANDIDATES) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const { createIngestionPipeline } = require(candidate);
    return createIngestionPipeline({
      prisma,
      logger: console,
    });
  }

  return null;
}

// MCP host-allowlist that is ALWAYS honored — Claude / ChatGPT / Anthropic
// admin consoles need CORS regardless of operator env-var config. Operators
// can still extend via HIVEMIND_ALLOWED_ORIGINS but cannot remove these.
const MCP_REMOTE_ORIGINS = new Set([
  'https://claude.ai',
  'https://www.claude.ai',
  'https://anthropic.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://platform.openai.com',
]);

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  if (ALLOWED_ORIGINS.includes(origin) || MCP_REMOTE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Secret, X-User-Id, X-Org-Id, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

const ingestionPipeline = loadIngestionPipeline();
const mcpIngestionService = new MCPIngestionService({ ingestionPipeline, db: prisma });

async function getIngestionJobStatus(jobId) {
  if (!ingestionPipeline || !jobId) {
    return null;
  }

  if (ingestionPipeline.mode === 'in-memory') {
    const job = ingestionPipeline.queueSystem.queue.jobs.get(jobId);
    if (!job) {
      return null;
    }

    return {
      jobId: String(job.id),
      stage: job.progress?.stage || job.data?.stage || 'Queued',
      attemptsMade: job.attemptsMade || 0,
      status: job.result?.status || (ingestionPipeline.queueSystem.queue.dlq.some(entry => entry.id === jobId) ? 'Failed' : 'Queued'),
      result: job.result || null,
    };
  }

  const job = await ingestionPipeline.queueSystem.queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  return {
    jobId: String(job.id),
    stage: job.progress?.stage || job.data?.stage || 'Queued',
    attemptsMade: job.attemptsMade || 0,
    status: state,
    result: job.returnvalue || null,
    failedReason: job.failedReason || null,
  };
}

async function listIngestionJobs({ limit = 20, status = null } = {}) {
  if (!ingestionPipeline) {
    return [];
  }

  if (ingestionPipeline.mode === 'in-memory') {
    const jobs = Array.from(ingestionPipeline.queueSystem.queue.jobs.values()).map(job => {
      const dlqEntry = ingestionPipeline.queueSystem.queue.dlq.find(entry => entry.id === job.id);
      return {
        jobId: String(job.id),
        stage: job.progress?.stage || job.data?.stage || 'Queued',
        status: dlqEntry ? 'failed' : (job.result?.status || 'queued'),
        attemptsMade: job.attemptsMade || 0,
        payload: job.data,
        result: job.result || null,
        failedReason: dlqEntry?.error || null,
        enqueuedAt: job.data?.enqueued_at || null
      };
    });

    const filtered = status
      ? jobs.filter(job => `${job.status}`.toLowerCase() === `${status}`.toLowerCase())
      : jobs;

    return filtered
      .sort((left, right) => new Date(right.enqueuedAt || 0) - new Date(left.enqueuedAt || 0))
      .slice(0, limit);
  }

  const states = status ? [status] : ['active', 'waiting', 'completed', 'failed', 'delayed', 'paused'];
  const jobs = await ingestionPipeline.queueSystem.queue.getJobs(states, 0, Math.max(limit - 1, 0), true);

  return jobs.map(job => ({
    jobId: String(job.id),
    stage: job.progress?.stage || job.data?.stage || 'Queued',
    status: job.finishedOn ? 'completed' : job.failedReason ? 'failed' : job.processedOn ? 'active' : 'waiting',
    attemptsMade: job.attemptsMade || 0,
    payload: job.data,
    result: job.returnvalue || null,
    failedReason: job.failedReason || null,
    enqueuedAt: job.data?.enqueued_at || null
  }));
}

async function retryIngestionJob(jobId) {
  if (!ingestionPipeline || !jobId) {
    return null;
  }

  if (ingestionPipeline.mode === 'in-memory') {
    const failedJob = ingestionPipeline.queueSystem.queue.dlq.find(entry => entry.id === jobId);
    if (!failedJob?.data && !failedJob?.payload) {
      return null;
    }

    const payload = failedJob.payload || failedJob.data;
    return ingestionPipeline.ingest({
      ...payload,
      request_id: payload.request_id || crypto.randomUUID(),
      idempotency_key: undefined,
      job_id: undefined
    });
  }

  const job = await ingestionPipeline.queueSystem.queue.getJob(jobId);
  if (job) {
    await job.retry();
    return {
      jobId: String(job.id),
      stage: job.progress?.stage || job.data?.stage || 'Queued'
    };
  }

  const dlqJob = await ingestionPipeline.queueSystem.dlq.getJob(jobId);
  if (!dlqJob?.data?.payload) {
    return null;
  }

  return ingestionPipeline.ingest({
    ...dlqJob.data.payload,
    request_id: dlqJob.data.payload.request_id || crypto.randomUUID(),
    idempotency_key: undefined,
    job_id: undefined
  });
}

function findExistingFile(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function ensurePersistedMemoryOrFail(res, endpoint) {
  if (!persistentMemoryStore && REQUIRE_PERSISTED_MEMORY) {
    jsonResponse(res, {
      error: 'Persistent memory store unavailable',
      message: `${endpoint} requires Prisma-backed memory in this environment.`
    }, 503);
    return false;
  }
  return true;
}

// ── Canonical ingest helper ─────────────────────────────────────────
// Every source should follow: normalize → SmartIngestRouter → GraphEngine.
// This helper ensures payloads get deterministic relationship enrichment
// (thread/session/document edges) before persistence.
async function buildRoutedIngestPayloads(payload, { smartIngestRouter, enableSmartRouting = true } = {}) {
  payload = await resolveScopedIngestPayload(payload);
  if (!enableSmartRouting || !smartIngestRouter) {
    return [payload];
  }
  try {
    const routed = await smartIngestRouter.route(payload);
    // Tree shape: { parent, children, entities?, edges? }
    //
    // Returned wrapped as a single-element array carrying `__ingest_tree:true`
    // so existing callers (`for (const p of routed) ingestMemory(p)`) still
    // work — the wrapper spreads the parent payload at the top level. Callers
    // that want the *full* tree-aware path (parent + children + PartOf edges
    // in one transaction) should pass each item through `ingestRoutedPayload()`
    // below, which dispatches to `engine.ingestMemoryTree()` when the marker
    // is present.
    if (routed && !Array.isArray(routed) && routed.parent) {
      const treeItem = {
        __ingest_tree: true,
        tree: routed,
        ...routed.parent, // legacy-compat spread
      };
      return [treeItem];
    }
    return Array.isArray(routed) && routed.length > 0 ? routed : [payload];
  } catch (routeErr) {
    console.warn('[smart-ingest] route failed (falling back to raw payload):', routeErr.message);
    return [payload];
  }
}

/**
 * Canonical dispatcher for routed payloads. Detects the `__ingest_tree`
 * marker and calls `engine.ingestMemoryTree(tree)` for hierarchical
 * sources (KB docs, Talk-to-HIVE sessions, Gmail/Slack threads). Falls
 * back to `engine.ingestMemory(p)` for legacy flat payloads.
 *
 * New ingest callsites should use this helper instead of bare
 * `persistentMemoryEngine.ingestMemory(p)` so the parent+children+edges
 * contract flows end-to-end. Existing callsites keep working unchanged
 * because the routed payload still spreads the parent fields at the top
 * level for legacy iteration.
 */
async function ingestRoutedPayload(routedPayload, engine) {
  if (!engine) {
    throw new Error('ingestRoutedPayload requires a memory engine');
  }
  if (routedPayload?.__ingest_tree && routedPayload.tree && typeof engine.ingestMemoryTree === 'function') {
    return engine.ingestMemoryTree(routedPayload.tree);
  }
  // Strip the tree marker if it slipped through.
  const { __ingest_tree, tree, ...cleanPayload } = routedPayload || {};
  return engine.ingestMemory(cleanPayload);
}

export async function resolveScopedIngestPayload(payload, options = {}) {
  if (!payload?.user_id || !payload?.org_id) return payload;

  const bypassMembership = options.bypassMembership === true || payload.__bypass_membership === true;
  const accessContext = bypassMembership
    ? null
    : await buildAccessContext(payload.user_id, payload.org_id);
  const projectIds = normalizeScopeIds([
    ...(Array.isArray(payload.project_ids) ? payload.project_ids : []),
    payload.project_id,
    payload.metadata?.project_id,
    ...(Array.isArray(payload.metadata?.project_ids) ? payload.metadata.project_ids : []),
    payload.source_metadata?.project_id,
  ]);
  const explicitTeamId = payload.primary_team_id
    || payload.metadata?.primary_team_id
    || payload.metadata?.team_id
    || payload.source_metadata?.team_id
    || null;

  let scopedProjectIds = projectIds;
  if (scopedProjectIds.length > 0 && accessContext?.projectIds?.length) {
    scopedProjectIds = scopedProjectIds.filter(id => accessContext.projectIds.includes(id));
    if (scopedProjectIds.length === 0) {
      throw new Error('Project scope is invalid or inaccessible for this user');
    }
  }

  let primaryTeamId = explicitTeamId;
  if (primaryTeamId && accessContext?.teamIds?.length && !accessContext.teamIds.includes(primaryTeamId)) {
    throw new Error('Team scope is invalid or inaccessible for this user');
  }

  if (!primaryTeamId && scopedProjectIds.length > 0 && prisma?.project) {
    const projectRows = await prisma.project.findMany({
      where: { id: { in: scopedProjectIds }, orgId: payload.org_id },
      select: { id: true, teamId: true },
    });
    const teamIds = Array.from(new Set(projectRows.map(row => row.teamId).filter(Boolean)));
    if (teamIds.length === 1) {
      primaryTeamId = teamIds[0];
    }
  }

  const nextScope = payload.scope
    || (scopedProjectIds.length > 0 ? 'project' : primaryTeamId ? 'team' : undefined);

  return {
    ...payload,
    scope: nextScope,
    primary_team_id: primaryTeamId || null,
    project_ids: scopedProjectIds,
    metadata: {
      ...(payload.metadata || {}),
      primary_team_id: primaryTeamId || null,
      project_id: scopedProjectIds.length === 1 ? scopedProjectIds[0] : payload.metadata?.project_id || null,
      project_ids: scopedProjectIds,
    },
    source_metadata: {
      ...(payload.source_metadata || {}),
      team_id: primaryTeamId || payload.source_metadata?.team_id || null,
    },
  };
}

export function normalizeScopeIds(values = []) {
  return Array.from(new Set(
    values
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim())
  ));
}

function countTopValues(values = [], limit = 5) {
  const counts = new Map();
  for (const value of values) {
    const key = `${value || ''}`.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function buildAggregateCacheKey(kind, payload) {
  return `${kind}:${JSON.stringify(payload)}`;
}

function getAggregateCache(key) {
  const entry = aggregateCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    aggregateCache.delete(key);
    return null;
  }
  return structuredClone(entry.value);
}

function setAggregateCache(key, value, ttlMs = CONTEXT_CACHE_TTL_MS) {
  aggregateCache.set(key, {
    value: structuredClone(value),
    expiresAt: Date.now() + ttlMs
  });
}

function invalidateAggregateCache({ userId, orgId, project = null }) {
  const scopeNeedle = JSON.stringify({ userId, orgId, project });
  for (const key of aggregateCache.keys()) {
    if (key.includes(scopeNeedle)) {
      aggregateCache.delete(key);
    }
  }
}

async function buildProfileSummary({ userId, orgId, project = null }) {
  const cacheKey = buildAggregateCacheKey('profile', { userId, orgId, project });
  const cached = getAggregateCache(cacheKey);
  if (cached) return cached;

  if (!prisma || !prisma.memory) {
    console.warn('[profile] prisma.memory is undefined, prisma type:', typeof prisma, 'keys:', Object.keys(prisma).slice(0, 5));
    // Try using persistentMemoryStore instead
    if (persistentMemoryStore) {
      try {
        const mems = await persistentMemoryStore.listLatestMemories({ user_id: userId, org_id: orgId, project });
        const recent = mems.slice(0, 20);
        const obs = recent.filter(m => (m.tags || []).includes('observation'));
        const allTags = recent.flatMap(m => m.tags || []);
        const tagCounts = {};
        for (const t of allTags) tagCounts[t] = (tagCounts[t] || 0) + 1;
        const topTags = Object.entries(tagCounts)
          .filter(([t]) => !['observation', 'longmemeval'].includes(t) && !t.startsWith('qid:') && !t.startsWith('session:'))
          .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);

        const staticFacts = obs.filter(m => (m.content || '').includes('🔴')).map(m => (m.content || '').replace(/^🔴\s*\[\d{4}-\d{2}-\d{2}\]\s*(\(ref:.*?\)\s*)?/gm, '').trim()).filter(Boolean).slice(0, 10);
        const dynamicContext = obs.filter(m => (m.content || '').includes('🟡') && !(m.content || '').includes('🔴')).map(m => (m.content || '').replace(/^🟡\s*\[\d{4}-\d{2}-\d{2}\]\s*(\(ref:.*?\)\s*)?/gm, '').trim()).filter(Boolean).slice(0, 10);

        const summary = {
          user_id: userId, org_id: orgId, project,
          memory_count: mems.length,
          observation_count: obs.length,
          relationship_count: 0,
          top_tags: topTags,
          top_source_platforms: [...new Set(recent.map(m => m.source_metadata?.source_platform).filter(Boolean))].slice(0, 5),
          recent_titles: recent.map(m => m.title).filter(Boolean).slice(0, 5),
          graph_summary: { included_count: mems.length },
          cognitive_profile: { static_facts: staticFacts, dynamic_context: dynamicContext },
        };
        setAggregateCache(cacheKey, summary, 30000);
        return summary;
      } catch (storeErr) {
        console.warn('[profile] Store fallback failed:', storeErr.message);
      }
    }
    return { memory_count: 0, relationship_count: 0, observation_count: 0, top_tags: [], top_source_platforms: [], recent_titles: [], graph_summary: {}, cognitive_profile: { static_facts: [], dynamic_context: [] } };
  }

  try {
    // Fast count queries instead of loading all records.
    // Match /api/memories default — exclude all hidden-child tag families so
    // Overview counts reconcile with the list view (was 1012 vs visible 346).
    // Mirrors HIDDEN_CHILD_TAGS in prisma-graph-store.listMemories.
    const HIDDEN_CHILD_TAGS = ['extracted-fact', 'tara-turn', 'tara-insight'];
    const where = {
      userId,
      orgId,
      deletedAt: null,
      isLatest: true,
      AND: HIDDEN_CHILD_TAGS.map((t) => ({ NOT: { tags: { has: t } } })),
    };
    if (project) where.project = project;

    const [memoryCount, recentMemories] = await Promise.all([
      prisma.memory.count({ where }).catch(() => 0),
      prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, tags: true, sourcePlatform: true, memoryType: true, content: true, createdAt: true },
      }).catch(() => []),
    ]);
    // Relationship count — use raw query against mapped table name, scoped to user.
    // Also excludes edges originating from extracted-fact children so the count
    // reconciles with the graph view.
    let relationships = 0;
    try {
      const relRows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as c FROM "relationships" r
         JOIN "memories" m ON r."from_id" = m."id"
         WHERE m."user_id" = $1::uuid
           AND m."deleted_at" IS NULL
           AND m."is_latest" = true
           AND NOT (m."tags" && ARRAY['extracted-fact','tara-turn','tara-insight']::text[])`,
        userId
      );
      relationships = relRows?.[0]?.c || 0;
    } catch { relationships = 0; }

    // Count observations from recent memories tags
    const observationCount = recentMemories.filter(m => (m.tags || []).includes('observation')).length;

    // Aggregate tags and platforms from recent sample
    const allTags = recentMemories.flatMap(m => m.tags || []);
    const tagCounts = {};
    for (const t of allTags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const topTags = Object.entries(tagCounts)
      .filter(([t]) => !['observation', 'longmemeval'].includes(t) && !t.startsWith('qid:') && !t.startsWith('session:'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t);

    const platforms = recentMemories.map(m => m.sourcePlatform).filter(Boolean);
    const platCounts = {};
    for (const p of platforms) platCounts[p] = (platCounts[p] || 0) + 1;
    const topPlatforms = Object.entries(platCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);

    const recentTitles = recentMemories.map(m => m.title).filter(Boolean).slice(0, 5);

    // Build cognitive profile from observations
    const observations = recentMemories
      .filter(m => (m.tags || []).includes('observation'))
      .map(m => m.content || '');

    const staticFacts = observations
      .filter(c => c.includes('🔴'))
      .map(c => c.replace(/^🔴\s*\[\d{4}-\d{2}-\d{2}\]\s*(\(ref:.*?\)\s*)?/gm, '').trim())
      .filter(Boolean)
      .slice(0, 10);

    const dynamicContext = observations
      .filter(c => c.includes('🟡') && !c.includes('🔴'))
      .map(c => c.replace(/^🟡\s*\[\d{4}-\d{2}-\d{2}\]\s*(\(ref:.*?\)\s*)?/gm, '').trim())
      .filter(Boolean)
      .slice(0, 10);

    // Fetch org plan
    let orgPlan = 'free';
    try {
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
      orgPlan = org?.plan || 'free';
    } catch {}

    const summary = {
      user_id: userId,
      org_id: orgId,
      project,
      plan: orgPlan,
      memory_count: memoryCount,
      observation_count: observationCount,
      relationship_count: typeof relationships === 'number' ? relationships : 0,
      top_tags: topTags,
      top_source_platforms: topPlatforms,
      recent_titles: recentTitles,
      graph_summary: {
        included_count: memoryCount,
      },
      cognitive_profile: {
        static_facts: staticFacts,
        dynamic_context: dynamicContext,
      },
    };

    setAggregateCache(cacheKey, summary, 30000); // 30s cache
    return summary;
  } catch (err) {
    console.warn('[profile] Build failed:', err.message);
    return { memory_count: 0, relationship_count: 0, observation_count: 0, top_tags: [], top_source_platforms: [], recent_titles: [], graph_summary: {}, cognitive_profile: { static_facts: [], dynamic_context: [] } };
  }
}

async function buildContextPayload({ body, userId, orgId }) {
  const platform = normalizeWebappPlatform(body.platform || body.source_platform || 'webapp');
  const query = body.query || body.user_prompt || body.prompt || '';
  const preferredSources = [...new Set([
    ...(body.preferred_source_platforms || []),
    ...(platform ? [platform] : [])
  ])];
  const preferredTags = body.preferred_tags || [];
  const maxMemories = body.max_memories || 5;
  const project = body.project || null;
  const cacheKey = buildAggregateCacheKey('context', {
    userId,
    orgId,
    project,
    query,
    platform,
    preferredSources,
    preferredTags,
    source_platforms: body.source_platforms || [],
    tags: body.tags || [],
    preferred_project: body.preferred_project || project,
    include_profile: body.include_profile !== false,
    include_graph_summary: body.include_graph_summary !== false,
    max_memories: maxMemories
  });
  const cached = getAggregateCache(cacheKey);
  if (cached) {
    return cached;
  }

  const accessCtx = await buildAccessContext(userId, orgId);
  const recall = await recallPersistedMemories(persistentMemoryStore, {
    query_context: query,
    user_id: userId,
    org_id: orgId,
    project,
    source_platforms: body.source_platforms || [],
    tags: body.tags || [],
    preferred_project: body.preferred_project || project,
    preferred_source_platforms: preferredSources,
    preferred_tags: preferredTags,
    max_memories: maxMemories,
    access_context: accessCtx,
    scope_filter: body.scope_filter || null,
  });

  const contextEnvelope = buildWebappContextResponse(recall, {
    query,
    platform,
    project,
    preferredSources,
    preferredTags,
    maxMemories
  });

  const response = {
    ok: true,
    platform: contextEnvelope.platform,
    query: contextEnvelope.query,
    project: contextEnvelope.project,
    search_method: contextEnvelope.search_method,
    policy: contextEnvelope.policy,
    context: contextEnvelope.context,
    prompt_envelope: buildPromptEnvelope(body, contextEnvelope.context)
  };

  const shouldIncludeProfile = body.include_profile !== false;
  const shouldIncludeGraphSummary = body.include_graph_summary !== false;
  const profile = shouldIncludeProfile || shouldIncludeGraphSummary
    ? await buildProfileSummary({ userId, orgId, project })
    : null;

  if (shouldIncludeProfile && profile) {
    response.profile = {
      user_id: profile.user_id,
      org_id: profile.org_id,
      project: profile.project,
      memory_count: profile.memory_count,
      relationship_count: profile.relationship_count,
      top_tags: profile.top_tags,
      top_source_platforms: profile.top_source_platforms,
      recent_titles: profile.recent_titles
    };
  }

  if (shouldIncludeGraphSummary && profile) {
    response.graph_summary = profile.graph_summary;
  }

  response.expansion_stats = {
    included_count: contextEnvelope.context.memories.length,
    max_memories: maxMemories
  };

  setAggregateCache(cacheKey, response);
  return response;
}

function ensureApiKeyStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(API_KEYS_FILE_PATH)) {
    const initial = { keys: [] };
    fs.writeFileSync(API_KEYS_FILE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
  }
}

function loadApiKeyStore() {
  ensureApiKeyStore();
  const raw = fs.readFileSync(API_KEYS_FILE_PATH, 'utf-8');
  return JSON.parse(raw || '{"keys":[]}');
}

function saveApiKeyStore(store) {
  ensureApiKeyStore();
  fs.writeFileSync(API_KEYS_FILE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

function ensureOAuthClientsStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(OAUTH_CLIENTS_FILE_PATH)) {
    fs.writeFileSync(
      OAUTH_CLIENTS_FILE_PATH,
      JSON.stringify({ clients: LOCAL_DEFAULT_OAUTH_CLIENTS }, null, 2),
      'utf-8'
    );
  }
}

function loadOAuthClientsFromDisk() {
  try {
    ensureOAuthClientsStore();
    const raw = fs.readFileSync(OAUTH_CLIENTS_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw || '{"clients":[]}');
    return Array.isArray(parsed.clients) ? parsed.clients : [];
  } catch {
    return [];
  }
}

function loadOAuthClientsFromEnv() {
  try {
    const raw = process.env.HIVEMIND_OAUTH_CLIENTS_JSON || '';
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function normalizeOAuthClientRecord(rawClient = {}) {
  const clientId = String(rawClient.client_id || rawClient.clientId || '').trim();
  if (!clientId) return null;
  const redirectUris = Array.isArray(rawClient.redirect_uris)
    ? rawClient.redirect_uris.map(uri => String(uri || '').trim()).filter(Boolean)
    : [];
  if (redirectUris.length === 0) return null;
  const allowedScopesRaw = Array.isArray(rawClient.allowed_scopes) ? rawClient.allowed_scopes : OAUTH_SCOPES_SUPPORTED;
  const allowedScopes = normalizeRequestedScopes(allowedScopesRaw.join(' '), OAUTH_SCOPES_SUPPORTED);
  // client_secret_hash is sha256 of the raw secret. Absent → public client
  // (PKCE-only). Present → confidential client; /oauth/token enforces
  // client_secret on the token exchange (matches ChatGPT GPT Actions
  // requirement which always sends client_secret).
  const secretHash = typeof rawClient.client_secret_hash === 'string' && rawClient.client_secret_hash
    ? rawClient.client_secret_hash
    : null;
  return {
    client_id: clientId,
    client_name: String(rawClient.client_name || rawClient.clientName || clientId),
    redirect_uris: redirectUris,
    allowed_scopes: allowedScopes,
    client_secret_hash: secretHash,
    is_public: secretHash ? false : (rawClient.is_public !== false),
    status: String(rawClient.status || 'active')
  };
}

async function loadOAuthClientRegistry() {
  const now = Date.now();
  if (oauthClientRegistryCache.expiresAt > now) {
    return oauthClientRegistryCache.clients;
  }

  const merged = new Map();
  const upsert = (rawClient) => {
    const normalized = normalizeOAuthClientRecord(rawClient);
    if (!normalized) return;
    merged.set(normalized.client_id, normalized);
  };

  for (const c of LOCAL_DEFAULT_OAUTH_CLIENTS) upsert(c);
  for (const c of loadOAuthClientsFromDisk()) upsert(c);
  for (const c of loadOAuthClientsFromEnv()) upsert(c);

  if (prisma?.metaParameter) {
    try {
      const dbRegistry = await prisma.metaParameter.findUnique({
        where: { key: 'oauth_client_registry' }
      });
      const value = Array.isArray(dbRegistry?.value) ? dbRegistry.value : [];
      for (const c of value) upsert(c);
    } catch {
      // Optional DB-backed registry, file/env fallback remains valid.
    }
  }

  const clients = Array.from(merged.values());
  oauthClientRegistryCache = {
    expiresAt: now + 60 * 1000,
    clients
  };
  return clients;
}

async function getOAuthClientById(clientId) {
  const clients = await loadOAuthClientRegistry();
  return clients.find(c => c.client_id === clientId && c.status === 'active') || null;
}

function normalizeRequestedScopes(scopeInput, fallbackScopes = ['memory.read']) {
  const rawScopes = Array.isArray(scopeInput)
    ? scopeInput
    : String(scopeInput || '')
      .split(/[\s+]/)
      .map(s => s.trim())
      .filter(Boolean);

  const normalized = rawScopes
    .map(scope => OAUTH_SCOPE_ALIASES[scope] || scope)
    .filter(scope => OAUTH_SCOPES_SUPPORTED.includes(scope));

  if (normalized.length === 0) {
    return Array.isArray(fallbackScopes) ? fallbackScopes : ['memory.read'];
  }

  return Array.from(new Set(normalized));
}

function mapOAuthScopesToInternalScopes(scopes) {
  const requested = normalizeRequestedScopes(scopes, []);
  const mapped = requested
    .map(scope => OAUTH_SCOPE_TO_INTERNAL[scope])
    .filter(Boolean);
  return Array.from(new Set(mapped));
}

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k.trim()] = decodeURIComponent(v.join('=').trim());
    return acc;
  }, {});
}

// HIVEMIND brand logo — geometric 3D "jack" of 6 interlocking cylinders.
// Inline SVG so it works on every OAuth page (consent, login, error) without
// needing static asset hosting. Same render is reused by Claude / ChatGPT /
// Perplexity OAuth flows since they all land on /oauth/authorize and /oauth/login.
const HIVEMIND_LOGO_SVG = `
<svg width="64" height="64" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="ivory" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fafaf6"/>
      <stop offset="100%" stop-color="#e8e3d8"/>
    </linearGradient>
    <linearGradient id="black" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a1a"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
  </defs>
  <!-- back-right black axis -->
  <g transform="translate(50 50) rotate(35)">
    <rect x="-7" y="-44" width="14" height="88" rx="7" fill="url(#black)" stroke="#0a0a0a" stroke-width="0.6"/>
  </g>
  <!-- vertical ivory axis -->
  <g transform="translate(50 50)">
    <rect x="-7" y="-44" width="14" height="88" rx="7" fill="url(#ivory)" stroke="#3a3a3a" stroke-width="0.6"/>
  </g>
  <!-- horizontal ivory axis -->
  <g transform="translate(50 50) rotate(90)">
    <rect x="-7" y="-44" width="14" height="88" rx="7" fill="url(#ivory)" stroke="#3a3a3a" stroke-width="0.6"/>
  </g>
  <!-- diagonal ivory axis -->
  <g transform="translate(50 50) rotate(-35)">
    <rect x="-6" y="-42" width="12" height="84" rx="6" fill="url(#ivory)" stroke="#3a3a3a" stroke-width="0.5"/>
  </g>
  <!-- center node -->
  <circle cx="50" cy="50" r="9" fill="url(#ivory)" stroke="#3a3a3a" stroke-width="0.6"/>
</svg>`;

function sanitizeHtml(value) {
  return String(value || '').replace(/[<>&"']/g, m => (
    m === '<' ? '&lt;'
      : m === '>' ? '&gt;'
        : m === '&' ? '&amp;'
          : m === '"' ? '&quot;'
            : '&#39;'
  ));
}

function buildOAuthWwwAuthenticate({ error = 'invalid_token', description = 'Bearer token missing or invalid', requiredScope = null, req = null } = {}) {
  // Same canonical-FE-host normalization as discovery doc. Claude reads
  // these URIs from WWW-Authenticate to bootstrap OAuth — must match the
  // host the client actually used to reach us.
  let base = OAUTH_BASE_URL;
  if (req) {
    const xfHost = req.headers['x-forwarded-host'] || req.headers['x-original-host'];
    const rawHost = (xfHost || req.headers.host || '').toString().split(',')[0].trim();
    if (rawHost && (rawHost.endsWith('davinciai.eu') || rawHost.endsWith('davinciai.eu:8050'))) {
      const FE_HOST = process.env.HIVEMIND_OAUTH_FE_HOST || 'hivemind.davinciai.eu';
      base = `https://${FE_HOST}`;
    }
  }
  const pairs = [
    `realm="hivemind"`,
    `error="${error}"`,
    `error_description="${description.replace(/"/g, "'")}"`,
    `authorization_uri="${base}/oauth/authorize"`,
    `token_uri="${base}/oauth/token"`,
    `resource_metadata_uri="${base}/.well-known/oauth-protected-resource"`
  ];
  if (requiredScope) {
    pairs.push(`scope="${requiredScope}"`);
  }
  return `Bearer ${pairs.join(', ')}`;
}

function setOAuthUnauthorized(res, {
  statusCode = 401,
  error = 'unauthorized',
  errorDescription = 'Unauthorized',
  requiredScope = null,
  req = null
} = {}) {
  res.setHeader(
    'WWW-Authenticate',
    buildOAuthWwwAuthenticate({
      error: statusCode === 403 ? 'insufficient_scope' : 'invalid_token',
      description: errorDescription,
      requiredScope,
      req
    })
  );
  return jsonResponse(res, { error, error_description: errorDescription }, statusCode);
}

// Resolve session for OAuth consent: accept BOTH the local /oauth/login
// short-lived session AND the dashboard's hm_cp_session cookie set by the
// control plane after a user signs in via /hivemind/login (Google SSO,
// email/password, or Zitadel — same flow used by CLI + browser extension).
//
// Why both: when Claude / ChatGPT redirects to /oauth/authorize, the user
// either has a dashboard session already (very common since most users
// are signed in to the dashboard) or has none. Falling back to the
// dashboard cookie makes OAuth consent feel like part of the same
// session, instead of forcing a second "Sign In to HiveMind" screen.
const CP_SESSION_COOKIE_NAME = process.env.HIVEMIND_CONTROL_PLANE_SESSION_COOKIE || 'hm_cp_session';

async function resolveOAuthSession(req) {
  const cookies = parseCookies(req);

  // 1) Local OAuth session set by /oauth/login (admin-secret or Zitadel
  //    callback path).
  const localCookie = cookies[OAUTH_SESSION_COOKIE_NAME];
  if (localCookie) {
    const sid = verifySessionCookie(OAUTH_SESSION_SECRET, localCookie);
    if (sid) {
      const session = await oauthSessionStore.getSession(sid);
      if (session?.userId) return session;
    }
  }

  // 2) Dashboard session — same Redis store, same key prefix
  //    (`cp:session:<id>`), same SESSION_SECRET shared via env across
  //    core + control-plane containers. Treat it as a first-class OAuth
  //    session so the consent screen renders for users who are already
  //    signed in to the dashboard.
  const cpCookie = cookies[CP_SESSION_COOKIE_NAME];
  if (cpCookie) {
    const sid = verifySessionCookie(OAUTH_SESSION_SECRET, cpCookie);
    if (sid) {
      const session = await oauthSessionStore.getSession(sid);
      if (session?.userId) return session;
    }
  }

  return null;
}

async function createOAuthSession(res, payload) {
  const sessionId = await oauthSessionStore.createSession(payload);
  const cookie = buildSessionCookie(OAUTH_SESSION_SECRET, sessionId);
  res.setHeader(
    'Set-Cookie',
    `${OAUTH_SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Number(process.env.HIVEMIND_OAUTH_SESSION_TTL_SECONDS || 60 * 60 * 8)}`
  );
}

function ensureOAuthRefreshTokenStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(OAUTH_REFRESH_TOKENS_FILE_PATH)) {
    fs.writeFileSync(OAUTH_REFRESH_TOKENS_FILE_PATH, JSON.stringify({ tokens: [] }, null, 2), 'utf-8');
  }
}

function loadOAuthRefreshTokenStore() {
  ensureOAuthRefreshTokenStore();
  const raw = fs.readFileSync(OAUTH_REFRESH_TOKENS_FILE_PATH, 'utf-8');
  return JSON.parse(raw || '{"tokens":[]}');
}

function saveOAuthRefreshTokenStore(store) {
  ensureOAuthRefreshTokenStore();
  fs.writeFileSync(OAUTH_REFRESH_TOKENS_FILE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

function generateRawRefreshToken() {
  return `hmr_live_${crypto.randomBytes(32).toString('hex')}`;
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createOAuthAccessToken({
  clientId,
  userId,
  orgId,
  internalScopes,
  oauthScopes,
  workspaceId,
  resource
}) {
  const expiresAt = new Date(Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
  const descriptionPayload = JSON.stringify({
    kind: 'oauth_access_token',
    client_id: clientId,
    workspace_id: workspaceId || null,
    resource: resource || OAUTH_RESOURCE_DEFAULT,
    oauth_scopes: oauthScopes,
    issued_at: new Date().toISOString()
  });

  if (prisma) {
    const { rawKey, record } = await createPersistedApiKey(prisma, {
      userId: userId || DEFAULT_USER,
      orgId: orgId || DEFAULT_ORG,
      name: `oauth:${clientId}`,
      description: descriptionPayload,
      scopes: internalScopes,
      expiresAt
    });
    return { accessToken: rawKey, accessTokenId: record.id, expiresAt };
  }

  const { rawKey, record } = generateApiKeyRecord({
    label: `oauth-${clientId}`,
    userId: userId || DEFAULT_USER,
    orgId: orgId || DEFAULT_ORG,
    scopes: internalScopes,
    expiresAt,
    description: descriptionPayload
  });
  const store = loadApiKeyStore();
  store.keys.push(record);
  saveApiKeyStore(store);
  return { accessToken: rawKey, accessTokenId: record.id, expiresAt };
}

function persistRefreshTokenRecord(rawToken, record) {
  oauthRefreshStore.set(record.refreshHash, record);
  const store = loadOAuthRefreshTokenStore();
  store.tokens = (Array.isArray(store.tokens) ? store.tokens : []).filter(t => t.refreshHash !== record.refreshHash);
  store.tokens.push({
    ...record,
    refreshTokenEncrypted: encryptToken(rawToken)
  });
  saveOAuthRefreshTokenStore(store);
}

function loadRefreshTokenRecord(rawToken) {
  if (!rawToken) return null;
  const refreshHash = hashRefreshToken(rawToken);
  const inMemory = oauthRefreshStore.get(refreshHash);
  if (inMemory) return inMemory;

  const store = loadOAuthRefreshTokenStore();
  const found = (store.tokens || []).find(t => t.refreshHash === refreshHash);
  if (!found) return null;
  if (found.refreshTokenEncrypted && decryptToken(found.refreshTokenEncrypted) !== rawToken) {
    return null;
  }
  oauthRefreshStore.set(refreshHash, found);
  return found;
}

function markRefreshTokenRevoked(refreshHash) {
  const now = new Date().toISOString();
  const inMemory = oauthRefreshStore.get(refreshHash);
  if (inMemory) {
    inMemory.revokedAt = now;
    oauthRefreshStore.set(refreshHash, inMemory);
  }
  const store = loadOAuthRefreshTokenStore();
  store.tokens = (store.tokens || []).map(entry => (
    entry.refreshHash === refreshHash
      ? { ...entry, revokedAt: now }
      : entry
  ));
  saveOAuthRefreshTokenStore(store);
}

async function revokeAccessTokenByHash(keyHash, reason = 'oauth_revoke') {
  if (!keyHash) return false;
  if (prisma) {
    try {
      const found = await prisma.apiKey.findUnique({ where: { keyHash } });
      if (found && !found.revokedAt) {
        await prisma.apiKey.update({
          where: { id: found.id },
          data: { revokedAt: new Date(), revokedReason: reason }
        });
        return true;
      }
    } catch {
      // fallback to local store
    }
  }

  const store = loadApiKeyStore();
  const match = store.keys.find(k => k.keyHash === keyHash && !k.revokedAt);
  if (!match) return false;
  match.revokedAt = new Date().toISOString();
  saveApiKeyStore(store);
  return true;
}

function ensureEvaluationReportStore() {
  if (!fs.existsSync(EVALUATION_REPORTS_DIR)) {
    fs.mkdirSync(EVALUATION_REPORTS_DIR, { recursive: true });
  }
}

function getHostedApiBaseUrl(req) {
  if (process.env.HIVEMIND_INTERNAL_BASE_URL || process.env.HIVEMIND_BASE_URL) {
    return process.env.HIVEMIND_INTERNAL_BASE_URL || process.env.HIVEMIND_BASE_URL;
  }

  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : '';
  const protocol = forwardedProto || 'https';

  return `${protocol}://${req.headers.host}`;
}

function evaluationReportPath(evaluationId) {
  return path.join(EVALUATION_REPORTS_DIR, `${evaluationId}.json`);
}

function persistEvaluationReport(report) {
  if (!report?.evaluationId) {
    return;
  }

  ensureEvaluationReportStore();
  fs.writeFileSync(evaluationReportPath(report.evaluationId), JSON.stringify(report, null, 2), 'utf-8');
}

function loadEvaluationReports() {
  ensureEvaluationReportStore();

  return fs.readdirSync(EVALUATION_REPORTS_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      try {
        return JSON.parse(fs.readFileSync(path.join(EVALUATION_REPORTS_DIR, file), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function getEvaluationReportById(evaluationId) {
  if (!evaluationId) return null;
  const reportPath = evaluationReportPath(evaluationId);
  if (!fs.existsSync(reportPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch {
    return null;
  }
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function generateRawApiKey() {
  return `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
}

function generateApiKeyRecord({
  label,
  userId,
  orgId,
  scopes = ['memory:read', 'memory:write'],
  containerTags = null,
  expiresAt = null,
  description = null
}) {
  const rawKey = generateRawApiKey();
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    label: label || 'ultimate-user-key',
    name: label || 'ultimate-user-key',
    keyHash: hashApiKey(rawKey),
    keyPrefix: rawKey.slice(0, 12),
    keyPreview: `${rawKey.slice(0, 12)}...${rawKey.slice(-6)}`,
    userId: userId || DEFAULT_USER,
    orgId: orgId || DEFAULT_ORG,
    scopes,
    description,
    containerTags: Array.isArray(containerTags) && containerTags.length > 0 ? containerTags : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null
  };
  return { rawKey, record };
}

function extractApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }
  return '';
}

function isAdminRequest(req) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET;
}

function isAdminAuthorized(req, url) {
  return isAdminRequest(req) || url.searchParams.get('admin_secret') === ADMIN_SECRET;
}

// ── Consumer URL / Meta MCP token helpers ──
const CONSUMER_TOKEN_PREFIX = 'hmc_';

function generateConsumerToken() {
  return `${CONSUMER_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

async function resolveConsumerToken(token) {
  if (!prisma || !token || !token.startsWith(CONSUMER_TOKEN_PREFIX)) {
    return null;
  }
  try {
    const keyHash = hashPersistedApiKey(token);
    const record = await prisma.apiKey.findUnique({
      where: { keyHash }
    });
    if (!record || record.revokedAt) {
      return null;
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    // Update usage stats (fire-and-forget)
    prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date(), usageCount: { increment: 1 } }
    }).catch(() => {});
    return {
      userId: record.userId || DEFAULT_USER,
      orgId: record.orgId || DEFAULT_ORG,
      scopes: record.scopes || ['mcp'],
      rawKey: token
    };
  } catch {
    return null;
  }
}

async function findExistingConsumerToken(userId) {
  if (!prisma) return null;
  try {
    const record = await prisma.apiKey.findFirst({
      where: {
        userId,
        name: 'consumer-url',
        revokedAt: null
      }
    });
    return record;
  } catch {
    return null;
  }
}

function buildAdminServiceSnapshot() {
  return {
    service: 'core',
    observed_at: new Date().toISOString(),
    health: {
      ok: true,
      service: 'hivemind-api',
      port: process.env.PORT || 3000,
    },
    runtime: {
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      node_env: process.env.NODE_ENV || 'development',
    },
    summary: getLogSummary('core'),
    logs: getRecentLogs({ service: 'core', limit: 150 }),
  };
}

async function authenticateApiKey(req) {
  if (!API_KEY_REQUIRED) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'], rawKey: null } };
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'Missing API key. Use Authorization: Bearer <key> or X-API-Key header.' };
  }

  // Accept test API key in non-production environments
  if (!IS_PRODUCTION && apiKey === TEST_API_KEY) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'], testKey: true, rawKey: apiKey } };
  }

  // Accept master API key in any environment
  // When used by the control plane proxy, X-HM-User-Id/X-HM-Org-Id override defaults
  if (MASTER_API_KEY && apiKey === MASTER_API_KEY) {
    const proxyUserId = req.headers['x-hm-user-id'] || DEFAULT_USER;
    const proxyOrgId = req.headers['x-hm-org-id'] || DEFAULT_ORG;
    return { ok: true, principal: { userId: proxyUserId, orgId: proxyOrgId, scopes: ['*'], master: true, rawKey: apiKey } };
  }

  const persistedRecord = await authenticatePersistedApiKey(prisma, apiKey);
  if (persistedRecord) {
    // Parse containerTags from description field (JSON-encoded) for persisted keys
    let persistedContainerTags = null;
    let oauthMetadata = null;
    if (persistedRecord.description) {
      try {
        const meta = JSON.parse(persistedRecord.description);
        if (Array.isArray(meta.containerTags)) {
          persistedContainerTags = meta.containerTags;
        }
        if (meta && meta.kind === 'oauth_access_token') {
          oauthMetadata = meta;
        }
      } catch {
        // description is plain text, not JSON — no containerTags
      }
    }
    
    // Resolve key access: if key is scoped to project/team, use those; otherwise fetch all accessible
    const userId = persistedRecord.userId || DEFAULT_USER;
    const orgId = persistedRecord.orgId || DEFAULT_ORG;
    const accessContext = await buildAccessContext(userId, orgId);
    const resolvedAccess = await resolveKeyAccess(prisma, persistedRecord, accessContext);
    
    return {
      ok: true,
      principal: {
        ...resolvedAccess,
        containerTags: persistedContainerTags,
        oauth: oauthMetadata,
        rawKey: apiKey,
        persisted: true
      }
    };
  }

  const keyHash = hashApiKey(apiKey);
  const store = loadApiKeyStore();
  const record = store.keys.find(k => {
    if (k.keyHash !== keyHash || k.revokedAt) return false;
    if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return false;
    return true;
  });
  if (!record) {
    return { ok: false, status: 401, error: 'Invalid or revoked API key.' };
  }

  record.lastUsedAt = new Date().toISOString();
  saveApiKeyStore(store);

  return {
    ok: true,
    principal: {
      keyId: record.id,
      userId: record.userId || DEFAULT_USER,
      orgId: record.orgId || DEFAULT_ORG,
      scopes: record.scopes || [],
      containerTags: record.containerTags || null,
      oauth: (() => {
        try {
          return record.description ? JSON.parse(record.description) : null;
        } catch {
          return null;
        }
      })(),
      rawKey: apiKey
    }
  };
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ─── ChatGPT Connector adapter (one-click integration layer) ─
  // Public spec at /v1/chatgpt/openapi.yaml; tool endpoints under
  // /v1/chatgpt/* authed via existing Bearer / API key pipeline.
  if (pathname === '/v1/chatgpt/openapi.yaml' && req.method === 'GET') {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const yamlPath = path.resolve(process.cwd(), 'chatgpt-adapter/openapi.yaml');
      const yaml = await fs.readFile(yamlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(yaml);
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'openapi.yaml not found', detail: err.message }));
      return;
    }
  }

  if (pathname.startsWith('/v1/chatgpt/')) {
    // Reuse existing Bearer / API key auth (OAuth tokens issued via
    // /oauth/token land in the apiKey table with kind='oauth_access_token').
    const auth = await authenticateApiKey(req);
    if (!auth.ok) {
      res.writeHead(auth.status || 401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': buildOAuthWwwAuthenticate({ description: auth.error, req }),
      });
      res.end(JSON.stringify({ error: auth.error || 'unauthorized' }));
      return;
    }
    const { handleChatgptRequest } = await import('./services/chatgpt-adapter.js');
    const deps = {
      persistentMemoryStore,
      persistentMemoryEngine,
      smartIngestRouter,
      buildRoutedIngestPayloads,
      ingestRoutedPayload,
      webIntelligence: globalThis.webIntelligence || null,
      prisma,
      accessContext: null,
    };
    const queryObj = Object.fromEntries(url.searchParams.entries());
    const handled = await handleChatgptRequest({
      req, res, pathname, query: queryObj, principal: auth.principal, deps,
    });
    if (handled) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown route ${req.method} ${pathname}` }));
    return;
  }

  // ─── Inbound webhook receiver (Nango-bridged connectors) ──────
  // POST /webhooks/:provider — no user auth; provider HMAC signature only.
  if (pathname.startsWith('/webhooks/') && req.method === 'POST') {
    const provider = pathname.slice('/webhooks/'.length).split('/')[0];
    try {
      // Body size cap 1 MiB
      const declared = parseInt(req.headers['content-length'] || '0', 10);
      if (declared > 1048576) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      // Per-IP rate limit: 30 req/min
      const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
      const now = Date.now();
      globalThis.__webhookBucket = globalThis.__webhookBucket || new Map();
      const bucket = globalThis.__webhookBucket;
      const entry = bucket.get(ip) || { count: 0, resetAt: now + 60000 };
      if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
      entry.count++;
      bucket.set(ip, entry);
      if (entry.count > 30) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        res.end(JSON.stringify({ error: 'rate_limited' }));
        return;
      }

      // Read raw body (cap during stream)
      const chunks = [];
      let total = 0;
      let aborted = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 1048576) { aborted = true; break; }
        chunks.push(chunk);
      }
      if (aborted) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      const rawBody = Buffer.concat(chunks);

      // Resolve adapter
      const { default: adapterRegistry } = await import('./connectors/framework/adapter-registry.js');
      // Lazy-import adapters so they self-register
      try {
        const providerModuleMap = {
          notion: './connectors/adapters/notion/notion-adapter.js',
          slack: './connectors/adapters/slack/slack-adapter.js',
          github: './connectors/adapters/github/github-adapter.js',
          linear: './connectors/adapters/linear/linear-adapter.js',
          jira: './connectors/adapters/jira/jira-adapter.js',
          confluence: './connectors/adapters/confluence/confluence-adapter.js',
        };
        if (providerModuleMap[provider]) {
          await import(providerModuleMap[provider]);
        }
      } catch (_) { /* registry remains empty for unknown providers */ }
      const AdapterClass = adapterRegistry.get(provider);
      if (!AdapterClass) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown provider' }));
        return;
      }

      const adapter = adapterRegistry.instantiate(provider, {
        providerKey: provider,
        tokenResolver: async ({ userId, orgId, providerKey }) => {
          const { getConnectionId, fetchBearerFromNango } = await import('./connectors/mcp/nango-service.js');
          const connId = await getConnectionId({ userId, orgId, providerKey }, { db: prisma });
          if (!connId) throw new Error(`no nango connection for ${providerKey}`);
          return fetchBearerFromNango(providerKey, connId);
        },
        prisma,
        logger: console,
      });

      // Verify signature
      let sigOk = false;
      try {
        sigOk = adapter.verifyWebhookSignature(req.headers, rawBody);
      } catch (sigErr) {
        sigOk = false;
        console.warn(`[webhook] ${provider} signature verify error: ${sigErr.code || 'unknown'}`);
      }
      if (!sigOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
      }

      // Parse JSON
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      // Slack URL verification short-circuit
      const parsed = adapter.parseEvent(payload);
      if (parsed?.urlVerification) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }

      // Find subscription
      const sub = parsed?.externalId
        ? await prisma.inboundWebhookSubscription.findFirst({
            where: { providerKey: provider, externalId: String(parsed.externalId), status: 'active' },
          })
        : null;
      if (!sub) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no subscription' }));
        return;
      }

      // Persist event
      try {
        const evt = await prisma.inboundWebhookEvent.create({
          data: {
            subscriptionId: sub.id,
            orgId: sub.orgId,
            providerKey: provider,
            eventId: parsed.eventId || null,
            eventType: parsed.eventType || null,
            status: 'received',
            payload,
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, event_id: evt.id }));
      } catch (insertErr) {
        // Dedup on (org_id, provider_key, event_id) — treat as accepted
        if (insertErr.code === 'P2002') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, dedup: true }));
        } else {
          console.error(`[webhook] ${provider} persist failed: ${insertErr.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'persist failed' }));
        }
      }
    } catch (outerErr) {
      console.error(`[webhook] ${provider} unhandled: ${outerErr.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
    return;
  }

  if (pathname === '/admin/logs' && req.method === 'GET') {
    const content = renderAdminLogsPage({
      controlPlaneBaseUrl: CONTROL_PLANE_ADMIN_BASE_URL,
      coreBaseUrl: process.env.HIVEMIND_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(content);
    return;
  }

  if (pathname === '/admin/api/logs' && req.method === 'GET') {
    if (!isAdminAuthorized(req, url)) {
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }
    return jsonResponse(res, buildAdminServiceSnapshot());
  }

  if (pathname === '/admin/api/observability' && req.method === 'GET') {
    if (!isAdminAuthorized(req, url)) {
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }

    const adminSecret = req.headers['x-admin-secret'] || url.searchParams.get('admin_secret') || '';
    const core = buildAdminServiceSnapshot();
    let controlPlane = {
      service: 'control-plane',
      observed_at: new Date().toISOString(),
      health: { ok: false, service: 'hivemind-control-plane' },
      runtime: {},
      summary: { total: 0, errors: 0, warnings: 0, lastErrorAt: null, lastWarningAt: null },
      logs: [],
      error: null,
    };

    try {
      const response = await fetch(`${CONTROL_PLANE_ADMIN_BASE_URL}/admin/api/logs`, {
        headers: {
          'X-Admin-Secret': adminSecret,
        },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Control plane request failed with ${response.status}`);
      }
      controlPlane = payload;
    } catch (error) {
      controlPlane.error = error.message;
    }

    const logs = [...(core.logs || []), ...(controlPlane.logs || [])]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 250);

    return jsonResponse(res, {
      observed_at: new Date().toISOString(),
      core,
      control_plane: controlPlane,
      logs,
    });
  }

  // Live log streamer endpoint
  if (pathname === '/api/logs' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const container = url.searchParams.get('container') || 'hm-core';

    if (!['hm-control', 'hm-core'].includes(container)) {
      return jsonResponse(res, { error: 'Invalid container. Use hm-control or hm-core' }, 400);
    }

    // For hm-core, return our captured logs
    if (container === 'hm-core') {
      const logs = getLogBuffer(container).map(e => `[${e.timestamp}] [${e.type.toUpperCase()}] ${e.line}`);
      return jsonResponse(res, { container, logs });
    }

    // For hm-control, fetch from control plane container via internal network
    try {
      const cpResp = await fetch('http://hm-control:3000/api/logs?container=hm-control', {
        timeout: 5000,
      });
      if (cpResp.ok) {
        const data = await cpResp.json();
        return jsonResponse(res, { container, logs: data.logs || [] });
      }
    } catch (err) {
      console.log('[logs] Failed to fetch control plane logs:', err.message);
    }

    // Fallback: return empty if control plane doesn't have the endpoint
    return jsonResponse(res, { container, logs: [], note: 'Control plane log endpoint not available' });
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    // Initialize metrics namespace with all known keys defaulted to 0
    const DEFAULTS = {
      promotion_runs_total: 0, promotion_promoted_total: 0, promotion_stale_total: 0,
      contradiction_runs_total: 0, contradiction_emitted_total: 0,
      hygiene_runs_total: 0, hygiene_proposals_total: 0,
      synthesis_runs_total: 0, synthesis_emitted_total: 0,
    };
    globalThis.__hmMetrics = { ...DEFAULTS, ...(globalThis.__hmMetrics || {}) };
    // P3 #27 — Prometheus exposition format for ingest stats
    try {
      const [docs, segs, memEvLinks, entities, mentions, webhookFailed, webhookReceived, srcArt] = await Promise.all([
        prisma.knowledgeDocument.count().catch(() => 0),
        prisma.knowledgeSegment.count().catch(() => 0),
        prisma.memoryEvidenceLink.count().catch(() => 0),
        prisma.entity.count().catch(() => 0),
        prisma.entityMention.count().catch(() => 0),
        prisma.inboundWebhookEvent.count({ where: { status: 'failed' } }).catch(() => 0),
        prisma.inboundWebhookEvent.count({ where: { status: 'received' } }).catch(() => 0),
        prisma.sourceArtifact.count().catch(() => 0),
      ]);
      const lines = [
        '# HELP hivemind_knowledge_documents_total Number of knowledge documents stored',
        '# TYPE hivemind_knowledge_documents_total gauge',
        `hivemind_knowledge_documents_total ${docs}`,
        '# HELP hivemind_knowledge_segments_total Number of knowledge segments stored',
        '# TYPE hivemind_knowledge_segments_total gauge',
        `hivemind_knowledge_segments_total ${segs}`,
        '# HELP hivemind_source_artifacts_total Immutable evidence artifacts',
        '# TYPE hivemind_source_artifacts_total gauge',
        `hivemind_source_artifacts_total ${srcArt}`,
        '# HELP hivemind_memory_evidence_links_total Provenance links memory<->segment',
        '# TYPE hivemind_memory_evidence_links_total gauge',
        `hivemind_memory_evidence_links_total ${memEvLinks}`,
        '# HELP hivemind_entities_total Distinct canonical entities',
        '# TYPE hivemind_entities_total gauge',
        `hivemind_entities_total ${entities}`,
        '# HELP hivemind_entity_mentions_total Entity mention rows',
        '# TYPE hivemind_entity_mentions_total gauge',
        `hivemind_entity_mentions_total ${mentions}`,
        '# HELP hivemind_inbound_webhook_pending Pending webhook events to process',
        '# TYPE hivemind_inbound_webhook_pending gauge',
        `hivemind_inbound_webhook_pending ${webhookReceived}`,
        '# HELP hivemind_inbound_webhook_failed Failed webhook events',
        '# TYPE hivemind_inbound_webhook_failed gauge',
        `hivemind_inbound_webhook_failed ${webhookFailed}`,
        '# HELP hivemind_promotion_runs_total Memory promotion cron ticks since boot',
        '# TYPE hivemind_promotion_runs_total counter',
        `hivemind_promotion_runs_total ${globalThis.__hmMetrics.promotion_runs_total}`,
        '# HELP hivemind_promotion_promoted_total Memories promoted via background scan',
        '# TYPE hivemind_promotion_promoted_total counter',
        `hivemind_promotion_promoted_total ${globalThis.__hmMetrics.promotion_promoted_total}`,
        '# HELP hivemind_contradiction_runs_total Contradiction scanner ticks since boot',
        '# TYPE hivemind_contradiction_runs_total counter',
        `hivemind_contradiction_runs_total ${globalThis.__hmMetrics.contradiction_runs_total}`,
        '# HELP hivemind_contradiction_emitted_total Contradicts edges written',
        '# TYPE hivemind_contradiction_emitted_total counter',
        `hivemind_contradiction_emitted_total ${globalThis.__hmMetrics.contradiction_emitted_total}`,
        '# HELP hivemind_hygiene_runs_total Hygiene scanner ticks since boot',
        '# TYPE hivemind_hygiene_runs_total counter',
        `hivemind_hygiene_runs_total ${globalThis.__hmMetrics.hygiene_runs_total}`,
        '# HELP hivemind_hygiene_proposals_total Hygiene proposals generated',
        '# TYPE hivemind_hygiene_proposals_total counter',
        `hivemind_hygiene_proposals_total ${globalThis.__hmMetrics.hygiene_proposals_total}`,
        '# HELP hivemind_synthesis_runs_total Memory synthesizer cron ticks since boot',
        '# TYPE hivemind_synthesis_runs_total counter',
        `hivemind_synthesis_runs_total ${globalThis.__hmMetrics.synthesis_runs_total}`,
        '# HELP hivemind_synthesis_emitted_total Synthesis memories created',
        '# TYPE hivemind_synthesis_emitted_total counter',
        `hivemind_synthesis_emitted_total ${globalThis.__hmMetrics.synthesis_emitted_total}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n') + '\n');
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`# error: ${err.message}\n`);
      return;
    }
  }

  if (pathname === '/health') {
    // Probe Docling sidecar (non-blocking, short timeout)
    let doclingOk = null;
    if (process.env.DOCLING_URL) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`${process.env.DOCLING_URL}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        doclingOk = r.ok;
      } catch { doclingOk = false; }
    }
    return jsonResponse(res, {
      ok: true,
      service: 'hivemind-api',
      port: process.env.PORT || 3000,
      phase1: {
        document_first_ingestion: !!documentFirstIngestion,
        evidence_retrieval: !!evidenceRetrieval,
        docling_adapter: !!doclingAdapter,
        docling_reachable: doclingOk,
        evidence_collection: process.env.EVIDENCE_QDRANT_COLLECTION || null,
        memory_collection: process.env.MEMORY_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION || null,
      },
      schedulers: {
        sync_scheduler: !!syncScheduler,
        webhook_processor: process.env.ENABLE_WEBHOOK_RECEIVER !== 'false',
        hygiene_cron: process.env.ENABLE_HYGIENE_CRON === 'true',
        memory_promotion_jobs: process.env.ENABLE_MEMORY_PROMOTION_JOBS === 'true',
        contradiction_scan: process.env.ENABLE_CONTRADICTION_SCAN === 'true',
        memory_synthesis: process.env.ENABLE_MEMORY_SYNTHESIS === 'true',
      },
      features: {
        evidence_recall: process.env.ENABLE_EVIDENCE_RECALL === 'true',
        document_first_ingest: process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true',
        entity_extraction: process.env.ENABLE_ENTITY_EXTRACTION === 'true',
        topic_state: process.env.ENABLE_TOPIC_STATE === 'true',
      },
    });
  }

  // ── DR Server auth relay: verify an API key and return userId/orgId ──
  // Called by dr-server.js to resolve user identity from an API key.
  // Requires HIVEMIND_MASTER_API_KEY in Authorization header from the caller.
  if (pathname === '/api/auth/verify' && req.method === 'GET') {
    const callerKey = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!MASTER_API_KEY || callerKey !== MASTER_API_KEY) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }
    const userApiKey = (req.headers['x-hm-api-key'] || '').trim();
    if (!userApiKey) {
      return jsonResponse(res, { valid: false, error: 'x-hm-api-key header required' }, 400);
    }
    // Reuse the existing auth logic by simulating a request
    const fakeReq = { headers: { authorization: `Bearer ${userApiKey}` } };
    const authResult = await authenticateApiKey(fakeReq);
    if (!authResult.ok) {
      return jsonResponse(res, { valid: false, error: authResult.error }, 401);
    }
    return jsonResponse(res, {
      valid: true,
      userId: authResult.principal.userId,
      orgId: authResult.principal.orgId,
      scopes: authResult.principal.scopes || [],
    });
  }

  // POST /api/auth/claim-invites — claim all pending email-based invites on first login
  if (pathname === '/api/auth/claim-invites' && req.method === 'POST') {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    // Inline auth — this route sits above the global auth wall (intentional:
    // first-login flow shouldn't require an existing API key principal).
    // Bearer token is required either way to identify the user.
    const claimAuth = await authenticateApiKey(req);
    if (!claimAuth.ok) {
      return setOAuthUnauthorized(res, { statusCode: claimAuth.status || 401, error: 'unauthorized', errorDescription: claimAuth.error });
    }
    const userId = claimAuth.principal.userId;
    try {
      // Get user's email
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user || !user.email) return jsonResponse(res, { error: 'User email not found' }, 404);
      
      // Find all pending invites for this email
      const pendingInvites = await prisma.orgInvite.findMany({
        where: {
          email: user.email,
          usedAt: null,
          expiresAt: { gt: new Date() }
        }
      });
      
      if (pendingInvites.length === 0) {
        return jsonResponse(res, { claimed: 0, orgs: [] });
      }
      
      const results = [];
      for (const invite of pendingInvites) {
        // Check if already member
        const existing = await prisma.userOrganization.findFirst({
          where: { userId, orgId: invite.orgId }
        });
        if (existing) {
          // Skip if already a member
          await prisma.orgInvite.update({
            where: { id: invite.id },
            data: { usedAt: new Date(), usedBy: userId }
          });
          continue;
        }
        
        // Create org membership
        await prisma.userOrganization.create({
          data: { userId, orgId: invite.orgId, role: invite.role, joinedAt: new Date() }
        });
        
        // Create team memberships
        const teamIds = invite.teamIds || [];
        if (teamIds.length > 0) {
          const teamMemberships = teamIds.map(teamId => ({
            teamId,
            userId,
            role: 'member',
            joinedAt: new Date()
          }));
          await prisma.teamMember.createMany({ data: teamMemberships, skipDuplicates: true });
        }
        
        // Create project memberships
        const projectIds = invite.projectIds || [];
        if (projectIds.length > 0) {
          const projectMemberships = projectIds.map(projectId => ({
            projectId,
            userId,
            role: 'member',
            addedAt: new Date()
          }));
          await prisma.projectMember.createMany({ data: projectMemberships, skipDuplicates: true });
        }
        
        // Mark invite as used
        await prisma.orgInvite.update({
          where: { id: invite.id },
          data: { usedAt: new Date(), usedBy: userId }
        });
        
        // Invalidate access context cache
        invalidateAccessContextCache(userId, invite.orgId);

        // Audit
        await writeAuditLog(prisma, {
          userId,
          orgId: invite.orgId,
          eventType: 'invite_accepted',
          action: 'create',
          resourceType: 'org_invite',
          resourceId: invite.id,
          metadata: {
            via: 'claim-invites',
            email: user.email,
            role: invite.role,
            teams_joined: teamIds.length,
            projects_granted: projectIds.length,
          },
        }).catch(() => {});

        results.push({
          orgId: invite.orgId,
          role: invite.role,
          teamsJoined: teamIds.length,
          projectsGranted: projectIds.length
        });
      }

      return jsonResponse(res, { claimed: results.length, orgs: results });
    } catch (err) {
      console.error('[auth] claim-invites failed:', err.message);
      return jsonResponse(res, { error: 'Failed to claim invites' }, 500);
    }
  }

  // Serve client.html at root
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const content = fs.readFileSync(findExistingFile(CLIENT_HTML_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading client.html: ' + e.message);
      return;
    }
  }

  if (pathname === '/ux-test' || pathname === '/ux-test.html') {
    try {
      const content = fs.readFileSync(findExistingFile(UX_TEST_HTML_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading ui-testing.html: ' + e.message);
      return;
    }
  }

  if (pathname === '/webapp-wrapper' || pathname === '/webapp-wrapper.html') {
    try {
      const content = fs.readFileSync(findExistingFile(WEBAPP_WRAPPER_HTML_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading webapp-wrapper.html: ' + e.message);
      return;
    }
  }

  if (pathname === '/web/hivemind-web-sdk.js') {
    try {
      const content = fs.readFileSync(findExistingFile(WEB_SDK_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading hivemind-web-sdk.js: ' + e.message);
      return;
    }
  }

  // Serve log streamer HTML
  if (pathname === '/logs' || pathname === '/log-streamer' || pathname === '/log-streamer.html') {
    try {
      const content = fs.readFileSync(findExistingFile(LOG_STREAMER_HTML_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading log-streamer.html: ' + e.message);
      return;
    }
  }

  if (pathname === '/tampermonkey/hivemind-web.user.js') {
    try {
      const content = fs.readFileSync(findExistingFile(TAMPERMONKEY_USER_SCRIPT_CANDIDATES), 'utf-8');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading tampermonkey-hivemind-web.user.js: ' + e.message);
      return;
    }
  }

  if ((pathname === '/install/claude-mcp-macos.sh' || pathname === '/install/claude-mcp-linux.sh') && req.method === 'GET') {
    try {
      const platform = pathname.includes('linux') ? 'linux' : 'macos';
      const template = fs.readFileSync(path.join(CORE_SCRIPTS_ROOT, 'claude-mcp-installer.sh'), 'utf-8');
      const apiKey = url.searchParams.get('api_key') || '';
      const content = template
        .replaceAll('__DIRECT_MCP_ENDPOINT__', 'https://core.hivemind.davinciai.eu:8050/api/mcp')
        .replaceAll('__HAS_API_KEY__', apiKey ? '1' : '0')
        .replaceAll('__API_KEY__', apiKey)
        .replaceAll('__PLATFORM__', platform);
      res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading Claude installer: ' + e.message);
      return;
    }
  }

  if (pathname === '/install/claude-mcp-windows.ps1' && req.method === 'GET') {
    try {
      const template = fs.readFileSync(path.join(CORE_SCRIPTS_ROOT, 'claude-mcp-installer.ps1'), 'utf-8');
      const apiKey = url.searchParams.get('api_key') || '';
      const content = template
        .replaceAll('__DIRECT_MCP_ENDPOINT__', 'https://core.hivemind.davinciai.eu:8050/api/mcp')
        .replaceAll('__HAS_API_KEY__', apiKey ? '1' : '0')
        .replaceAll('__API_KEY__', apiKey);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200);
      res.end(content);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading Claude PowerShell installer: ' + e.message);
      return;
    }
  }

  // ── @hivemind/cli tarball (until package is published to npm registry) ──
  // GET /install/cli.tgz → serves packages/cli/hivemind-cli-<ver>.tgz
  // GET /install/cli.sh  → renders shim that `npx`s the tarball URL
  //
  // Why this exists: until we run `npm publish`, `npx @hivemind/cli` can't
  // resolve. npx happily accepts a tarball URL directly, so the same UX
  // works via `npx -y https://core.hivemind.davinciai.eu:8050/install/cli.tgz setup`.
  // The cli.sh wraps that in a curl|bash for users who don't want to type
  // the URL.
  // ── Chrome extension download ─────────────────────────────────────────
  // GET /install/chrome-extension.zip → serves the prebuilt extension zip.
  // Production image bakes it at /app/data/extension/hivemind-chrome-extension.zip.
  // Local dev: builds on demand from repo's extensions/chrome/.
  if ((pathname === '/install/chrome-extension.zip' ||
       pathname === '/install/extension.zip' ||
       pathname === '/install/hivemind-chrome.zip') && req.method === 'GET') {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const candidates = [
        process.env.HIVEMIND_EXTENSION_DIR,
        path.join(PROJECT_ROOT, 'data', 'extension'),
        path.join(REPO_ROOT, 'extensions', 'chrome'),
        '/opt/HIVEMIND/extensions/chrome',
      ].filter(Boolean);

      // Try prebuilt zip first.
      for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir);
        const zips = entries.filter((f) => f.startsWith('hivemind-chrome-extension') && f.endsWith('.zip'));
        if (zips.length > 0) {
          zips.sort();
          const zipPath = path.join(dir, zips[zips.length - 1]);
          const stat = fs.statSync(zipPath);
          const filename = `hivemind-chrome-extension.zip`;
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Length', stat.size);
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.writeHead(200);
          fs.createReadStream(zipPath).pipe(res);
          return;
        }
      }

      // Fallback: zip on-demand from extensions/chrome (dev mode).
      const chromeDir = candidates.find((d) =>
        fs.existsSync(d) && fs.existsSync(path.join(d, 'manifest.json'))
      );
      if (!chromeDir) {
        res.writeHead(404);
        res.end('chrome extension not found — tried: ' + candidates.join(', '));
        return;
      }
      const { spawn } = await import('node:child_process');
      const tmpZip = `/tmp/hivemind-chrome-${Date.now()}.zip`;
      const proc = spawn('zip', [
        '-r', tmpZip, '.',
        '-x', '*.md', '-x', '.DS_Store',
        '-x', 'node_modules/*', '-x', '*.bak',
        '-x', '.git/*', '-x', '*.test.js',
        '-x', 'store-assets/*',
      ], { cwd: chromeDir });
      await new Promise((resolve, reject) => {
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`zip exit ${code}`)));
        proc.on('error', reject);
      });
      const stat = fs.statSync(tmpZip);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="hivemind-chrome-extension.zip"`);
      res.setHeader('Cache-Control', 'no-cache');
      res.writeHead(200);
      const stream = fs.createReadStream(tmpZip);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(tmpZip); } catch {} });
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('chrome extension serve error: ' + e.message);
      return;
    }
  }

  if (pathname === '/install/cli.tgz' && req.method === 'GET') {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      // In dev REPO_ROOT works fine. In the deployed hm-core container the
      // bind-mount maps /opt/HIVEMIND/core → /app, so REPO_ROOT resolves to
      // / which is wrong. Check both, plus an explicit env override for
      // future redeploys that move things around.
      const candidates = [
        process.env.HIVEMIND_CLI_DIR,
        // Inside the hm-core container the bind mount is core/ → /app,
        // so /app/data/cli is the canonical in-container location. Keep
        // it first so prod resolves fast.
        path.join(PROJECT_ROOT, 'data', 'cli'),
        path.join(REPO_ROOT, 'packages', 'cli'),
        '/opt/HIVEMIND/packages/cli',
        '/opt/HIVEMIND/core/data/cli',
      ].filter(Boolean);
      let cliDir = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) { cliDir = c; break; }
      }
      if (!cliDir) {
        res.writeHead(404);
        res.end('cli tarball dir not found — tried: ' + candidates.join(', '));
        return;
      }
      const files = fs.readdirSync(cliDir).filter(f => f.startsWith('hivemind-cli-') && f.endsWith('.tgz'));
      if (!files.length) {
        res.writeHead(404);
        res.end('cli tarball not built — run `cd packages/cli && npm pack`');
        return;
      }
      // Pick highest-version tarball (lexicographic sort works for semver in our range).
      files.sort();
      const tarPath = path.join(cliDir, files[files.length - 1]);
      const stat = fs.statSync(tarPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${files[files.length - 1]}"`);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.writeHead(200);
      fs.createReadStream(tarPath).pipe(res);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('cli tarball error: ' + e.message);
      return;
    }
  }

  if (pathname === '/install/cli.sh' && req.method === 'GET') {
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'core.hivemind.davinciai.eu:8050').toString();
    const base = `${proto}://${host}`;
    const apiKey = url.searchParams.get('api_key') || '';
    // Heredoc-safe — escape $ that should reach bash, leave ${} in the
    // template literal alone via plain string concat.
    const body =
`#!/usr/bin/env bash
# HIVEMIND CLI bootstrap. Deliberately NOT using \`set -e\` — the
# /dev/tty redirect can fail on hosts without a controlling terminal
# (CI, agent harnesses) and we want the script to continue anyway,
# just falling back to non-interactive mode.
set -uo pipefail

HIVEMIND_BASE="${base}"
HIVEMIND_API_KEY="\${HIVEMIND_API_KEY:-${apiKey}}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ required. Install from https://nodejs.org and re-run." >&2
  exit 1
fi

HIVEMIND_TMP="\$(mktemp -d 2>/dev/null || mktemp -d -t hivemind)"
TARBALL="\$HIVEMIND_TMP/hivemind-cli.tgz"

echo "→ Downloading @hivemind/cli from \$HIVEMIND_BASE …"
curl -fsSL "\$HIVEMIND_BASE/install/cli.tgz" -o "\$TARBALL" || {
  echo "download failed" >&2; rm -rf "\$HIVEMIND_TMP"; exit 1;
}

echo "→ Extracting …"
( cd "\$HIVEMIND_TMP" && tar xzf "\$TARBALL" ) || {
  echo "extract failed" >&2; rm -rf "\$HIVEMIND_TMP"; exit 1;
}

PKG_DIR="\$HIVEMIND_TMP/package"
if [ ! -d "\$PKG_DIR" ]; then
  echo "extracted package dir not found at \$PKG_DIR" >&2
  ls -la "\$HIVEMIND_TMP" >&2
  rm -rf "\$HIVEMIND_TMP"
  exit 1
fi

echo "→ Launching …"

# Run node directly (no \`exec\` replacement) so we can:
#   - redirect this single command's stdin from /dev/tty when available,
#     avoiding the previous \`exec </dev/tty ...\` failure on no-ctty hosts.
#   - clean up the tmp dir after the CLI finishes.
#
# The \`< /dev/tty\` redirect is per-command — if /dev/tty doesn't exist
# the redirect line will fail but we route around it with the if-branch.
NODE_BIN="\$PKG_DIR/bin/hivemind.js"
RC=0

# Detect a usable controlling terminal. \`[ -r /dev/tty ]\` returns true on
# many hosts that nonetheless reject 'open /dev/tty' with ENOTTY — so we
# try the actual redirect in a sub-shell first and fall back gracefully.
HIVEMIND_HAVE_TTY=0
if ( exec </dev/tty ) >/dev/null 2>&1; then
  HIVEMIND_HAVE_TTY=1
fi

if [ "\$HIVEMIND_HAVE_TTY" = "1" ]; then
  HIVEMIND_API_KEY="\$HIVEMIND_API_KEY" \\
  HIVEMIND_ENDPOINT="\$HIVEMIND_BASE/api/mcp" \\
    node "\$NODE_BIN" setup "\$@" </dev/tty >/dev/tty 2>/dev/tty
  RC=\$?
else
  # No TTY (CI / agent harness) — node will fall back to non-interactive
  # mode. Setup must have been pre-configured with HIVEMIND_API_KEY +
  # an explicit client arg, else the picker will silently pick the first
  # option which is rarely what the user wants. Print a hint.
  echo "(no TTY detected — running non-interactive. Pass client + HIVEMIND_API_KEY explicitly.)" >&2
  HIVEMIND_API_KEY="\$HIVEMIND_API_KEY" \\
  HIVEMIND_ENDPOINT="\$HIVEMIND_BASE/api/mcp" \\
    node "\$NODE_BIN" setup "\$@"
  RC=\$?
fi

rm -rf "\$HIVEMIND_TMP"
exit \$RC
`;
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200);
    res.end(body);
    return;
  }

  // ── Consumer URL / Meta MCP: auth-less token-based SSE & RPC ──
  const consumerSseMatch = pathname.match(/^\/mcp\/([^\/]+)\/sse$/);
  if (consumerSseMatch && req.method === 'GET') {
    const token = consumerSseMatch[1];
    const consumer = await resolveConsumerToken(token);
    if (!consumer) {
      return jsonResponse(res, { error: 'Invalid or expired consumer token' }, 401);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/mcp/${token}/rpc` })}\n\n`);
    res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
    });
    return;
  }

  const consumerRpcMatch = pathname.match(/^\/mcp\/([^\/]+)\/rpc$/);
  if (consumerRpcMatch && req.method === 'POST') {
    const token = consumerRpcMatch[1];
    const consumer = await resolveConsumerToken(token);
    if (!consumer) {
      return jsonResponse(res, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Invalid or expired consumer token' }
      }, 401);
    }

    const body = await parseBody(req);
    const { userId, orgId, rawKey } = consumer;

    const apiClient = createHostedApiClient({
      baseUrl: getHostedApiBaseUrl(req),
      apiKey: rawKey || '',
      userId,
      orgId
    });

    if (!body?.method) {
      return jsonResponse(res, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'Invalid request: method is required' }
      }, 400);
    }

    if (body.method === 'notifications/initialized' || body.method === 'initialized') {
      res.writeHead(202);
      res.end();
      return;
    }

    let result;
    switch (body.method) {
      case 'initialize':
        result = handleInitialize(body.params || {}, userId);
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = handleToolsList(userId, orgId, { scopes: consumer.scopes || ['*'] });
        break;
      case 'tools/call':
        result = await handleToolCall(body.params || {}, userId, orgId, apiClient, { isMaster: !!consumer.master });
        break;
      case 'resources/list':
        result = handleResourcesList(userId, orgId);
        break;
      case 'resources/read':
        result = handleReadResource(body.params || {}, userId, orgId);
        break;
      case 'prompts/list':
        result = handlePromptsList(userId, orgId);
        break;
      case 'prompts/get':
        result = handleGetPrompt(body.params || {}, userId, orgId);
        break;
      default:
        return jsonResponse(res, {
          jsonrpc: '2.0',
          id: body?.id ?? null,
          error: { code: -32601, message: `Method not found: ${body.method}` }
        }, 404);
    }

    return jsonResponse(res, {
      jsonrpc: '2.0',
      id: body?.id ?? null,
      result
    });
  }

  // ── OAuth 2.1 Discovery & Endpoints ──────────────────────────────────────

  // Discovery base — derive from request Host so a client that reached us
  // via the FE domain (hivemind.davinciai.eu) gets matching issuer +
  // endpoints. Claude.ai's custom-connector flow rejects issuer/host
  // mismatches. Vercel rewrites /oauth/* + /.well-known/oauth-* on the FE
  // domain back to core, so all endpoint URLs work via either host.
  const _discoveryBase = (() => {
    const xfHost = req.headers['x-forwarded-host'] || req.headers['x-original-host'];
    const rawHost = (xfHost || req.headers.host || '').toString().split(',')[0].trim();
    if (!rawHost) return OAUTH_BASE_URL;
    // Caddy proxies hivemind.davinciai.eu (Vercel-rewritten) to the same
    // hm-core container as core.hivemind.davinciai.eu:8050. Whichever
    // host Caddy forwards, normalize to the canonical FE host so issuer
    // matches what Claude sees in the address bar when it fetched the
    // discovery doc.
    if (rawHost.endsWith('davinciai.eu') || rawHost.endsWith('davinciai.eu:8050')) {
      const FE_HOST = process.env.HIVEMIND_OAUTH_FE_HOST || 'hivemind.davinciai.eu';
      return `https://${FE_HOST}`;
    }
    return OAUTH_BASE_URL;
  })();

  // ── HIVEMIND logo asset for OAuth pages ────────────────────────
  // Streams the actual brand PNG (extensions/chrome/Hivemind_extension.png)
  // so Claude/ChatGPT/Perplexity OAuth consent pages render the real logo
  // rather than an SVG approximation. Cached aggressively.
  if (pathname === '/oauth/logo.png' && req.method === 'GET') {
    try {
      // Container bind-mounts only /opt/HIVEMIND/core → /app, so the brand
      // asset is copied into core/public/brand/ for in-container access.
      // Fallback to repo root extensions/chrome/ when running outside docker.
      const candidates = [
        path.join(process.cwd(), 'public', 'brand', 'hivemind-logo.png'),
        path.join(process.cwd(), 'core', 'public', 'brand', 'hivemind-logo.png'),
        path.join(process.cwd(), 'extensions', 'chrome', 'Hivemind_extension.png'),
        path.join(process.cwd(), '..', 'extensions', 'chrome', 'Hivemind_extension.png'),
      ];
      let logoPath = null;
      for (const p of candidates) { if (fs.existsSync(p)) { logoPath = p; break; } }
      if (!logoPath) throw new Error(`logo not found in: ${candidates.join(', ')}`);
      const png = fs.readFileSync(logoPath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'Content-Length': png.length,
      });
      return res.end(png);
    } catch (err) {
      console.warn('[oauth/logo] missing PNG, falling back to 404:', err.message);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('logo not found');
    }
  }

  if (pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    return jsonResponse(res, {
      resource: _discoveryBase,
      authorization_servers: [_discoveryBase],
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      bearer_methods_supported: ['header']
    });
  }

  if (pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    return jsonResponse(res, {
      issuer: _discoveryBase,
      authorization_endpoint: `${_discoveryBase}/oauth/authorize`,
      token_endpoint: `${_discoveryBase}/oauth/token`,
      revocation_endpoint: `${_discoveryBase}/oauth/revoke`,
      registration_endpoint: `${_discoveryBase}/oauth/register`,
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    });
  }

  // ── OAuth 2.0 Dynamic Client Registration (RFC 7591) ───────────────
  // Required by Claude.ai / ChatGPT MCP custom connectors — they POST
  // client metadata, get back a client_id (and optional client_secret),
  // then use that for the authorization flow. Public PKCE clients only:
  // no client_secret issued. New clients persisted via the oauth_client_registry
  // metaParameter row (same store loadOAuthClientRegistry reads from).
  if (pathname === '/oauth/register' && req.method === 'POST') {
    try {
      // /oauth/register runs before the main body-parse path; parse inline.
      const reqBody = await parseBody(req).catch(() => ({}));
      const meta = (typeof reqBody === 'object' && reqBody) ? reqBody : {};
      const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter(u => typeof u === 'string' && u.length > 0) : [];
      if (redirectUris.length === 0) {
        return jsonResponse(res, { error: 'invalid_redirect_uri', error_description: 'redirect_uris[] required' }, 400);
      }
      const clientName = String(meta.client_name || 'Unnamed Client').slice(0, 200);
      // Generate public client_id (PKCE only, no secret).
      const clientId = `hmc_${crypto.randomBytes(12).toString('hex')}`;
      const record = {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        allowed_scopes: OAUTH_SCOPES_SUPPORTED,
        is_public: true,
        client_secret_hash: null,
        status: 'active',
        created_at: new Date().toISOString(),
        metadata: {
          grant_types: Array.isArray(meta.grant_types) ? meta.grant_types : ['authorization_code', 'refresh_token'],
          response_types: Array.isArray(meta.response_types) ? meta.response_types : ['code'],
          token_endpoint_auth_method: meta.token_endpoint_auth_method || 'none',
          software_id: meta.software_id || null,
          software_version: meta.software_version || null,
          client_uri: meta.client_uri || null,
          logo_uri: meta.logo_uri || null,
        },
      };
      // Persist via metaParameter (same registry loadOAuthClientRegistry reads).
      if (prisma?.metaParameter) {
        try {
          const existing = await prisma.metaParameter.findUnique({ where: { key: 'oauth_client_registry' } });
          const current = Array.isArray(existing?.value) ? existing.value : [];
          current.push(record);
          await prisma.metaParameter.upsert({
            where: { key: 'oauth_client_registry' },
            update: { value: current },
            create: { key: 'oauth_client_registry', value: current },
          });
        } catch (dbErr) {
          console.warn('[oauth/register] DB persist failed, falling back to in-memory:', dbErr.message);
        }
      }
      // Invalidate registry cache so the new client is visible on the
      // immediately-following /oauth/authorize call.
      oauthClientRegistryCache = { expiresAt: 0, clients: oauthClientRegistryCache.clients };

      return jsonResponse(res, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: record.metadata.grant_types,
        response_types: record.metadata.response_types,
        token_endpoint_auth_method: 'none',
        scope: OAUTH_SCOPES_SUPPORTED.join(' '),
      }, 201);
    } catch (err) {
      console.error('[oauth/register] error:', err);
      return jsonResponse(res, { error: 'server_error', error_description: err.message }, 500);
    }
  }

  if (pathname === '/oauth/login/zitadel' && req.method === 'GET') {
    if (!oauthZitadelClient) {
      return jsonResponse(res, { error: 'service_unavailable', error_description: 'Zitadel login is not configured.' }, 503);
    }
    const payload = {
      client_id: url.searchParams.get('client_id') || '',
      redirect_uri: url.searchParams.get('redirect_uri') || '',
      scope: url.searchParams.get('scope') || '',
      state: url.searchParams.get('state') || '',
      code_challenge: url.searchParams.get('code_challenge') || '',
      code_challenge_method: url.searchParams.get('code_challenge_method') || '',
      resource: url.searchParams.get('resource') || OAUTH_RESOURCE_DEFAULT,
      response_type: url.searchParams.get('response_type') || 'code'
    };
    const authState = await oauthSessionStore.createAuthState({
      kind: 'oauth_zitadel_login',
      oauthParams: payload
    });
    const redirect = oauthZitadelClient.buildAuthorizeUrl(authState);
    res.writeHead(302, { Location: redirect });
    res.end();
    return;
  }

  if (pathname === '/oauth/callback/zitadel' && req.method === 'GET') {
    if (!oauthZitadelClient) {
      return jsonResponse(res, { error: 'service_unavailable', error_description: 'Zitadel login is not configured.' }, 503);
    }
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (!code || !state) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'Missing code/state for callback.' }, 400);
    }

    const authState = await oauthSessionStore.consumeAuthState(state);
    if (!authState || authState.kind !== 'oauth_zitadel_login' || !authState.oauthParams) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'Invalid or expired login state.' }, 400);
    }

    let resolved;
    try {
      resolved = await oauthZitadelClient.exchangeAndResolveUser(code);
    } catch (error) {
      return jsonResponse(res, { error: 'access_denied', error_description: `Zitadel exchange failed: ${error.message}` }, 401);
    }

    await createOAuthSession(res, {
      userId: resolved?.userInfo?.sub || DEFAULT_USER,
      orgId: DEFAULT_ORG,
      authProvider: 'zitadel',
      email: resolved?.userInfo?.email || null
    });

    const next = new URLSearchParams(authState.oauthParams);
    res.writeHead(302, { Location: `/oauth/authorize?${next.toString()}` });
    res.end();
    return;
  }

  if (pathname === '/oauth/authorize' && req.method === 'GET') {
    const responseType = url.searchParams.get('response_type') || 'code';
    const clientId = url.searchParams.get('client_id') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const scope = url.searchParams.get('scope') || '';
    const state = url.searchParams.get('state') || '';
    const resource = url.searchParams.get('resource') || OAUTH_RESOURCE_DEFAULT;
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';

    if (responseType !== 'code') {
      return jsonResponse(res, { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' }, 400);
    }
    if (!clientId || !redirectUri) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'client_id and redirect_uri are required.' }, 400);
    }

    const client = await getOAuthClientById(clientId);
    if (!client) {
      return jsonResponse(res, { error: 'unauthorized_client', error_description: 'Client is not registered or not active.' }, 401);
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'redirect_uri is not allowed for this client.' }, 400);
    }

    if (client.is_public) {
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        return jsonResponse(
          res,
          { error: 'invalid_request', error_description: 'Public clients must provide PKCE code_challenge with method S256.' },
          400
        );
      }
    }

    const requestedScopes = normalizeRequestedScopes(scope, ['memory.read']);
    const disallowed = requestedScopes.filter(s => !client.allowed_scopes.includes(s));
    if (disallowed.length > 0) {
      return jsonResponse(res, { error: 'invalid_scope', error_description: `Scopes not allowed for client: ${disallowed.join(', ')}` }, 400);
    }

    const session = await resolveOAuthSession(req);
    if (session?.userId) {
      const consentStateId = await oauthSessionStore.createAuthState({
        kind: 'oauth_consent',
        payload: {
          clientId,
          redirectUri,
          scopes: requestedScopes,
          state,
          codeChallenge,
          codeChallengeMethod,
          resource,
          responseType
        }
      });

      const scopeListHtml = requestedScopes.map(s => `
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.5rem 0; padding:0.5rem; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0;">
        <input type="checkbox" checked disabled id="s-${s}" style="accent-color:#0ea5e9;">
        <label for="s-${s}" style="font-size:0.9rem; color:#475569; cursor:default;">${sanitizeHtml(s)}</label>
      </div>
    `).join('');

    const consentHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HiveMind Partner Connection</title>
<style>
  body{font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;background:#fafaf6;color:#0a0a0a;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid #e3e0db;border-radius:18px;padding:2.2rem;max-width:480px;width:92%;box-shadow:0 20px 60px rgba(10,10,10,.08)}
  .brand{display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:1.4rem;padding-bottom:1.2rem;border-bottom:1px solid #f3f1ec}
  .brand img,.brand svg{width:72px;height:72px;margin-bottom:.6rem}
  .brand-title{font-size:.78rem;font-weight:700;letter-spacing:.18em;color:#737373;text-transform:uppercase}
  .header{display:flex;align-items:center;justify-content:center;gap:.9rem;margin-bottom:1.2rem}
  .app-icon{width:44px;height:44px;background:#f3f1ec;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#737373;font-size:1.1rem}
  .sync-icon{color:#a3a3a3;font-size:1.2rem}
  .hm-icon{width:44px;height:44px;border-radius:10px;background:#fafaf6;border:1px solid #e3e0db;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .hm-icon img,.hm-icon svg{width:38px;height:38px}
  h1{font-size:1.3rem;margin:0 0 .3rem;color:#0f172a}
  p{font-size:0.95rem;color:#64748b;line-height:1.5;margin:0 0 1.2rem}
  .permissions-box{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem;margin-bottom:1.5rem}
  .perm-header{font-size:0.85rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#94a3b8;margin-bottom:0.8rem}
  .access-level{margin-bottom:1.5rem}
  .radio-group{display:flex;flex-direction:column;gap:0.8rem}
  .radio-item{display:flex;align-items:flex-start;gap:0.8rem;padding:1rem;border:1px solid #e2e8f0;border-radius:10px;cursor:pointer;transition:all 0.2s}
  .radio-item:hover{background:#f8fafc;border-color:#0ea5e9}
  .radio-item input:checked + .radio-content{color:#0ea5e9}
  .radio-content strong{display:block;margin-bottom:0.2rem}
  .radio-content span{font-size:0.85rem;color:#64748b}
  .actions{display:flex;gap:.7rem;margin-top:1.5rem}
  button{flex:1;padding:.85rem;border:none;border-radius:10px;font-size:.95rem;cursor:pointer;font-weight:600;transition:opacity 0.2s}
  button:hover{opacity:0.9}
  .approve{background:#0ea5e9;color:#fff}
  .deny{background:#f1f5f9;color:#475569}
</style></head><body>
<div class="card">
  <div class="brand">
    <img src="/oauth/logo.png" alt="HIVEMIND" width="72" height="72" style="border-radius:14px;object-fit:cover">
    <div class="brand-title">HIVEMIND</div>
  </div>
  <div class="header">
    <div class="app-icon">${sanitizeHtml(client.client_name[0])}</div>
    <div class="sync-icon">⇌</div>
    <div class="hm-icon"><img src="/oauth/logo.png" alt="HIVEMIND" width="38" height="38" style="border-radius:8px;object-fit:cover"></div>
  </div>
  <h1>Connect ${sanitizeHtml(client.client_name)}</h1>
  <p>Authorize <strong>${sanitizeHtml(client.client_name)}</strong> to securely access your HiveMind account details and tools.</p>
  
  <form method="POST" action="/oauth/authorize">
    <div class="access-level">
      <div class="perm-header">Select Access Level</div>
      <div class="radio-group">
        <label class="radio-item">
          <input type="radio" name="access_tier" value="full" checked style="margin-top:0.3rem">
          <div class="radio-content">
            <strong>Full Access</strong>
            <span>Ability to read, write and execute memory operations. recommended for full integration.</span>
          </div>
        </label>
        <label class="radio-item">
          <input type="radio" name="access_tier" value="default" style="margin-top:0.3rem">
          <div class="radio-content">
            <strong>Default Access</strong>
            <span>Read-only access to specific memory segments and limited tool execution.</span>
          </div>
        </label>
      </div>
    </div>

    <div class="permissions-box">
      <div class="perm-header">Requested Scopes</div>
      ${scopeListHtml}
    </div>

    <input type="hidden" name="oauth_state_id" value="${sanitizeHtml(consentStateId)}">
    <input type="hidden" name="client_id" value="${sanitizeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${sanitizeHtml(redirectUri)}">
    <input type="hidden" name="scope" value="${sanitizeHtml(requestedScopes.join(' '))}">
    <input type="hidden" name="state" value="${sanitizeHtml(state)}">
    <input type="hidden" name="code_challenge" value="${sanitizeHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${sanitizeHtml(codeChallengeMethod)}">
    <input type="hidden" name="resource" value="${sanitizeHtml(resource)}">
    
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">Proceed Further</button>
      <button type="submit" name="action" value="deny" class="deny">Cancel</button>
    </div>
  </form>
</div></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(consentHtml);
      return;
    }

    // Primary login button → dashboard branded login page
    // (/hivemind/login). That page handles Google SSO + email/password +
    // Zitadel under one HIVEMIND-branded UI, the same flow CLI and the
    // browser extension use. After login the dashboard sets hm_cp_session
    // on hivemind.davinciai.eu and redirects back to /oauth/authorize,
    // where resolveOAuthSession() recognises the cookie automatically.
    //
    // returnTo MUST use the public dashboard origin (hivemind.davinciai.eu)
    // not the upstream core origin. Vercel rewrites /oauth/authorize back
    // to core, and the dashboard cookie hm_cp_session is scoped to that
    // host — so the OAuth flow stays end-to-end on one domain.
    const dashboardFeBase = process.env.HIVEMIND_FRONTEND_BASE_URL
      || process.env.HIVEMIND_DASHBOARD_URL
      || 'https://hivemind.davinciai.eu';
    // Strip any upstream-side prefix and force the canonical /oauth/authorize
    // path on the dashboard origin. req.url already carries the full query
    // string (response_type, client_id, etc.).
    const reqUrlPath = req.url.startsWith('/') ? req.url : `/${req.url}`;
    const returnTo = `${dashboardFeBase}${reqUrlPath}`;
    const dashboardLoginUrl = `${dashboardFeBase}/hivemind/login?cli_return_to=${encodeURIComponent(returnTo)}`;

    const dashboardButton = `<a href="${dashboardLoginUrl}" style="display:block;text-align:center;padding:.7rem .8rem;background:#117dff;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;margin-bottom:1rem">Continue with HIVEMIND login</a>`;

    const loginHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HiveMind Sign In</title>
<style>
  body{font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;background:#fafaf6;color:#0a0a0a;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid #e3e0db;border-radius:18px;padding:2.2rem;max-width:420px;width:92%;box-shadow:0 20px 60px rgba(10,10,10,.08)}
  .brand{display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:1.4rem;padding-bottom:1.2rem;border-bottom:1px solid #f3f1ec}
  .brand img,.brand svg{width:72px;height:72px;margin-bottom:.6rem}
  .brand-title{font-size:.78rem;font-weight:700;letter-spacing:.18em;color:#737373;text-transform:uppercase}
  h1{font-size:1.2rem;margin:0 0 .4rem;color:#0a0a0a}
  p{font-size:.9rem;color:#737373;margin:0 0 1rem}
  label{display:block;font-size:.85rem;color:#0a0a0a;margin-bottom:.3rem;font-weight:600}
  input[type=password]{width:100%;padding:.65rem;border:1px solid #e3e0db;border-radius:10px;background:#fafaf6;color:#0a0a0a;margin-bottom:.8rem;box-sizing:border-box;font-size:.95rem}
  input[type=password]:focus{outline:none;border-color:#0a0a0a;background:#fff}
  button{width:100%;padding:.72rem;background:#0a0a0a;color:#fff;border:none;border-radius:10px;cursor:pointer;font-weight:600;font-size:.95rem}
  button:hover{background:#1a1a1a}
  .divider{margin:.9rem 0;text-align:center;color:#a3a3a3;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase}
</style></head><body>
<div class="card">
  <div class="brand">
    <img src="/oauth/logo.png" alt="HIVEMIND" width="72" height="72" style="border-radius:14px;object-fit:cover">
    <div class="brand-title">HIVEMIND</div>
  </div>
  <h1>Sign in to HiveMind</h1>
  <p>${sanitizeHtml(client.client_name)} needs your consent to connect.</p>
  ${dashboardButton}
  <div class="divider">or use local admin login</div>
  <form method="POST" action="/oauth/login">
    <input type="hidden" name="client_id" value="${sanitizeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${sanitizeHtml(redirectUri)}">
    <input type="hidden" name="scope" value="${sanitizeHtml(requestedScopes.join(' '))}">
    <input type="hidden" name="state" value="${sanitizeHtml(state)}">
    <input type="hidden" name="code_challenge" value="${sanitizeHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${sanitizeHtml(codeChallengeMethod)}">
    <input type="hidden" name="resource" value="${sanitizeHtml(resource)}">
    <label for="admin_secret">Admin Secret</label>
    <input type="password" id="admin_secret" name="admin_secret" required autofocus>
    <button type="submit">Sign In</button>
  </form>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(loginHtml);
    return;
  }

  if (pathname === '/oauth/login' && req.method === 'POST') {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    const params = new URLSearchParams(rawBody);
    const secret = params.get('admin_secret') || '';

    if (secret !== ADMIN_SECRET) {
      return jsonResponse(res, { error: 'access_denied', error_description: 'Invalid credentials.' }, 401);
    }

    await createOAuthSession(res, {
      userId: DEFAULT_USER,
      orgId: DEFAULT_ORG,
      authProvider: 'local_admin'
    });

    const authorizeParams = new URLSearchParams();
    for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']) {
      const val = params.get(key);
      if (val) authorizeParams.set(key, val);
    }
    authorizeParams.set('response_type', 'code');
    res.writeHead(302, { Location: `/oauth/authorize?${authorizeParams.toString()}` });
    res.end();
    return;
  }

  if (pathname === '/oauth/authorize' && req.method === 'POST') {
    const session = await resolveOAuthSession(req);
    if (!session?.userId) {
      return jsonResponse(res, { error: 'access_denied', error_description: 'User session is not authenticated.' }, 401);
    }

    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    const params = new URLSearchParams(rawBody);
    const action = params.get('action');
    const clientId = params.get('client_id') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const scope = params.get('scope') || '';
    const state = params.get('state') || '';
    const resource = params.get('resource') || OAUTH_RESOURCE_DEFAULT;
    const codeChallenge = params.get('code_challenge') || '';
    const codeChallengeMethod = params.get('code_challenge_method') || '';
    const oauthStateId = params.get('oauth_state_id') || '';

    const client = await getOAuthClientById(clientId);
    if (!client) {
      return jsonResponse(res, { error: 'unauthorized_client' }, 401);
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'redirect_uri is not allowed for this client.' }, 400);
    }

    const requestedScopes = normalizeRequestedScopes(scope, ['memory.read']);
    const disallowed = requestedScopes.filter(s => !client.allowed_scopes.includes(s));
    if (disallowed.length > 0) {
      return jsonResponse(res, { error: 'invalid_scope', error_description: `Scopes not allowed for client: ${disallowed.join(', ')}` }, 400);
    }

    const consentState = await oauthSessionStore.consumeAuthState(oauthStateId);
    if (!consentState || consentState.kind !== 'oauth_consent' || !consentState.payload) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'Consent state is invalid or expired.' }, 400);
    }
    const expected = consentState.payload;
    const consentMatches = (
      expected.clientId === clientId
      && expected.redirectUri === redirectUri
      && expected.state === state
      && expected.codeChallenge === codeChallenge
      && expected.codeChallengeMethod === codeChallengeMethod
      && expected.resource === resource
      && requestedScopes.join(' ') === (expected.scopes || []).join(' ')
    );
    if (!consentMatches) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'Consent parameters mismatch.' }, 400);
    }

    if (action === 'deny') {
      const denyUrl = new URL(redirectUri);
      denyUrl.searchParams.set('error', 'access_denied');
      if (state) denyUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: denyUrl.toString() });
      res.end();
      return;
    }

    const code = crypto.randomBytes(32).toString('hex');
    oauthCodeStore.set(code, {
      clientId,
      redirectUri,
      scopes: requestedScopes,
      codeChallenge,
      codeChallengeMethod,
      userId: session.userId || DEFAULT_USER,
      orgId: session.orgId || DEFAULT_ORG,
      workspaceId: session.workspaceId || null,
      resource,
      state,
      expiresAt: Date.now() + OAUTH_CODE_TTL_MS
    });

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);
    res.writeHead(302, { Location: callbackUrl.toString() });
    res.end();
    return;
  }

  if (pathname === '/oauth/token' && req.method === 'POST') {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });

    let tokenParams;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) {
      try { tokenParams = JSON.parse(rawBody); } catch { tokenParams = {}; }
    } else {
      tokenParams = Object.fromEntries(new URLSearchParams(rawBody).entries());
    }

    const grantType = tokenParams.grant_type;
    // client_id + client_secret can arrive via Basic auth (token_endpoint_auth_method=client_secret_basic)
    // or in the body (client_secret_post). Accept both.
    let clientId = String(tokenParams.client_id || '').trim();
    let clientSecretFromCaller = String(tokenParams.client_secret || '').trim();
    const basicAuth = (req.headers['authorization'] || '').match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
    if (basicAuth) {
      try {
        const decoded = Buffer.from(basicAuth[1], 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx > 0) {
          const basicId = decoded.slice(0, idx);
          const basicSecret = decoded.slice(idx + 1);
          if (basicId) clientId = clientId || basicId;
          if (basicSecret) clientSecretFromCaller = clientSecretFromCaller || basicSecret;
        }
      } catch { /* ignore — fall through to body params */ }
    }
    const client = await getOAuthClientById(clientId);
    if (!client) {
      return jsonResponse(res, { error: 'unauthorized_client' }, 401);
    }
    // Confidential client → require client_secret on every token request.
    // ChatGPT GPT Actions always sends client_secret, so a secret-bearing
    // HIVEMIND client matches that flow.
    if (!client.is_public) {
      if (!clientSecretFromCaller) {
        return jsonResponse(res, { error: 'invalid_client', error_description: 'client_secret is required for this client.' }, 401);
      }
      const callerHash = crypto.createHash('sha256').update(clientSecretFromCaller).digest('hex');
      if (!client.client_secret_hash || callerHash !== client.client_secret_hash) {
        return jsonResponse(res, { error: 'invalid_client', error_description: 'client_secret mismatch.' }, 401);
      }
    }

    if (grantType === 'authorization_code') {
      const code = tokenParams.code || '';
      const redirectUri = tokenParams.redirect_uri || '';
      const codeVerifier = tokenParams.code_verifier || '';

      const entry = oauthCodeStore.get(code);
      if (!entry) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' }, 400);
      }
      oauthCodeStore.delete(code);

      if (Date.now() > entry.expiresAt) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'Authorization code has expired.' }, 400);
      }
      if (entry.clientId !== clientId) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'client_id mismatch.' }, 400);
      }
      if (entry.redirectUri !== redirectUri || !client.redirect_uris.includes(redirectUri)) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' }, 400);
      }
      if (client.is_public) {
        if (!entry.codeChallenge || entry.codeChallengeMethod !== 'S256') {
          return jsonResponse(res, { error: 'invalid_grant', error_description: 'PKCE challenge missing on authorization request.' }, 400);
        }
        if (!codeVerifier) {
          return jsonResponse(res, { error: 'invalid_grant', error_description: 'code_verifier is required for PKCE.' }, 400);
        }
        const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        if (expectedChallenge !== entry.codeChallenge) {
          return jsonResponse(res, { error: 'invalid_grant', error_description: 'PKCE code_verifier validation failed.' }, 400);
        }
      }

      const oauthScopes = normalizeRequestedScopes(entry.scopes, ['memory.read']);
      const disallowed = oauthScopes.filter(s => !client.allowed_scopes.includes(s));
      if (disallowed.length > 0) {
        return jsonResponse(res, { error: 'invalid_scope', error_description: `Scopes not allowed for client: ${disallowed.join(', ')}` }, 400);
      }
      const internalScopes = mapOAuthScopesToInternalScopes(oauthScopes);
      if (internalScopes.length === 0) {
        return jsonResponse(res, { error: 'invalid_scope', error_description: 'No internal scopes resolved from requested scopes.' }, 400);
      }

      const { accessToken, accessTokenId, expiresAt } = await createOAuthAccessToken({
        clientId,
        userId: entry.userId,
        orgId: entry.orgId,
        internalScopes,
        oauthScopes,
        workspaceId: entry.workspaceId || null,
        resource: entry.resource || OAUTH_RESOURCE_DEFAULT
      });

      const refreshToken = generateRawRefreshToken();
      const refreshHash = hashRefreshToken(refreshToken);
      const refreshRecord = {
        refreshHash,
        clientId,
        userId: entry.userId,
        orgId: entry.orgId,
        workspaceId: entry.workspaceId || null,
        resource: entry.resource || OAUTH_RESOURCE_DEFAULT,
        scopes: oauthScopes,
        internalScopes,
        accessTokenHash: hashPersistedApiKey(accessToken),
        accessTokenId,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
        revokedAt: null,
        rotatedFrom: null
      };
      persistRefreshTokenRecord(refreshToken, refreshRecord);

      return jsonResponse(res, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
        refresh_token: refreshToken,
        scope: oauthScopes.join(' '),
        claims: {
          iss: OAUTH_BASE_URL,
          aud: entry.resource || OAUTH_RESOURCE_DEFAULT,
          exp: Math.floor(new Date(expiresAt).getTime() / 1000),
          sub: entry.userId,
          org_id: entry.orgId,
          workspace_id: entry.workspaceId || null,
          scope: oauthScopes.join(' ')
        }
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = String(tokenParams.refresh_token || '');
      if (!refreshToken) {
        return jsonResponse(res, { error: 'invalid_request', error_description: 'refresh_token is required.' }, 400);
      }
      const record = loadRefreshTokenRecord(refreshToken);
      if (!record) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'Refresh token is invalid.' }, 400);
      }
      if (record.clientId !== clientId) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'client_id mismatch for refresh token.' }, 400);
      }
      if (record.revokedAt || Date.now() > Number(record.expiresAt || 0)) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'Refresh token expired or revoked.' }, 400);
      }

      markRefreshTokenRevoked(record.refreshHash);
      await revokeAccessTokenByHash(record.accessTokenHash, 'oauth_refresh_rotation');

      const { accessToken, accessTokenId, expiresAt } = await createOAuthAccessToken({
        clientId,
        userId: record.userId,
        orgId: record.orgId,
        internalScopes: Array.isArray(record.internalScopes) ? record.internalScopes : mapOAuthScopesToInternalScopes(record.scopes || []),
        oauthScopes: normalizeRequestedScopes(record.scopes || [], ['memory.read']),
        workspaceId: record.workspaceId || null,
        resource: record.resource || OAUTH_RESOURCE_DEFAULT
      });

      const rotatedRefreshToken = generateRawRefreshToken();
      const rotatedRecord = {
        ...record,
        refreshHash: hashRefreshToken(rotatedRefreshToken),
        accessTokenHash: hashPersistedApiKey(accessToken),
        accessTokenId,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
        revokedAt: null,
        rotatedFrom: record.refreshHash
      };
      persistRefreshTokenRecord(rotatedRefreshToken, rotatedRecord);

      const oauthScopes = normalizeRequestedScopes(record.scopes || [], ['memory.read']);
      return jsonResponse(res, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
        refresh_token: rotatedRefreshToken,
        scope: oauthScopes.join(' '),
        claims: {
          iss: OAUTH_BASE_URL,
          aud: record.resource || OAUTH_RESOURCE_DEFAULT,
          exp: Math.floor(new Date(expiresAt).getTime() / 1000),
          sub: record.userId,
          org_id: record.orgId,
          workspace_id: record.workspaceId || null,
          scope: oauthScopes.join(' ')
        }
      });
    }

    return jsonResponse(res, { error: 'unsupported_grant_type' }, 400);
  }

  if (pathname === '/oauth/revoke' && req.method === 'POST') {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    const params = Object.fromEntries(new URLSearchParams(rawBody).entries());
    const token = String(params.token || '').trim();
    if (!token) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'token is required' }, 400);
    }

    const refreshRecord = loadRefreshTokenRecord(token);
    if (refreshRecord && !refreshRecord.revokedAt) {
      markRefreshTokenRevoked(refreshRecord.refreshHash);
      await revokeAccessTokenByHash(refreshRecord.accessTokenHash, 'oauth_revoke');
      return jsonResponse(res, { revoked: true, token_type: 'refresh_token' });
    }

    const keyHash = hashPersistedApiKey(token);
    const accessRevoked = await revokeAccessTokenByHash(keyHash, 'oauth_revoke');

    return jsonResponse(res, { revoked: accessRevoked, token_type: 'access_token' });
  }

  if (pathname === '/oauth/connection-status' && req.method === 'GET') {
    const authResult = await authenticateApiKey(req);
    if (!authResult.ok) {
      return setOAuthUnauthorized(res, {
        statusCode: 401,
        error: 'unauthorized',
        errorDescription: authResult.error || 'Missing or invalid bearer token.'
      });
    }
    const principal = authResult.principal;
    const oauthMeta = principal.oauth || null;
    return jsonResponse(res, {
      connected: true,
      client_id: oauthMeta?.client_id || null,
      workspace_id: oauthMeta?.workspace_id || null,
      resource: oauthMeta?.resource || OAUTH_RESOURCE_DEFAULT,
      scopes: oauthMeta?.oauth_scopes || [],
      user_id: principal.userId || null,
      org_id: principal.orgId || null,
      key_id: principal.keyId || null
    });
  }

  // API Routes
  if (pathname.startsWith('/api/')) {
    try {
      // Skip JSON body parsing for multipart upload endpoints
      const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
      const body = (req.method !== 'GET' && !isMultipart) ? await parseBody(req) : {};

      const hostedDescriptorMatch = pathname.match(/^\/api\/mcp\/servers\/([^\/]+)$/);
      if (hostedDescriptorMatch && req.method === 'GET' && url.searchParams.get('token')) {
        const pathUserId = hostedDescriptorMatch[1];
        const token = url.searchParams.get('token') || extractApiKey(req);

        if (!token || !(await validateConnectionToken(token, pathUserId))) {
          return setOAuthUnauthorized(res, {
            statusCode: 401,
            error: 'unauthorized',
            errorDescription: 'Invalid or expired connection token for hosted MCP descriptor.'
          });
        }

        const serverConfig = await getHostedServerByToken(token, pathUserId);
        if (!serverConfig) {
          return setOAuthUnauthorized(res, {
            statusCode: 401,
            error: 'unauthorized',
            errorDescription: 'Hosted MCP descriptor not found for connection token.'
          });
        }

        return jsonResponse(res, serverConfig);
      }

      const hostedRpcMatch = pathname.match(/^\/api\/mcp\/servers\/([^\/]+)\/(rpc|message)$/);
      if (hostedRpcMatch && req.method === 'POST') {
        const pathUserId = hostedRpcMatch[1];
        const token = url.searchParams.get('token') || extractApiKey(req);

        if (!token || !(await validateConnectionToken(token, pathUserId))) {
          return jsonResponse(res, {
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32001, message: 'Invalid or expired connection token' }
          }, 401);
        }

        const connection = await getConnectionContext(token, pathUserId);
        const connectionOrgId = connection?.orgId || DEFAULT_ORG;
        const requestApiKey = typeof req.headers['x-api-key'] === 'string'
          ? req.headers['x-api-key'].trim()
          : '';
        const apiClient = createHostedApiClient({
          baseUrl: getHostedApiBaseUrl(req),
          apiKey: requestApiKey || '',
          userId: pathUserId,
          orgId: connectionOrgId
        });

        if (!body?.method) {
          return jsonResponse(res, {
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32600, message: 'Invalid request: method is required' }
          }, 400);
        }

        if (body.method === 'notifications/initialized' || body.method === 'initialized') {
          res.writeHead(202);
          res.end();
          return;
        }

        let result;
        switch (body.method) {
          case 'initialize':
            result = handleInitialize(body.params || {}, pathUserId);
            break;
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            // Connection-token path: scopes stored in connection context, default to ['*'] for issued tokens
            result = handleToolsList(pathUserId, connectionOrgId, { scopes: connection?.scopes || ['*'] });
            break;
          case 'tools/call':
            result = await handleToolCall(body.params || {}, pathUserId, connectionOrgId, apiClient, { isMaster: !!connection?.master });
            break;
          case 'resources/list':
            result = handleResourcesList(pathUserId, connectionOrgId);
            break;
          case 'resources/read':
            result = handleReadResource(body.params || {}, pathUserId, connectionOrgId);
            break;
          case 'prompts/list':
            result = handlePromptsList(pathUserId, connectionOrgId);
            break;
          case 'prompts/get':
            result = handleGetPrompt(body.params || {}, pathUserId, connectionOrgId);
            break;
          default:
            return jsonResponse(res, {
              jsonrpc: '2.0',
              id: body.id ?? null,
              error: { code: -32601, message: `Method not found: ${body.method}` }
            }, 404);
        }

        return jsonResponse(res, {
          jsonrpc: '2.0',
          id: body.id ?? null,
          result
        });
      }

      const hostedSseMatch = pathname.match(/^\/api\/mcp\/servers\/([^\/]+)\/sse$/);
      if (hostedSseMatch && req.method === 'GET') {
        const pathUserId = hostedSseMatch[1];
        const token = url.searchParams.get('token') || extractApiKey(req);

        if (!token || !(await validateConnectionToken(token, pathUserId))) {
          return setOAuthUnauthorized(res, {
            statusCode: 401,
            error: 'unauthorized',
            errorDescription: 'Invalid or expired connection token for hosted MCP SSE.'
          });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/api/mcp/servers/${pathUserId}/rpc?token=${token}` })}\n\n`);
        res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);

        const keepAlive = setInterval(() => {
          res.write(`event: ping\ndata: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);
        }, 30000);

        req.on('close', () => {
          clearInterval(keepAlive);
        });
        return;
      }

      // API key management endpoints
      if (pathname === '/api/keys/generate' && req.method === 'POST') {
        if (!isAdminRequest(req)) {
          return jsonResponse(res, { error: 'Forbidden. Missing or invalid X-Admin-Secret header.' }, 403);
        }
        const { rawKey, record } = generateApiKeyRecord({
          label: body.label,
          userId: body.user_id,
          orgId: body.org_id,
          scopes: body.scopes,
          containerTags: body.containerTags
        });
        const store = loadApiKeyStore();
        store.keys.push(record);
        saveApiKeyStore(store);

        return jsonResponse(res, {
          success: true,
          key: rawKey,
          key_id: record.id,
          key_preview: record.keyPreview,
          user_id: record.userId,
          org_id: record.orgId,
          scopes: record.scopes,
          container_tags: record.containerTags || null,
          created_at: record.createdAt,
          warning: 'Store this key now. It will not be shown again in full.'
        });
      }

      if (pathname === '/api/keys/revoke' && req.method === 'POST') {
        if (!isAdminRequest(req)) {
          return jsonResponse(res, { error: 'Forbidden. Missing or invalid X-Admin-Secret header.' }, 403);
        }
        if (!body.key_id) {
          return jsonResponse(res, { error: 'key_id is required.' }, 400);
        }
        const store = loadApiKeyStore();
        const record = store.keys.find(k => k.id === body.key_id && !k.revokedAt);
        if (!record) {
          return jsonResponse(res, { error: 'Active key not found for key_id.' }, 404);
        }
        record.revokedAt = new Date().toISOString();
        saveApiKeyStore(store);
        return jsonResponse(res, { success: true, key_id: body.key_id, revoked_at: record.revokedAt });
      }

      if (pathname === '/api/keys' && req.method === 'GET') {
        if (!isAdminRequest(req)) {
          return jsonResponse(res, { error: 'Forbidden. Missing or invalid X-Admin-Secret header.' }, 403);
        }
        const store = loadApiKeyStore();
        const keys = store.keys.map(k => ({
          id: k.id,
          label: k.label,
          key_preview: k.keyPreview,
          user_id: k.userId,
          org_id: k.orgId,
          scopes: k.scopes,
          container_tags: k.containerTags || null,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
          revoked_at: k.revokedAt
        }));
        return jsonResponse(res, { keys });
      }

      // Gmail OAuth callback — browser redirect from Google, no API key possible
      if (pathname === '/api/connectors/gmail/callback' && req.method === 'GET') {
        const callbackCode = url.searchParams.get('code');
        const callbackState = url.searchParams.get('state');
        const callbackError = url.searchParams.get('error');

        if (callbackError) {
          const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
          res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?error=${encodeURIComponent(callbackError)}` });
          res.end();
          return;
        }

        if (!callbackCode) {
          return jsonResponse(res, { error: 'Missing authorization code' }, 400);
        }

        try {
          let stateUserId = DEFAULT_USER, stateOrgId = DEFAULT_ORG;
          if (callbackState) {
            try {
              const parsed = JSON.parse(Buffer.from(callbackState, 'base64url').toString());
              stateUserId = parsed.userId || stateUserId;
              stateOrgId = parsed.orgId || stateOrgId;
            } catch {}
          }

          const { exchangeCode } = await import('./connectors/providers/gmail/oauth.js');
          const gmailCallbackUri = `${process.env.HIVEMIND_BASE_URL || getHostedApiBaseUrl(req)}/api/connectors/gmail/callback`;
          const tokens = await exchangeCode({ code: callbackCode, redirectUri: gmailCallbackUri });

          const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
          const connStore = new ConnectorStore(prisma);
          const tokenExpiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

          // Plan enforcement: check connector limit before creating
          if (planEnforcer && stateOrgId) {
            const connectorCheck = await planEnforcer.checkLimit(stateOrgId, 'connectors', 1);
            if (!connectorCheck.allowed) {
              const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
              res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?error=${encodeURIComponent(connectorCheck.reason)}` });
              res.end();
              return;
            }
          }

          await connStore.upsertConnector({
            userId: stateUserId,
            provider: 'gmail',
            accountRef: tokens.email || null,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt,
            scopes: tokens.scope?.split(' ') || ['https://www.googleapis.com/auth/gmail.readonly'],
            metadata: { email: tokens.email },
          });

          console.log(`[gmail-oauth] Connected for user=${stateUserId} email=${tokens.email}. Awaiting sync configuration.`);

          const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
          res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?connected=gmail&needs_config=true&email=${encodeURIComponent(tokens.email || '')}` });
          res.end();
          return;
        } catch (err) {
          console.error('[gmail-oauth] Callback failed:', err.message);
          const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
          res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?error=${encodeURIComponent(err.message)}` });
          res.end();
          return;
        }
      }

      // Public webhook bypass. Nango (and Gmail Pub/Sub) verify requests
      // by signature header, not by API key. For these paths we synthesize
      // a service principal so downstream code (which references userId/
      // orgId from `principal`) still has a context — the actual user is
      // resolved per-event by the webhook handler.
      const PUBLIC_WEBHOOK_PATHS = new Set([
        '/api/connectors/nango/webhook',
        '/api/connectors/gmail/pubsub-webhook',
        '/api/connectors/slack/event-ingest',
      ]);
      const isPublicWebhook = PUBLIC_WEBHOOK_PATHS.has(pathname) && req.method === 'POST';

      // Protect all non-key-management API endpoints (skip for webhooks
      // verified by provider signature).
      let auth;
      if (isPublicWebhook) {
        auth = { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['webhook'], rawKey: null } };
      } else {
        auth = await authenticateApiKey(req);
      }
      if (!auth.ok) {
        return setOAuthUnauthorized(res, {
          statusCode: auth.status || 401,
          error: 'unauthorized',
          errorDescription: auth.error || 'Missing or invalid bearer token.',
          req,
        });
      }
      const principal = auth.principal;
      const userId = principal.userId || DEFAULT_USER;
      const orgId = principal.orgId || DEFAULT_ORG;

      // ── Container Tag (multi-tenant namespace) resolution ──
      // Priority: x-hm-container header > body.containerTag > query param > scoped key default
      const headerContainer = req.headers['x-hm-container'] || null;
      const bodyContainer = body?.containerTag || null;
      const queryContainer = url.searchParams.get('containerTag') || null;
      const keyContainerTags = principal.containerTags || null;
      const resolvedContainerTag = headerContainer || bodyContainer || queryContainer || null;

      // If the API key is scoped to specific containerTags, enforce it
      if (keyContainerTags && keyContainerTags.length > 0) {
        if (resolvedContainerTag && !keyContainerTags.includes(resolvedContainerTag)) {
          return jsonResponse(res, {
            error: 'Forbidden',
            message: `This API key is scoped to containerTags: [${keyContainerTags.join(', ')}]. Requested containerTag "${resolvedContainerTag}" is not allowed.`
          }, 403);
        }
      }
      // Effective container: explicit request > single-scoped key default > null
      const effectiveContainerTag = resolvedContainerTag
        || (keyContainerTags && keyContainerTags.length === 1 ? keyContainerTags[0] : null);

      // ── Consumer URL generation (authenticated) ──
      if (pathname === '/api/mcp/consumer-url' && req.method === 'POST') {
        // Check if user already has a consumer URL
        const existing = await findExistingConsumerToken(userId);
        if (existing) {
          const baseUrl = getHostedApiBaseUrl(req);
          let fullToken = existing.keyPrefix;
          try { fullToken = JSON.parse(existing.description).fullToken || fullToken; } catch {}
          return jsonResponse(res, {
            url: `${baseUrl}/mcp/${fullToken}/sse`,
            token: fullToken,
            created_at: existing.createdAt
          });
        }

        // Generate a new consumer token and store it as an ApiKey record
        const consumerToken = generateConsumerToken();
        const tokenHash = hashPersistedApiKey(consumerToken);
        try {
          await prisma.apiKey.create({
            data: {
              userId,
              orgId,
              name: 'consumer-url',
              keyHash: tokenHash,
              keyPrefix: consumerToken.slice(0, 12),
              description: JSON.stringify({ fullToken: consumerToken }),
              scopes: ['mcp'],
              expiresAt: null,
              rateLimitPerMinute: 120,
              createdByIp: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
              userAgent: req.headers['user-agent'] || null
            }
          });
        } catch (err) {
          console.error('[consumer-url] Failed to create consumer token:', err);
          return jsonResponse(res, { error: 'Failed to create consumer token' }, 500);
        }

        const baseUrl = getHostedApiBaseUrl(req);
        return jsonResponse(res, {
          url: `${baseUrl}/mcp/${consumerToken}/sse`,
          token: consumerToken,
          warning: 'Store this URL securely. The token will not be shown again in full.'
        });
      }

      // MCP Streamable HTTP transport: clients (mcp-remote, Claude Desktop,
      // VS Code, Cursor) open a GET on the same URL with Accept:text/event-stream
      // for server-initiated notifications. We don't push server→client events
      // — per spec
      // (https://spec.modelcontextprotocol.io/specification/basic/transports/#streamable-http)
      // the server MUST return 405 in that case so the client stops retrying.
      // Without this we 404'd, which mcp-remote logs as
      // "StreamableHTTPError: Failed to open SSE stream: Not Found" — looked
      // like a broken server even though POST RPC worked fine.
      if ((pathname === '/api/mcp' || pathname === '/api/mcp/rpc' || pathname === '/api/mcp/message') && req.method === 'GET') {
        res.setHeader('Allow', 'POST');
        res.writeHead(405);
        res.end();
        return;
      }

      // OPTIONS preflight for browser-based MCP clients (Cursor, etc.) — quick
      // ACK with the canonical CORS triple. Global CORS already adds the
      // *-Allow-Origin header, this just short-circuits the preflight.
      if ((pathname === '/api/mcp' || pathname === '/api/mcp/rpc' || pathname === '/api/mcp/message') && req.method === 'OPTIONS') {
        res.setHeader('Allow', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID');
        res.writeHead(204);
        res.end();
        return;
      }

      if ((pathname === '/api/mcp' || pathname === '/api/mcp/rpc' || pathname === '/api/mcp/message') && req.method === 'POST') {
        const apiClient = createHostedApiClient({
          baseUrl: getHostedApiBaseUrl(req),
          apiKey: principal.rawKey || MASTER_API_KEY || '',
          userId,
          orgId
        });

        if (!body?.method) {
          return jsonResponse(res, {
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32600, message: 'Invalid request: method is required' }
          }, 400);
        }

        if (body.method === 'notifications/initialized' || body.method === 'initialized') {
          res.writeHead(202);
          res.end();
          return;
        }

        let result;
        switch (body.method) {
          case 'initialize':
            result = handleInitialize(body.params || {}, userId);
            break;
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            result = handleToolsList(userId, orgId, { scopes: principal.scopes || [] });
            break;
          case 'tools/call':
            result = await handleToolCall(body.params || {}, userId, orgId, apiClient, { isMaster: !!principal?.master });
            break;
          case 'resources/list':
            result = handleResourcesList(userId, orgId);
            break;
          case 'resources/read':
            result = handleReadResource(body.params || {}, userId, orgId);
            break;
          case 'prompts/list':
            result = handlePromptsList(userId, orgId);
            break;
          case 'prompts/get':
            result = handleGetPrompt(body.params || {}, userId, orgId);
            break;
          default:
            return jsonResponse(res, {
              jsonrpc: '2.0',
              id: body?.id ?? null,
              error: { code: -32601, message: `Method not found: ${body.method}` }
            }, 404);
        }

        return jsonResponse(res, {
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result
        });
      }

      // Handle /api/webhooks/:id routes (dynamic webhook deletion)
      if (pathname.startsWith('/api/webhooks/') && req.method === 'DELETE') {
        if (!webhookManager) {
          return jsonResponse(res, { error: 'Webhook system unavailable' }, 503);
        }
        // Plan gate
        try {
          const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
          if (!org || (org.plan !== 'scale' && org.plan !== 'enterprise')) {
            return jsonResponse(res, { error: 'Webhooks require Scale or Enterprise plan' }, 403);
          }
        } catch {
          return jsonResponse(res, { error: 'Plan check failed' }, 500);
        }
        const webhookId = pathname.split('/api/webhooks/')[1];
        try {
          const result = await webhookManager.delete(webhookId, orgId);
          return jsonResponse(res, result);
        } catch (err) {
          return jsonResponse(res, { error: err.message }, 404);
        }
      }

      // GET /api/memories/:memoryId/evolution — traverse Updates/Extends chain
      if (pathname.match(/^\/api\/memories\/[^/]+\/evolution$/) && req.method === 'GET') {
        const memoryId = pathname.split('/')[3];
        try {
          const memory = await persistentMemoryStore.getMemory(memoryId);
          if (!memory) return jsonResponse(res, { error: 'Memory not found' }, 404);

          // BFS traverse all connected memories via relationship edges
          const visited = new Set([memoryId]);
          const queue = [memoryId];
          const timeline = [{ ...memory, _role: 'current' }];
          const edges = [];

          while (queue.length > 0 && visited.size < 20) {
            const currentId = queue.shift();

            const rels = await prisma.relationship.findMany({
              where: {
                OR: [{ fromId: currentId }, { toId: currentId }],
                type: { in: ['Updates', 'Extends', 'Derives', 'Contradicts'] },
              },
              take: 50,
            });

            for (const rel of rels) {
              edges.push({
                from: rel.fromId,
                to: rel.toId,
                type: rel.type,
                confidence: rel.confidence,
                metadata: rel.metadata,
                created_at: rel.createdAt?.toISOString(),
              });

              const otherId = rel.fromId === currentId ? rel.toId : rel.fromId;
              if (!visited.has(otherId)) {
                visited.add(otherId);
                queue.push(otherId);
                try {
                  const other = await persistentMemoryStore.getMemory(otherId);
                  if (other) {
                    timeline.push({
                      ...other,
                      _role: rel.type === 'Updates' ? 'superseded' : 'related',
                    });
                  }
                } catch {}
              }
            }
          }

          // Sort timeline by document_date or created_at
          timeline.sort((a, b) => {
            const da = new Date(a.document_date || a.created_at || 0);
            const db = new Date(b.document_date || b.created_at || 0);
            return da - db;
          });

          return jsonResponse(res, {
            memory,
            timeline,
            edges,
            chain_length: timeline.length,
          });
        } catch (err) {
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // Handle /api/memories/:id routes (dynamic ID matching)
      // List all CSI bundles (metadata only — no content)
      if (pathname === '/api/csi/bundles' && req.method === 'GET') {
        const bundleDir = path.join(PROJECT_ROOT, 'data', 'csi_bundles');
        try {
          if (!fs.existsSync(bundleDir)) {
            return jsonResponse(res, { success: true, sessions: [] });
          }
          const files = fs.readdirSync(bundleDir).filter(f => f.endsWith('.json'));
          const sessions = files.map(f => {
            try {
              const raw = fs.readFileSync(path.join(bundleDir, f), 'utf8');
              const data = JSON.parse(raw);
              return {
                simulation_id: data.simulation_id || f.replace('.json', ''),
                query: data.title || data.metadata?.query || '',
                timestamp: data.metadata?.timestamp || '',
                claim_count: data.metadata?.claim_count || 0,
                source_count: data.metadata?.source_count || 0,
                agent_count: data.metadata?.agent_count || 0,
              };
            } catch {
              return { simulation_id: f.replace('.json', ''), query: '', timestamp: '' };
            }
          }).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
          return jsonResponse(res, { success: true, sessions });
        } catch (error) {
          return jsonResponse(res, { error: 'List bundles failed', message: error.message }, 500);
        }
      }

      // Handle /api/csi/bundle/:sim_id
      if (pathname.startsWith('/api/csi/bundle/')) {
        const simId = pathname.split('/api/csi/bundle/')[1];
        const bundleDir = path.join(PROJECT_ROOT, 'data', 'csi_bundles');
        const bundleFile = path.join(bundleDir, `${encodeURIComponent(simId)}.json`);

        if (req.method === 'POST') {
          try {
            if (!fs.existsSync(bundleDir)) {
              fs.mkdirSync(bundleDir, { recursive: true });
            }
            fs.writeFileSync(bundleFile, JSON.stringify(body), 'utf8');
            return jsonResponse(res, { success: true, simulation_id: simId });
          } catch (error) {
            console.error('Save CSI bundle failed:', error);
            return jsonResponse(res, { error: 'Failed to save', message: error.message }, 500);
          }
        }

        if (req.method === 'GET') {
          try {
            if (!fs.existsSync(bundleFile)) {
              return jsonResponse(res, { error: 'Not found' }, 404);
            }
            const data = fs.readFileSync(bundleFile, 'utf8');
            return res.setHeader('Content-Type', 'application/json').writeHead(200).end(data);
          } catch (error) {
            console.error('Get CSI bundle failed:', error);
            return jsonResponse(res, { error: 'Failed to load', message: error.message }, 500);
          }
        }
      }
      // ── Phase 3: research session ephemeral-buffer endpoints ───────────
      // Proxies the DeepResearcher static buffer Map (shared in-process).
      // All routes tenant-scoped: only the buffer's recorded userId/orgId
      // can read/approve/discard.
      if (pathname === '/api/research/sessions' && req.method === 'GET') {
        try {
          const { DeepResearcher } = await import('./deep-research/researcher.js');
          const list = DeepResearcher.listSessionBuffers(userId, orgId);
          return jsonResponse(res, { sessions: list, count: list.length });
        } catch (err) {
          return jsonResponse(res, { error: 'list sessions failed', message: err.message }, 500);
        }
      }
      {
        const pendingMatch = pathname.match(/^\/api\/research\/sessions\/([^/]+)\/pending-proposals$/);
        if (pendingMatch && req.method === 'GET') {
          try {
            const sid = pendingMatch[1];
            const { DeepResearcher } = await import('./deep-research/researcher.js');
            const buf = DeepResearcher._sessionBuffers.get(sid);
            if (buf && buf.userId && buf.userId !== userId) {
              return jsonResponse(res, { error: 'forbidden' }, 403);
            }
            const tmp = new DeepResearcher({ memoryStore: null, recallFn: null, prisma: null, groqApiKey: '' });
            return jsonResponse(res, tmp.getPendingProposals(sid));
          } catch (err) {
            return jsonResponse(res, { error: 'pending-proposals failed', message: err.message }, 500);
          }
        }
        const approveMatch = pathname.match(/^\/api\/research\/sessions\/([^/]+)\/approve$/);
        if (approveMatch && req.method === 'POST') {
          try {
            const sid = approveMatch[1];
            const { DeepResearcher } = await import('./deep-research/researcher.js');
            const buf = DeepResearcher._sessionBuffers.get(sid);
            if (buf && buf.userId && buf.userId !== userId) {
              return jsonResponse(res, { error: 'forbidden' }, 403);
            }
            const tmp = new DeepResearcher({ memoryStore: persistentMemoryStore, recallFn: null, prisma, groqApiKey: '' });
            const result = await tmp.approveSessionProposals(sid, {
              kinds: Array.isArray(body.kinds) ? body.kinds : undefined,
              ids: Array.isArray(body.ids) ? body.ids : undefined,
            });
            return jsonResponse(res, result);
          } catch (err) {
            return jsonResponse(res, { error: 'approve failed', message: err.message }, 500);
          }
        }
        const discardMatch = pathname.match(/^\/api\/research\/sessions\/([^/]+)\/discard$/);
        if (discardMatch && req.method === 'POST') {
          try {
            const sid = discardMatch[1];
            const { DeepResearcher } = await import('./deep-research/researcher.js');
            const buf = DeepResearcher._sessionBuffers.get(sid);
            if (buf && buf.userId && buf.userId !== userId) {
              return jsonResponse(res, { error: 'forbidden' }, 403);
            }
            const tmp = new DeepResearcher({ memoryStore: null, recallFn: null, prisma: null, groqApiKey: '' });
            return jsonResponse(res, tmp.discardSessionProposals(sid));
          } catch (err) {
            return jsonResponse(res, { error: 'discard failed', message: err.message }, 500);
          }
        }

        // ── Pending writes: approve / cancel / get-by-id ──────────────
        // Agent draft-approval workflow. Owner check enforces user_id
        // matches the session principal; cross-user approval is forbidden.
        const pwMatch = pathname.match(/^\/api\/pending-writes\/([0-9a-f-]{36})\/(approve|cancel)$/i);
        if (pwMatch && req.method === 'POST') {
          if (!prisma) return jsonResponse(res, { error: 'db unavailable' }, 503);
          const draftId = pwMatch[1];
          const action = pwMatch[2];
          try {
            const row = await prisma.pendingWrite.findUnique({ where: { id: draftId } });
            if (!row) return jsonResponse(res, { error: 'draft not found' }, 404);
            if (row.userId !== userId) return jsonResponse(res, { error: 'forbidden' }, 403);
            if (row.status !== 'draft') {
              return jsonResponse(res, { error: `draft already ${row.status}` }, 409);
            }
            if (action === 'cancel') {
              await prisma.pendingWrite.update({
                where: { id: draftId },
                data: { status: 'cancelled' },
              });
              return jsonResponse(res, { ok: true, status: 'cancelled', id: draftId });
            }
            // Approve → mark approved, then re-dispatch tool with
            // _approval_token. Middleware verifies + flips to sent.
            await prisma.pendingWrite.update({
              where: { id: draftId },
              data: { status: 'approved', approvedAt: new Date() },
            });
            try {
              const { buildToolkitForUser } = await import('./agent/toolkit-factory.js');
              const tk = await buildToolkitForUser({ prisma, userId, orgId, hivemindTools: [] });
              tk.resetEquippedTools([row.provider]);
              const execArgs = { ...(row.toolArgs || {}), _approval_token: draftId };
              const resp = await tk.execute(row.toolName, execArgs, { userId, orgId, prisma });
              const final = await prisma.pendingWrite.findUnique({ where: { id: draftId } });
              return jsonResponse(res, {
                ok: resp.status !== 'error',
                status: final?.status || resp.status,
                tool_status: resp.status,
                text: resp.content?.[0]?.text || null,
                draft: final,
              });
            } catch (execErr) {
              await prisma.pendingWrite.update({
                where: { id: draftId },
                data: { status: 'failed', errorMsg: execErr.message },
              }).catch(() => {});
              return jsonResponse(res, { ok: false, error: execErr.message }, 500);
            }
          } catch (err) {
            return jsonResponse(res, { error: 'pending-write action failed', message: err.message }, 500);
          }
        }
      }

      // ── Generic per-connector dispatch ──────────────────────────────
      // POST   /api/connectors/:id/connect    — start OAuth or store API key
      // POST   /api/connectors/:id/disconnect — revoke + delete tokens
      // GET    /api/connectors/:id/status     — single-connector status
      //
      // For OAuth providers (gmail, slack, notion, microsoft, atlassian,
      // salesforce, github), the connect handler RETURNS a redirect URL
      // for the FE to open in a popup; it does not perform the redirect
      // itself (CORS-safe). For api-key providers (linear), the body
      // carries { api_key } and is stored encrypted server-side.
      {
        const connectorMatch = pathname.match(/^\/api\/connectors\/([a-z0-9_-]+)\/(connect|disconnect|status)$/i);
        // Only handle dispatch for catalog-known providers; let legacy
        // routes like /api/connectors/mcp/status and /api/connectors/gmail/callback
        // fall through to the existing switch.
        const { CONNECTOR_BY_ID: _DISPATCH_CATALOG } = connectorMatch
          ? await import('./connectors/catalog.js')
          : { CONNECTOR_BY_ID: {} };
        if (connectorMatch && _DISPATCH_CATALOG[connectorMatch[1].toLowerCase()]) {
          const provider = connectorMatch[1].toLowerCase();
          const verb = connectorMatch[2].toLowerCase();
          const catalog = _DISPATCH_CATALOG[provider];
          try {

            if (verb === 'status' && req.method === 'GET') {
              let record = null;
              try {
                if (typeof connectorStore?.getConnector === 'function') {
                  record = await connectorStore.getConnector(userId, provider);
                }
              } catch (_) { /* swallow */ }
              return jsonResponse(res, {
                provider,
                catalog,
                connection: record || null,
                connected: Boolean(record),
              });
            }

            if (verb === 'connect' && req.method === 'POST') {
              // OAuth providers — return existing per-provider OAuth start URL.
              // The FE opens it in a popup; callback already lives at
              // /api/connectors/<provider>/callback and stores the token.
              const oauthStartByProvider = {
                gmail: '/api/connectors/gmail/connect',
                'google-drive': '/api/connectors/google/connect',
                'google-calendar': '/api/connectors/google/connect',
                'google-docs': '/api/connectors/google/connect',
                'google-sheets': '/api/connectors/google/connect',
                'google-slides': '/api/connectors/google/connect',
                'google-contacts': '/api/connectors/google/connect',
                'google-tasks': '/api/connectors/google/connect',
                'google-chat': '/api/connectors/google/connect',
                slack: '/api/connectors/slack/connect',
                notion: '/api/connectors/notion/connect',
                github: '/api/connectors/github/connect',
                microsoft365: '/api/connectors/microsoft/connect',
                atlassian: '/api/connectors/atlassian/connect',
                salesforce: '/api/connectors/salesforce/connect',
              };

              if (catalog.authType === 'oauth2') {
                const startPath = oauthStartByProvider[provider];
                if (!startPath) {
                  return jsonResponse(res, {
                    error: 'oauth start not configured',
                    provider,
                    hint: catalog.setupHint || null,
                  }, 501);
                }
                return jsonResponse(res, {
                  provider,
                  authType: 'oauth2',
                  oauthStartUrl: startPath,
                  // FE should open this in a popup w/ Authorization header.
                  // Server-side OAuth handler issues the 302 to the provider.
                });
              }

              if (catalog.authType === 'api_key' || catalog.authType === 'connection_string') {
                // ConnectorStore today is OAuth-centric. API-key /
                // connection-string flows need a dedicated store table.
                // Surface 501 with hint so the UI shows "coming soon".
                return jsonResponse(res, {
                  error: 'not implemented',
                  provider,
                  authType: catalog.authType,
                  hint: 'API-key / connection-string flow needs a secrets store. OAuth providers work today.',
                }, 501);
              }

              if (catalog.authType === 'none') {
                return jsonResponse(res, {
                  provider,
                  authType: 'none',
                  hint: 'No connection needed. Use the connector directly.',
                });
              }

              return jsonResponse(res, { error: 'unsupported authType', authType: catalog.authType }, 400);
            }

            if (verb === 'disconnect' && req.method === 'POST') {
              try {
                if (typeof connectorStore?.disconnect === 'function') {
                  await connectorStore.disconnect(userId, provider);
                }
                return jsonResponse(res, { provider, disconnected: true });
              } catch (delErr) {
                return jsonResponse(res, { error: 'disconnect failed', message: delErr.message }, 500);
              }
            }
          } catch (err) {
            return jsonResponse(res, { error: 'connector dispatch failed', message: err.message }, 500);
          }
        }
      }

      // GET /api/memories/:id/relationships
      // Returns every edge touching this memory, grouped by direction +
      // type, with target/source memory titles inlined so the FE drawer
      // doesn't need a second fetch per edge.
      //
      // Response shape:
      //   {
      //     memory_id,
      //     out: [{ id, type, confidence, target_id, target_title, ... }],
      //     in:  [{ id, type, confidence, source_id, source_title, ... }],
      //     by_type: { Updates: [...], Extends: [...], Mentions: [...], ... },
      //   }
      const relsMatch = pathname.match(/^\/api\/memories\/([^/]+)\/relationships$/);
      if (relsMatch && req.method === 'GET') {
        if (!ensurePersistedMemoryOrFail(res, '/api/memories/:id/relationships')) return;
        const memoryId = relsMatch[1];
        try {
          // Tenant + ownership check via the canonical store
          const mem = await persistentMemoryStore.getMemory(memoryId);
          if (!mem || mem.deleted_at) return jsonResponse(res, { error: 'Not found' }, 404);
          if (mem.user_id !== userId && !principal.scopes?.includes('admin')) {
            return jsonResponse(res, { error: 'Not found' }, 404);
          }

          // Pull edges in both directions in a single round-trip.
          const [outRels, inRels] = await Promise.all([
            prisma.relationship.findMany({
              where: { fromId: memoryId },
              select: { id: true, fromId: true, toId: true, type: true, confidence: true, createdBy: true, createdAt: true, metadata: true },
              orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
              take: 200,
            }),
            prisma.relationship.findMany({
              where: { toId: memoryId },
              select: { id: true, fromId: true, toId: true, type: true, confidence: true, createdBy: true, createdAt: true, metadata: true },
              orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
              take: 200,
            }),
          ]);

          // Batch-fetch titles for every referenced peer memory.
          const peerIds = Array.from(new Set([
            ...outRels.map(r => r.toId),
            ...inRels.map(r => r.fromId),
          ]));
          const peers = peerIds.length > 0
            ? await prisma.memory.findMany({
                where: { id: { in: peerIds } },
                select: { id: true, title: true, memoryType: true, isLatest: true, deletedAt: true, createdAt: true, content: true },
              })
            : [];
          const peerById = new Map(peers.map(p => [p.id, p]));
          const peerTitle = (p) => p?.title || (p?.content || '').slice(0, 60) || '(untitled)';

          const enrichOut = outRels.map(r => {
            const p = peerById.get(r.toId);
            return {
              id: r.id,
              type: r.type,
              confidence: r.confidence,
              created_by: r.createdBy,
              created_at: r.createdAt,
              metadata: r.metadata || {},
              direction: 'out',
              target_id: r.toId,
              target_title: peerTitle(p),
              target_memory_type: p?.memoryType || null,
              target_is_latest: p?.isLatest ?? null,
              target_deleted: !!p?.deletedAt,
            };
          });
          const enrichIn = inRels.map(r => {
            const p = peerById.get(r.fromId);
            return {
              id: r.id,
              type: r.type,
              confidence: r.confidence,
              created_by: r.createdBy,
              created_at: r.createdAt,
              metadata: r.metadata || {},
              direction: 'in',
              source_id: r.fromId,
              source_title: peerTitle(p),
              source_memory_type: p?.memoryType || null,
              source_is_latest: p?.isLatest ?? null,
              source_deleted: !!p?.deletedAt,
            };
          });

          // Group by canonical type for the FE side panel sections.
          const by_type = {};
          for (const e of [...enrichOut, ...enrichIn]) {
            const t = e.type || 'Other';
            (by_type[t] = by_type[t] || []).push(e);
          }

          return jsonResponse(res, {
            memory_id: memoryId,
            out: enrichOut,
            in: enrichIn,
            by_type,
            counts: {
              out: enrichOut.length,
              in: enrichIn.length,
              total: enrichOut.length + enrichIn.length,
            },
          });
        } catch (error) {
          console.error('[memory-relationships]', error);
          return jsonResponse(res, { error: error.message }, 500);
        }
      }

      // ── Entities dyn routes ─────────────────────────────────────────
      if (pathname.startsWith('/api/entities/') && pathname !== '/api/entities/stats' && pathname !== '/api/entities/review-queue' && pathname !== '/api/entities/by-external-ref') {
        if (!prisma || !entityResolver) return jsonResponse(res, { error: 'service unavailable' }, 503);
        const rest = pathname.slice('/api/entities/'.length);
        // /review-queue/:id/approve|reject
        if (rest.startsWith('review-queue/')) {
          const parts = rest.slice('review-queue/'.length).split('/');
          const candidateId = parts[0];
          const action = parts[1];
          if (req.method === 'POST' && action === 'approve') {
            try { await entityResolver.approveReview({ candidateId, userId }); return jsonResponse(res, { ok: true }); }
            catch (e) { return jsonResponse(res, { error: e.message }, 500); }
          }
          if (req.method === 'POST' && action === 'reject') {
            try { await entityResolver.rejectReview({ candidateId }); return jsonResponse(res, { ok: true }); }
            catch (e) { return jsonResponse(res, { error: e.message }, 500); }
          }
          return jsonResponse(res, { error: 'not found' }, 404);
        }
        // /:id/merge or /:id (GET detail)
        const segs = rest.split('/');
        const entityId = segs[0];
        if (!entityId) return jsonResponse(res, { error: 'entity id required' }, 400);
        if (segs[1] === 'merge' && req.method === 'POST') {
          try {
            const dstId = body?.target_entity_id || body?.dst_id;
            if (!dstId) return jsonResponse(res, { error: 'target_entity_id required' }, 400);
            const r = await entityResolver.mergeEntities({ srcId: entityId, dstId });
            return jsonResponse(res, r);
          } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
        }
        if (req.method === 'GET') {
          try {
            const entity = await prisma.canonicalEntity.findFirst({ where: { id: entityId, organizationId: orgId } });
            if (!entity) return jsonResponse(res, { error: 'not found' }, 404);
            const links = await prisma.memoryEntityLink.findMany({ where: { entityId }, take: 200 });
            const memoryIds = links.map((l) => l.memoryId);
            const memories = memoryIds.length
              ? await prisma.memory.findMany({
                  where: { id: { in: memoryIds }, deletedAt: null },
                  select: { id: true, title: true, memoryType: true, createdAt: true, tags: true, sourcePlatform: true },
                  orderBy: { createdAt: 'desc' }, take: 200,
                })
              : [];
            const externalRefs = await prisma.externalRef.findMany({
              where: { memoryId: { in: memoryIds.length ? memoryIds : ['00000000-0000-0000-0000-000000000000'] } },
              take: 500,
            });
            return jsonResponse(res, { entity, memories, externalRefs, link_count: links.length });
          } catch (e) { return jsonResponse(res, { error: e.message }, 500); }
        }
        return jsonResponse(res, { error: 'method not allowed' }, 405);
      }

      if (pathname.startsWith('/api/memories/') && pathname !== '/api/memories/search' && pathname !== '/api/memories/query' && pathname !== '/api/memories/code/ingest' && pathname !== '/api/memories/traverse' && pathname !== '/api/memories/decay' && pathname !== '/api/memories/reinforce' && pathname !== '/api/memories/delete-all') {
        if (req.method === 'GET') {
          if (!ensurePersistedMemoryOrFail(res, '/api/memories/:id')) {
            return;
          }
          const memoryId = pathname.split('/api/memories/')[1];
          // Skip if this is the /relationships sub-route — handler above
          // already returned. Other sub-routes fall through to plain GET
          // which will fail the UUID parse — fine, that's existing behaviour.
          if (memoryId.includes('/')) {
            return jsonResponse(res, { error: 'Not found' }, 404);
          }
          try {
            const memory = await persistentMemoryStore.getMemory(memoryId);
            if (!memory || memory.deleted_at) {
              return jsonResponse(res, { error: 'Not found' }, 404);
            }
            if (memory.user_id !== userId && !principal.scopes?.includes('admin')) {
              return jsonResponse(res, { error: 'Not found' }, 404);
            }
            return jsonResponse(res, memory);
          } catch (error) {
            console.error('Get memory failed:', error);
            return jsonResponse(res, { error: error.message }, 500);
          }
        }
        if (req.method === 'DELETE') {
          if (!ensurePersistedMemoryOrFail(res, '/api/memories/:id')) {
            return;
          }
          const memoryId = pathname.split('/api/memories/')[1];
          try {
            const existing = await persistentMemoryStore.getMemory(memoryId);
            await persistentMemoryStore.deleteMemory(memoryId);
            if (existing) {
              invalidateAggregateCache({ userId, orgId, project: existing.project || null });
              invalidateAggregateCache({ userId, orgId, project: null });
            }
            // Audit: memory deleted
            auditLog({
              userId,
              organizationId: orgId,
              eventType: 'memory.delete',
              eventCategory: 'data_modification',
              action: 'delete',
              resourceType: 'memory',
              resourceId: memoryId || null,
              ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
              userAgent: req.headers['user-agent'] || null,
            });
            // Dispatch webhook event
            webhookManager?.dispatch('memory.deleted', { memoryId, userId, orgId }, { userId, orgId }).catch(() => {});
            return jsonResponse(res, { success: true });
          } catch (error) {
            return jsonResponse(res, { error: error.message }, 500);
          }
        }
        if (req.method === 'PUT') {
          if (!ensurePersistedMemoryOrFail(res, '/api/memories/:id')) {
            return;
          }
          const memoryId = pathname.split('/api/memories/')[1];
          const scopedBody = {
            ...body,
            user_id: userId,
            org_id: orgId
          };
          const validation = updateMemorySchema.safeParse(scopedBody);
          if (!validation.success) {
            return jsonResponse(res, {
              error: 'Validation failed',
              details: validation.error.flatten()
            }, 400);
          }
          try {
            const existing = await persistentMemoryStore.getMemory(memoryId);
            if (!existing || existing.deleted_at) {
              return jsonResponse(res, { error: 'Not found' }, 404);
            }
            if (existing.user_id !== userId && !principal.scopes?.includes('admin')) {
              return jsonResponse(res, { error: 'Not found' }, 404);
            }
            const updated = await persistentMemoryStore.updateMemory(memoryId, {
              ...validation.data,
              updated_at: new Date().toISOString(),
              source_metadata: {
                source_platform: existing.source_metadata?.source_platform || 'mcp',
                source_id: existing.source_metadata?.source_id || null
              }
            });
            // Embed updated memory in Qdrant
            if (qdrantClient && updated) {
              try {
                await qdrantClient.storeMemory(updated, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
              } catch {}
            }
            invalidateAggregateCache({ userId, orgId, project: existing.project || null });
            invalidateAggregateCache({ userId, orgId, project: updated.project || null });
            invalidateAggregateCache({ userId, orgId, project: null });
            return jsonResponse(res, { success: true, memory: updated });
          } catch (error) {
            return jsonResponse(res, { error: error.message }, 500);
          }
        }
      }

      if (pathname === '/api/connectors/mcp/jobs' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        const endpointName = url.searchParams.get('endpoint_name') || undefined;
        const status = url.searchParams.get('status') || undefined;

        try {
          const jobs = mcpIngestionService.listJobs(
            { user_id: userId, org_id: orgId, endpoint_name: endpointName, status },
            { limit }
          );
          return jsonResponse(res, {
            success: true,
            count: jobs.length,
            jobs
          });
        } catch (error) {
          return jsonResponse(res, { error: error.message }, 400);
        }
      }

      // PATCH /api/connectors/:provider/scope — change sync target scope
      // Permission gate:
      //   target_scope='organization' → requires org_admin or org_owner role
      //   target_scope='team'         → requires team_lead on the provided team_id
      //   target_scope='personal'     → any authenticated user
      const connectorScopeMatch = pathname.match(/^\/api\/connectors\/(\w+)\/scope$/);
      if (connectorScopeMatch && req.method === 'PATCH') {
        const provider = connectorScopeMatch[1];
        const { target_scope, team_id: scopeTeamId } = body;
        if (!['personal', 'organization', 'team'].includes(target_scope)) {
          return jsonResponse(res, { error: 'Invalid scope. Must be "personal", "team", or "organization".' }, 400);
        }
        try {
          // Permission check — organisation scope
          if (target_scope === 'organization') {
            const orgMembership = prisma ? await prisma.userOrganization.findUnique({
              where: { userId_orgId: { userId, orgId } },
            }) : null;
            const isOrgAdmin = orgMembership?.role === 'owner' || orgMembership?.role === 'admin';
            if (!isOrgAdmin) {
              return jsonResponse(res, { error: 'Only org admins can set org-scope connectors' }, 403);
            }
          }

          // Permission check — team scope
          if (target_scope === 'team') {
            if (!scopeTeamId) {
              return jsonResponse(res, { error: 'team_id is required when target_scope is "team"' }, 400);
            }
            const ts = await getTeamStore();
            const orgMembership = prisma ? await prisma.userOrganization.findUnique({
              where: { userId_orgId: { userId, orgId } },
            }) : null;
            const orgRole = orgMembership?.role || 'member';
            try {
              const { assertTeamPermission } = await import('./teams/team-store.js');
              await assertTeamPermission(prisma, {
                teamId: scopeTeamId,
                userId,
                orgRole,
                level: 'lead',
              });
            } catch {
              return jsonResponse(res, { error: 'Only team leads can set team-scope connectors' }, 403);
            }
          }

          const patchData = { targetScope: target_scope };
          if (target_scope === 'team' && scopeTeamId) {
            patchData.teamId = scopeTeamId;
          } else if (target_scope !== 'team') {
            // Clear teamId when switching away from team scope
            patchData.teamId = null;
          }

          const updated = await prisma.platformIntegration.updateMany({
            where: { userId, platformType: provider },
            data: patchData,
          });
          if (updated.count === 0) {
            return jsonResponse(res, { error: `No connector found for provider: ${provider}` }, 404);
          }

          // Audit log the scope change
          if (auditLogger) {
            auditLogger.log({
              userId,
              organizationId: orgId,
              eventType: 'connector.scope_changed',
              eventCategory: 'connector',
              action: 'update',
              resourceType: 'connector',
              newValue: { provider, target_scope, team_id: scopeTeamId || null },
            }).catch(err => console.warn('[audit] connector scope_changed log failed:', err.message));
          }

          return jsonResponse(res, { success: true, provider, target_scope, team_id: scopeTeamId || null });
        } catch (err) {
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      const mcpJobActionMatch = pathname.match(/^\/api\/connectors\/mcp\/jobs\/([^\/]+)\/(retry|replay)$/);
      if (mcpJobActionMatch && req.method === 'POST') {
        try {
          const [, jobId, action] = mcpJobActionMatch;
          const result = await mcpIngestionService.retryJob(
            jobId,
            { user_id: userId, org_id: orgId },
            { replay: action === 'replay' }
          );
          return jsonResponse(res, {
            success: true,
            action,
            result
          }, 202);
        } catch (error) {
          return jsonResponse(res, { error: error.message, job_id: error.connectorJobId || null }, 400);
        }
      }

      const mcpJobMatch = pathname.match(/^\/api\/connectors\/mcp\/jobs\/([^\/]+)$/);
      if (mcpJobMatch && req.method === 'GET') {
        try {
          const [, jobId] = mcpJobMatch;
          const job = mcpIngestionService.getJob(jobId, { user_id: userId, org_id: orgId });
          return jsonResponse(res, {
            success: true,
            job
          });
        } catch (error) {
          return jsonResponse(res, { error: error.message }, 404);
        }
      }

      if (pathname === '/api/connectors/sync' && req.method === 'POST') {
        if (!persistentMemoryEngine || !persistentMemoryStore) {
          return jsonResponse(res, { error: 'Persistent memory unavailable' }, 503);
        }
        try {
          const provider = body.provider;
          const syncUserId = body.user_id || userId;
          const syncOrgId = body.org_id || orgId;
          const allowedScopes = ['personal', 'organization', 'team'];
          const targetScope = allowedScopes.includes(body.target_scope) ? body.target_scope : null;
          const syncTeamId = body.team_id || null;

          const adapterModules = {
            gmail: './connectors/providers/gmail/adapter.js',
            slack: './connectors/providers/slack/adapter.js',
            notion: './connectors/providers/notion/adapter.js',
            github: './connectors/providers/github/adapter.js',
            linear: './connectors/providers/linear/adapter.js',
            atlassian: './connectors/providers/atlassian/adapter.js',
            // Nango-routed Google providers — same adapter pattern, mounted
            // under new keys so sync engine can dispatch by provider id.
            'google-docs': './connectors/providers/gdocs/adapter.js',
            gdocs: './connectors/providers/gdocs/adapter.js',
            'google-gemini': './connectors/providers/gemini/adapter.js',
            gemini: './connectors/providers/gemini/adapter.js',
            'google-mail': './connectors/providers/gmail/adapter.js',
          };
          const adapterPath = adapterModules[provider];
          if (!adapterPath) {
            return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
          }

          const mod = await import(adapterPath);
          // Adapter class export naming differs per provider: GmailAdapter,
          // SlackAdapter, NotionAdapter, etc. Fall back to default export.
          const AdapterClass = Object.values(mod).find(v => typeof v === 'function') || mod.default;
          if (!AdapterClass) {
            return jsonResponse(res, { error: `Adapter has no exported class: ${provider}` }, 500);
          }
          const adapter = new AdapterClass();

          const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
          const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
          const cStore = new ConnectorStore(prisma);
          const syncEngine = new SyncEngine({
            connectorStore: cStore,
            memoryEngine: persistentMemoryEngine,
            memoryStore: persistentMemoryStore,
            prisma,
            trailExecutor,
            smartIngestRouter,
            externalRefStore,
            entityResolver,
          });

          const incremental = body.incremental !== false;
          const cursor = body.cursor || null;

          setImmediate(async () => {
            try {
              const result = await syncEngine.runSync({
                adapter,
                userId: syncUserId,
                orgId: syncOrgId,
                provider,
                cursor,
                incremental,
                targetScope,
                teamId: syncTeamId,
              });
              console.log(`[connector-sync] ${provider}:${syncUserId} → ${result.status} (imported: ${result.imported}, skipped: ${result.skipped})`);
            } catch (syncErr) {
              console.error(`[connector-sync] ${provider}:${syncUserId} failed:`, syncErr.message);
            }
          });

          return jsonResponse(res, { success: true, message: 'Sync enqueued', provider }, 202);
        } catch (error) {
          return jsonResponse(res, { error: error.message }, 500);
        }
      }

      // POST /api/connectors/nango/webhook — unified Nango push handler
      //   Verifies x-nango-signature, dispatches to handleNangoWebhook which
      //   triggers an incremental sync for the affected connection via the
      //   same SyncEngine path as scheduled syncs. Covers all Nango
      //   providers — gmail, gdocs, gemini, slack, notion, github, linear.
      if (pathname === '/api/connectors/nango/webhook' && req.method === 'POST') {
        try {
          const { handleNangoWebhook } = await import('./webhooks/nango-webhook-handler.js');
          const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
          const result = await handleNangoWebhook({
            rawBody,
            body: typeof body === 'string' ? JSON.parse(body || '{}') : (body || {}),
            headers: req.headers,
            deps: {
              prisma,
              persistentMemoryStore,
              persistentMemoryEngine,
              smartIngestRouter,
            },
          });
          // 200 ack on every accepted event (Nango retries on non-2xx).
          const status = result.status === 'error' && result.reason === 'invalid-signature' ? 401 : 200;
          return jsonResponse(res, result, status);
        } catch (err) {
          console.warn('[nango-webhook] handler failed:', err.message);
          // 200 ack to prevent retry storm on internal bugs.
          return jsonResponse(res, { status: 'error', reason: err.message }, 200);
        }
      }

      // POST /api/connectors/gemini/ingest-paste
      //   Body: { session_id?, title?, model?, turns: [{role,content,ts?}], exported_at? }
      //   Or:   { transcript: "User: ...\nAssistant: ..." }
      // Normalizes via GeminiAdapter → tree → engine.ingestMemoryTree.
      if (pathname === '/api/connectors/gemini/ingest-paste' && req.method === 'POST') {
        if (!persistentMemoryEngine) {
          return jsonResponse(res, { error: 'memory engine unavailable' }, 503);
        }
        if (!userId || !orgId) {
          return jsonResponse(res, { error: 'auth required' }, 401);
        }
        try {
          let turns = Array.isArray(body?.turns) ? body.turns : null;
          // Plaintext transcript fallback — split on "User:" / "Assistant:".
          if (!turns && typeof body?.transcript === 'string' && body.transcript.trim()) {
            const blocks = body.transcript.split(/\n(?=(?:User|Assistant|Gemini|You):)/i);
            turns = blocks.map(b => {
              const m = b.match(/^(User|Assistant|Gemini|You):\s*([\s\S]*)/i);
              if (!m) return null;
              const role = /^(User|You)$/i.test(m[1]) ? 'user' : 'assistant';
              return { role, content: m[2].trim() };
            }).filter(t => t && t.content);
          }
          if (!Array.isArray(turns) || turns.length === 0) {
            return jsonResponse(res, { error: 'turns[] or transcript required' }, 400);
          }
          const { GeminiAdapter } = await import('./connectors/providers/gemini/adapter.js');
          const adapter = new GeminiAdapter();
          const payloads = adapter.normalize({
            session_id: body.session_id,
            title: body.title,
            model: body.model,
            exported_at: body.exported_at,
            turns,
          }, { user_id: userId, org_id: orgId });
          let imported = 0;
          for (const p of payloads) {
            if (p?._tree?.parent) {
              const routed = await smartIngestRouter.route(p);
              if (routed?.parent) {
                const result = await persistentMemoryEngine.ingestMemoryTree(routed);
                if (result?.parentId) imported++;
              }
            } else {
              await persistentMemoryEngine.ingestMemory(p);
              imported++;
            }
          }
          return jsonResponse(res, { success: true, imported, turn_count: turns.length }, 200);
        } catch (err) {
          console.warn('[gemini-ingest-paste] failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // POST /api/employees/slack-action — Digital Employee action gateway.
      // Called from MCP tools (hivemind_slack_post/react/search/history).
      // Resolves employee from caller's API key, runs policy gate, executes
      // via SlackBridge, persists ActionIntent, audits, optional auto-ingest.
      if (pathname === '/api/employees/slack-action' && req.method === 'POST') {
        if (!prisma || !persistentMemoryEngine) {
          return jsonResponse(res, { error: 'service unavailable' }, 503);
        }
        const actionType = body?.action_type;
        const payload = body?.payload || {};
        if (!actionType) return jsonResponse(res, { error: 'action_type required' }, 400);

        // Resolve employee by API key (principal.keyId → DigitalEmployee.hivemindApiKeyId)
        const keyId = principal?.keyId || null;
        if (!keyId) return jsonResponse(res, { error: 'API key required (Digital Employee scope)' }, 401);
        const employee = await prisma.digitalEmployee.findFirst({
          where: { hivemindApiKeyId: keyId, archivedAt: null },
        });
        if (!employee) return jsonResponse(res, { error: 'No Digital Employee bound to this key' }, 403);

        // Scope check on API key
        const scopes = principal?.scopes || [];
        const hasSlackAct = scopes.includes('*') || scopes.includes('slack:act');
        if (!hasSlackAct) return jsonResponse(res, { error: 'slack:act scope required' }, 403);

        // Policy gate
        const { checkPolicy, recordIntent } = await import('./employees/policy.js');
        const redis = (typeof qdrantClient !== 'undefined' && qdrantClient?.redis) || null;
        const intent = { actionType, payload };
        const verdict = await checkPolicy({ intent, employee, redis });

        if (!verdict.allowed) {
          await recordIntent({ prisma, employee, intent, status: 'denied', denyReason: verdict.reason });
          auditLog({
            organizationId: employee.orgId,
            userId: employee.createdBy,
            actorType: 'api_key',
            actorApiKeyId: keyId,
            eventType: `action.${actionType}.denied`,
            eventCategory: 'employee',
            action: 'denied',
            resourceType: 'digital_employee',
            resourceId: employee.id,
            metadata: { reason: verdict.reason, detail: verdict.detail || null, payload },
          });
          return jsonResponse(res, { ok: false, denied: true, reason: verdict.reason, detail: verdict.detail }, 403);
        }

        // Resolve Slack token for the employee's workspace via existing connector store
        const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
        const connStore = new ConnectorStore(prisma);
        const installerUserId = employee.createdBy;
        const token = await connStore.getAccessToken(installerUserId, 'slack').catch(() => null);
        if (!token) {
          await recordIntent({ prisma, employee, intent, status: 'failed', denyReason: 'slack_not_connected' });
          return jsonResponse(res, { ok: false, error: 'Slack connector not connected for employee owner' }, 412);
        }

        // Execute via SlackBridge
        const { SlackBridge } = await import('./connectors/providers/slack/bridge.js');
        const bridge = new SlackBridge({ connectorStore: connStore });
        let result = null;
        let executionError = null;
        try {
          if (actionType === 'slack_post') {
            // Per-employee identity override. Payload may supply username/
            // icon explicitly; otherwise we fall back to the employee row so
            // the same shared Slack app appears as N distinct personas.
            const displayName = payload.username || employee.slackDisplayName || employee.name;
            const iconUrl = payload.icon_url || employee.avatarUrl || undefined;
            const iconEmoji = payload.icon_emoji || employee.slackAvatarEmoji || (iconUrl ? undefined : ':robot_face:');
            result = await bridge.postMessage(installerUserId, payload.channel, payload.text, {
              threadTs: payload.thread_ts,
              username: displayName,
              iconUrl,
              iconEmoji,
            });
          } else if (actionType === 'slack_react') {
            result = await bridge._call('reactions.add', { channel: payload.channel, timestamp: payload.ts, name: payload.emoji }, token, 'POST');
          } else if (actionType === 'slack_search') {
            result = await bridge.searchMessages(installerUserId, payload.query, { count: payload.count || 10 });
          } else if (actionType === 'slack_history') {
            const sinceTs = payload.since ? String(new Date(payload.since).getTime() / 1000) : undefined;
            result = await bridge.getChannelHistory(installerUserId, payload.channel, { limit: payload.limit || 50, since: sinceTs });
          } else {
            return jsonResponse(res, { error: `unknown action_type: ${actionType}` }, 400);
          }
        } catch (err) {
          executionError = err.message;
        }

        if (executionError) {
          await recordIntent({ prisma, employee, intent, status: 'failed', denyReason: executionError });
          auditLog({
            organizationId: employee.orgId, userId: employee.createdBy,
            actorType: 'api_key', actorApiKeyId: keyId,
            eventType: `action.${actionType}.failed`, eventCategory: 'employee',
            action: 'failed', resourceType: 'digital_employee', resourceId: employee.id,
            metadata: { error: executionError, payload },
          });
          return jsonResponse(res, { ok: false, error: executionError }, 502);
        }

        await recordIntent({ prisma, employee, intent, status: 'executed', result });
        auditLog({
          organizationId: employee.orgId, userId: employee.createdBy,
          actorType: 'api_key', actorApiKeyId: keyId,
          eventType: `action.${actionType}.executed`, eventCategory: 'employee',
          action: 'execute', resourceType: 'digital_employee', resourceId: employee.id,
          metadata: { payload, result_summary: actionType.startsWith('slack_post') ? 'message posted' : `${Array.isArray(result) ? result.length : 'ok'}` },
        });

        // Auto-ingest posted message back to memory (team-scope)
        if (actionType === 'slack_post' && payload.text) {
          const slackPayload = {
            content: payload.text,
            title: `${employee.name} → ${payload.channel}`,
            tags: ['slack', 'employee', `employee:${employee.slug}`, 'live-slack', 'auto-ingest'],
            memory_type: 'note',
            user_id: employee.createdBy,
            org_id: employee.orgId,
            scope: 'team',
            primary_team_id: employee.teamId,
            source_metadata: {
              source_platform: 'slack',
              channel_id: payload.channel,
              employee_id: employee.id,
              thread_ts: payload.thread_ts || null,
            },
            skip_fact_extraction: true,
          };
          buildRoutedIngestPayloads(slackPayload, { smartIngestRouter }).then(([routed]) =>
            persistentMemoryEngine.ingestMemory(routed)
          ).catch(err => console.warn('[slack-action] auto-ingest failed:', err.message));
        }

        return jsonResponse(res, { ok: true, result });
      }

      // POST /api/connectors/slack/event-ingest — webhook ingest path
      // Called by control-plane after Slack signature verification. Master-key auth.
      // Ingests one Slack event (message/reaction/pin) as a HIVEMIND memory.
      if (pathname === '/api/connectors/slack/event-ingest' && req.method === 'POST') {
        if (!persistentMemoryEngine) {
          return jsonResponse(res, { error: 'memory engine unavailable' }, 503);
        }
        const evUserId = body.user_id;
        const evOrgId = body.org_id || orgId;
        const teamId = body.team_id;
        const ev = body.event || {};
        const evType = body.event_type || ev.type || 'unknown';
        const subtype = body.event_subtype || ev.subtype || null;

        if (!evUserId) return jsonResponse(res, { error: 'user_id required' }, 400);

        // Filter noise: skip joins/leaves/bot heartbeats/reaction-only short msgs
        const NOISE_SUBTYPES = new Set(['channel_join', 'channel_leave', 'bot_message', 'message_deleted', 'thread_broadcast']);
        if (subtype && NOISE_SUBTYPES.has(subtype)) {
          return jsonResponse(res, { ok: true, skipped: 'noise_subtype' });
        }

        // Only ingest message-class events for now
        if (!evType.startsWith('message') && evType !== 'pin_added' && evType !== 'reaction_added') {
          return jsonResponse(res, { ok: true, skipped: `unhandled_type:${evType}` });
        }

        const text = (ev.text || '').trim();
        if (evType === 'message' || evType.startsWith('message')) {
          if (!text || text.length < 15) {
            return jsonResponse(res, { ok: true, skipped: 'too_short' });
          }
        }

        const channelId = ev.channel || ev.item?.channel || null;
        const channelName = ev.channel_name || null;
        const where = channelName ? `#${channelName}` : (channelId || 'unknown');
        const who = ev.user || ev.user_id || 'unknown';
        const ts = ev.ts || ev.event_ts || body.event_ts || null;

        const titleBase = text || `Slack ${evType}`;
        const title = `Slack ${where} · ${who}: ${titleBase.slice(0, 60)}`;

        // Fire-and-forget ingest, ack 200 immediately
        const slackEventPayload = {
          content: text || `[${evType}${subtype ? `:${subtype}` : ''}] in ${where}`,
          title,
          tags: ['slack', 'live-slack', 'webhook', `slack:${where}`, `slack-team:${teamId || 'unknown'}`],
          memory_type: 'note',
          user_id: evUserId,
          org_id: evOrgId,
          source_metadata: {
            source_platform: 'slack',
            event_type: evType,
            event_subtype: subtype,
            channel_id: channelId,
            channel_name: channelName,
            ts,
            user: who,
            team_id: teamId,
          },
          skip_fact_extraction: true,
        };
        buildRoutedIngestPayloads(slackEventPayload, { smartIngestRouter }).then(([routed]) =>
          persistentMemoryEngine.ingestMemory(routed)
        ).catch(err => console.warn('[slack-events] ingest failed:', err.message));

        return jsonResponse(res, { ok: true, ingested: true, event_type: evType });
      }

      // ── Usage tracking + plan enforcement (PlanEnforcer) ──
      if (planEnforcer && orgId) {
        // Pre-flight: check the relevant limit type for this request
        let enforcementType = null;
        let enforcementAmount = 1;

        if (req.method === 'POST' && (pathname === '/api/memories')) {
          enforcementType = 'tokens';
          enforcementAmount = body?.content ? Math.ceil(body.content.length / 4) : 100;
        } else if (pathname.includes('/search') || pathname.includes('/recall')) {
          enforcementType = 'searches';
        } else if (body?.content) {
          enforcementType = 'tokens';
          enforcementAmount = Math.ceil((body.content.length || 0) / 4);
        }

        if (enforcementType) {
          const check = await planEnforcer.checkLimit(orgId, enforcementType, enforcementAmount);
          if (!check.allowed) {
            return jsonResponse(res, {
              error: 'Plan limit exceeded',
              reason: check.reason,
              limit: check.limit,
              current: check.current,
              plan: check.plan,
              upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing',
            }, 429);
          }
          // Set warning header for overage plans
          if (check.overage) {
            res.setHeader('X-HiveMind-Usage-Warning', 'Overage billing active — usage exceeds plan allocation');
          }
        }

        // Legacy warning headers from UsageTracker
        if (usageTracker && planStore) {
          const orgPlan = await planStore.getOrgPlan(orgId);
          const limits = await usageTracker.checkLimits(orgId, orgPlan.id);
          if (limits.warnings.length > 0) {
            res.setHeader('X-HiveMind-Usage-Warning', limits.warnings[0]);
          }
        }

        // Feature gating — only gate web search/crawl creation, not status/admin endpoints
        if (planStore) {
          const orgPlan = await planStore.getOrgPlan(orgId);
          // Web Intelligence is now available on all plans (free included)
          // if (!orgPlan.features.webIntelligence && req.method === 'POST' && (pathname === '/api/web/search/jobs' || pathname === '/api/web/crawl/jobs')) {
          //   return jsonResponse(res, { error: 'Web Intelligence requires Pro plan or higher', upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing' }, 403);
          // }
          if (pathname.includes('/swarm') && !orgPlan.features.agentSwarm) {
            return jsonResponse(res, { error: 'Agent Swarm requires Scale plan or higher', upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing' }, 403);
          }
        }
      }

      // Dynamic route: PATCH /api/swarm/blueprints/:id
      if (pathname.startsWith('/api/swarm/blueprints/') && pathname !== '/api/swarm/blueprints/mine' && req.method === 'PATCH') {
        if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
        try {
          const blueprintId = pathname.split('/api/swarm/blueprints/')[1];
          if (!blueprintId) return jsonResponse(res, { error: 'blueprint id is required' }, 400);
          if (!body.state || !['active', 'deprecated'].includes(body.state)) {
            return jsonResponse(res, { error: 'state must be "active" or "deprecated"' }, 400);
          }

          const trail = await trailExecutor._store.getTrail(blueprintId);
          if (!trail || trail.kind !== 'blueprint') {
            return jsonResponse(res, { error: 'Blueprint not found' }, 404);
          }

          if (body.expected_version != null && trail.blueprintMeta?.version !== body.expected_version) {
            return jsonResponse(res, { error: 'Version mismatch', current_version: trail.blueprintMeta?.version }, 409);
          }

          trail.blueprintMeta.state = body.state;
          await trailExecutor._store.putTrail(trail);

          return jsonResponse(res, {
            id: trail.id,
            chainSignature: trail.blueprintMeta.chainSignature,
            state: trail.blueprintMeta.state,
            version: trail.blueprintMeta.version,
            updated_at: new Date().toISOString(),
          });
        } catch (error) {
          return jsonResponse(res, { error: 'Update blueprint failed', message: error.message }, 500);
        }
      }

      // Dynamic route: GET /api/swarm/meta/parameters/:key
      if (pathname.startsWith('/api/swarm/meta/parameters/') && req.method === 'GET') {
        if (!trailExecutor?._parameterRegistry) return jsonResponse(res, { error: 'ParameterRegistry unavailable' }, 503);
        try {
          const key = decodeURIComponent(pathname.split('/api/swarm/meta/parameters/')[1]);
          const history = await trailExecutor._parameterRegistry.getHistory(key);
          return jsonResponse(res, history);
        } catch (error) {
          return jsonResponse(res, { error: 'Get parameter failed', message: error.message }, 500);
        }
      }

      if (residentRoutes) {
        const residentResult = await residentRoutes.dispatch({
          pathname,
          method: req.method,
          body,
          userId,
          orgId,
        });
        if (residentResult) {
          return jsonResponse(res, residentResult.body, residentResult.statusCode);
        }
      }

      if (enterpriseChatRoutes) {
        const enterpriseChatResult = await enterpriseChatRoutes.dispatch({
          pathname,
          method: req.method,
          body,
          userId,
          orgId,
        });
        if (enterpriseChatResult) {
          return jsonResponse(res, enterpriseChatResult.body, enterpriseChatResult.statusCode);
        }
      }

      // Dynamic route: /api/swarm/agents/:agent_id
      if (pathname.startsWith('/api/swarm/agents/') && pathname !== '/api/swarm/agents') {
        const agentId = decodeURIComponent(pathname.split('/api/swarm/agents/')[1]);
        if (agentId && !agentId.includes('/')) {
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const agent = await trailExecutor._store.getAgent(agentId);
              if (!agent) return jsonResponse(res, { error: 'Agent not found' }, 404);
              const reputation = trailExecutor._reputationEngine
                ? await trailExecutor._reputationEngine.getReputation(agentId)
                : null;
              return jsonResponse(res, { agent, reputation });
            } catch (error) {
              return jsonResponse(res, { error: 'Get agent failed', message: error.message }, 500);
            }
          }
          if (req.method === 'PATCH') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const agent = await trailExecutor._store.getAgent(agentId);
              if (!agent) return jsonResponse(res, { error: 'Agent not found' }, 404);
              const updates = {};
              if (body.role) updates.role = body.role;
              if (body.skills) updates.skills = body.skills;
              if (body.status) updates.status = body.status;
              if (body.model_version) updates.model_version = body.model_version;
              const updated = await trailExecutor._store.updateAgent(agentId, updates);
              return jsonResponse(res, { agent: updated });
            } catch (error) {
              return jsonResponse(res, { error: 'Update agent failed', message: error.message }, 500);
            }
          }
        }
      }

      // ── Team: dynamic routes (invite accept, member PATCH/DELETE, project PATCH/DELETE) ──

      // POST /api/team/invites/:token/accept
      if (pathname.startsWith('/api/team/invites/') && pathname.endsWith('/accept') && req.method === 'POST') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const token = pathname.split('/api/team/invites/')[1].replace('/accept', '');
        try {
          const invite = await prisma.orgInvite.findUnique({ where: { token } });
          if (!invite) return jsonResponse(res, { error: 'Invite not found' }, 404);
          if (invite.usedAt) return jsonResponse(res, { error: 'Invite already used' }, 410);
          if (invite.expiresAt < new Date()) return jsonResponse(res, { error: 'Invite expired' }, 410);
          const existing = await prisma.userOrganization.findFirst({ where: { userId, orgId: invite.orgId } });
          if (existing) return jsonResponse(res, { error: 'Already a member of this organization' }, 409);
          
          // Create org membership
          await prisma.userOrganization.create({
            data: { userId, orgId: invite.orgId, role: invite.role, joinedAt: new Date() }
          });
          
          // Create team memberships from invite.teamIds
          const teamIds = invite.teamIds || [];
          if (teamIds.length > 0) {
            const teamMemberships = teamIds.map(teamId => ({
              teamId,
              userId,
              role: 'member',
              joinedAt: new Date()
            }));
            await prisma.teamMember.createMany({ data: teamMemberships, skipDuplicates: true });
          }
          
          // Create project memberships from invite.projectIds
          const projectIds = invite.projectIds || [];
          if (projectIds.length > 0) {
            const projectMemberships = projectIds.map(projectId => ({
              projectId,
              userId,
              role: 'member',
              addedAt: new Date()
            }));
            await prisma.projectMember.createMany({ data: projectMemberships, skipDuplicates: true });
          }
          
          // Mark invite as used
          await prisma.orgInvite.update({ where: { id: invite.id }, data: { usedAt: new Date(), usedBy: userId } });
          
          // Invalidate access context cache
          invalidateAccessContextCache(userId, invite.orgId);
          
          // Audit log
          await writeAuditLog(prisma, {
            userId,
            orgId: invite.orgId,
            eventType: 'invite_accepted',
            action: 'accept',
            resourceType: 'invite',
            resourceId: invite.id,
            metadata: { role: invite.role, teamsJoined: teamIds.length, projectsGranted: projectIds.length },
            ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null
          });
          
          return jsonResponse(res, { 
            success: true, 
            orgId: invite.orgId, 
            role: invite.role,
            teamsJoined: teamIds.length,
            projectsGranted: projectIds.length
          });
        } catch (err) {
          console.error('[team] accept invite failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // DELETE /api/team/invites/:id — soft-revoke (sets revokedAt; row kept
      // so the status list can show it as revoked + for audit).
      if (pathname.startsWith('/api/team/invites/') && !pathname.endsWith('/accept') && !pathname.endsWith('/resend') && req.method === 'DELETE') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const inviteId = pathname.split('/api/team/invites/')[1];
        try {
          const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
          const memberRoles = new Set([
            ...(membership?.role ? [membership.role] : []),
            ...(Array.isArray(membership?.roles) ? membership.roles : []),
          ]);
          const isAdmin = membership?.isActive !== false && (
            memberRoles.has('admin') || memberRoles.has('owner') ||
            memberRoles.has('org_admin') || memberRoles.has('org_owner')
          );
          if (!isAdmin && !principal?.master) return jsonResponse(res, { error: 'Admin access required' }, 403);
          const invite = await prisma.orgInvite.findFirst({ where: { id: inviteId, orgId } });
          if (!invite) return jsonResponse(res, { error: 'Invite not found' }, 404);
          if (invite.usedAt) return jsonResponse(res, { error: 'Invite already accepted — cannot revoke' }, 409);
          const updated = await prisma.orgInvite.update({
            where: { id: inviteId },
            data: { revokedAt: new Date(), revokedBy: userId },
          });
          await writeAuditLog(prisma, {
            userId, orgId,
            eventType: 'invite_revoked', action: 'revoke',
            resourceType: 'invite', resourceId: inviteId,
            metadata: { email: invite.email, projectIds: invite.projectIds, teamIds: invite.teamIds },
            ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
          });
          return jsonResponse(res, { success: true, invite: updated });
        } catch (err) {
          console.error('[team] revoke invite failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // POST /api/team/invites/:id/resend — resend email + extend expiry.
      // Used by the share modal "Resend" action on pending invites.
      if (pathname.startsWith('/api/team/invites/') && pathname.endsWith('/resend') && req.method === 'POST') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const inviteId = pathname.split('/api/team/invites/')[1].replace('/resend', '');
        try {
          const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
          const memberRoles = new Set([
            ...(membership?.role ? [membership.role] : []),
            ...(Array.isArray(membership?.roles) ? membership.roles : []),
          ]);
          const isAdmin = membership?.isActive !== false && (
            memberRoles.has('admin') || memberRoles.has('owner') ||
            memberRoles.has('org_admin') || memberRoles.has('org_owner')
          );
          if (!isAdmin && !principal?.master) return jsonResponse(res, { error: 'Admin access required' }, 403);
          const invite = await prisma.orgInvite.findFirst({ where: { id: inviteId, orgId } });
          if (!invite) return jsonResponse(res, { error: 'Invite not found' }, 404);
          if (invite.usedAt) return jsonResponse(res, { error: 'Invite already accepted' }, 409);
          if (invite.revokedAt) return jsonResponse(res, { error: 'Invite was revoked' }, 409);
          if (!invite.email) return jsonResponse(res, { error: 'Link-only invite — no email to resend. Share the link instead.' }, 400);

          // Bump expiry by 7d from now (or preserve if longer remains).
          const newExpiresAt = new Date(Math.max(
            invite.expiresAt?.getTime?.() || 0,
            Date.now() + 7 * 24 * 3600 * 1000,
          ));

          const FRONTEND = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
          const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } });
          const inviteUrl = `${FRONTEND}/hivemind/join/${org?.slug || orgId}/${invite.token}`;

          let dispatch = { attempted: true };
          try {
            const [{ sendEmail, buildInviteEmail }, projectRows, teamRows, inviter] = await Promise.all([
              import('./services/email-sender.js'),
              invite.projectIds?.length
                ? prisma.project.findMany({ where: { id: { in: invite.projectIds }, orgId }, select: { name: true } })
                : Promise.resolve([]),
              invite.teamIds?.length
                ? prisma.team.findMany({ where: { id: { in: invite.teamIds }, orgId }, select: { name: true } }).catch(() => [])
                : Promise.resolve([]),
              prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null),
            ]);
            const tpl = buildInviteEmail({
              orgName: org?.name || 'your team',
              inviteUrl,
              inviterEmail: inviter?.email || null,
              projectNames: projectRows.map(p => p.name),
              teamNames: teamRows.map(t => t.name),
              role: invite.role,
              expiresAt: newExpiresAt,
              resend: true,
            });
            const result = await sendEmail({ to: invite.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
            dispatch = { attempted: true, ...result };
          } catch (mailErr) {
            dispatch = { attempted: true, ok: false, error: mailErr.message };
          }

          const updated = await prisma.orgInvite.update({
            where: { id: inviteId },
            data: {
              expiresAt: newExpiresAt,
              lastSentAt: new Date(),
              sendCount: { increment: 1 },
            },
          });
          await writeAuditLog(prisma, {
            userId, orgId,
            eventType: 'invite_resent', action: 'resend',
            resourceType: 'invite', resourceId: inviteId,
            metadata: { email: invite.email, dispatch },
            ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
          });
          return jsonResponse(res, {
            success: true,
            invite: updated,
            url: inviteUrl,
            email_dispatch: dispatch,
          });
        } catch (err) {
          console.error('[team] resend invite failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // PATCH /api/team/members/:memberId — change role
      if (pathname.startsWith('/api/team/members/') && req.method === 'PATCH') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const memberId = pathname.split('/api/team/members/')[1];
        try {
          const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
          if (!membership || membership.role !== 'admin') return jsonResponse(res, { error: 'Admin access required' }, 403);
          const { role } = body;
          if (!role || !['member', 'admin'].includes(role)) return jsonResponse(res, { error: 'Valid role required: member or admin' }, 400);
          await prisma.userOrganization.updateMany({ where: { userId: memberId, orgId }, data: { role } });
          return jsonResponse(res, { success: true, userId: memberId, role });
        } catch (err) {
          console.error('[team] change role failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // DELETE /api/team/members/:memberId — remove member
      if (pathname.startsWith('/api/team/members/') && req.method === 'DELETE') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const memberId = pathname.split('/api/team/members/')[1];
        try {
          const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
          if (!membership || membership.role !== 'admin') return jsonResponse(res, { error: 'Admin access required' }, 403);
          if (memberId === userId) return jsonResponse(res, { error: 'Cannot remove yourself from the organization' }, 400);
          await prisma.userOrganization.deleteMany({ where: { userId: memberId, orgId } });
          return jsonResponse(res, { success: true });
        } catch (err) {
          console.error('[team] remove member failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // PATCH /api/team/projects/:id — update project
      if (pathname.startsWith('/api/team/projects/') && req.method === 'PATCH') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const projectId = pathname.split('/api/team/projects/')[1];
        try {
          const { name, description } = body;
          const updated = await prisma.project.update({
            where: { id: projectId },
            data: { ...(name && { name }), ...(description !== undefined && { description }) }
          });
          return jsonResponse(res, { project: updated });
        } catch (err) {
          console.error('[team] update project failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // DELETE /api/team/projects/:id — delete project
      if (pathname.startsWith('/api/team/projects/') && req.method === 'DELETE') {
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        const projectId = pathname.split('/api/team/projects/')[1];
        try {
          const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
          if (!membership || membership.role !== 'admin') return jsonResponse(res, { error: 'Admin access required' }, 403);
          await prisma.project.delete({ where: { id: projectId } });
          return jsonResponse(res, { success: true });
        } catch (err) {
          console.error('[team] delete project failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      // ==========================================
      // PageIndex Dynamic Routes (before switch)
      // ==========================================

      // Get all memories for a PageIndex node
      if (pathname.startsWith('/api/pageindex/node/') && pathname.endsWith('/memories')) {
        if (req.method === 'GET') {
          if (!ensurePersistedMemoryOrFail(res, pathname)) {
            return;
          }
          try {
            const parts = pathname.split('/').filter(Boolean);
            const nodeIdIndex = parts.indexOf('node');
            const nodeId = nodeIdIndex >= 0 ? parts[nodeIdIndex + 1] : null;

            if (!nodeId) {
              return jsonResponse(res, { error: 'nodeId required' }, 400);
            }

            const includeChildren = url.searchParams.get('includeChildren') !== 'false';

            const { PageIndexService } = await import('./services/pageindex-service.js');
            const pageindexService = new PageIndexService({ prisma });
            const result = await pageindexService.getMemoriesForNode(nodeId, includeChildren);

            const memories = result.memoryIds.length > 0
              ? await prisma.memory.findMany({
                  where: { id: { in: result.memoryIds }, deletedAt: null },
                  select: {
                    id: true, title: true, content: true, memoryType: true,
                    tags: true, createdAt: true, project: true,
                  },
                })
              : [];

            jsonResponse(res, { memories, count: result.count });
          } catch (error) {
            console.error('PageIndex node memories fetch failed:', error);
            jsonResponse(res, { memories: [], count: 0 });
          }
        }
        return;
      }

      // Generate summary for a node
      if (pathname.startsWith('/api/pageindex/node/') && pathname.endsWith('/summary')) {
        if (req.method === 'POST') {
          if (!ensurePersistedMemoryOrFail(res, pathname)) {
            return;
          }
          try {
            const parts = pathname.split('/').filter(Boolean);
            const nodeIdIndex = parts.indexOf('node');
            const nodeId = nodeIdIndex >= 0 ? parts[nodeIdIndex + 1] : null;

            if (!nodeId) {
              return jsonResponse(res, { error: 'nodeId required' }, 400);
            }

            const { PageIndexService } = await import('./services/pageindex-service.js');
            const pageindexService = new PageIndexService({ prisma });
            const result = await pageindexService.generateNodeSummary(nodeId);

            jsonResponse(res, result);
          } catch (error) {
            console.error('PageIndex node summary generation failed:', error);
            jsonResponse(res, { success: false, error: error.message }, 500);
          }
        }
        return;
      }

      // Move memory to a node
      if (pathname.startsWith('/api/pageindex/memory/') && pathname.endsWith('/move')) {
        if (req.method === 'POST') {
          if (!ensurePersistedMemoryOrFail(res, pathname)) {
            return;
          }
          try {
            const parts = pathname.split('/').filter(Boolean);
            const memoryIdIndex = parts.indexOf('memory');
            const memoryId = memoryIdIndex >= 0 ? parts[memoryIdIndex + 1] : null;

            if (!memoryId) {
              return jsonResponse(res, { error: 'memoryId required' }, 400);
            }

            const body = await parseBody(req);
            const { nodeId, action = 'add' } = body;

            if (!nodeId) {
              return jsonResponse(res, { error: 'nodeId required' }, 400);
            }

            const { PageIndexService } = await import('./services/pageindex-service.js');
            const pageindexService = new PageIndexService({ prisma });

            let success;
            if (action === 'remove') {
              success = await pageindexService.removeMemoryFromNode(nodeId, memoryId);
            } else {
              success = await pageindexService.assignMemoryToNode(nodeId, memoryId);
            }

            jsonResponse(res, { success });
          } catch (error) {
            console.error('PageIndex memory move failed:', error);
            jsonResponse(res, { error: error.message }, 500);
          }
        }
        return;
      }

      // Get nodes for a memory
      if (pathname.startsWith('/api/pageindex/memory/') && pathname.endsWith('/nodes')) {
        if (req.method === 'GET') {
          if (!ensurePersistedMemoryOrFail(res, pathname)) {
            return;
          }
          try {
            const parts = pathname.split('/').filter(Boolean);
            const memoryIdIndex = parts.indexOf('memory');
            const memoryId = memoryIdIndex >= 0 ? parts[memoryIdIndex + 1] : null;

            if (!memoryId) {
              return jsonResponse(res, { error: 'memoryId required' }, 400);
            }

            const { PageIndexService } = await import('./services/pageindex-service.js');
            const pageindexService = new PageIndexService({ prisma });
            const nodes = await pageindexService.findNodesForMemory(memoryId);

            jsonResponse(res, { nodes: nodes || [] });
          } catch (error) {
            console.error('PageIndex memory nodes fetch failed:', error);
            jsonResponse(res, { nodes: [] });
          }
        }
        return;
      }

      // GET /api/documents/:documentId — get single document with segments and promoted memories
      // (Exclude reserved sub-routes that look like ids but aren't UUIDs)
      if (
        pathname.match(/^\/api\/documents\/[^/]+$/) &&
        req.method === 'GET' &&
        !pathname.endsWith('/search')
      ) {
        if (!ensurePersistedMemoryOrFail(res, '/api/documents/:id')) return;
        if (!documentFirstIngestion) {
          return jsonResponse(res, { error: 'Document-first ingestion not enabled' }, 501);
        }

        const documentId = pathname.split('/')[3];
        
        try {
          const document = await prisma.knowledgeDocument.findFirst({
            where: {
              id: documentId,
              userId,
              orgId
            },
            include: {
              sourceArtifact: {
                select: {
                  id: true,
                  contentType: true,
                  sizeBytes: true,
                  storageLocation: true,
                  payload: true
                }
              }
            }
          });

          if (!document) {
            return jsonResponse(res, { error: 'Document not found or access denied' }, 404);
          }

          // Get segments
          const segments = await prisma.knowledgeSegment.findMany({
            where: { documentId },
            orderBy: { segmentIndex: 'asc' }
          });

          // Get promoted memories linked to this document
          const evidenceLinks = await prisma.memoryEvidenceLink.findMany({
            where: { documentId },
            include: {
              memory: {
                select: {
                  id: true,
                  title: true,
                  content: true,
                  memoryType: true,
                  importanceScore: true,
                  tags: true,
                  createdAt: true
                }
              }
            },
            orderBy: { confidence: 'desc' }
          });

          const promotedMemories = evidenceLinks.map(link => ({
            ...link.memory,
            linkType: link.linkType,
            confidence: link.confidence,
            excerpt: link.excerpt
          }));

          return jsonResponse(res, {
            document,
            segments,
            promotedMemories,
            segmentCount: segments.length,
            promotedCount: promotedMemories.length
          });
        } catch (err) {
          console.error('[documents/:id] Failed:', err.message);
          return jsonResponse(res, { error: err.message }, 500);
        }
      }

      switch (pathname) {
        case '/api/generate':
          if (req.method === 'POST') {
            if (!groqClient.isAvailable()) {
              return jsonResponse(res, { error: 'Groq not configured. Set GROQ_API_KEY.' }, 503);
            }
            const prompt = body.prompt || '';
            if (!prompt.trim()) {
              return jsonResponse(res, { error: 'prompt is required' }, 400);
            }
            try {
              const content = await groqClient.generate(prompt, {
                model: body.model,
                temperature: body.temperature,
                maxTokens: body.max_tokens || body.maxTokens
              });
              return jsonResponse(res, {
                content,
                model: body.model || groqClient.getConfig().inferenceModel,
                usage: groqClient.getUsage()
              });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/ingest/image':
          if (req.method === 'POST') {
            if (!persistentMemoryEngine) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }
            try {
              const contentType = req.headers['content-type'] || '';
              if (!contentType.includes('multipart/form-data')) {
                return jsonResponse(res, { error: 'Content-Type must be multipart/form-data' }, 400);
              }
              const boundaryMatch = contentType.match(/boundary=(.+)/);
              if (!boundaryMatch) {
                return jsonResponse(res, { error: 'Missing boundary' }, 400);
              }
              const rawBody = await new Promise((resolve) => {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => resolve(Buffer.concat(chunks)));
              });
              const parts = parseMultipart(rawBody, boundaryMatch[1].trim());
              const filePart = parts.find((p) => p.filename);
              if (!filePart) {
                return jsonResponse(res, { error: 'No file uploaded — send a file field' }, 400);
              }
              const mime = (filePart.contentType || '').toLowerCase();
              if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) {
                return jsonResponse(res, { error: `Unsupported MIME ${mime} — only image/* on this endpoint` }, 415);
              }
              // 20MB cap matches Groq Scout file limit.
              if (filePart.data.length > 20 * 1024 * 1024) {
                return jsonResponse(res, { error: 'Image too large. Max 20MB.' }, 413);
              }
              const hint = parts.find((p) => p.name === 'hint')?.value || null;
              const projectId = parts.find((p) => p.name === 'projectId')?.value
                || parts.find((p) => p.name === 'project_id')?.value
                || null;

              const { buildImageMemoryPayload } = await import('./services/image-ingest.js');
              const { payload, classification, extraction, usage } = await buildImageMemoryPayload({
                imageBuffer: filePart.data,
                mimeType: mime,
                hint,
                userId,
                orgId,
                projectId,
                filename: filePart.filename,
              });

              const [routed] = await buildRoutedIngestPayloads(payload, { smartIngestRouter });
              const saved = await ingestRoutedPayload(routed, persistentMemoryEngine);

              return jsonResponse(res, {
                success: true,
                memory_id: saved?.parentId || saved?.id || saved?.memoryId || null,
                title: payload.title,
                classification,
                extraction_preview: {
                  description: extraction?.description?.slice(0, 240) || null,
                  entities: extraction?.entities || [],
                  key_facts: (extraction?.key_facts || []).slice(0, 5),
                  has_structured_fields: !!(extraction?.structured_fields && Object.keys(extraction.structured_fields).length),
                },
                usage,
              });
            } catch (err) {
              console.warn('[/api/ingest/image] failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/ingest':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/ingest')) {
              return;
            }
            if (!ingestionPipeline) {
              return jsonResponse(res, {
                error: 'Ingestion pipeline unavailable',
                message: '/api/ingest is not available in this runtime.'
              }, 503);
            }

            if (!body.source_type) {
              return jsonResponse(res, { error: 'source_type is required' }, 400);
            }

            try {
              const accepted = await ingestionPipeline.ingest({
                ...body,
                user_id: userId,
                org_id: orgId,
              });

              return jsonResponse(res, {
                success: true,
                ...accepted
              }, 202);
            } catch (error) {
              return jsonResponse(res, {
                error: 'Ingestion request failed',
                message: error.message
              }, 400);
            }
          }
          break;

        case '/api/ingest/status':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/ingest/status')) {
              return;
            }
            if (!ingestionPipeline) {
              return jsonResponse(res, {
                error: 'Ingestion pipeline unavailable',
                message: '/api/ingest/status is not available in this runtime.'
              }, 503);
            }

            const jobId = url.searchParams.get('job_id');
            if (!jobId) {
              return jsonResponse(res, { error: 'job_id is required' }, 400);
            }

            const status = await getIngestionJobStatus(jobId);
            if (!status) {
              return jsonResponse(res, { error: 'Job not found' }, 404);
            }

            return jsonResponse(res, status);
          }
          break;

        // ── Static catalog: what connectors exist + their modes ─────────
        case '/api/connectors/catalog':
          if (req.method === 'GET') {
            try {
              const { CONNECTOR_CATALOG, CONNECTOR_CATEGORIES, CONNECTOR_MODES } = await import('./connectors/catalog.js');
              return jsonResponse(res, {
                connectors: CONNECTOR_CATALOG,
                categories: CONNECTOR_CATEGORIES,
                modes: CONNECTOR_MODES,
                count: CONNECTOR_CATALOG.length,
              });
            } catch (err) {
              return jsonResponse(res, { error: 'catalog load failed', message: err.message }, 500);
            }
          }
          break;

        // ── Per-tenant connection status across all connectors ──────────
        case '/api/connectors/status':
          if (req.method === 'GET') {
            try {
              const { CONNECTOR_CATALOG } = await import('./connectors/catalog.js');
              let records = [];
              try {
                if (typeof connectorStore?.listConnectors === 'function') {
                  records = await connectorStore.listConnectors(userId) || [];
                }
              } catch (storeErr) {
                console.warn('[connectors/status] store query failed:', storeErr.message);
              }
              const byProvider = {};
              for (const r of records) {
                const key = r.provider || r.connector_id || r.id;
                if (!key) continue;
                byProvider[key] = {
                  provider: key,
                  status: r.status || 'connected',
                  lastSyncAt: r.lastSyncAt || r.last_sync_at || null,
                  createdAt: r.createdAt || r.created_at || null,
                  metadata: r.metadata || null,
                  email: r.email || r.providerEmail || null,
                };
              }

              // Overlay Nango connections (connectors/connect writes here)
              const CATALOG_ID_TO_NANGO = {
                slack: 'slack',
                notion: 'notion',
                github: 'github',
                linear: 'linear',
                atlassian: 'jira',
                jira: 'jira',
                confluence: 'confluence',
                gmail: 'google-mail',
                'google-mail': 'google-mail',
                'google-drive': 'google-drive',
                'google-calendar': 'google-calendar',
              };
              try {
                if (prisma?.nangoConnection) {
                  const nangoRows = await prisma.nangoConnection.findMany({
                    where: { userId, orgId, status: 'active' },
                    select: { providerKey: true, connectionId: true, connectedAt: true, metadata: true },
                  });
                  const nangoByProvider = {};
                  for (const row of nangoRows) {
                    nangoByProvider[row.providerKey] = {
                      provider: row.providerKey,
                      status: 'connected',
                      lastSyncAt: null,
                      createdAt: row.connectedAt,
                      metadata: row.metadata,
                      connectionId: row.connectionId,
                      source: 'nango',
                    };
                  }
                  for (const c of CONNECTOR_CATALOG) {
                    const nangoKey = CATALOG_ID_TO_NANGO[c.id] || c.id;
                    if (nangoByProvider[nangoKey] && !byProvider[c.id]) {
                      byProvider[c.id] = nangoByProvider[nangoKey];
                    }
                  }
                }
              } catch (nangoErr) {
                console.warn('[connectors/status] nango overlay failed:', nangoErr.message);
              }

              const merged = CONNECTOR_CATALOG.map(c => ({
                id: c.id,
                name: c.name,
                category: c.category,
                mode: c.mode,
                authType: c.authType,
                catalogStatus: c.status,
                connection: byProvider[c.id] || null,
              }));
              return jsonResponse(res, { connectors: merged, count: merged.length });
            } catch (err) {
              return jsonResponse(res, { error: 'status load failed', message: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/mcp/endpoints':
          if (req.method === 'GET') {
            return jsonResponse(res, {
              endpoints: mcpIngestionService.listEndpoints({ user_id: userId, org_id: orgId })
            });
          }

          if (req.method === 'POST') {
            try {
              const endpoint = mcpIngestionService.registerEndpoint({
                ...body,
                user_id: userId,
                org_id: orgId
              });
              return jsonResponse(res, { success: true, endpoint }, 201);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 400);
            }
          }
          break;

        case '/api/connectors/mcp/inspect':
          if (req.method === 'POST') {
            try {
              const inspection = await mcpIngestionService.inspectEndpoint(body.name, {
                user_id: userId,
                org_id: orgId
              });
              return jsonResponse(res, { success: true, inspection });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 400);
            }
          }
          break;

        case '/api/connectors/mcp/status':
          if (req.method === 'GET') {
            try {
              const status = await mcpIngestionService.listEndpointStatuses({
                user_id: userId,
                org_id: orgId
              });
              return jsonResponse(res, { success: true, ...status });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 400);
            }
          }
          break;

        case '/api/admin/backfill':
          // P3 #20 — re-process historical segments through current pipeline
          if (req.method === 'POST') {
            try {
              if (!documentFirstIngestion) {
                return jsonResponse(res, { error: 'Document-first not enabled' }, 503);
              }
              const since = body.since ? new Date(body.since) : new Date(Date.now() - 30 * 86400000);
              const limit = Math.min(Number(body.limit || 100), 500);
              const segments = await prisma.knowledgeSegment.findMany({
                where: { orgId, createdAt: { gte: since }, memoryLinks: { none: {} } },
                take: limit,
                orderBy: { createdAt: 'asc' },
              });
              let reprocessed = 0;
              for (const seg of segments) {
                try {
                  const r = await documentFirstIngestion._promoteMemories({
                    documentId: seg.documentId, userId: seg.userId, orgId: seg.orgId,
                    segments: [{ id: seg.id, content: seg.content, segmentIndex: 0 }],
                    metadata: {}, promotionStrategy: 'admin_backfill',
                  });
                  reprocessed += r.memories.filter(m => m?.id).length;
                } catch (err) {
                  console.warn(`[backfill] segment ${seg.id} failed: ${err.message}`);
                }
              }
              return jsonResponse(res, { success: true, scanned: segments.length, promoted: reprocessed });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/admin/entities/merge':
          // P3 #22 — manual entity merge tool
          if (req.method === 'POST') {
            try {
              const { canonical_id, duplicate_ids } = body;
              if (!canonical_id || !Array.isArray(duplicate_ids) || !duplicate_ids.length) {
                return jsonResponse(res, { error: 'canonical_id + duplicate_ids[] required' }, 400);
              }
              const canonical = await prisma.entity.findFirst({ where: { id: canonical_id, orgId } });
              if (!canonical) return jsonResponse(res, { error: 'canonical not found' }, 404);
              const dupes = await prisma.entity.findMany({ where: { id: { in: duplicate_ids }, orgId } });
              const aliases = new Set([...(canonical.aliases || [])]);
              let mentionsRepointed = 0;
              for (const d of dupes) {
                aliases.add(d.canonicalName);
                for (const a of d.aliases || []) aliases.add(a);
                const r = await prisma.entityMention.updateMany({ where: { entityId: d.id }, data: { entityId: canonical_id } });
                mentionsRepointed += r.count;
                await prisma.entity.update({
                  where: { id: d.id },
                  data: { isActive: false, mergedFromIds: { push: canonical_id } },
                });
              }
              await prisma.entity.update({
                where: { id: canonical_id },
                data: {
                  aliases: { set: Array.from(aliases).slice(0, 50) },
                  mentionCount: { increment: dupes.reduce((s, d) => s + (d.mentionCount || 0), 0) },
                },
              });
              return jsonResponse(res, { success: true, merged: dupes.length, mentions_repointed: mentionsRepointed });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/admin/contradictions':
          // P3 #23 — review pending Contradicts edges
          if (req.method === 'GET') {
            try {
              const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
              const rows = await prisma.relationship.findMany({
                where: { type: 'Contradicts' },
                orderBy: { createdAt: 'desc' },
                take: limit,
                select: {
                  id: true, fromId: true, toId: true, confidence: true, metadata: true, createdAt: true,
                  fromMemory: { select: { id: true, content: true, orgId: true } },
                  toMemory: { select: { id: true, content: true, orgId: true } },
                },
              });
              const filtered = rows.filter(r => r.fromMemory?.orgId === orgId && r.toMemory?.orgId === orgId);
              return jsonResponse(res, { count: filtered.length, contradictions: filtered });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'DELETE') {
            try {
              const relId = body.id || url.searchParams.get('id');
              if (!relId) return jsonResponse(res, { error: 'id required' }, 400);
              const rel = await prisma.relationship.findUnique({
                where: { id: relId },
                select: { id: true, fromMemory: { select: { orgId: true } } },
              });
              if (!rel || rel.fromMemory?.orgId !== orgId) {
                return jsonResponse(res, { error: 'not found' }, 404);
              }
              await prisma.relationship.delete({ where: { id: relId } });
              return jsonResponse(res, { success: true });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/admin/webhook-subscriptions/health':
          // P3 #19 — webhook subscription health for org
          if (req.method === 'GET') {
            try {
              const subs = await prisma.inboundWebhookSubscription.findMany({
                where: { orgId },
                select: {
                  id: true, providerKey: true, externalId: true, status: true,
                  consecutiveFailures: true, lastEventAt: true, registeredAt: true,
                  _count: { select: { events: true } },
                },
              });
              const stale = subs.filter(s => {
                if (!s.lastEventAt) return false;
                const days = (Date.now() - new Date(s.lastEventAt).getTime()) / 86400000;
                return days > 7;
              });
              const failing = subs.filter(s => s.consecutiveFailures >= 5);
              return jsonResponse(res, { count: subs.length, subscriptions: subs, stale, failing });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/admin/topic-states':
          // P3 #6 — surface rolling topic state summaries
          if (req.method === 'GET') {
            try {
              const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
              const entityType = url.searchParams.get('entity_type') || null;
              const where = { orgId };
              const topics = await prisma.topicState.findMany({
                where,
                orderBy: { lastUpdatedAt: 'desc' },
                take: limit,
                include: entityType ? { entity: { where: { entityType } } } : { entity: true },
              });
              return jsonResponse(res, {
                count: topics.length,
                topics: topics.filter(t => !entityType || t.entity?.entityType === entityType),
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/cognition/status':
          // Read-only — any authenticated caller can see loop health.
          // In-memory _status carries current-process state; cognition_status
          // table carries per-org persistent history that survives restart.
          try {
            const { getCognitionStatus } = await import('./memory/cognition-loop.js');
            const st = getCognitionStatus();
            // Per-org rows: caller's own org first, then top-5 by recent tick.
            let perOrg = [];
            if (prisma?.cognitionStatus) {
              try {
                const rows = await prisma.cognitionStatus.findMany({
                  orderBy: { lastTickAt: 'desc' },
                  take: 20,
                  select: {
                    orgId: true,
                    lastTickAt: true,
                    lastRunMs: true,
                    lastSynthCount: true,
                    lastCompactCount: true,
                    nextTickAt: true,
                    totalTicks: true,
                    totalSynth: true,
                    totalCompact: true,
                    lastError: true,
                    lastErrorAt: true,
                  },
                });
                perOrg = rows;
              } catch (dbErr) {
                console.warn('[/api/cognition/status] db read failed:', dbErr.message);
              }
            }
            // Caller's org-specific row pulled to top of payload.
            const callerOrg = perOrg.find(r => r.orgId === orgId) || null;
            return jsonResponse(res, {
              enabled: COGNITION_LOOP_ENABLED,
              interval_ms: Number(process.env.COGNITION_INTERVAL_MS || 60 * 60 * 1000),
              lookback_hours: Number(process.env.SYNTHESIS_LOOKBACK_HOURS || 24),
              cluster_min: Number(process.env.SYNTHESIS_CLUSTER_MIN || 4),
              cluster_max: Number(process.env.SYNTHESIS_CLUSTER_MAX || 30),
              drift_threshold: Number(process.env.DRIFT_COMPACT_THRESHOLD || 12),
              model: process.env.SYNTHESIS_MODEL || 'llama-3.3-70b-versatile',
              ...st,
              caller_org: callerOrg,
              per_org_recent: perOrg,
            });
          } catch (err) {
            return jsonResponse(res, { error: err.message }, 500);
          }

        case '/api/cognition/recent':
          // Last N synthesis + summary memories the loop produced. Read-only.
          try {
            const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get('limit') || '5', 10)));
            const rows = await prisma.memory.findMany({
              where: {
                orgId,
                memoryType: { in: ['synthesis', 'summary'] },
                deletedAt: null,
              },
              orderBy: { createdAt: 'desc' },
              take: limit,
              select: {
                id: true, title: true, content: true,
                memoryType: true, tags: true, createdAt: true,
              },
            });
            return jsonResponse(res, {
              count: rows.length,
              items: rows.map(r => ({
                id: r.id,
                title: r.title,
                type: r.memoryType,
                preview: (r.content || '').slice(0, 280),
                full_chars: (r.content || '').length,
                tags: r.tags,
                created_at: r.createdAt,
              })),
            });
          } catch (err) {
            console.error('[cognition/recent] failed:', err.message);
            return jsonResponse(res, { error: 'Failed to load recent cognition output' }, 500);
          }

        case '/api/cognition/synthesize-now':
          // Admin-gated manual trigger — runs one tick immediately.
          if (req.method !== 'POST') break;
          try {
            const membership = await prisma.userOrganization.findUnique({
              where: { userId_orgId: { userId, orgId } },
              select: { role: true, roles: true },
            }).catch(() => null);
            const roles = new Set([
              ...(membership?.role ? [membership.role] : []),
              ...(Array.isArray(membership?.roles) ? membership.roles : []),
            ]);
            // Accept both legacy short forms (admin/owner) and the canonical
            // long forms our invite + RBAC layer issues (org_owner/org_admin).
            // Same bug pattern fixed in invites commit a9c61dd — keep these
            // gates in sync until we centralise role parsing.
            const ADMIN_ROLES = ['admin', 'owner', 'org_admin', 'org_owner'];
            const isAdmin = ADMIN_ROLES.some(r => roles.has(r));
            if (!isAdmin && !principal.master) {
              return jsonResponse(res, {
                error: 'admin/owner role required',
                role_seen: Array.from(roles),
              }, 403);
            }
            if (!cognitionLoop) {
              return jsonResponse(res, { error: 'cognition loop not running (set ENABLE_COGNITION_LOOP!=false and ensure prisma is wired)' }, 503);
            }
            // Run inline (await) so we can return the actual synth/compact
            // counts to the FE. Previous fire-and-forget made the button
            // look like a no-op when there were simply no eligible
            // memories — now FE can render "0 new" instead of guessing.
            try {
              const result = await cognitionLoop.runOnce(orgId);
              return jsonResponse(res, {
                triggered: true,
                org_id: orgId,
                synth: result?.synth ?? 0,
                compact: result?.compact ?? 0,
                ms: result?.ms ?? 0,
                skipped: result?.skipped || false,
                reason: result?.reason || null,
              });
            } catch (runErr) {
              console.warn('[cognition] manual run failed:', runErr.message);
              return jsonResponse(res, { error: runErr.message }, 500);
            }
          } catch (err) {
            return jsonResponse(res, { error: err.message }, 500);
          }

        case '/api/synthesis': {
          // GET — browse synthesis memories for the calling user's org.
          // Query params: ?type=canonical-fact|synthesis-bridge|all (default all)
          //               ?limit=50  ?offset=0
          // Returns synthesis memories sorted by revision DESC, confidence DESC, updated_at DESC.
          // Each entry includes top-3 evidence snippets fetched from source memories.
          if (req.method !== 'GET') break;
          try {
            const typeFilter = url.searchParams.get('type') || 'all';
            const limit      = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit')  || '50', 10)));
            const offset     = Math.max(0,              parseInt(url.searchParams.get('offset') || '0',  10));

            // Build tag filter for type
            const tagFilter = typeFilter === 'canonical-fact'
              ? { hasSome: ['synthesis:canonical'] }
              : typeFilter === 'synthesis-bridge'
                ? { hasSome: ['synthesis:bridge'] }
                : { hasSome: ['synthesis:canonical', 'synthesis:bridge'] };

            // Fetch synthesis memories: isLatest=true, clusterHash NOT NULL, tenant-scoped
            const [rows, total] = await Promise.all([
              prisma.memory.findMany({
                where: {
                  orgId,
                  userId,
                  isLatest:  true,
                  deletedAt: null,
                  synthesisClusterHash: { not: null },
                  tags: tagFilter,
                },
                orderBy: [
                  { synthesisRevision:    'desc' },
                  { synthesisConfidence:  'desc' },
                  { updatedAt:            'desc' },
                ],
                take:   limit,
                skip:   offset,
                select: {
                  id: true, title: true, content: true, tags: true,
                  createdAt: true, updatedAt: true,
                  synthesisConfidence: true,
                  synthesisRevision: true,
                  synthesisClusterHash: true,
                  synthesisEvidenceIds: true,
                },
              }),
              prisma.memory.count({
                where: {
                  orgId,
                  userId,
                  isLatest:  true,
                  deletedAt: null,
                  synthesisClusterHash: { not: null },
                  tags: tagFilter,
                },
              }),
            ]);

            // Count by type
            const [canonCount, bridgeCount] = await Promise.all([
              prisma.memory.count({
                where: { orgId, userId, isLatest: true, deletedAt: null,
                  synthesisClusterHash: { not: null }, tags: { hasSome: ['synthesis:canonical'] } },
              }),
              prisma.memory.count({
                where: { orgId, userId, isLatest: true, deletedAt: null,
                  synthesisClusterHash: { not: null }, tags: { hasSome: ['synthesis:bridge'] } },
              }),
            ]);

            // Fetch top-3 evidence snippets for each synthesis memory
            const evidenceCache = new Map();
            const allEvidenceIds = rows.flatMap(r => (r.synthesisEvidenceIds || []).slice(0, 3));
            const uniqueIds = [...new Set(allEvidenceIds)];
            if (uniqueIds.length > 0) {
              const evidenceRows = await prisma.memory.findMany({
                where: { id: { in: uniqueIds }, deletedAt: null },
                select: { id: true, title: true, content: true, createdAt: true },
              });
              for (const ev of evidenceRows) evidenceCache.set(ev.id, ev);
            }

            const getSynthType = (tags) => {
              if ((tags || []).includes('synthesis:canonical')) return 'canonical-fact';
              if ((tags || []).includes('synthesis:bridge'))    return 'synthesis-bridge';
              return 'unknown';
            };

            const synthesis = rows.map(r => {
              const evidenceIds = (r.synthesisEvidenceIds || []).slice(0, 3);
              const evidenceRecent = evidenceIds
                .map(eid => evidenceCache.get(eid))
                .filter(Boolean)
                .map(ev => ({
                  id:         ev.id,
                  title:      ev.title || '',
                  snippet:    (ev.content || '').slice(0, 200),
                  created_at: ev.createdAt,
                }));
              return {
                id:             r.id,
                type:           getSynthType(r.tags),
                claim:          r.content || '',
                confidence:     r.synthesisConfidence ?? null,
                revision:       r.synthesisRevision   ?? 1,
                evidence_count: (r.synthesisEvidenceIds || []).length,
                cluster_hash:   r.synthesisClusterHash,
                created_at:     r.createdAt,
                updated_at:     r.updatedAt,
                evidence_recent: evidenceRecent,
              };
            });

            return jsonResponse(res, {
              synthesis,
              total,
              by_type: {
                'canonical-fact':   canonCount,
                'synthesis-bridge': bridgeCount,
              },
            });
          } catch (err) {
            console.error('[/api/synthesis] failed:', err.message);
            return jsonResponse(res, { error: err.message }, 500);
          }
        }

        case '/api/admin/org/policy': {
          // GET: returns the org's default_project_policy + meta.
          // PUT: admin-only setter (requires org owner/admin role).
          if (req.method === 'GET') {
            try {
              const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: { id: true, name: true, defaultProjectPolicy: true, memorySavePolicy: true },
              });
              if (!org) return jsonResponse(res, { error: 'Org not found' }, 404);
              return jsonResponse(res, {
                org_id: org.id,
                name: org.name,
                // Project-access policy: who gets access when a NEW project is created.
                default_project_policy: org.defaultProjectPolicy,
                default_project_policy_allowed: ['private', 'team_inherited', 'org_visible'],
                default_project_policy_description: {
                  'private': 'Only the creator gets access. Add members manually.',
                  'team_inherited': 'All members of the project\'s team get access on create.',
                  'org_visible': 'Visible to every org member as read-only.',
                },
                // Memory-save policy: where MCP save_memory routes when caller omits project.
                memory_save_policy: org.memorySavePolicy,
                memory_save_policy_allowed: ['private', 'org-wide', 'ask'],
                memory_save_policy_description: {
                  'private': 'Save to caller default project; falls through to org-wide if none.',
                  'org-wide': 'Always saves org-wide unless caller explicitly passes a project.',
                  'ask': 'Server returns a hint asking Claude to pick a project on every save.',
                },
              });
            } catch (err) {
              console.error('[admin/org/policy] GET failed:', err.message);
              return jsonResponse(res, { error: 'Failed to read org policy' }, 500);
            }
          }
          if (req.method === 'PUT') {
            try {
              // Admin gate: must be member with admin/owner role in this org.
              const membership = await prisma.userOrganization.findUnique({
                where: { userId_orgId: { userId, orgId } },
                select: { role: true, roles: true, isActive: true },
              }).catch(() => null);
              const memberRoles = new Set([
                ...(membership?.role ? [membership.role] : []),
                ...(Array.isArray(membership?.roles) ? membership.roles : []),
              ]);
              const isAdmin = membership?.isActive && (memberRoles.has('admin') || memberRoles.has('owner'));
              if (!isAdmin && !principal.master) {
                return jsonResponse(res, { error: 'admin/owner role required' }, 403);
              }
              const PROJ_ALLOWED = ['private', 'team_inherited', 'org_visible'];
              const MEM_ALLOWED  = ['private', 'org-wide', 'ask'];
              const data = {};
              if (body?.default_project_policy !== undefined) {
                const v = String(body.default_project_policy).toLowerCase().trim();
                if (!PROJ_ALLOWED.includes(v)) {
                  return jsonResponse(res, { error: `default_project_policy must be one of ${PROJ_ALLOWED.join(', ')}` }, 400);
                }
                data.defaultProjectPolicy = v;
              }
              if (body?.memory_save_policy !== undefined) {
                const v = String(body.memory_save_policy).toLowerCase().trim();
                if (!MEM_ALLOWED.includes(v)) {
                  return jsonResponse(res, { error: `memory_save_policy must be one of ${MEM_ALLOWED.join(', ')}` }, 400);
                }
                data.memorySavePolicy = v;
              }
              if (Object.keys(data).length === 0) {
                return jsonResponse(res, { error: 'pass default_project_policy and/or memory_save_policy' }, 400);
              }
              const updated = await prisma.organization.update({
                where: { id: orgId },
                data,
                select: { id: true, defaultProjectPolicy: true, memorySavePolicy: true },
              });
              await writeAuditLog(prisma, {
                userId, orgId,
                eventType: 'org_policy_changed',
                action: 'update',
                resourceType: 'organization',
                resourceId: orgId,
                newValue: data,
              }).catch(() => {});
              return jsonResponse(res, {
                org_id: updated.id,
                default_project_policy: updated.defaultProjectPolicy,
                memory_save_policy: updated.memorySavePolicy,
                changed_by: userId,
              });
            } catch (err) {
              console.error('[admin/org/policy] PUT failed:', err.message);
              return jsonResponse(res, { error: 'Failed to update org policy' }, 500);
            }
          }
          break;
        }

        case '/api/admin/webhook-events/dead-letter':
          // P2 #25 — list webhook events that failed processing (admin)
          if (req.method === 'GET') {
            try {
              const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
              const status = url.searchParams.get('status') || 'failed';
              const events = await prisma.inboundWebhookEvent.findMany({
                where: { orgId, status },
                orderBy: { receivedAt: 'desc' },
                take: limit,
                select: {
                  id: true, providerKey: true, eventId: true, eventType: true,
                  status: true, attempts: true, error: true, receivedAt: true, processedAt: true,
                },
              });
              return jsonResponse(res, { count: events.length, events });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'POST') {
            // Retry a dead-lettered event: reset status to 'received' for processor pickup
            try {
              const eventId = body.event_id;
              if (!eventId) return jsonResponse(res, { error: 'event_id required' }, 400);
              const updated = await prisma.inboundWebhookEvent.updateMany({
                where: { id: eventId, orgId, status: { in: ['failed', 'dead_lettered'] } },
                data: { status: 'received', attempts: 0, error: null },
              });
              return jsonResponse(res, { success: true, requeued: updated.count });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/evidence-resync':
          // P1 #1.7 — manual bulk resync via adapter.fetchBulk into evidence-first pipeline
          if (req.method === 'POST') {
            if (!documentFirstIngestion) {
              return jsonResponse(res, { error: 'Document-first ingestion not enabled' }, 503);
            }
            try {
              const providerKey = body.provider_key || body.provider;
              const targetUserId = body.user_id || userId;
              const targetOrgId = body.org_id || orgId;
              const limit = Math.min(Number(body.limit || 50), 200);
              const scope = body.scope || {};
              const cursor = body.cursor || null;
              if (!providerKey) {
                return jsonResponse(res, { error: 'provider_key required' }, 400);
              }
              const { default: adapterRegistry } = await import('./connectors/framework/adapter-registry.js');
              const AdapterClass = adapterRegistry.get(providerKey);
              if (!AdapterClass) {
                return jsonResponse(res, { error: `unknown provider ${providerKey}` }, 404);
              }
              const adapter = adapterRegistry.instantiate(providerKey, {
                providerKey,
                tokenResolver: async ({ userId: u, orgId: o, providerKey: p }) => {
                  const { getConnectionId, fetchBearerFromNango } = await import('./connectors/mcp/nango-service.js');
                  const connId = await getConnectionId({ userId: u, orgId: o, providerKey: p }, { db: prisma });
                  if (!connId) throw new Error(`no nango connection for ${p}`);
                  return fetchBearerFromNango(p, connId);
                },
                prisma,
                logger: console,
              });
              if (typeof adapter.fetchBulk !== 'function') {
                return jsonResponse(res, { error: `${providerKey} adapter has no fetchBulk` }, 400);
              }
              const { records, nextCursor } = await adapter.fetchBulk({ userId: targetUserId, orgId: targetOrgId, cursor, scope, limit });
              const ingested = [];
              for (const rec of records) {
                const content = rec.content || rec.body || rec.text || null;
                if (!content) continue;
                try {
                  const result = await documentFirstIngestion.ingestConnectorRecord({
                    userId: targetUserId,
                    orgId: targetOrgId,
                    providerKey,
                    sourceId: String(rec.resource_id || rec.id || `${providerKey}-${Date.now()}-${Math.random()}`),
                    title: rec.title || null,
                    content,
                    sourceUrl: rec.refs?.url || null,
                    documentDate: rec.ts ? new Date(rec.ts) : null,
                    metadata: { resource_type: rec.resource_type, refs: rec.refs || null },
                  });
                  ingested.push({ resource_id: rec.resource_id, ...result });
                } catch (e) {
                  ingested.push({ resource_id: rec.resource_id, error: e.message });
                }
              }
              return jsonResponse(res, { success: true, processed: records.length, ingested, nextCursor }, 200);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/connectors/mcp/ingest':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/connectors/mcp/ingest')) {
              return;
            }
            try {
              const result = await mcpIngestionService.ingestFromEndpoint({
                endpoint_name: body.endpoint_name,
                operation: body.operation,
                adapter: body.adapter,
                project: body.project || null,
                tags: body.tags || [],
                relationship: body.relationship || null,
                user_id: userId,
                org_id: orgId
              });
              return jsonResponse(res, { success: true, ...result }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 400);
            }
          }
          break;

        // ==========================================
        // GMAIL OAUTH FLOW
        // ==========================================

        case '/api/connectors/gmail/connect':
          if (req.method === 'GET') {
            const { buildAuthUrl, AVAILABLE_SERVICES } = await import('./connectors/providers/gmail/oauth.js');
            const gmailRedirectUri = `${process.env.HIVEMIND_BASE_URL || getHostedApiBaseUrl(req)}/api/connectors/gmail/callback`;
            const targetScope = url.searchParams.get('target_scope') === 'organization' ? 'organization' : 'personal';

            // Services opt-in: ?services=gmail,drive,calendar,docs
            // Default to all available (full Workspace) for new connections.
            const requestedServices = (url.searchParams.get('services') || AVAILABLE_SERVICES.join(','))
              .split(',')
              .map(s => s.trim().toLowerCase())
              .filter(s => AVAILABLE_SERVICES.includes(s));
            const services = requestedServices.length > 0 ? requestedServices : ['gmail'];

            const gmailState = Buffer.from(JSON.stringify({ userId, orgId, targetScope, services })).toString('base64url');
            const authorizationUrl = buildAuthUrl({ redirectUri: gmailRedirectUri, state: gmailState, services });
            return jsonResponse(res, {
              url: authorizationUrl,
              redirect_uri: gmailRedirectUri,
              services_requested: services,
              available_services: AVAILABLE_SERVICES,
            });
          }
          break;

        case '/api/connectors/gmail/callback':
          if (req.method === 'GET') {
            const callbackCode = url.searchParams.get('code');
            const callbackState = url.searchParams.get('state');
            const callbackError = url.searchParams.get('error');

            if (callbackError) {
              res.writeHead(302, { Location: `${process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu'}/hivemind/app/connectors?error=${encodeURIComponent(callbackError)}` });
              res.end();
              return;
            }

            if (!callbackCode) {
              return jsonResponse(res, { error: 'Missing authorization code' }, 400);
            }

            try {
              // Parse state to get userId/orgId
              let stateUserId = userId, stateOrgId = orgId, stateTargetScope = 'personal';
              if (callbackState) {
                try {
                  const parsed = JSON.parse(Buffer.from(callbackState, 'base64url').toString());
                  stateUserId = parsed.userId || stateUserId;
                  stateOrgId = parsed.orgId || stateOrgId;
                  stateTargetScope = parsed.targetScope === 'organization' ? 'organization' : 'personal';
                } catch {}
              }

              const { exchangeCode } = await import('./connectors/providers/gmail/oauth.js');
              const gmailCallbackUri = `${process.env.HIVEMIND_BASE_URL || getHostedApiBaseUrl(req)}/api/connectors/gmail/callback`;
              const tokens = await exchangeCode({ code: callbackCode, redirectUri: gmailCallbackUri });

              // Store connection via ConnectorStore — ONE ROW PER GRANTED SERVICE
              // so user can disconnect any service independently (Drive without
              // losing Gmail, etc.). All rows share the same Google token because
              // the OAuth grant is single — but stored under per-service provider.
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const connStore = new ConnectorStore(prisma);

              const tokenExpiresAt = tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000)
                : null;

              const grantedScopes = (tokens.scope || '').split(' ').filter(Boolean);

              // Map each granted scope to the service it represents
              // CANONICAL provider key form is hyphen (`google-drive`) to match
              // the connector catalog + /api/connectors/status lookups.
              // Underscore form (`google_drive`) was an older variant that
              // caused split-brain rows. Don't reintroduce it.
              const SCOPE_TO_SERVICE = {
                'https://www.googleapis.com/auth/gmail.readonly':         'gmail',
                'https://www.googleapis.com/auth/gmail.modify':           'gmail',
                'https://www.googleapis.com/auth/drive.readonly':         'google-drive',
                'https://www.googleapis.com/auth/drive':                  'google-drive',
                'https://www.googleapis.com/auth/calendar.readonly':      'google-calendar',
                'https://www.googleapis.com/auth/calendar':               'google-calendar',
                'https://www.googleapis.com/auth/documents.readonly':     'google-docs',
                'https://www.googleapis.com/auth/documents':              'google-docs',
                'https://www.googleapis.com/auth/spreadsheets.readonly':  'google-sheets',
                'https://www.googleapis.com/auth/spreadsheets':           'google-sheets',
                'https://www.googleapis.com/auth/presentations.readonly': 'google-slides',
                'https://www.googleapis.com/auth/presentations':          'google-slides',
                'https://www.googleapis.com/auth/contacts.readonly':      'google-contacts',
                'https://www.googleapis.com/auth/contacts':               'google-contacts',
                'https://www.googleapis.com/auth/chat.messages.readonly': 'google-chat',
                'https://www.googleapis.com/auth/tasks.readonly':         'google-tasks',
                'https://www.googleapis.com/auth/tasks':                  'google-tasks',
                'https://www.googleapis.com/auth/forms.body.readonly':    'google-forms',
              };

              const grantedServices = [...new Set(
                grantedScopes.map(s => SCOPE_TO_SERVICE[s]).filter(Boolean)
              )];

              // Intersect with services the user actually REQUESTED in this
              // OAuth round (parsed from state.services). Defends against
              // Google echoing previously-authorized scopes — without this,
              // clicking "Connect Gmail" after a prior Drive/Calendar grant
              // would create rows for everything.
              let requestedServices = null;
              if (callbackState) {
                try {
                  const parsedState = JSON.parse(Buffer.from(callbackState, 'base64url').toString());
                  if (Array.isArray(parsedState.services) && parsedState.services.length > 0) {
                    // state uses short names ('gmail','drive','calendar') —
                    // SCOPE_TO_SERVICE produces canonical ('google_drive', …).
                    const SHORT_TO_CANON = {
                      gmail: 'gmail',
                      drive: 'google_drive',
                      calendar: 'google_calendar',
                      docs: 'google_docs',
                      sheets: 'google_sheets',
                      slides: 'google_slides',
                      contacts: 'google_contacts',
                      chat: 'google_chat',
                      tasks: 'google_tasks',
                      forms: 'google_forms',
                    };
                    requestedServices = new Set(parsedState.services
                      .map(s => SHORT_TO_CANON[String(s).toLowerCase()])
                      .filter(Boolean));
                  }
                } catch { /* state parse already happened above */ }
              }
              const filteredServices = requestedServices
                ? grantedServices.filter(s => requestedServices.has(s))
                : grantedServices;
              if (filteredServices.length === 0) filteredServices.push('gmail');
              // Replace grantedServices with filtered set for downstream upsert
              grantedServices.length = 0;
              grantedServices.push(...filteredServices);

              // Per-service upsert — same token shared across all rows
              for (const service of grantedServices) {
                await connStore.upsertConnector({
                  userId: stateUserId,
                  provider: service,
                  targetScope: stateTargetScope,
                  accountRef: tokens.email || null,
                  accessToken: tokens.access_token,
                  refreshToken: tokens.refresh_token,
                  tokenExpiresAt,
                  scopes: grantedScopes,
                  metadata: {
                    email: tokens.email,
                    google_account: tokens.email,
                    primary_provider: 'gmail',
                    granted_services: grantedServices,
                  },
                });
              }

              console.log(`[google-oauth] Connected user=${stateUserId} email=${tokens.email} services=[${grantedServices.join(', ')}]`);

              // Auto-register Pub/Sub watch if topic configured. Non-fatal on failure —
              // user can still use polling-based sync. Skipped if scopes don't include
              // gmail.modify (watch requires write tier).
              if (process.env.GCP_PUBSUB_TOPIC) {
                const grantedScopes = (tokens.scope || '').split(' ');
                if (grantedScopes.includes('https://www.googleapis.com/auth/gmail.modify')) {
                  try {
                    const { registerWatch } = await import('./connectors/providers/gmail/gmail-watch.js');
                    const watch = await registerWatch({
                      accessToken: tokens.access_token,
                      topicName: process.env.GCP_PUBSUB_TOPIC,
                    });
                    await connStore.updateMetadata(stateUserId, 'gmail', { watch });
                    console.log(`[gmail-oauth] Watch registered for ${tokens.email} expires=${new Date(watch.expirationMs).toISOString()}`);
                  } catch (watchErr) {
                    console.warn(`[gmail-oauth] Watch registration failed (non-fatal): ${watchErr.message}`);
                  }
                } else {
                  console.log(`[gmail-oauth] Skipping watch — gmail.modify scope not granted (only got: ${tokens.scope})`);
                }
              }

              const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
              res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?connected=gmail&needs_config=true&email=${encodeURIComponent(tokens.email || '')}&target_scope=${encodeURIComponent(stateTargetScope)}` });
              res.end();
              return;
            } catch (err) {
              console.error('[gmail-oauth] Callback failed:', err.message);
              const frontendUrl = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
              res.writeHead(302, { Location: `${frontendUrl}/hivemind/app/connectors?error=${encodeURIComponent(err.message)}` });
              res.end();
              return;
            }
          }
          break;

        // ==========================================
        // NANGO CONNECT SESSION (OAuth popup trigger)
        // POST /api/connectors/connect-session
        // Body: { connector_id: string, allowed_integrations?: string[] }
        // Returns: { connect_session_token: string }
        // ==========================================
        case '/api/connectors/connect-session':
          if (req.method === 'POST') {
            try {
              const { createConnectSession: createNangoConnectSession } = await import('./connectors/mcp/nango-service.js');
              const connectorId = body.connector_id;
              if (!connectorId) {
                return jsonResponse(res, { error: 'connector_id is required' }, 400);
              }

              // Resolve which Nango provider this connector maps to.
              // Accept either the catalog name (e.g. "slack-live") OR the
              // FE-facing id / nango_provider (e.g. "slack") — list-and-find
              // covers all three so the FE doesn't need to know the catalog
              // naming scheme.
              const scope = { user_id: userId, org_id: orgId };
              let endpoint = mcpIngestionService.registry.get(connectorId, scope);
              if (!endpoint) {
                const all = mcpIngestionService.registry.list(scope);
                endpoint = all.find(e =>
                  e.name === connectorId ||
                  e.nango_provider === connectorId ||
                  e.name === `${connectorId}-live` ||
                  e.name === `${connectorId}-ingestion`
                ) || null;
              }
              if (!endpoint) {
                return jsonResponse(res, { error: `Unknown connector: ${connectorId}` }, 404);
              }
              const nangoProvider = endpoint.nango_provider;
              if (!nangoProvider) {
                return jsonResponse(res, { error: `Connector ${connectorId} does not use Nango auth` }, 400);
              }

              const allowedIntegrations = body.allowed_integrations || [nangoProvider];
              const token = await createNangoConnectSession({
                userId,
                orgId,
                allowedIntegrations,
              });

              const publicNangoHost =
                process.env.NANGO_PUBLIC_URL ||
                process.env.NANGO_BROWSER_URL ||
                (process.env.NODE_ENV === 'production'
                  ? 'https://api.hivemind.davinciai.eu:8042'
                  : null);

              return jsonResponse(res, {
                connect_session_token: token,
                provider: nangoProvider,
                ...(publicNangoHost ? { host: publicNangoHost } : {}),
              });
            } catch (err) {
              console.error('[nango-connect-session] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // NANGO CONNECTION FINALIZE (after OAuth success)
        // POST /api/connectors/:id/connect
        // Body: { connection_id: string, provider_key: string }
        // ==========================================
        case '/api/connectors/connect':
          if (req.method === 'POST') {
            try {
              const providerKey = body.provider_key;
              const connectionId = body.connection_id;
              const targetScope = body.target_scope || 'personal';
              const teamId = body.team_id || null;
              if (!providerKey || !connectionId) {
                return jsonResponse(res, { error: 'provider_key and connection_id are required' }, 400);
              }

              if (!prisma) {
                return jsonResponse(res, { error: 'Database unavailable' }, 503);
              }

              await prisma.nangoConnection.upsert({
                where: {
                  userId_providerKey_orgId: {
                    userId,
                    providerKey,
                    orgId,
                  },
                },
                create: {
                  userId,
                  orgId,
                  providerKey,
                  connectionId,
                  status: 'active',
                },
                update: {
                  connectionId,
                  status: 'active',
                  updatedAt: new Date(),
                  metadata: { last_connected_via: 'connect-ui' },
                },
              });

              await prisma.platformIntegration.upsert({
                where: {
                  userId_platformType: {
                    userId,
                    platformType: providerKey,
                  },
                },
                create: {
                  userId,
                  platformType: providerKey,
                  authType: 'oauth2',
                  oauthScopes: [],
                  oauthGrantedAt: new Date(),
                  oauthLastRefreshed: new Date(),
                  isActive: true,
                  syncStatus: 'idle',
                  targetScope,
                  teamId,
                  connectorMetadata: {
                    nango: {
                      connection_id: connectionId,
                      provider_key: providerKey,
                    },
                  },
                },
                update: {
                  authType: 'oauth2',
                  isActive: true,
                  syncStatus: 'idle',
                  targetScope,
                  teamId,
                  oauthLastRefreshed: new Date(),
                  connectorMetadata: {
                    nango: {
                      connection_id: connectionId,
                      provider_key: providerKey,
                    },
                    last_connected_via: 'connect-ui',
                  },
                },
              });

              try {
                const { default: adapterRegistry } = await import('./connectors/framework/adapter-registry.js');
                const providerModuleMap = {
                  notion: './connectors/adapters/notion/notion-adapter.js',
                  slack: './connectors/adapters/slack/slack-adapter.js',
                  github: './connectors/adapters/github/github-adapter.js',
                  linear: './connectors/adapters/linear/linear-adapter.js',
                  jira: './connectors/adapters/jira/jira-adapter.js',
                  confluence: './connectors/adapters/confluence/confluence-adapter.js',
                };
                if (providerModuleMap[providerKey]) {
                  await import(providerModuleMap[providerKey]);
                }

                const AdapterClass = adapterRegistry.get(providerKey);
                if (AdapterClass) {
                  const adapter = adapterRegistry.instantiate(providerKey, {
                    providerKey,
                    tokenResolver: nangoTokenResolver,
                    prisma,
                    logger: console,
                  });

                  const publicBaseUrl =
                    process.env.HIVEMIND_PUBLIC_URL ||
                    process.env.PUBLIC_API_URL ||
                    process.env.API_BASE_URL ||
                    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

                  const webhook = await adapter.registerWebhook({
                    userId,
                    orgId,
                    callbackUrl: `${publicBaseUrl}/webhooks/${providerKey}`,
                    secret: crypto.randomUUID().replace(/-/g, ''),
                  }).catch((err) => {
                    if (err?.code === 'not_supported') return null;
                    throw err;
                  });

                  if (webhook?.externalId) {
                    await prisma.inboundWebhookSubscription.upsert({
                      where: {
                        orgId_providerKey_externalId: {
                          orgId,
                          providerKey,
                          externalId: String(webhook.externalId),
                        },
                      },
                      create: {
                        userId,
                        orgId,
                        providerKey,
                        externalId: String(webhook.externalId),
                        webhookSecretEncrypted: webhook.secret ? encryptToken(webhook.secret) : null,
                        eventTypes: webhook.eventTypes || ['*'],
                        webhookUrl: `${publicBaseUrl}/webhooks/${providerKey}`,
                        status: 'active',
                      },
                      update: {
                        webhookSecretEncrypted: webhook.secret ? encryptToken(webhook.secret) : undefined,
                        eventTypes: webhook.eventTypes || ['*'],
                        webhookUrl: `${publicBaseUrl}/webhooks/${providerKey}`,
                        status: 'active',
                      },
                    });
                  }
                }
              } catch (webhookErr) {
                console.warn(`[nango-connect] Webhook registration skipped for ${providerKey}: ${webhookErr.message}`);
              }

              return jsonResponse(res, {
                success: true,
                provider: providerKey,
                status: 'active',
              }, 201);
            } catch (err) {
              console.error('[nango-connect] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/google/sync':
          // POST { provider, config }
          //   provider: 'gmail' | 'google_drive' | 'google_calendar' |
          //             'google_docs' | 'google_sheets' | 'google_slides' |
          //             'google_contacts' | 'google_tasks'
          //   config: per-service config object (see SERVICE_CONFIG_SCHEMAS on FE)
          //
          // Persists config to connectorMetadata + triggers initial sync via
          // the matching adapter through SyncEngine.
          if (req.method === 'POST') {
            try {
              const { provider, config = {} } = body;
              if (!provider) return jsonResponse(res, { error: 'provider required' }, 400);

              const validProviders = [
                'gmail', 'google_drive', 'google_calendar', 'google_docs',
                'google_sheets', 'google_slides', 'google_contacts',
                'google_chat', 'google_tasks', 'google_forms',
              ];
              if (!validProviders.includes(provider)) {
                return jsonResponse(res, { error: `Invalid provider: ${provider}` }, 400);
              }

              // 1. Persist config to connectorMetadata.sync_config
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const cs = new ConnectorStore(prisma);
              await cs.updateMetadata(userId, provider, { sync_config: config });

              // 2. Detect Nango connection — prefer the Nango-routed adapter
              //    whenever the user has a live Nango connection for the
              //    matching provider key. This bypasses the legacy
              //    workspace-mcp sidecar (taylorwilsdon/google_workspace_mcp)
              //    which has caused intermittent token-refresh + scope errors.
              //
              //    Map UI provider name (gmail / google_docs / google_drive ...)
              //    to the Nango providerConfigKey set up in the dashboard.
              // Maps UI provider name → Nango unique_key (the value in
              // _nango_configs.unique_key — set when integration registered
              // in Nango dashboard). Mismatch here = "Integration does not
              // exist" 400 on /connect/sessions.
              const NANGO_PROVIDER_MAP = {
                gmail: 'gmail',
                google_docs: 'google-docs',
                google_gemini: 'google-gemini',
                // Below await Nango dashboard registration — currently unmapped.
                google_drive: 'google-drive',
                google_calendar: 'google-calendar',
                google_contacts: 'google-contacts',
                google_sheets: 'google-sheets',
                google_slides: 'google-slides',
                google_tasks: 'google-tasks',
                google_chat: 'google-chat',
                google_forms: 'google-forms',
              };
              const nangoProviderKey = NANGO_PROVIDER_MAP[provider] || null;
              let nangoActive = false;
              if (nangoProviderKey && prisma?.nangoConnection) {
                try {
                  const nrow = await prisma.nangoConnection.findFirst({
                    where: { userId, providerKey: nangoProviderKey, status: 'active' },
                    select: { id: true },
                  });
                  nangoActive = !!nrow;
                } catch {}
              }

              // 2a. Gmail — when Nango is connected use the Nango-routed
              //     GmailAdapter; otherwise fall through to the legacy
              //     /api/connectors/gmail/sync (Pub/Sub + watch) path.
              if (provider === 'gmail' && nangoActive) {
                console.log(`[google-sync] gmail: routing through Nango (provider=google-mail)`);
                try {
                  const { GmailAdapter } = await import('./connectors/providers/gmail/adapter.js');
                  const adapter = new GmailAdapter();
                  const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
                  const engine = new SyncEngine({
                    connectorStore: cs,
                    memoryStore: persistentMemoryStore,
                    memoryEngine: persistentMemoryEngine,
                    smartIngestRouter,
                    externalRefStore,
                    entityResolver,
                  });
                  const result = await engine.runSync({
                    adapter, userId, orgId, provider: nangoProviderKey, mode: 'incremental',
                  });
                  return jsonResponse(res, { success: true, provider, via: 'nango', result });
                } catch (err) {
                  console.warn(`[google-sync] nango gmail failed: ${err.message}`);
                  return jsonResponse(res, { error: err.message, via: 'nango' }, 500);
                }
              }
              if (provider === 'gmail') {
                // Defer to existing Gmail sync handler logic (legacy)
                console.log(`[google-sync] gmail config saved, advise user to use /api/connectors/gmail/sync for run (no Nango connection)`);
                return jsonResponse(res, {
                  success: true,
                  provider,
                  config_saved: true,
                  note: 'Gmail uses dedicated sync endpoint — call /api/connectors/gmail/sync to trigger (no Nango connection)',
                });
              }

              // 2b. Google Docs — when Nango is connected use Nango-routed
              //     GoogleDocsAdapter. Legacy drive-docs-adapter only fires
              //     if Nango isn't connected.
              if (provider === 'google_docs' && nangoActive) {
                console.log(`[google-sync] google_docs: routing through Nango`);
                try {
                  const { GoogleDocsAdapter } = await import('./connectors/providers/gdocs/adapter.js');
                  const adapter = new GoogleDocsAdapter();
                  const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
                  const engine = new SyncEngine({
                    connectorStore: cs,
                    memoryStore: persistentMemoryStore,
                    memoryEngine: persistentMemoryEngine,
                    smartIngestRouter,
                    externalRefStore,
                    entityResolver,
                  });
                  const result = await engine.runSync({
                    adapter, userId, orgId, provider: nangoProviderKey, mode: 'incremental',
                  });
                  return jsonResponse(res, { success: true, provider, via: 'nango', result });
                } catch (err) {
                  console.warn(`[google-sync] nango gdocs failed: ${err.message}`);
                  return jsonResponse(res, { error: err.message, via: 'nango' }, 500);
                }
              }

              // 3. For new providers, dispatch via SyncEngine + adapter
              //    (LEGACY workspace-mcp path — only reached when no Nango
              //    connection exists for the matched Google provider key).
              if (nangoActive) {
                console.log(`[google-sync] ${provider}: Nango connection live but no Nango-native adapter — falling back to workspace-mcp`);
              }
              const adapterModule = await (async () => {
                if (provider.startsWith('google_drive') || provider === 'google_docs' || provider === 'google_sheets' || provider === 'google_slides') {
                  return import('./connectors/providers/google/drive-docs-adapter.js');
                }
                if (provider === 'google_calendar') {
                  return import('./connectors/providers/google/calendar-adapter.js');
                }
                if (provider === 'google_contacts') {
                  return import('./connectors/providers/google/contacts-adapter.js');
                }
                return null;
              })();

              if (!adapterModule) {
                // Live-only services (tasks/chat/forms/slides/sheets) — no sync,
                // they're queried on-demand via live-query-router
                console.log(`[google-sync] ${provider} is live-only, config saved but no scheduled sync`);
                return jsonResponse(res, {
                  success: true,
                  provider,
                  config_saved: true,
                  mode: 'live-only',
                  note: `${provider} is queried live on demand; no background sync runs.`,
                });
              }

              const AdapterClass = adapterModule.default
                || Object.values(adapterModule).find(v => typeof v === 'function');

              const { decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
              const adapter = new AdapterClass({
                prisma,
                decryptToken,
                refreshOAuthToken: refreshOAuthToken || null,
              });

              // Fire off background sync — don't block FE
              (async () => {
                try {
                  const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
                  const engine = new SyncEngine({
                    connectorStore: cs,
                    memoryStore: persistentMemoryStore,
                    memoryEngine: persistentMemoryEngine,
                    prisma,
                    smartIngestRouter,
                    externalRefStore,
                    entityResolver,
                  });
                  await engine.runSync({
                    adapter,
                    userId,
                    orgId,
                    provider,
                    incremental: false,
                    targetScope: 'personal',
                  });
                  console.log(`[google-sync] ${provider} initial sync complete`);
                } catch (syncErr) {
                  console.warn(`[google-sync] ${provider} sync failed: ${syncErr.message}`);
                }
              })();

              return jsonResponse(res, {
                success: true,
                provider,
                config_saved: true,
                sync_started: true,
                message: `Sync started in background for ${provider}. Check status for progress.`,
              });
            } catch (err) {
              console.error('[google-sync] failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/google/status':
          // Returns ALL Google service connections for current user.
          // Lets FE render per-service tiles with connected/disconnect status.
          if (req.method === 'GET') {
            try {
              const services = ['gmail', 'google_drive', 'google_calendar', 'google_docs', 'google_sheets', 'google_slides', 'google_contacts', 'google_chat', 'google_tasks', 'google_forms'];
              const rows = await prisma.platformIntegration.findMany({
                where: { userId, platformType: { in: services } },
                select: {
                  platformType: true,
                  syncStatus: true,
                  isActive: true,
                  lastSyncedAt: true,
                  syncIntervalMinutes: true,
                  oauthScopes: true,
                  connectorMetadata: true,
                  createdAt: true,
                },
              });

              const map = {};
              for (const r of rows) {
                map[r.platformType] = {
                  connected: r.isActive && r.syncStatus !== 'revoked',
                  status: r.syncStatus,
                  email: r.connectorMetadata?.email || null,
                  last_synced_at: r.lastSyncedAt,
                  sync_interval_minutes: r.syncIntervalMinutes,
                  connected_at: r.createdAt,
                  scopes_count: r.oauthScopes?.length || 0,
                };
              }

              // Group: same Google account → one "session", multiple services
              const primaryEmail = Object.values(map).map(s => s.email).find(Boolean);
              return jsonResponse(res, {
                google_account: primaryEmail,
                services: services.map(s => ({
                  provider: s,
                  ...(map[s] || { connected: false, status: null }),
                })),
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/google/disconnect':
          // POST { provider: 'google_drive' }  → revoke one service
          // POST { provider: 'all' }           → revoke entire Google account
          if (req.method === 'POST') {
            try {
              const targetProvider = body.provider;
              if (!targetProvider) {
                return jsonResponse(res, { error: 'provider required (or "all")' }, 400);
              }

              const services = ['gmail', 'google_drive', 'google_calendar', 'google_docs', 'google_sheets', 'google_slides', 'google_contacts', 'google_chat', 'google_tasks', 'google_forms'];
              const toRevoke = targetProvider === 'all' ? services : [targetProvider];

              const result = await prisma.platformIntegration.updateMany({
                where: { userId, platformType: { in: toRevoke } },
                data: { syncStatus: 'revoked', isActive: false },
              });

              console.log(`[google-disconnect] user=${userId} revoked=${toRevoke.join(',')} count=${result.count}`);
              return jsonResponse(res, {
                success: true,
                revoked: toRevoke,
                count: result.count,
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/status':
          if (req.method === 'GET') {
            try {
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const statusStore = new ConnectorStore(prisma);
              const connection = await statusStore.getConnector(userId, 'gmail');
              if (!connection) {
                return jsonResponse(res, { connected: false });
              }
              return jsonResponse(res, {
                connected: true,
                email: connection.account_ref,
                status: connection.status,
                target_scope: connection.target_scope,
                last_synced: connection.last_sync_at,
                last_error: connection.last_error,
              });
            } catch (err) {
              return jsonResponse(res, { connected: false, error: err.message });
            }
          }
          break;

        case '/api/connectors/gmail/disconnect':
          if (req.method === 'POST') {
            try {
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const dcStore = new ConnectorStore(prisma);
              await dcStore.disconnect(userId, 'gmail');
              return jsonResponse(res, { disconnected: true });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // Gmail sync settings + trigger
        // ──────────────────────────────────────────────────────────
        // POST /api/connectors/gmail/flush — nuke all Gmail-sourced
        // memories for the current user. One-shot cleanup for users
        // whose graph got polluted by an over-eager initial sync.
        // Soft-deletes via deletedAt so a recovery path exists.
        // ──────────────────────────────────────────────────────────
        // ──────────────────────────────────────────────────────────
        // POST /api/connectors/gmail/preview — dry-run fetch.
        // Applies the user's sync config to the Gmail query, returns
        // a preview list of threads (subject, from, to, date, snippet,
        // labels) WITHOUT writing anything to memory. The frontend
        // uses this to render an approval modal so users can hand-pick
        // which threads actually get ingested via /ingest below.
        //
        // body: { date_range, folders, exclude_categories,
        //         include_only_sent, include_keywords, exclude_keywords,
        //         max_emails, page_token? }
        // returns: { previews: [...], next_page_token, query }
        // ──────────────────────────────────────────────────────────
        case '/api/connectors/gmail/preview':
          if (req.method === 'POST') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const store = new ConnectorStore(prisma);
              const token = await store.getAccessToken(userId, 'gmail').catch(() => null);
              if (!token) return jsonResponse(res, { error: 'Gmail not connected' }, 412);

              const { GmailAdapter } = await import('./connectors/providers/gmail/adapter.js');
              const adapter = new GmailAdapter();
              const config = {
                date_range: body.date_range || '30d',
                folders: Array.isArray(body.folders) ? body.folders : ['INBOX'],
                exclude_categories: Array.isArray(body.exclude_categories) ? body.exclude_categories : [],
                include_only_sent: !!body.include_only_sent,
                include_keywords: Array.isArray(body.include_keywords) ? body.include_keywords : [],
                exclude_keywords: Array.isArray(body.exclude_keywords) ? body.exclude_keywords : [],
                exclude_chats: body.exclude_chats !== false,
                include_only_with_attachments: !!body.include_only_with_attachments,
              };
              const q = adapter._buildGmailQuery(config);
              const maxResults = Math.min(parseInt(body.max_emails, 10) || 50, 200);
              const buildParams = (useQ) => {
                const p = new URLSearchParams({ maxResults: String(maxResults) });
                if (useQ && q) p.set('q', q);
                if (body.page_token) p.set('pageToken', body.page_token);
                if (Array.isArray(config.folders)) {
                  config.folders.forEach((f) => p.append('labelIds', String(f).toUpperCase()));
                }
                return p;
              };
              // List + metadata-only fetch for each thread (no full body).
              // Gracefully degrade: if Gmail integration has only metadata
              // scope (gmail.metadata), the q parameter triggers
              // 403 "Metadata scope does not support 'q' parameter".
              // Retry without q so users see SOMETHING instead of 500.
              let listRes;
              let scopeLimited = false;
              try {
                listRes = await adapter._gmailFetch(`/threads?${buildParams(true)}`, token);
              } catch (err) {
                if (/Metadata scope does not support 'q' parameter/i.test(String(err.message))) {
                  scopeLimited = true;
                  listRes = await adapter._gmailFetch(`/threads?${buildParams(false)}`, token);
                } else {
                  throw err;
                }
              }
              const threadStubs = listRes.threads || [];
              const previews = [];
              await Promise.all(threadStubs.slice(0, maxResults).map(async (stub) => {
                try {
                  const t = await adapter._gmailFetch(`/threads/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token);
                  const msgs = t.messages || [];
                  if (msgs.length === 0) return;
                  const first = msgs[0];
                  const last = msgs[msgs.length - 1];
                  const header = (m, name) => {
                    const h = (m?.payload?.headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
                    return h ? h.value : null;
                  };
                  previews.push({
                    thread_id: t.id,
                    subject: header(first, 'Subject') || '(no subject)',
                    from: header(first, 'From'),
                    to: header(first, 'To'),
                    date: header(last, 'Date'),
                    message_count: msgs.length,
                    snippet: t.snippet || first.snippet || '',
                    labels: t.messages?.[0]?.labelIds || [],
                  });
                } catch { /* skip thread on error */ }
              }));
              return jsonResponse(res, {
                ok: true,
                previews,
                next_page_token: listRes.nextPageToken || null,
                query: q,
                applied_config: config,
                scope_limited: scopeLimited,
                ...(scopeLimited ? {
                  notice: 'Gmail integration is metadata-only — widen Nango scopes to gmail.readonly to use search query (q) + body retrieval.',
                } : {}),
              });
            } catch (err) {
              console.error('[gmail-preview] error:', err);
              const isScope = /Metadata scope|insufficient.*scope|insufficientPermissions|PERMISSION_DENIED/i.test(String(err.message));
              return jsonResponse(res, {
                error: err.message,
                scope_issue: isScope || undefined,
                hint: isScope ? 'Widen Nango Gmail scopes (gmail.readonly + gmail.send + gmail.modify), then reconnect.' : undefined,
              }, isScope ? 403 : 500);
            }
          }
          break;

        // ──────────────────────────────────────────────────────────
        // POST /api/connectors/gmail/ingest-selected
        // Ingest ONLY the thread_ids the user approved in the preview.
        // body: { thread_ids: [...], thread_mode?: 'thread'|'message' }
        // ──────────────────────────────────────────────────────────
        case '/api/connectors/gmail/ingest-selected':
          if (req.method === 'POST') {
            if (!prisma || !persistentMemoryEngine) {
              return jsonResponse(res, { error: 'service unavailable' }, 503);
            }
            const threadIds = Array.isArray(body.thread_ids) ? body.thread_ids : [];
            if (threadIds.length === 0) {
              return jsonResponse(res, { error: 'thread_ids required' }, 400);
            }
            if (threadIds.length > 500) {
              return jsonResponse(res, { error: 'max 500 threads per call' }, 400);
            }
            try {
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const store = new ConnectorStore(prisma);
              const token = await store.getAccessToken(userId, 'gmail').catch(() => null);
              if (!token) return jsonResponse(res, { error: 'Gmail not connected' }, 412);
              const { GmailAdapter } = await import('./connectors/providers/gmail/adapter.js');
              const adapter = new GmailAdapter();
              const threadMode = body.thread_mode === 'message' ? 'message' : 'thread';
              const context = {
                user_id: userId,
                org_id: orgId,
                config: { thread_mode: threadMode },
              };
              let ingested = 0;
              let failed = 0;
              let treesIngested = 0;
              for (const threadId of threadIds) {
                try {
                  const thread = await adapter._gmailFetch(`/threads/${threadId}?format=full`, token);
                  const payloads = adapter.normalize(thread, context);

                  // Enterprise schema: multi-message threads ingest as a
                  // tree (Thread parent + Message children) so the agent
                  // can recall the whole thread by parent-id and each
                  // message keeps its own entity/temporal extraction.
                  // Detect the consolidated thread payload (type=gmail_thread)
                  // and the per-message payloads from adapter output.
                  const threadParent = payloads.find(p => p.metadata?.type === 'gmail_thread');
                  const messageChildren = payloads.filter(p => p.metadata?.gmail_message_id && !p.metadata?.is_thread_summary);
                  if (threadParent && messageChildren.length >= 2) {
                    // Stamp force_entity_linking on every child for the
                    // canonical LLM operator + entity-co-mention pass.
                    const children = messageChildren.map(c => ({
                      ...c,
                      metadata: {
                        ...(c.metadata || {}),
                        force_entity_linking: true,
                        ingest_tree_role: 'child',
                        parent_title: threadParent.title,
                      },
                    }));
                    const parent = {
                      ...threadParent,
                      metadata: {
                        ...(threadParent.metadata || {}),
                        force_entity_linking: true,
                        ingest_tree_role: 'parent',
                        child_count: children.length,
                      },
                    };
                    const treeResult = await persistentMemoryEngine.ingestMemoryTree({ parent, children });
                    treesIngested += 1;
                    ingested += 1 + children.length;
                    // Post-commit structured enrichment on parent thread
                    // — fire-and-forget so HTTP response doesn't wait.
                    // Adds summary / action_items / decisions / urgency
                    // fields + kind:* / urgency:* / owner:* tags.
                    if (treeResult?.parentId && enrichmentQueue) {
                      enrichmentQueue.enqueue(treeResult.parentId, {
                        content: parent.content,
                        title: parent.title,
                        tags: parent.tags,
                      });
                    }
                    // Skip residual summary memory if adapter also produced one.
                    const summary = payloads.find(p => p.metadata?.is_thread_summary);
                    if (summary) {
                      await persistentMemoryEngine.ingestMemory(summary);
                      ingested += 1;
                    }
                    continue;
                  }

                  // Single-message thread or per-message mode → flat ingest.
                  for (const p of payloads) {
                    const flatResult = await persistentMemoryEngine.ingestMemory(p);
                    ingested += 1;
                    if (flatResult?.memoryId && enrichmentQueue) {
                      enrichmentQueue.enqueue(flatResult.memoryId, {
                        content: p.content,
                        title: p.title,
                        tags: p.tags,
                      });
                    }
                  }
                } catch (err) {
                  // Surface root cause — empty err.message obscures
                  // Postgres 25P02 (aborted transaction) cascades.
                  const detail = err.message || err.code || String(err).slice(0, 200);
                  console.warn(`[gmail-ingest-selected] thread ${threadId} failed: ${detail}`, {
                    stack: err.stack?.split('\n').slice(0, 4).join('\n'),
                    code: err.code,
                  });
                  failed += 1;
                }
              }
              auditLog({
                organizationId: orgId, userId,
                actorType: 'user', actorUserId: userId,
                eventType: 'connector.gmail.ingest_selected', eventCategory: 'connector',
                action: 'ingest', resourceType: 'gmail_thread', resourceId: 'batch',
                metadata: { thread_count: threadIds.length, ingested, failed, thread_mode: threadMode },
              });
              return jsonResponse(res, { ok: true, ingested, failed, trees_ingested: treesIngested, requested: threadIds.length });
            } catch (err) {
              console.error('[gmail-ingest-selected] error:', err);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ── Claude.ai / ChatGPT / Perplexity remote-MCP connection status ──
        // Detects whether the user has live OAuth tokens issued to a client
        // registered via /oauth/register with a redirect_uri matching one of
        // the remote-MCP origins. Returns aggregated status the FE Connectors
        // page uses to render "Connected" + Disconnect button without showing
        // a duplicate card after the user finishes the OAuth dance in Claude.
        case '/api/connectors/claude-web/status':
          if (req.method === 'GET') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              const registry = await loadOAuthClientRegistry();
              const claudeClientIds = registry
                .filter((c) => Array.isArray(c.redirect_uris) && c.redirect_uris.some((u) =>
                  /claude\.ai|anthropic\.com/i.test(String(u || ''))))
                .map((c) => c.client_id);
              if (claudeClientIds.length === 0) {
                return jsonResponse(res, { connected: false, token_count: 0, last_used_at: null, client_ids: [] });
              }
              // Pull active oauth_access_token rows for this user issued to any
              // of the Claude client_ids. apiKey.name format is "oauth:<clientId>".
              const claudeNames = claudeClientIds.map((id) => `oauth:${id}`);
              const tokens = await prisma.apiKey.findMany({
                where: {
                  userId,
                  orgId,
                  name: { in: claudeNames },
                  OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                  ],
                  revokedAt: null,
                },
                select: { id: true, name: true, lastUsedAt: true, createdAt: true, expiresAt: true },
                orderBy: { lastUsedAt: 'desc' },
                take: 50,
              });
              const lastUsed = tokens.find((t) => t.lastUsedAt)?.lastUsedAt || tokens[0]?.createdAt || null;
              return jsonResponse(res, {
                connected: tokens.length > 0,
                token_count: tokens.length,
                last_used_at: lastUsed,
                client_ids: claudeClientIds,
                client_count: claudeClientIds.length,
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // POST /api/connectors/claude-web/disconnect
        // Revokes ALL active oauth tokens issued to any Claude/Anthropic client_id
        // for this user. Does NOT remove the connector from claude.ai (that lives
        // server-side on Anthropic) — FE shows instructions to do that step.
        case '/api/connectors/claude-web/disconnect':
          if (req.method === 'POST') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              const registry = await loadOAuthClientRegistry();
              const claudeClientIds = registry
                .filter((c) => Array.isArray(c.redirect_uris) && c.redirect_uris.some((u) =>
                  /claude\.ai|anthropic\.com/i.test(String(u || ''))))
                .map((c) => c.client_id);
              if (claudeClientIds.length === 0) return jsonResponse(res, { revoked: 0 });
              const claudeNames = claudeClientIds.map((id) => `oauth:${id}`);
              const result = await prisma.apiKey.updateMany({
                where: {
                  userId,
                  orgId,
                  name: { in: claudeNames },
                  revokedAt: null,
                },
                data: { revokedAt: new Date() },
              });
              auditLog({
                organizationId: orgId, userId,
                actorType: 'user', actorUserId: userId,
                eventType: 'connector.claude-web.disconnect', eventCategory: 'connector',
                action: 'disconnect', resourceType: 'oauth_client', resourceId: claudeClientIds.join(','),
                metadata: { revoked_count: result.count },
              });
              return jsonResponse(res, { revoked: result.count, client_ids: claudeClientIds });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/flush':
          if (req.method === 'POST') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              // Match every memory sourced from Gmail — tags OR sourceMetadata.
              const matchWhere = {
                userId,
                orgId,
                OR: [
                  { tags: { has: 'gmail' } },
                  { tags: { has: 'gmail_thread' } },
                  { tags: { has: 'gmail-thread' } },
                  { sourceMetadata: { is: { sourceType: 'gmail' } } },
                  { sourceMetadata: { is: { sourcePlatform: 'gmail' } } },
                ],
              };

              // Hard-delete mode: ?hard=true query param OR body.hard=true.
              // Purges Postgres rows, Qdrant vectors, and any pageindex /
              // memory_versions / relationships referencing the targets.
              const hard = url.searchParams.get('hard') === 'true' || body.hard === true;

              if (!hard) {
                // ── Soft delete (default, recoverable) ──
                const result = await prisma.memory.updateMany({
                  where: { ...matchWhere, deletedAt: null },
                  data: { deletedAt: new Date() },
                });
                auditLog({
                  organizationId: orgId, userId,
                  actorType: 'user', actorUserId: userId,
                  eventType: 'connector.gmail.flush', eventCategory: 'connector',
                  action: 'flush', resourceType: 'memory_bulk', resourceId: 'gmail',
                  metadata: { deleted_count: result.count, soft: true },
                });
                return jsonResponse(res, {
                  ok: true,
                  deleted: result.count,
                  mode: 'soft',
                  message: `Soft-deleted ${result.count} Gmail-sourced memor${result.count === 1 ? 'y' : 'ies'}. Pass {"hard":true} to purge.`,
                });
              }

              // ── HARD delete (unrecoverable) ──
              // 1. Collect ids (include already soft-deleted so we wipe them too)
              const matches = await prisma.memory.findMany({
                where: matchWhere,
                select: { id: true },
              });
              const ids = matches.map((m) => m.id);
              if (ids.length === 0) {
                return jsonResponse(res, { ok: true, deleted: 0, mode: 'hard', message: 'Nothing to purge.' });
              }

              // 2. Cascade-cleanup FK references then delete rows
              await prisma.auditLog.updateMany({
                where: { resourceId: { in: ids } },
                data: { resourceId: null },
              });
              await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: ids } } });
              await prisma.memoryVersion.updateMany({
                where: { relatedMemoryId: { in: ids } },
                data: { relatedMemoryId: null },
              });
              await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: ids } } });
              await prisma.relationship.deleteMany({
                where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] },
              });
              // Page index rows if model exists (best-effort, table may not exist on older deployments)
              try {
                if (prisma.pageIndex?.deleteMany) {
                  await prisma.pageIndex.deleteMany({ where: { memoryId: { in: ids } } });
                }
              } catch (pageErr) {
                console.warn('[gmail-flush:hard] pageindex delete failed (non-fatal):', pageErr.message);
              }
              const deletedRows = await prisma.memory.deleteMany({ where: { id: { in: ids } } });

              // 3. Qdrant vector purge — delete points whose payload memory_id ∈ ids.
              //    One filter-batched POST so we do not N+1 the vector store.
              let qdrantDeleted = 0;
              try {
                const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
                const qdrantCollection = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
                const qdrantKey = process.env.QDRANT_API_KEY || '';
                if (qdrantUrl) {
                  // Chunk ids to keep the filter payload small on big batches
                  const chunkSize = 500;
                  for (let i = 0; i < ids.length; i += chunkSize) {
                    const slice = ids.slice(i, i + chunkSize);
                    await fetch(`${qdrantUrl}/collections/${qdrantCollection}/points/delete`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...(qdrantKey ? { 'api-key': qdrantKey } : {}),
                      },
                      body: JSON.stringify({
                        filter: { must: [{ key: 'memory_id', match: { any: slice } }] },
                        wait: true,
                      }),
                    });
                    qdrantDeleted += slice.length;
                  }
                }
              } catch (qErr) {
                console.warn('[gmail-flush:hard] Qdrant purge failed (non-fatal):', qErr.message);
              }

              // 4. Invalidate aggregate cache so /api/memories etc. don't serve stale counts
              try { invalidateAggregateCache({ userId, orgId, project: null }); } catch { /* noop */ }

              auditLog({
                organizationId: orgId, userId,
                actorType: 'user', actorUserId: userId,
                eventType: 'connector.gmail.flush.hard', eventCategory: 'connector',
                action: 'purge', resourceType: 'memory_bulk', resourceId: 'gmail',
                metadata: { deleted_count: deletedRows.count, qdrant_deleted: qdrantDeleted, hard: true },
              });
              return jsonResponse(res, {
                ok: true,
                deleted: deletedRows.count,
                qdrant_deleted: qdrantDeleted,
                mode: 'hard',
                message: `Hard-deleted ${deletedRows.count} Gmail-sourced memor${deletedRows.count === 1 ? 'y' : 'ies'} (Postgres + Qdrant).`,
              });
            } catch (err) {
              console.error('[gmail-flush] error:', err);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/sync':
          if (req.method === 'POST') {
            // Accept sync configuration from the frontend settings panel
            const {
              date_range = '30d',         // '7d', '30d', '90d', '365d', 'all'
              folders = ['INBOX', 'SENT'], // Gmail label IDs
              exclude_categories = [],     // ['promotions', 'social', 'updates', 'forums']
              max_emails = 500,            // safety limit
              container_tag = null,        // optional project/container isolation
            } = body;

            if (!persistentMemoryEngine || !persistentMemoryStore) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }

            try {
              const { ConnectorStore, decryptToken } = await import('./connectors/framework/connector-store.js');
              const syncStore = new ConnectorStore(prisma);
              const connector = await syncStore.getConnector(userId, 'gmail');
              if (!connector) {
                return jsonResponse(res, { error: 'Gmail not connected. Complete OAuth first.' }, 400);
              }
              const targetScope = body.target_scope === 'organization'
                ? 'organization'
                : connector.target_scope || 'personal';

              // Build Gmail API query from user settings
              const queryParts = [];

              // Date range filter
              const dateRanges = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
              if (date_range !== 'all' && dateRanges[date_range]) {
                const after = new Date(Date.now() - dateRanges[date_range] * 86400000);
                queryParts.push(`after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`);
              }

              // Folder filter (label inclusion)
              if (folders.length > 0 && !folders.includes('ALL')) {
                queryParts.push(`in:${folders.map(f => f.toLowerCase()).join(' OR in:')}`);
              }

              // Exclude categories
              for (const cat of exclude_categories) {
                queryParts.push(`-category:${cat}`);
              }

              const gmailQuery = queryParts.join(' ');

              // Store settings in connector metadata
              await syncStore.updateStatus(userId, 'gmail', {
                status: 'syncing',
                cursor: connector.connectorMetadata?.cursor || null,
                syncStats: null,
              });

              // Return immediately, sync in background
              const syncId = crypto.randomUUID();
              console.log(`[gmail-sync] Starting configured sync id=${syncId} user=${userId} query="${gmailQuery}" maxEmails=${max_emails}`);

              // Background sync
              (async () => {
                try {
                  const accessToken = await syncStore.getAccessToken(userId, 'gmail');
                  if (!accessToken) throw new Error('Gmail access token not found or expired. Please reconnect Gmail.');

                  const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
                  const params = new URLSearchParams({
                    maxResults: String(Math.min(max_emails, 100)),
                    q: gmailQuery,
                  });

                  let totalImported = 0;
                  let totalSkipped = 0;
                  let pageToken = null;

                  do {
                    if (pageToken) params.set('pageToken', pageToken);
                    const listResp = await fetch(`${GMAIL_API}/threads?${params}`, {
                      headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    if (!listResp.ok) throw new Error(`Gmail API ${listResp.status}: ${await listResp.text()}`);
                    const listData = await listResp.json();

                    const threads = listData.threads || [];
                    for (const threadStub of threads) {
                      if (totalImported + totalSkipped >= max_emails) break;

                      try {
                        const threadResp = await fetch(`${GMAIL_API}/threads/${threadStub.id}?format=full`, {
                          headers: { Authorization: `Bearer ${accessToken}` },
                        });
                        if (!threadResp.ok) { totalSkipped++; continue; }
                        const thread = await threadResp.json();
                        const messages = thread.messages || [];

                        // ── Thread-level ingestion ──────────────────────────────────
                        if (totalImported >= max_emails) break;

                        // MIME helpers (defined once per thread, cheap)
                        const _decodeB64 = (d) => { try { return Buffer.from(d, 'base64url').toString('utf-8'); } catch { try { return Buffer.from(d, 'base64').toString('utf-8'); } catch { return ''; } } };
                        const _stripHtml = (h) => h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
                        const _extractText = (part) => {
                          if (!part) return '';
                          if (part.mimeType === 'text/plain' && part.body?.data) return _decodeB64(part.body.data);
                          if (part.mimeType === 'text/html' && part.body?.data) return _stripHtml(_decodeB64(part.body.data));
                          if (part.parts) {
                            const plain = part.parts.find(p => p.mimeType === 'text/plain');
                            if (plain?.body?.data) return _decodeB64(plain.body.data);
                            const html = part.parts.find(p => p.mimeType === 'text/html');
                            if (html?.body?.data) return _stripHtml(_decodeB64(html.body.data));
                            for (const sub of part.parts) {
                              const result = _extractText(sub);
                              if (result.length > 20) return result;
                            }
                          }
                          return '';
                        };

                        // Gather thread-level labels from all messages (union)
                        const threadLabelSet = new Set();
                        for (const msg of messages) {
                          for (const lbl of (msg.labelIds || [])) {
                            threadLabelSet.add(lbl.replace(/^CATEGORY_/, '').toLowerCase());
                          }
                        }
                        const threadLabels = [...threadLabelSet];

                        // Skip excluded categories (thread-level)
                        if (exclude_categories.some(cat => threadLabels.includes(cat))) {
                          totalSkipped++;
                          continue;
                        }

                        // Build per-message content blocks and collect metadata
                        const messageBlocks = [];
                        const participants = new Set();
                        for (const msg of messages) {
                          const headers = msg.payload?.headers || [];
                          const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
                          const from = getH('From');
                          const to = getH('To');
                          const date = getH('Date');
                          let bodyText = _extractText(msg.payload) || msg.snippet || '';
                          bodyText = bodyText.replace(/\x00/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                          messageBlocks.push(`[${from} — ${date}]\n${bodyText}`);
                          if (from) participants.add(from);
                          if (to) participants.add(to);
                        }

                        // Subject + dates from first/last message
                        const firstMsg = messages[0];
                        const lastMsg = messages[messages.length - 1];
                        const firstHeaders = firstMsg?.payload?.headers || [];
                        const getFirstH = (n) => firstHeaders.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
                        const subject = getFirstH('Subject') || '(no subject)';
                        const firstDate = getFirstH('Date');
                        const lastHeaders = lastMsg?.payload?.headers || [];
                        const lastDate = lastHeaders.find(h => h.name.toLowerCase() === 'date')?.value;

                        // Build full thread content
                        const threadContent = messageBlocks.join('\n\n---\n\n');

                        // ── Noise filtering ──────────────────────────────────────────
                        const SKIP_PATTERNS = /\b(unsubscribe|opt[.\s-]?out|no[.\s-]?reply|noreply|do not reply|verify your|confirm your|reset your password|OTP|one[.\s-]?time passcode|one[.\s-]?time code|security alert|account alert|sign[.\s-]?in attempt|unusual sign|new sign[.\s-]?in|your receipt|order confirmation|payment confirmation|invoice #|your shipment|has been shipped|out of office|auto[.\s-]?reply|automatic reply)\b/i;
                        if (SKIP_PATTERNS.test(subject) || SKIP_PATTERNS.test(threadContent.slice(0, 600))) {
                          console.log(`[gmail-sync] Skipping noise thread: "${subject}"`);
                          totalSkipped++;
                          continue;
                        }

                        // Build tags
                        const tags = ['gmail', `gmail-thread:${thread.id}`, ...threadLabels.filter(l => !['unread', 'inbox'].includes(l))];
                        for (const p of participants) {
                          const emailMatch = p.match(/<([^>]+)>/);
                          if (emailMatch) tags.push(`participant:${emailMatch[1].split('@')[0]}`);
                        }

                        // Assemble final content with header summary
                        const content = `Email Thread: ${subject}\n\n${threadContent}`.slice(0, 8000);

                        try {
                          const gmailPayload = {
                            content,
                            title: subject,
                            tags,
                            memory_type: 'event',
                            visibility: targetScope === 'organization' ? 'organization' : 'private',
                            document_date: firstDate ? new Date(firstDate).toISOString() : null,
                            source: 'gmail',
                            source_metadata: {
                              source_type: 'gmail',
                              source_platform: 'gmail',
                              source_id: `thread:${thread.id}`,
                              thread_id: thread.id,
                              message_count: messages.length,
                              last_message_date: lastDate || null,
                            },
                            project: container_tag || null,
                            user_id: userId,
                            org_id: orgId,
                            metadata: {
                              // Canonical pipeline directive — every gmail
                              // sync row gets entity + temporal + operator
                              // LLM extraction, not just tag accumulation.
                              force_entity_linking: true,
                            },
                          };
                          const [routedGmailPayload] = await buildRoutedIngestPayloads(gmailPayload, { smartIngestRouter });
                          const gmailResult = await persistentMemoryEngine.ingestMemory(routedGmailPayload);
                          // Enterprise structured enrichment post-commit.
                          if (gmailResult?.memoryId && enrichmentQueue) {
                            enrichmentQueue.enqueue(gmailResult.memoryId, {
                              content: routedGmailPayload.content,
                              title: routedGmailPayload.title,
                              tags: routedGmailPayload.tags,
                            });
                          }
                          // Embed thread memory in Qdrant for vector search
                          if (gmailResult?.memoryId && qdrantClient) {
                            try {
                              const gmailMem = await persistentMemoryStore.getMemory(gmailResult.memoryId);
                              if (gmailMem) await qdrantClient.storeMemory(gmailMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                            } catch {}
                          }
                          // Embed fact-memories in Qdrant
                          if (gmailResult?.factMemoryIds?.length > 0 && qdrantClient) {
                            for (const factId of gmailResult.factMemoryIds) {
                              try {
                                const factMem = await persistentMemoryStore.getMemory(factId);
                                if (factMem) await qdrantClient.storeMemory(factMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                              } catch {}
                            }
                          }
                          totalImported++;
                        } catch (ingestErr) {
                          console.warn(`[gmail-sync] Ingest failed for thread ${thread.id}:`, ingestErr.message);
                          totalSkipped++;
                        }
                      } catch (threadErr) {
                        console.warn(`[gmail-sync] Thread ${threadStub.id} failed:`, threadErr.message);
                        totalSkipped++;
                      }
                    }

                    pageToken = listData.nextPageToken;
                  } while (pageToken && totalImported + totalSkipped < max_emails);

                  // Update connector status
                  await syncStore.updateStatus(userId, 'gmail', {
                    status: 'idle',
                    syncStats: { imported: totalImported, skipped: totalSkipped, query: gmailQuery },
                  });

                  console.log(`[gmail-sync] Complete: imported=${totalImported}, skipped=${totalSkipped}`);
                } catch (syncErr) {
                  console.error(`[gmail-sync] Failed:`, syncErr.message);
                  try {
                    await syncStore.updateStatus(userId, 'gmail', {
                      status: 'idle',
                      error: syncErr.message,
                    });
                  } catch {}
                }
              })();

              return jsonResponse(res, {
                sync_id: syncId,
                status: 'syncing',
                settings: { date_range, folders, exclude_categories, max_emails, container_tag, gmail_query: gmailQuery },
                message: 'Sync started in background. Check /api/connectors/gmail/status for progress.',
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // GMAIL PUB/SUB WATCH — Real-time email ingestion
        // ==========================================

        case '/api/workspace/live-query':
          // POST { query: 'meeting tomorrow', memory_results?: [...] }
          // → fans out live calls to Drive/Calendar/Gmail based on intent
          // → merges with memory hits
          if (req.method === 'POST') {
            try {
              const { query, memory_results = [], force_services = null } = body;
              if (!query) return jsonResponse(res, { error: 'query required' }, 400);

              const { LiveQueryRouter } = await import('./connectors/providers/google/live-query-router.js');
              const { decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
              const router = new LiveQueryRouter({
                prisma,
                decryptToken,
                refreshOAuthToken: refreshOAuthToken || null,
              });

              let services;
              let reason;
              if (Array.isArray(force_services) && force_services.length > 0) {
                services = force_services;
                reason = 'caller-specified';
              } else {
                const classification = router.classify(query, memory_results);
                services = classification.services;
                reason = classification.reason;
                if (!classification.needsLive) {
                  return jsonResponse(res, {
                    needsLive: false,
                    reason,
                    items: [],
                  });
                }
              }

              const items = await router.fetch(userId, query, services);
              return jsonResponse(res, {
                needsLive: true,
                reason,
                services_queried: services,
                item_count: items.length,
                items,
              });
            } catch (err) {
              console.error('[live-query] failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/workspace/health':
          if (req.method === 'GET') {
            try {
              const { WorkspaceMcpBridge } = await import('./connectors/providers/google/workspace-mcp-bridge.js');
              const { ConnectorStore, decryptToken } = await import('./connectors/framework/connector-store.js');
              const bridge = new WorkspaceMcpBridge({ prisma, decryptToken });
              const health = await bridge.health();
              return jsonResponse(res, {
                bridge_url: process.env.WORKSPACE_MCP_URL || 'http://workspace-mcp:8000',
                ...health,
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/workspace/tools':
          if (req.method === 'GET') {
            try {
              const { WorkspaceMcpBridge } = await import('./connectors/providers/google/workspace-mcp-bridge.js');
              const { decryptToken } = await import('./connectors/framework/connector-store.js');
              const bridge = new WorkspaceMcpBridge({ prisma, decryptToken });
              const tools = await bridge.listTools();
              return jsonResponse(res, {
                tool_count: tools.length,
                tools: tools.map(t => ({ name: t.name, description: t.description?.slice(0, 200) })),
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/workspace/call':
          // POST { tool: 'gmail_search_messages', args: { query: 'from:alice' } }
          // Forwards to workspace-mcp sidecar with this user's Google token
          if (req.method === 'POST') {
            try {
              const { tool, args = {} } = body;
              if (!tool) return jsonResponse(res, { error: 'tool name required' }, 400);

              const { WorkspaceMcpBridge } = await import('./connectors/providers/google/workspace-mcp-bridge.js');
              const { decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
              const bridge = new WorkspaceMcpBridge({
                prisma,
                decryptToken,
                refreshOAuthToken: refreshOAuthToken || null,
              });
              const result = await bridge.callTool(userId, tool, args);
              return jsonResponse(res, { tool, result });
            } catch (err) {
              console.error('[workspace-call] failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/cadence':
          // GET → list per-connector cadences for this user
          // POST { provider, sync_interval_minutes } → update one
          //   sync_interval_minutes: null = use global default
          //   sync_interval_minutes: 15-1440 = per-connector override (15 min floor)
          if (req.method === 'GET') {
            try {
              const rows = await prisma.platformIntegration.findMany({
                where: { userId },
                select: {
                  platformType: true,
                  syncIntervalMinutes: true,
                  lastSchedulerRunAt: true,
                  lastSyncedAt: true,
                  syncStatus: true,
                },
              });
              const globalMs = Number(process.env.HIVEMIND_SYNC_INTERVAL_MS || 60 * 60 * 1000);
              return jsonResponse(res, {
                global_interval_minutes: Math.round(globalMs / 60000),
                connectors: rows.map(r => ({
                  provider: r.platformType,
                  sync_interval_minutes: r.syncIntervalMinutes,
                  effective_interval_minutes: r.syncIntervalMinutes || Math.round(globalMs / 60000),
                  last_scheduler_run: r.lastSchedulerRunAt,
                  last_synced_at: r.lastSyncedAt,
                  status: r.syncStatus,
                })),
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'POST') {
            try {
              const { provider, sync_interval_minutes } = body;
              if (!provider) return jsonResponse(res, { error: 'provider required' }, 400);

              // Validate cadence
              let cadence = null;
              if (sync_interval_minutes !== null && sync_interval_minutes !== undefined) {
                cadence = parseInt(sync_interval_minutes, 10);
                if (!Number.isFinite(cadence) || cadence < 15 || cadence > 60 * 24 * 30) {
                  return jsonResponse(res, {
                    error: 'sync_interval_minutes must be null (use global default) or between 15 and 43200 (30 days)',
                  }, 400);
                }
              }

              const updated = await prisma.platformIntegration.update({
                where: { userId_platformType: { userId, platformType: provider } },
                data: { syncIntervalMinutes: cadence },
                select: { platformType: true, syncIntervalMinutes: true },
              });
              return jsonResponse(res, { success: true, ...updated });
            } catch (err) {
              if (err.code === 'P2025') {
                return jsonResponse(res, { error: 'Connector not found' }, 404);
              }
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/cleanup-legacy':
          // Purge garbage fact-memories generated by old (pre-event-type)
          // Gmail ingestion pipeline. Targets:
          //   - "X sent an email on Y date"
          //   - "X previously sent an email in the same thread"
          //   - "The email address of X is Y@z.com"
          //   - Marketing-footer-dominated fact memories
          // Body: { dry_run: true|false (default true), hard: true|false (default false), all_users: false }
          if (req.method === 'POST') {
            try {
              const dryRun = body.dry_run !== false;
              const hardDelete = body.hard === true;
              const allUsers = body.all_users === true; // admin-only flag

              // Build scope filter
              const scopeWhere = allUsers
                ? {} // requires admin (TODO: gate with admin check)
                : { userId };

              // Patterns that identify legacy Gmail fact-extraction garbage
              const patterns = [
                'sent an email', // "X sent an email on Y date"
                'previously sent an email',
                'email address of', // "The email address of X is Y@z.com"
                'email of ', // "email of X is Y@z.com"
                'in the same thread',
                'Email Thread:', // old title prefix on per-message memories
              ];

              const where = {
                ...scopeWhere,
                deletedAt: null,
                OR: [
                  // Match by source platform + fact type + content patterns
                  {
                    AND: [
                      { sourcePlatform: 'gmail' },
                      { memoryType: 'fact' },
                      {
                        OR: patterns.map((p) => ({
                          content: { contains: p, mode: 'insensitive' },
                        })),
                      },
                    ],
                  },
                  // Match by tags carrying old per-message gmail-thread:* tag + fact type
                  {
                    AND: [
                      { memoryType: 'fact' },
                      { tags: { hasSome: ['gmail', 'gmail-thread'] } },
                      {
                        OR: patterns.map((p) => ({
                          content: { contains: p, mode: 'insensitive' },
                        })),
                      },
                    ],
                  },
                ],
              };

              const total = await prisma.memory.count({ where });

              // Sample first 5 for dry-run preview
              const sample = await prisma.memory.findMany({
                where,
                select: { id: true, content: true, title: true, memoryType: true, sourcePlatform: true },
                take: 5,
                orderBy: { createdAt: 'desc' },
              });

              if (dryRun) {
                return jsonResponse(res, {
                  dry_run: true,
                  candidates: total,
                  sample: sample.map((m) => ({
                    id: m.id,
                    title: m.title,
                    content_preview: (m.content || '').slice(0, 120),
                    memory_type: m.memoryType,
                    source_platform: m.sourcePlatform,
                  })),
                  message: `${total} legacy Gmail fact-memories matched. Re-call with dry_run=false to ${hardDelete ? 'PERMANENTLY DELETE' : 'soft-delete'} them.`,
                });
              }

              // Execute deletion
              let deleted = 0;
              if (hardDelete) {
                const result = await prisma.memory.deleteMany({ where });
                deleted = result.count;
              } else {
                const result = await prisma.memory.updateMany({
                  where,
                  data: { deletedAt: new Date() },
                });
                deleted = result.count;
              }

              console.log(`[gmail-cleanup] User ${userId} purged ${deleted} legacy fact-memories (hard=${hardDelete}, allUsers=${allUsers})`);

              return jsonResponse(res, {
                success: true,
                dry_run: false,
                deleted,
                hard: hardDelete,
                message: `${deleted} legacy Gmail fact-memories ${hardDelete ? 'permanently deleted' : 'soft-deleted'}.`,
              });
            } catch (err) {
              console.error('[gmail-cleanup] failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/watch/register':
          // Caller-triggered: register a Gmail watch for the current user.
          // Auto-called after successful OAuth; manual re-trigger via this route.
          if (req.method === 'POST') {
            try {
              const { ConnectorStore, decryptToken } = await import('./connectors/framework/connector-store.js');
              const { registerWatch } = await import('./connectors/providers/gmail/gmail-watch.js');
              const cs = new ConnectorStore(prisma);
              const conn = await cs.getConnector(userId, 'gmail');
              if (!conn) return jsonResponse(res, { error: 'Gmail not connected' }, 400);

              const topicName = process.env.GCP_PUBSUB_TOPIC;
              if (!topicName) {
                return jsonResponse(res, {
                  error: 'Server not configured for Pub/Sub. Set GCP_PUBSUB_TOPIC env var.',
                  hint: 'See docs/gmail-pubsub-setup.md',
                }, 503);
              }

              const accessToken = decryptToken(conn.access_token_encrypted);
              const watch = await registerWatch({
                accessToken,
                topicName,
                labelIds: body.labels || undefined,
              });

              await cs.updateMetadata?.(userId, 'gmail', { watch });
              return jsonResponse(res, { success: true, watch });
            } catch (err) {
              console.error('[gmail-watch] register failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/gmail/pubsub-webhook':
          // Pub/Sub push target. Google sends a JSON payload with the base64
          // Gmail notification + an OIDC token in Authorization header.
          if (req.method === 'POST') {
            try {
              const { decodePubSubMessage, verifyPubSubAuth } = await import('./connectors/providers/gmail/gmail-watch.js');

              // Verify OIDC token from Pub/Sub
              const expectedAudience = process.env.GCP_PUBSUB_AUDIENCE
                || `${process.env.HIVEMIND_PUBLIC_URL || 'https://core.hivemind.davinciai.eu:8050'}/api/connectors/gmail/pubsub-webhook`;
              const authValid = await verifyPubSubAuth(
                req.headers['authorization'] || '',
                expectedAudience,
              );
              if (!authValid && process.env.NODE_ENV === 'production') {
                return jsonResponse(res, { error: 'Invalid Pub/Sub auth token' }, 401);
              }

              const decoded = decodePubSubMessage(body);
              if (!decoded) {
                // Pub/Sub treats 2xx as ack; malformed = no retry
                return jsonResponse(res, { ack: true, reason: 'malformed' });
              }

              // Find the user whose Gmail account matches this notification
              const { ConnectorStore, decryptToken } = await import('./connectors/framework/connector-store.js');
              const cs = new ConnectorStore(prisma);
              const conn = await cs.findByEmail?.('gmail', decoded.emailAddress);
              if (!conn) {
                console.warn(`[gmail-pubsub] No connection for ${decoded.emailAddress}`);
                return jsonResponse(res, { ack: true, reason: 'no-connection' });
              }

              // Trigger incremental sync from stored historyId → notification's historyId.
              // SyncEngine handles the heavy lifting (fetch threads, normalize, ingest).
              const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
              const { GmailAdapter } = await import('./connectors/providers/gmail/adapter.js');
              const adapter = new GmailAdapter();
              const engine = new SyncEngine({ connectorStore: cs, memoryStore: persistentMemoryStore, memoryEngine: persistentMemoryEngine, smartIngestRouter, externalRefStore, entityResolver });

              const cursor = conn.metadata?.cursor || decoded.historyId;
              const accessToken = decryptToken(conn.access_token_encrypted);

              // Run async — Pub/Sub waits up to 10s for ack, don't block
              engine.runSync({
                adapter,
                userId: conn.userId,
                orgId: conn.orgId,
                provider: 'gmail',
                cursor,
                incremental: true,
                accessToken,
                context: {
                  user_id: conn.userId,
                  org_id: conn.orgId,
                  user_account_ref: decoded.emailAddress,
                  target_scope: conn.target_scope || 'personal',
                  gmail_thread_mode: conn.metadata?.gmail_thread_mode || 'thread',
                },
              }).catch(err => console.error(`[gmail-pubsub] sync failed for ${decoded.emailAddress}:`, err.message));

              // Ack immediately so Pub/Sub doesn't retry
              return jsonResponse(res, { ack: true, triggered_sync: true });
            } catch (err) {
              console.error('[gmail-pubsub] webhook error:', err.message);
              // Return 2xx anyway — retries cause duplicates
              return jsonResponse(res, { ack: true, error: err.message });
            }
          }
          break;

        case '/api/connectors/gmail/watch/renew-all':
          // Cron-driven (or manual admin). Renews watches close to 7-day expiry.
          if (req.method === 'POST') {
            try {
              const cronToken = req.headers['x-cron-token'] || req.headers['authorization']?.replace('Bearer ', '');
              if (process.env.CRON_TOKEN && cronToken !== process.env.CRON_TOKEN) {
                return jsonResponse(res, { error: 'Unauthorized' }, 401);
              }

              const { ConnectorStore, decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
              const { renewAllWatches } = await import('./connectors/providers/gmail/gmail-watch.js');
              const cs = new ConnectorStore(prisma);

              const topicName = process.env.GCP_PUBSUB_TOPIC;
              if (!topicName) return jsonResponse(res, { error: 'GCP_PUBSUB_TOPIC not set' }, 503);

              const refreshAccessToken = async (uid) => {
                const c = await cs.getConnector(uid, 'gmail');
                if (!c) throw new Error('connection-missing');
                // Use refresh flow if access token expired; otherwise decrypt
                if (refreshOAuthToken && c.refresh_token_encrypted) {
                  try { return await refreshOAuthToken(c); } catch (_e) {}
                }
                return decryptToken(c.access_token_encrypted);
              };

              const result = await renewAllWatches({ connectorStore: cs, refreshAccessToken, topicName });
              return jsonResponse(res, { success: true, ...result });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // SLACK CONNECTOR — Status & Sync
        // ==========================================

        case '/api/connectors/slack/status':
          if (req.method === 'GET') {
            try {
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const statusStore = new ConnectorStore(prisma);
              const connection = await statusStore.getConnector(userId, 'slack');
              if (!connection) return jsonResponse(res, { connected: false });
              return jsonResponse(res, {
                connected: true,
                team: connection.account_ref,
                status: connection.status,
                target_scope: connection.target_scope,
                last_synced: connection.last_sync_at,
                last_error: connection.last_error,
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/connectors/slack/sync':
          if (req.method === 'POST') {
            try {
              const { SlackAdapter } = await import('./connectors/providers/slack/adapter.js');
              const adapter = new SlackAdapter();
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const slackStore = new ConnectorStore(prisma);

              // Run sync in background
              const syncId = crypto.randomUUID();
              setImmediate(async () => {
                try {
                  await syncEngine.runSync({
                    adapter,
                    userId,
                    orgId,
                    provider: 'slack',
                    incremental: !!body.incremental,
                    targetScope: body.target_scope || 'personal',
                  });
                } catch (err) {
                  console.error('[slack-sync] Failed:', err.message);
                }
              });
              return jsonResponse(res, { sync_id: syncId, status: 'started' }, 202);
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // KNOWLEDGE BASE — Per-document relations summary (batch)
        // ==========================================
        case '/api/knowledge/relations-summary':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/knowledge/relations-summary')) return;
            try {
              // Body: { doc_ids: string[] } — each is a top-level document memory id
              const reqIds = Array.isArray(body.doc_ids) ? body.doc_ids.filter(x => typeof x === 'string' && x.length > 0) : [];
              if (reqIds.length === 0) {
                return jsonResponse(res, { error: 'doc_ids[] required' }, 400);
              }

              // Resolve the cluster (doc + chunks + facts) per docId using same
              // strategies as DELETE handler.
              const out = {};
              for (const docId of reqIds.slice(0, 100)) {
                let docMemory = null;
                try {
                  docMemory = await prisma.memory.findFirst({
                    where: { id: docId, userId, deletedAt: null },
                    select: {
                      id: true, tags: true, title: true,
                      sourceMetadata: { select: { sourceId: true, metadata: true } },
                    },
                  });
                } catch (_) { docMemory = null; }

                const memoryIds = new Set([docId]);
                const docMeta = docMemory?.sourceMetadata?.metadata || {};
                const uploadTag = (docMemory?.tags || []).find(t => typeof t === 'string' && t.startsWith('upload:')) || null;

                if (uploadTag) {
                  try {
                    const rows = await prisma.memory.findMany({
                      where: { userId, tags: { has: uploadTag }, deletedAt: null },
                      select: { id: true },
                    });
                    rows.forEach(r => memoryIds.add(r.id));
                  } catch (_) { /* swallow */ }
                }
                if (docMeta?.source_upload_id) {
                  try {
                    const rows = await prisma.memory.findMany({
                      where: { userId, tags: { has: `upload:${docMeta.source_upload_id}` }, deletedAt: null },
                      select: { id: true },
                    });
                    rows.forEach(r => memoryIds.add(r.id));
                  } catch (_) { /* swallow */ }
                }
                const fname = docMeta?.filename || docMeta?.document_title;
                if (fname) {
                  try {
                    const rows = await prisma.memory.findMany({
                      where: {
                        userId, deletedAt: null,
                        sourceMetadata: { is: { sourceId: { startsWith: `doc:${fname}` } } },
                      },
                      select: { id: true },
                    });
                    rows.forEach(r => memoryIds.add(r.id));
                  } catch (_) { /* swallow */ }
                }

                const idArr = Array.from(memoryIds);
                if (idArr.length === 0) {
                  out[docId] = { total: 0, byType: {}, cluster_size: 0 };
                  continue;
                }

                // Aggregate relationship types touching the cluster
                try {
                  const grouped = await prisma.relationship.groupBy({
                    by: ['type'],
                    where: { OR: [{ fromId: { in: idArr } }, { toId: { in: idArr } }] },
                    _count: { type: true },
                  });
                  const byType = {};
                  let total = 0;
                  for (const row of grouped) {
                    const t = row.type;
                    const c = row._count?.type || 0;
                    byType[t] = (byType[t] || 0) + c;
                    total += c;
                  }
                  out[docId] = { total, byType, cluster_size: idArr.length };
                } catch (relErr) {
                  out[docId] = { total: 0, byType: {}, cluster_size: idArr.length, error: relErr.message };
                }
              }

              return jsonResponse(res, { summaries: out, count: Object.keys(out).length });
            } catch (err) {
              return jsonResponse(res, { error: 'relations-summary failed', message: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // KNOWLEDGE BASE — Document Delete (cascading)
        // ==========================================
        case '/api/knowledge/document':
          if (req.method === 'DELETE') {
            if (!persistentMemoryEngine || !persistentMemoryStore) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }

            // Accept memory_id, upload_id, or a generic id (the FE sends both
            // when it can't tell which it has — just-uploaded docs carry an
            // upload_id, persisted docs carry a real memory UUID).
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const rawMemoryId = body.memory_id || url.searchParams.get('memory_id');
            const rawUploadId = body.upload_id || url.searchParams.get('upload_id');
            const rawId = body.id || url.searchParams.get('id') || rawMemoryId || rawUploadId;

            if (!rawId && !rawMemoryId && !rawUploadId) {
              return jsonResponse(res, { error: 'memory_id, upload_id, or id is required' }, 400);
            }

            // Resolve which slot the value belongs to. If memory_id is set but
            // points to a non-existent memory (i.e. caller actually had an
            // upload_id), we transparently fall back to upload_id below.
            let deleteMemoryId = rawMemoryId && UUID_RE.test(rawMemoryId) ? rawMemoryId : null;
            let deleteUploadId = rawUploadId || null;
            // If we got rawId without splitting and it doesn't look UUID-ish,
            // assume it's an upload_id.
            if (!deleteMemoryId && !deleteUploadId && rawId) {
              if (UUID_RE.test(rawId)) deleteMemoryId = rawId;
              else deleteUploadId = rawId;
            }

            try {
              let memoryIds = [];
              let resolutionStrategy = null;

              // Helper: run a Prisma query but never let it bubble — log and
              // return [] so the next strategy can run.
              const safeFind = async (label, queryFn) => {
                try {
                  const rows = await queryFn();
                  return Array.isArray(rows) ? rows.map(r => r.id).filter(Boolean) : [];
                } catch (qErr) {
                  console.warn(`[knowledge-delete] strategy "${label}" failed:`, qErr.message);
                  return [];
                }
              };

              if (deleteUploadId && !deleteMemoryId) {
                // Direct upload_id path: find all memories tagged with upload:{id}
                memoryIds = await safeFind('upload-tag-direct', () =>
                  prisma.memory.findMany({
                    where: { userId, tags: { has: `upload:${deleteUploadId}` }, deletedAt: null },
                    select: { id: true },
                  })
                );
                resolutionStrategy = 'upload-id-direct';
              }

              if (memoryIds.length === 0 && deleteMemoryId) {
                // Find the document memory first to get its source info
                let docMemory = null;
                try {
                  docMemory = await prisma.memory.findFirst({
                    where: { id: deleteMemoryId, userId, deletedAt: null },
                    select: {
                      id: true,
                      tags: true,
                      title: true,
                      sourceMetadata: { select: { sourceId: true, metadata: true } },
                      versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { metadata: true } },
                    },
                  });
                } catch (lookupErr) {
                  console.warn('[knowledge-delete] doc lookup failed:', lookupErr.message);
                }

                // If memory_id didn't resolve, treat it as a possible upload_id.
                if (!docMemory) {
                  const fallbackUploadId = deleteUploadId || deleteMemoryId;
                  memoryIds = await safeFind('upload-tag-fallback', () =>
                    prisma.memory.findMany({
                      where: { userId, tags: { has: `upload:${fallbackUploadId}` }, deletedAt: null },
                      select: { id: true },
                    })
                  );
                  if (memoryIds.length === 0) {
                    // Don't 404 here — fall through to Phase1 knowledgeDocument
                    // lookup below. Catches the common case where the FE sent
                    // a knowledge_document.id under memory_id.
                  } else {
                    deleteUploadId = fallbackUploadId;
                    resolutionStrategy = 'upload-id-fallback';
                  }
                } else {
                  const docMeta = docMemory.versions?.[0]?.metadata || docMemory.sourceMetadata?.metadata || {};

                  // Strategy 1: upload:{id} tag on the document memory itself
                  const uploadTag = (docMemory.tags || []).find(t => t.startsWith('upload:'));
                  if (uploadTag) {
                    memoryIds = await safeFind('upload-tag-on-doc', () =>
                      prisma.memory.findMany({
                        where: { userId, tags: { has: uploadTag }, deletedAt: null },
                        select: { id: true },
                      })
                    );
                    if (memoryIds.length) resolutionStrategy = 'tag-on-doc';
                  }

                  // Strategy 2: metadata.source_upload_id (enterprise schema)
                  if (memoryIds.length === 0 && docMeta?.source_upload_id) {
                    memoryIds = await safeFind('source-upload-id-tag', () =>
                      prisma.memory.findMany({
                        where: { userId, tags: { has: `upload:${docMeta.source_upload_id}` }, deletedAt: null },
                        select: { id: true },
                      })
                    );
                    if (memoryIds.length) resolutionStrategy = 'source-upload-id';
                  }

                  // Strategy 3: source_id pattern (regular KB uploads — doc:{filename}:*)
                  if (memoryIds.length === 0) {
                    const filename = docMeta?.filename || docMeta?.document_title;
                    if (filename) {
                      memoryIds = await safeFind('source-id-prefix', () =>
                        prisma.memory.findMany({
                          where: {
                            userId,
                            deletedAt: null,
                            sourceMetadata: { is: { sourceId: { startsWith: `doc:${filename}` } } },
                          },
                          select: { id: true },
                        })
                      );
                      if (memoryIds.length) resolutionStrategy = 'source-id-prefix';
                    }
                  }

                  // Strategy 4: children via versions.metadata.parent_schema_id
                  // (this is the JSON path filter that historically threw 500s
                  // when metadata was null — safeFind() now isolates it).
                  if (memoryIds.length === 0) {
                    const children = await safeFind('parent-schema-id', () =>
                      prisma.memory.findMany({
                        where: {
                          userId,
                          deletedAt: null,
                          versions: {
                            some: {
                              metadata: { path: ['parent_schema_id'], equals: deleteMemoryId },
                            },
                          },
                        },
                        select: { id: true },
                      })
                    );
                    memoryIds = [deleteMemoryId, ...children];
                    resolutionStrategy = resolutionStrategy || 'self-plus-children';
                  }

                  // Always include the clicked document
                  if (!memoryIds.includes(deleteMemoryId)) {
                    memoryIds.push(deleteMemoryId);
                  }
                }
              }

              if (memoryIds.length === 0) {
                // Fallback: Phase1 knowledge_document delete (cascades segments + evidence links via FK)
                const tryDocId = rawMemoryId || rawId;
                if (tryDocId && UUID_RE.test(tryDocId)) {
                  try {
                    const doc = await prisma.knowledgeDocument.findFirst({
                      where: { id: tryDocId, userId, orgId },
                      select: { id: true, sourceArtifactId: true },
                    });
                    if (doc) {
                      // Best-effort: remove Qdrant evidence points first
                      try {
                        const segs = await prisma.knowledgeSegment.findMany({
                          where: { documentId: doc.id },
                          select: { id: true },
                        });
                        if (segs.length) {
                          const qUrl = process.env.QDRANT_URL || 'http://qdrant:6333';
                          const qKey = process.env.QDRANT_API_KEY || '';
                          const hdrs = { 'Content-Type': 'application/json' };
                          if (qKey) hdrs['api-key'] = qKey;
                          const coll = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';
                          await fetch(`${qUrl}/collections/${coll}/points/delete?wait=true`, {
                            method: 'POST', headers: hdrs,
                            body: JSON.stringify({ points: segs.map(s => s.id) }),
                          }).catch(() => {});
                        }
                      } catch { /* noop */ }
                      // Delete document — cascades segments + memory_evidence_links via FK
                      await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
                      // Try also delete source_artifact (orphaned if no other docs reference it)
                      if (doc.sourceArtifactId) {
                        await prisma.sourceArtifact.delete({ where: { id: doc.sourceArtifactId } }).catch(() => {});
                      }
                      return jsonResponse(res, {
                        success: true,
                        mode: 'phase1_document_delete',
                        documentId: doc.id,
                      });
                    }
                  } catch (phase1Err) {
                    console.warn(`[knowledge-delete] phase1 fallback failed: ${phase1Err.message}`);
                  }
                }
                return jsonResponse(res, { error: 'No memories found for this document' }, 404);
              }
              // De-dup
              memoryIds = Array.from(new Set(memoryIds));
              console.log(`[knowledge-delete] resolution=${resolutionStrategy} target=${deleteMemoryId || deleteUploadId} count=${memoryIds.length}`);

              // Cascade hard delete (same pattern as delete-all). Each step is
              // wrapped so a partial failure (e.g. orphan relationship row)
              // still lets the rest progress and the user gets a useful error
              // mentioning WHICH step failed, not a generic 500.
              const cascade = async (label, fn) => {
                try { await fn(); } catch (cErr) {
                  const detail = cErr.code
                    ? `${cErr.code} ${cErr.message || ''} ${cErr.meta ? JSON.stringify(cErr.meta) : ''}`
                    : (cErr.message || cErr.toString() || 'unknown');
                  console.error(`[knowledge-delete] cascade "${label}" failed:`, detail, cErr);
                  throw new Error(`cascade ${label} failed: ${detail}`);
                }
              };
              await cascade('audit_logs', () =>
                prisma.auditLog.updateMany({
                  where: { resourceId: { in: memoryIds } },
                  data: { resourceId: null },
                })
              );
              await cascade('source_metadata', () =>
                prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: memoryIds } } })
              );
              await cascade('related_memory_versions', () =>
                prisma.memoryVersion.updateMany({
                  where: { relatedMemoryId: { in: memoryIds } },
                  data: { relatedMemoryId: null },
                })
              );
              await cascade('memory_versions', () =>
                prisma.memoryVersion.deleteMany({ where: { memoryId: { in: memoryIds } } })
              );
              await cascade('relationships', () =>
                prisma.relationship.deleteMany({
                  where: { OR: [{ fromId: { in: memoryIds } }, { toId: { in: memoryIds } }] },
                })
              );
              // FK to Memory.id from OTHER memories' versions via related_memory_id.
              // Has no onDelete cascade in schema → restrict → memories.deleteMany fails.
              // Nullify these refs first (audit-safe — they were "see also" pointers).
              await cascade('memory_versions_related_refs', () =>
                prisma.memoryVersion.updateMany({
                  where: { relatedMemoryId: { in: memoryIds } },
                  data: { relatedMemoryId: null },
                })
              );
              // AuditLog.resourceId → Memory.id has no onDelete cascade either.
              // Audit records must outlive deletions (compliance) so we nullify the FK
              // rather than delete the log entries.
              await cascade('audit_log_refs', () =>
                prisma.auditLog.updateMany({
                  where: { resourceId: { in: memoryIds } },
                  data: { resourceId: null },
                })
              );
              await cascade('memories', () =>
                prisma.memory.deleteMany({ where: { id: { in: memoryIds } } })
              );

              // Delete from Qdrant
              try {
                const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
                const qdrantCollection = process.env.QDRANT_COLLECTION || 'hivemind_memories';
                const qdrantKey = process.env.QDRANT_API_KEY || '';
                if (qdrantUrl && memoryIds.length > 0) {
                  await fetch(`${qdrantUrl}/collections/${qdrantCollection}/points/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
                    body: JSON.stringify({ points: memoryIds, wait: true }),
                  });
                }
              } catch (qdrantErr) {
                console.warn('[knowledge-delete] Qdrant delete failed:', qdrantErr.message);
              }

              invalidateAggregateCache({ userId, orgId, project: null });

              console.log(`[knowledge-delete] Deleted ${memoryIds.length} memories for document ${deleteMemoryId || deleteUploadId}`);

              return jsonResponse(res, {
                success: true,
                deleted: memoryIds.length,
                memory_ids: memoryIds,
              });
            } catch (err) {
              console.error('[knowledge-delete] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // ENTERPRISE UPLOAD — Schema-First Extraction
        // ==========================================

        case '/api/enterprise/upload/detect':
          if (req.method === 'POST') {
            // Requires persistent memory (same check as knowledge upload)
            if (!persistentMemoryEngine) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }

            try {
              // Parse multipart (same pattern as /api/knowledge/upload)
              const contentType = req.headers['content-type'] || '';
              if (!contentType.includes('multipart/form-data')) {
                return jsonResponse(res, { error: 'Content-Type must be multipart/form-data' }, 400);
              }
              const boundaryMatch = contentType.match(/boundary=(.+)/);
              if (!boundaryMatch) {
                return jsonResponse(res, { error: 'Missing boundary' }, 400);
              }
              const rawBody = await new Promise((resolve) => {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => resolve(Buffer.concat(chunks)));
              });
              const boundary = boundaryMatch[1].trim();
              const parts = parseMultipart(rawBody, boundary);
              const filePart = parts.find(p => p.filename);
              if (!filePart) {
                return jsonResponse(res, { error: 'No file uploaded' }, 400);
              }

              // Validate size
              if (filePart.data.length > 100 * 1024 * 1024) {
                return jsonResponse(res, { error: 'File too large. Maximum 100MB.' }, 413);
              }

              // Validate file type (add xlsx/xls to existing types)
              const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
              const allowedExts = ['pdf', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls'];
              if (!allowedExts.includes(ext)) {
                return jsonResponse(res, { error: `Unsupported: ${ext}. Allowed: PDF, DOCX, TXT, MD, CSV, XLSX, XLS` }, 415);
              }

              const uploadId = crypto.randomUUID();
              // Write to temp storage immediately instead of keeping raw buffer in RAM.
              const fs = await import('fs');
              const path = await import('path');
              const os = await import('os');
              const tempDir = path.join(os.tmpdir(), 'hivemind-enterprise');
              fs.mkdirSync(tempDir, { recursive: true });
              const tempPath = path.join(tempDir, `${uploadId}_${filePart.filename}`);
              fs.writeFileSync(tempPath, filePart.data);

              let parsedText = '';
              let sheets = null;
              let doclingOutput = null;

              // Try Docling sidecar for rich parsing (non-blocking — fallback on failure)
              try {
                const { parseWithDocling } = await import('./knowledge/enterprise/docling-adapter.js');
                doclingOutput = await parseWithDocling(tempPath, filePart.filename, { smart: true });
                if (doclingOutput.error) {
                  console.warn(`[enterprise] Docling fallback: ${doclingOutput.error}`);
                  doclingOutput = null;
                } else {
                  console.log(`[enterprise] Docling parsed ${filePart.filename}: ${doclingOutput.pages} pages, ${doclingOutput.tables.length} tables`);
                }
              } catch (doclingErr) {
                console.warn(`[enterprise] Docling unavailable: ${doclingErr.message}`);
              }

              // Excel: parse sheets for detection
              if (ext === 'xlsx' || ext === 'xls') {
                const { parseExcelSheets } = await import('./knowledge/enterprise/excel-parser.js');
                sheets = parseExcelSheets(filePart.data);
                // Use all sheet previews combined for type detection
                parsedText = sheets.filter(s => !s.empty).map(s => `Sheet: ${s.name}\n${s.preview}`).join('\n\n');
              } else {
                // Non-Excel: prefer Docling output, fall back to raw parsing
                if (doclingOutput) {
                  parsedText = doclingOutput.text || doclingOutput.markdown;
                }
                if (!parsedText) {
                  const { parseFile } = await import('./knowledge/document-chunker.js');
                  const parsed = await parseFile(
                    filePart.data,
                    filePart.contentType || `text/${ext}`,
                    filePart.filename
                  );
                  parsedText = typeof parsed?.text === 'string'
                    ? parsed.text
                    : String(parsed?.text || '');
                }
              }

              // Run type detection
              const { detectDocumentType, detectExcelSheetTypes } = await import('./knowledge/enterprise/detector.js');
              const { getDefaultModel } = await import('./knowledge/enterprise/litellm-client.js');

              let detected;
              let sheetDetections = null;

              if (sheets) {
                // Excel: detect per-sheet
                sheetDetections = await detectExcelSheetTypes(sheets);
                // Overall type = most common detected type
                const typeCounts = {};
                sheetDetections.forEach(s => { typeCounts[s.detected_type] = (typeCounts[s.detected_type] || 0) + 1; });
                const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'spreadsheet';
                detected = { type: topType, confidence: sheetDetections[0]?.confidence || 0.5, reasoning: 'Excel workbook — per-sheet detection' };
              } else {
                detected = await detectDocumentType(parsedText, { filename: filePart.filename });
              }

              // Store in pending uploads map (10 min TTL)
              if (!global._enterprisePendingUploads) {
                global._enterprisePendingUploads = new Map();
                // Sweep expired entries every minute
                setInterval(() => {
                  const now = Date.now();
                  for (const [id, entry] of global._enterprisePendingUploads) {
                    if (now - entry.createdAt > 10 * 60 * 1000) global._enterprisePendingUploads.delete(id);
                  }
                }, 60_000).unref();
              }

              global._enterprisePendingUploads.set(uploadId, {
                tempPath,
                filename: filePart.filename,
                mimeType: filePart.contentType || `application/${ext}`,
                ext,
                sheets,
                parsedText,
                detectedType: detected.type,
                confidence: detected.confidence,
                doclingOutput,
                buffer: filePart.data, // Phase 1: preserve buffer for document-first path
                createdAt: Date.now(),
              });

              console.log(`[enterprise] Detect id=${uploadId} file=${filePart.filename} type=${detected.type} confidence=${detected.confidence}`);

              return jsonResponse(res, {
                upload_id: uploadId,
                detected_type: detected.type,
                confidence: detected.confidence,
                reasoning: detected.reasoning,
                filename: filePart.filename,
                size_bytes: filePart.data.length,
                sheets: sheetDetections || null,
                model: getDefaultModel(),
                available_types: (await import('./knowledge/enterprise/schemas/index.js')).DOCUMENT_TYPES,
                // Soft-deprecation hint — consolidated path needs only one request.
                deprecation_hint: 'For new code, POST /api/knowledge/upload with form field enterprise=auto|true (single-shot, returns segments+schema fields together).',
              });
            } catch (err) {
              console.error('[enterprise] Detect failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/enterprise/upload/ingest':
          if (req.method === 'POST') {
            if (!persistentMemoryEngine) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }

            const { upload_id, confirmed_type, sheet_configs, tags: ingestTags, targetScope, containerTag, model } = body;

            if (!upload_id) return jsonResponse(res, { error: 'upload_id is required' }, 400);
            if (!confirmed_type) return jsonResponse(res, { error: 'confirmed_type is required' }, 400);

            const pending = global._enterprisePendingUploads?.get(upload_id);
            if (!pending) {
              return jsonResponse(res, { error: 'Upload not found or expired. Please re-upload.' }, 404);
            }

            // Remove from pending
            global._enterprisePendingUploads.delete(upload_id);

            const userTags = ingestTags ? (Array.isArray(ingestTags) ? ingestTags : ingestTags.split(',').map(t => t.trim()).filter(Boolean)) : [];
            const visibility = targetScope === 'organization' ? 'organization' : 'private';
            const project = containerTag || null;
            const projectIds = normalizeScopeIds([
              body.projectId || null,
              ...(Array.isArray(body.project_ids) ? body.project_ids : []),
            ]);
            const primaryTeamId = body.primary_team_id || null;

            // ─── Phase 1: Document-First Enterprise Ingestion (feature-flagged) ───
            if (documentFirstIngestion && pending.buffer) {
              try {
                const result = await documentFirstIngestion.ingestEnterpriseDocument({
                  userId, orgId,
                  filename: pending.filename,
                  fileBuffer: pending.buffer,
                  contentType: pending.mimeType || 'application/octet-stream',
                  schema: { documentType: confirmed_type, title: pending.filename },
                  metadata: {
                    tags: userTags,
                    project,
                    project_id: projectIds[0] || null,
                    project_ids: projectIds,
                    primary_team_id: primaryTeamId,
                    visibility
                  }
                });
                console.log(`[enterprise] Phase1 upload file=${pending.filename} docId=${result.documentId} segments=${result.segmentCount} promoted=${result.promotedCount}`);
                return jsonResponse(res, {
                  job_id: crypto.randomUUID(),
                  upload_id,
                  mode: 'document_first',
                  status: 'completed',
                  confirmed_type,
                  documentId: result.documentId,
                  segmentCount: result.segmentCount,
                  candidateCount: result.candidateCount,
                  promotedCount: result.promotedCount,
                  promotedMemoryIds: result.promotedMemoryIds
                }, 202);
              } catch (phase1Err) {
                console.error('[enterprise] Phase1 upload failed, falling back to legacy path:', phase1Err.message);
                // Fall through to legacy path
              }
            }

            try {
              const { extractSchema } = await import('./knowledge/enterprise/extractor.js');
              const { createEnterpriseMemories } = await import('./knowledge/enterprise/enterprise-chunker.js');
              const { parseSheet } = await import('./knowledge/enterprise/excel-parser.js');

              const isExcel = pending.ext === 'xlsx' || pending.ext === 'xls';
              const results = [];

              // Resolve preferred text source: Docling output > plain parsed text
              const doclingOut = pending.doclingOutput;
              const resolveText = () => {
                if (doclingOut) return doclingOut.text || doclingOut.markdown || pending.parsedText;
                return pending.parsedText;
              };

              if (isExcel && sheet_configs && sheet_configs.length > 0) {
                // Read Excel buffer from temp path if buffer not stored
                const excelBuffer = pending.buffer || (pending.tempPath ? require('fs').readFileSync(pending.tempPath) : null);
                // Process each selected sheet
                for (const sheetConfig of sheet_configs) {
                  if (sheetConfig.include === false) continue;
                  const sheetType = sheetConfig.confirmed_type || confirmed_type;
                  const sheetData = parseSheet(excelBuffer, sheetConfig.sheet_name);

                  const extracted = await extractSchema(sheetData.raw_text, sheetType, { model, filename: `${pending.filename} — ${sheetConfig.sheet_name}` });
                  // For spreadsheets, inject sheet metadata
                  if (sheetType === 'spreadsheet') {
                    extracted.fields.sheet_name = extracted.fields.sheet_name || sheetConfig.sheet_name;
                    extracted.fields.headers = extracted.fields.headers || sheetData.headers;
                    extracted.fields.row_count = extracted.fields.row_count || sheetData.row_count;
                  }

                  const memories = createEnterpriseMemories({
                    documentType: sheetType,
                    extractedSchema: extracted,
                    rawText: sheetData.raw_text,
                    filename: pending.filename,
                    uploadId: upload_id,
                    userId, orgId, project, visibility, userTags,
                    sheetData,
                  });

                  memories.parent.metadata.detection_confidence = pending.confidence;
                  results.push({ sheet: sheetConfig.sheet_name, type: sheetType, ...memories });
                }
              } else {
                // Single document processing — prefer Docling-enriched text
                const text = resolveText();
                const extracted = await extractSchema(text, confirmed_type, { model, filename: pending.filename });
                const memories = createEnterpriseMemories({
                  documentType: confirmed_type,
                  extractedSchema: extracted,
                  rawText: text,
                  filename: pending.filename,
                  uploadId: upload_id,
                  userId, orgId, project, visibility, userTags,
                });
                memories.parent.metadata.detection_confidence = pending.confidence;
                results.push({ type: confirmed_type, ...memories });
              }

              // Background ingestion
              const jobId = crypto.randomUUID();
              let totalMemories = 0;

              console.log(`[enterprise] Ingest job=${jobId} upload=${upload_id} type=${confirmed_type} sheets=${results.length}`);

              (async () => {
                const collectionName = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
                let ingested = 0;
                let failed = 0;

                for (const result of results) {
                  try {
                    // Ingest parent schema memory
                    const parentPayload = { ...result.parent, skip_fact_extraction: true };
                    const [routedParent] = await buildRoutedIngestPayloads(parentPayload, { smartIngestRouter });
                    const parentResult = await persistentMemoryEngine.ingestMemory(routedParent);
                    const parentId = parentResult?.memoryId;
                    console.log(`[enterprise] Parent ingested: id=${parentId} operation=${parentResult?.operation}`);

                    // Embed parent in Qdrant
                    if (parentId && qdrantClient) {
                      try {
                        const mem = await persistentMemoryStore.getMemory(parentId);
                        console.log(`[enterprise] Parent getMemory: found=${!!mem} content_len=${mem?.content?.length} user_id=${mem?.user_id}`);
                        if (mem) {
                          await qdrantClient.storeMemory(mem, { collectionName });
                          console.log(`[enterprise] Parent Qdrant stored: id=${parentId}`);
                        }
                      } catch (e) { console.warn(`[enterprise] Parent embed failed:`, e.message); }
                    } else {
                      console.warn(`[enterprise] Parent Qdrant SKIPPED: parentId=${parentId} qdrantClient=${!!qdrantClient}`);
                    }
                    ingested++;

                    // Ingest child chunks with previous-chunk chaining
                    let prevChunkId = null;
                    for (const chunk of result.chunks) {
                      try {
                        chunk.metadata.parent_schema_id = parentId || null;
                        chunk.metadata.previous_chunk_id = prevChunkId || null;
                        // Route through smart ingest so chunks get deterministic
                        // Extends edges to their parent document.
                        const [routedChunk] = await buildRoutedIngestPayloads(chunk, { smartIngestRouter });
                        // Safety net: force parent→chunk Extends edge if router missed it
                        if (parentId && !routedChunk.relationship && !routedChunk._derives_from) {
                          routedChunk.relationship = 'Extends';
                          routedChunk.related_to = parentId;
                        }
                        const chunkResult = await persistentMemoryEngine.ingestMemory(routedChunk);
                        const chunkMemoryId = chunkResult?.memoryId;
                        // Deterministic previous-chunk edge
                        if (prevChunkId && chunkMemoryId) {
                          try {
                            await persistentMemoryStore.createRelationship({
                              id: crypto.randomUUID(),
                              from_id: chunkMemoryId,
                              to_id: prevChunkId,
                              type: 'Extends',
                              confidence: 0.99,
                              metadata: {
                                auto_structural: true,
                                source: 'enterprise_chunk_chain',
                              },
                              created_by: 'enterprise_ingest',
                            });
                            console.log(`[enterprise] Chunk chain edge: ${chunkMemoryId} -> ${prevChunkId}`);
                          } catch (chainErr) {
                            console.warn('[enterprise] Chunk chain edge failed:', chainErr.message);
                          }
                        }
                        prevChunkId = chunkMemoryId;
                        const routedTargetId = routedChunk.related_to || routedChunk.relationship?.target_id || routedChunk.relationship?.targetId || null;
                        if (parentId && chunkResult?.memoryId && routedTargetId !== parentId) {
                          try {
                            await persistentMemoryStore.createRelationship({
                              id: crypto.randomUUID(),
                              from_id: chunkResult.memoryId,
                              to_id: parentId,
                              type: 'Extends',
                              confidence: 0.99,
                              metadata: {
                                auto_structural: true,
                                source: 'enterprise_parent_fallback',
                              },
                              created_by: 'enterprise_ingest',
                            });
                          } catch (parentEdgeErr) {
                            console.warn('[enterprise] Parent fallback edge failed:', parentEdgeErr.message);
                          }
                        }
                        console.log(`[enterprise] Chunk ingested: id=${chunkResult?.memoryId} operation=${chunkResult?.operation}`);
                        if (chunkResult?.memoryId && qdrantClient) {
                          try {
                            const mem = await persistentMemoryStore.getMemory(chunkResult.memoryId);
                            console.log(`[enterprise] Chunk getMemory: found=${!!mem} content_len=${mem?.content?.length}`);
                            if (mem) {
                              await qdrantClient.storeMemory(mem, { collectionName });
                              console.log(`[enterprise] Chunk Qdrant stored: id=${chunkResult.memoryId}`);
                            }
                          } catch (e) { console.warn(`[enterprise] Chunk embed failed:`, e.message); }
                        }
                        ingested++;
                      } catch (e) {
                        console.warn(`[enterprise] Chunk failed:`, e.message);
                        failed++;
                      }
                    }
                  } catch (err) {
                    console.error(`[enterprise] Sheet processing failed:`, err.message);
                    failed += 1 + result.chunks.length;
                  }
                }

                console.log(`[enterprise] Job ${jobId} complete: ingested=${ingested} failed=${failed}`);
              })();

              for (const r of results) totalMemories += 1 + r.chunks.length;

              return jsonResponse(res, {
                job_id: jobId,
                upload_id,
                status: 'processing',
                confirmed_type,
                memories_queued: totalMemories,
                sheets_processed: results.length,
                schema_fields: results.map(r => ({
                  type: r.type,
                  sheet: r.sheet || null,
                  fields: r.parent.metadata.extracted_schema,
                  summary: r.parent.content,
                })),
              }, 202);
            } catch (err) {
              console.error('[enterprise] Ingest failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/enterprise/model':
          if (req.method === 'GET') {
            try {
              const { getDefaultModel } = await import('./knowledge/enterprise/litellm-client.js');
              const { DOCUMENT_TYPES } = await import('./knowledge/enterprise/schemas/index.js');
              return jsonResponse(res, { model: getDefaultModel(), available_types: DOCUMENT_TYPES });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // KNOWLEDGE BASE — Document Upload
        // ==========================================

        case '/api/knowledge/upload-bulk': {
          // True multi-file multipart endpoint. Accepts N file parts +
          // shared tags/project. Concurrency-limited fanout (default 3).
          if (req.method !== 'POST') break;
          if (!persistentMemoryEngine || !documentFirstIngestion) {
            return jsonResponse(res, { error: 'Bulk ingest requires Phase1' }, 503);
          }
          try {
            const ct = req.headers['content-type'] || '';
            if (!ct.includes('multipart/form-data')) {
              return jsonResponse(res, { error: 'Content-Type must be multipart/form-data' }, 400);
            }
            const bm = ct.match(/boundary=(.+)/);
            if (!bm) return jsonResponse(res, { error: 'Missing boundary' }, 400);
            const raw = await new Promise((resolve) => {
              const c = []; req.on('data', x => c.push(x)); req.on('end', () => resolve(Buffer.concat(c)));
            });
            const parts = parseMultipart(raw, bm[1].trim());
            const fileParts = parts.filter(p => p.filename);
            if (fileParts.length === 0) {
              return jsonResponse(res, { error: 'No files uploaded' }, 400);
            }
            const tagsRaw = parts.find(p => p.name === 'tags')?.value || '';
            const userTags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
            const containerTag = parts.find(p => p.name === 'containerTag')?.value || null;
            const projectIdRaw = parts.find(p => p.name === 'projectId')?.value || null;
            const primaryTeamId = parts.find(p => p.name === 'primaryTeamId')?.value || null;
            const targetScope = parts.find(p => p.name === 'targetScope')?.value === 'organization' ? 'organization' : 'personal';
            const smartFlag = (parts.find(p => p.name === 'smart')?.value || '').toLowerCase() === 'true';

            const CONC = Number(process.env.BULK_INGEST_CONCURRENCY || 3);
            const results = new Array(fileParts.length);
            let i = 0;
            const workers = Array.from({ length: Math.min(CONC, fileParts.length) }, async () => {
              while (true) {
                const idx = i++;
                if (idx >= fileParts.length) return;
                const fp = fileParts[idx];
                try {
                  if (planEnforcer && orgId) {
                    const est = Math.max(1, Math.ceil(fp.data.length / 50_000));
                    const ck = await planEnforcer.checkLimit(orgId, 'kbPages', est);
                    if (!ck.allowed) {
                      results[idx] = { filename: fp.filename, status: 'rejected', reason: ck.reason };
                      continue;
                    }
                  }
                  const r = await documentFirstIngestion.ingestKnowledgeDocument({
                    userId, orgId,
                    filename: fp.filename,
                    fileBuffer: fp.data,
                    contentType: fp.contentType || 'application/octet-stream',
                    metadata: {
                      tags: userTags,
                      project: containerTag,
                      project_id: projectIdRaw,
                      project_ids: projectIdRaw ? [projectIdRaw] : [],
                      primary_team_id: primaryTeamId,
                      visibility: targetScope === 'organization' ? 'organization' : 'private',
                      smart: smartFlag,
                    },
                  });
                  if (planEnforcer && orgId) {
                    planEnforcer.recordUsage(orgId, 'kbPages', r.pages || r.segmentCount || 1);
                    planEnforcer.recordUsage(orgId, 'uploads', 1);
                  }
                  results[idx] = {
                    filename: fp.filename, status: 'ingested',
                    documentId: r.documentId, segmentCount: r.segmentCount,
                    promotedCount: r.promotedCount,
                  };
                } catch (perFileErr) {
                  results[idx] = { filename: fp.filename, status: 'error', error: perFileErr.message };
                }
              }
            });
            await Promise.all(workers);
            const summary = {
              total: fileParts.length,
              ingested: results.filter(r => r?.status === 'ingested').length,
              rejected: results.filter(r => r?.status === 'rejected').length,
              errored: results.filter(r => r?.status === 'error').length,
            };
            return jsonResponse(res, { summary, files: results });
          } catch (err) {
            return jsonResponse(res, { error: err.message }, 500);
          }
        }

        case '/api/knowledge/upload':
          if (req.method === 'POST') {
            if (!persistentMemoryEngine) {
              return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
            }

            try {
              // Parse multipart form data manually (no external dep)
              const contentType = req.headers['content-type'] || '';
              if (!contentType.includes('multipart/form-data')) {
                return jsonResponse(res, { error: 'Content-Type must be multipart/form-data' }, 400);
              }

              const boundaryMatch = contentType.match(/boundary=(.+)/);
              if (!boundaryMatch) {
                return jsonResponse(res, { error: 'Missing boundary in Content-Type' }, 400);
              }

              const rawBody = await new Promise((resolve) => {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => resolve(Buffer.concat(chunks)));
              });

              // Simple multipart parser
              const boundary = boundaryMatch[1].trim();
              const parts = parseMultipart(rawBody, boundary);

              const filePart = parts.find(p => p.filename);
              if (!filePart) {
                return jsonResponse(res, { error: 'No file uploaded. Send a file field in multipart form data.' }, 400);
              }

              // Extract optional form fields
              const containerTag = parts.find(p => p.name === 'containerTag')?.value || null;
              const targetScope = parts.find(p => p.name === 'targetScope')?.value === 'organization'
                ? 'organization'
                : 'personal';
              const customTags = parts.find(p => p.name === 'tags')?.value || '';
              const userTags = customTags ? customTags.split(',').map(t => t.trim()).filter(Boolean) : [];
              const projectId = parts.find(p => p.name === 'projectId')?.value || null;
              const projectIdsRaw = parts.find(p => p.name === 'projectIds')?.value || '';
              const primaryTeamId = parts.find(p => p.name === 'primaryTeamId')?.value || null;
              const projectIds = normalizeScopeIds([
                projectId,
                ...projectIdsRaw.split(',').map(value => value.trim()).filter(Boolean),
              ]);

              // Validate file size (max 100MB)
              if (filePart.data.length > 100 * 1024 * 1024) {
                return jsonResponse(res, { error: 'File too large. Maximum 100MB.' }, 413);
              }

              // Validate file type
              const allowedTypes = [
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
                'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
                'application/vnd.ms-excel', // xls
                'application/vnd.ms-powerpoint', // ppt
                'text/plain', 'text/markdown', 'text/csv', 'text/html',
                'image/png', 'image/jpeg', 'image/tiff', 'image/webp',
                'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a',
              ];
              const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
              const allowedExts = [
                'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
                'txt', 'md', 'markdown', 'csv', 'tsv', 'html', 'htm',
                'png', 'jpg', 'jpeg', 'tiff', 'tif', 'webp',
                'mp3', 'wav', 'm4a', 'flac', 'ogg',
              ];
              if (!allowedTypes.includes(filePart.contentType) && !allowedExts.includes(ext)) {
                return jsonResponse(res, {
                  error: `Unsupported file type: ${filePart.contentType || ext}. Allowed: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML, PNG, JPG, TIFF, MP3, WAV.`
                }, 415);
              }

              // Read smart flag — when true, force Docling smart-mode parse
              // (full enrichment: tables, charts, picture descriptions via
              // Groq VLM, code/formula extraction). Default false = fast tiers.
              const smartFlag = (parts.find(p => p.name === 'smart')?.value || '').toLowerCase() === 'true';
              const pictureDescFlag = (parts.find(p => p.name === 'picture_descriptions')?.value || '').toLowerCase() === 'true';
              // enterprise = 'auto' | 'true' | 'false'  (default 'auto')
              //   auto  → detect type; if confidence≥0.7 run schema extract
              //   true  → force schema extract even on low confidence
              //   false → skip enterprise pipeline entirely (legacy behavior)
              const enterpriseFlag = (parts.find(p => p.name === 'enterprise')?.value || 'auto').toLowerCase();
              const confirmedType = parts.find(p => p.name === 'confirmed_type')?.value || null;

              // Pre-flight pages quota: rough estimate by file size (1 page ≈ 50KB
              // PDF / 5KB text). Real page count comes after parse; we record
              // exact then. This pre-check is a cheap "blow up obvious overages".
              if (planEnforcer && orgId) {
                const estPages = Math.max(1, Math.ceil(filePart.data.length / 50_000));
                const check = await planEnforcer.checkLimit(orgId, 'kbPages', estPages);
                if (!check.allowed) {
                  return jsonResponse(res, {
                    error: 'page_budget_exceeded',
                    reason: check.reason,
                    limit: check.limit,
                    current: check.current,
                    estimated_pages: estPages,
                  }, 402);
                }
              }

              // ─── Phase 1: Document-First Ingestion Path (feature-flagged) ───
              if (documentFirstIngestion) {
                console.log(`[knowledge] Using Phase 1 document-first ingestion for ${filePart.filename}${smartFlag ? ' (smart=true)' : ''}`);
                const tPhase1 = Date.now();
                try {
                  const result = await documentFirstIngestion.ingestKnowledgeDocument({
                    userId, orgId,
                    filename: filePart.filename,
                    fileBuffer: filePart.data,
                    contentType: filePart.contentType || `text/${ext}`,
                    metadata: {
                      tags: userTags,
                      project: containerTag,
                      project_id: projectIds[0] || null,
                      project_ids: projectIds,
                      primary_team_id: primaryTeamId,
                      visibility: targetScope === 'organization' ? 'organization' : 'private',
                      smart: smartFlag,
                      picture_descriptions: pictureDescFlag,
                    }
                  });
                  console.log(`[knowledge] ✓ Phase1 complete: file=${filePart.filename} docId=${result.documentId} segments=${result.segmentCount} promoted=${result.promotedCount} ms=${Date.now() - tPhase1}`);
                  // Record actual page usage. Use segmentCount as a page-proxy
                  // when real pages unknown (txt/csv/etc).
                  if (planEnforcer && orgId) {
                    const realPages = result.pages || result.segmentCount || 1;
                    planEnforcer.recordUsage(orgId, 'kbPages', realPages);
                    planEnforcer.recordUsage(orgId, 'uploads', 1);
                  }
                  // ─── Enterprise schema extraction (auto|true) ───
                  let enterprise = null;
                  if (enterpriseFlag !== 'false') {
                    try {
                      const [{ detectDocumentType }, { extractSchema }] = await Promise.all([
                        import('./knowledge/enterprise/detector.js'),
                        import('./knowledge/enterprise/extractor.js'),
                      ]);
                      // Pull representative text from segments
                      const segText = (await prisma.knowledgeSegment.findMany({
                        where: { documentId: result.documentId },
                        orderBy: { segmentIndex: 'asc' },
                        take: 4,
                        select: { content: true },
                      })).map(s => s.content).join('\n\n');
                      const detection = confirmedType
                        ? { type: confirmedType, confidence: 1.0, reasoning: 'caller-confirmed' }
                        : await detectDocumentType(segText, { filename: filePart.filename });
                      const shouldExtract = enterpriseFlag === 'true'
                        || (enterpriseFlag === 'auto' && detection.type !== 'general' && (detection.confidence ?? 0) >= 0.7);
                      if (shouldExtract) {
                        const extracted = await extractSchema(segText, detection.type, {
                          filename: filePart.filename,
                        });
                        enterprise = {
                          detected_type: detection.type,
                          confidence: detection.confidence,
                          reasoning: detection.reasoning,
                          schema_fields: extracted,
                        };
                        console.log(`[knowledge] enterprise extract type=${detection.type} conf=${detection.confidence.toFixed(2)} fields=${Object.keys(extracted || {}).length}`);
                      } else {
                        enterprise = {
                          detected_type: detection.type,
                          confidence: detection.confidence,
                          extracted: false,
                          reason: 'confidence below 0.7 — pass enterprise=true to force',
                        };
                      }
                    } catch (entErr) {
                      console.warn(`[knowledge] enterprise extract failed (non-fatal): ${entErr.message}`);
                    }
                  }
                  return jsonResponse(res, {
                    upload_id: crypto.randomUUID(),
                    filename: filePart.filename,
                    mode: 'document_first',
                    documentId: result.documentId,
                    segmentCount: result.segmentCount,
                    candidateCount: result.candidateCount,
                    promotedCount: result.promotedCount,
                    promotedMemoryIds: result.promotedMemoryIds,
                    ...(enterprise ? { enterprise } : {}),
                  });
                } catch (phase1Err) {
                  console.error('[knowledge] ✗ Phase1 failed, falling back to legacy:', phase1Err.message, phase1Err.stack);
                  // Fall through to legacy path
                }
              } else {
                console.log(`[knowledge] Phase 1 disabled (ENABLE_DOCUMENT_FIRST_INGEST=${process.env.ENABLE_DOCUMENT_FIRST_INGEST}), using legacy path`);
              }

              const { processDocument } = await import('./knowledge/document-chunker.js');
              const { summary, chunks } = await processDocument(
                filePart.data,
                filePart.contentType || `text/${ext}`,
                filePart.filename,
                {
                  user_id: userId,
                  org_id: orgId,
                  project: containerTag,
                  tags: userTags,
                  visibility: targetScope === 'organization' ? 'organization' : 'private',
                }
              );

              // Ingest summary + chunks in background, return immediately
              const uploadId = crypto.randomUUID();

              // ── Optimization 1: Document-level fingerprint dedup ──
              // Compute SHA256 of file bytes. If any existing memory for this user
              // carries this doc-hash tag, skip ingestion entirely. Avoids running
              // smart ingest for re-uploaded identical files.
              const docHash = crypto.createHash('sha256').update(filePart.data).digest('hex').slice(0, 16);
              const docHashTag = `doc-hash:${docHash}`;
              try {
                const existing = await prisma.memory.findFirst({
                  where: {
                    userId,
                    deletedAt: null,
                    tags: { has: docHashTag },
                  },
                  select: { id: true, title: true, createdAt: true },
                });
                if (existing) {
                  console.log(`[knowledge] Upload id=${uploadId} file=${filePart.filename} DEDUPED via ${docHashTag} → existing ${existing.id}`);
                  return jsonResponse(res, {
                    upload_id: uploadId,
                    filename: filePart.filename,
                    chunks: 0,
                    deduped: true,
                    existing_memory_id: existing.id,
                    message: 'Identical document already ingested. Skipping re-processing.',
                  });
                }
              } catch (dedupErr) {
                console.warn(`[knowledge] doc-hash dedup check failed (non-fatal):`, dedupErr.message);
              }

              // Tag every memory we create with the doc-hash so future re-uploads dedupe.
              const taggedSummary = { ...summary, tags: [...(summary.tags || []), docHashTag] };
              const taggedChunks = chunks.map(c => ({ ...c, tags: [...(c.tags || []), docHashTag] }));

              console.log(`[knowledge] Upload id=${uploadId} file=${filePart.filename} chunks=${chunks.length} docHash=${docHash}`);

              // Start background ingestion — smart ingest preserved + optimized.
              (async () => {
                let ingested = 0;
                let failed = 0;
                const collectionName = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';

                // ── Optimization 2: Pre-embed all chunks IN PARALLEL before
                //   acquiring per-user advisory lock. Embedding is the slow part
                //   (200ms/chunk via Mistral). Doing it in parallel before
                //   smart-ingest critical section means the lock holds for
                //   conflict-detect + relationship work only — not embedding.
                const preEmbed = async (text) => {
                  if (!qdrantClient || !text) return null;
                  try {
                    return await qdrantClient.generateEmbedding(String(text).slice(0, 8000));
                  } catch (embedErr) {
                    console.warn(`[knowledge] Pre-embed failed (non-fatal):`, embedErr.message);
                    return null;
                  }
                };

                const allPayloads = [
                  { ...taggedSummary, skip_fact_extraction: true },
                  ...taggedChunks,
                ];

                console.log(`[knowledge] Upload ${uploadId} pre-embedding ${allPayloads.length} chunks in parallel...`);
                const t0 = Date.now();
                const vectors = await Promise.all(
                  allPayloads.map(p => preEmbed(p.content))
                );
                console.log(`[knowledge] Upload ${uploadId} pre-embed done in ${Date.now() - t0}ms`);

                // ── Optimization 3: Batch Qdrant upserts. Collect every memory
                //   created during smart ingest, then upsert in one bulk call
                //   instead of N round-trips.
                const qdrantBatch = [];

                const ingestOne = async (payload, precomputedVector) => {
                  // Pass cached vector via `precomputedQueryVector` so graph-engine
                  // can use it for Qdrant dedup search inside the lock without
                  // re-embedding. Falls back to live embedding if missing.
                  const basePayload = precomputedVector
                    ? { ...payload, precomputedQueryVector: precomputedVector }
                    : payload;
                  const [enriched] = await buildRoutedIngestPayloads(basePayload, { smartIngestRouter });
                  const result = await persistentMemoryEngine.ingestMemory(enriched);

                  // Collect memories for batch Qdrant upsert (not per-chunk write)
                  if (result?.memoryId && qdrantClient) {
                    const memory = await persistentMemoryStore.getMemory(result.memoryId);
                    if (memory) {
                      qdrantBatch.push({ memory, vector: precomputedVector || null });
                    }
                  }
                  if (result?.factMemoryIds?.length > 0 && qdrantClient) {
                    for (const factId of result.factMemoryIds) {
                      const factMem = await persistentMemoryStore.getMemory(factId);
                      if (factMem) qdrantBatch.push({ memory: factMem, vector: null });
                    }
                  }
                };

                try {
                  // Summary first (no-process), then chunks in order.
                  for (let i = 0; i < allPayloads.length; i++) {
                    try {
                      await ingestOne(allPayloads[i], vectors[i]);
                      ingested++;
                    } catch (chunkErr) {
                      console.warn(`[knowledge] Chunk ${i} failed:`, chunkErr.message);
                      failed++;
                    }
                  }

                  // Bulk Qdrant upsert — single network roundtrip per batch
                  if (qdrantBatch.length > 0 && qdrantClient) {
                    try {
                      const batchT0 = Date.now();
                      await Promise.all(qdrantBatch.map(({ memory, vector }) =>
                        qdrantClient.storeMemory(memory, { collectionName, vector })
                          .catch(err => console.warn(`[knowledge] Qdrant store ${memory.id} failed:`, err.message))
                      ));
                      console.log(`[knowledge] Upload ${uploadId} Qdrant batch (${qdrantBatch.length}) in ${Date.now() - batchT0}ms`);
                    } catch (batchErr) {
                      console.warn(`[knowledge] Qdrant batch failed:`, batchErr.message);
                    }
                  }

                  console.log(`[knowledge] Upload ${uploadId} complete: ingested=${ingested}, failed=${failed}, qdrant=${collectionName}`);
                } catch (err) {
                  console.error(`[knowledge] Upload ${uploadId} failed:`, err.message);
                }
              })();

              return jsonResponse(res, {
                upload_id: uploadId,
                filename: filePart.filename,
                size_bytes: filePart.data.length,
                chunks: chunks.length + 1, // +1 for summary
                status: 'processing',
                message: `Document "${filePart.filename}" uploaded. ${chunks.length} chunks + 1 summary being ingested.`,
              });
            } catch (err) {
              console.error('[knowledge] Upload failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ==========================================
        // CONNECTOR FRAMEWORK SYNC (Provider-agnostic)
        // ==========================================
        case '/api/connectors/sync':
          if (req.method === 'POST') {
            if (!persistentMemoryEngine || !persistentMemoryStore) {
              return jsonResponse(res, { error: 'Persistent memory unavailable' }, 503);
            }
            try {
              const provider = body.provider;
              const syncUserId = body.user_id || userId;
              const syncOrgId = body.org_id || orgId;

              // Dynamically load provider adapter
              const adapterModules = {
                gmail: './connectors/providers/gmail/adapter.js',
              };
              const adapterPath = adapterModules[provider];
              if (!adapterPath) {
                return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
              }

              const mod = await import(adapterPath);
              const AdapterClass = mod.GmailAdapter || mod.default;
              const adapter = new AdapterClass();

              // Build sync engine
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
              const cStore = new ConnectorStore(prisma);
              const syncEngine = new SyncEngine({
                connectorStore: cStore,
                memoryEngine: persistentMemoryEngine,
                memoryStore: persistentMemoryStore,
                prisma,
                smartIngestRouter,
                externalRefStore,
                entityResolver,
              });

              // Run sync in background
              const incremental = body.incremental !== false;
              const cursor = body.cursor || null;

              setImmediate(async () => {
                try {
                  const result = await syncEngine.runSync({
                    adapter,
                    userId: syncUserId,
                    orgId: syncOrgId,
                    provider,
                    cursor,
                    incremental,
                  });
                  console.log(`[connector-sync] ${provider}:${syncUserId} → ${result.status} (imported: ${result.imported}, skipped: ${result.skipped})`);
                } catch (syncErr) {
                  console.error(`[connector-sync] ${provider}:${syncUserId} failed:`, syncErr.message);
                }
              });

              return jsonResponse(res, { success: true, message: 'Sync enqueued', provider }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // ==========================================
        // CONNECTOR SYNC SCHEDULE STATUS
        // ==========================================
        case '/api/connectors/sync/schedule':
          if (req.method === 'GET') {
            if (!syncScheduler) {
              return jsonResponse(res, { error: 'Sync scheduler not initialized' }, 503);
            }
            return jsonResponse(res, syncScheduler.getStats());
          }
          break;

        // ==========================================
        // WEB INTELLIGENCE (Search + Crawl)
        // ==========================================
        case '/api/web/search/jobs':
          if (req.method === 'POST') {
            // Web search open to all authenticated users (entitlement gate removed — all keys get access)
            try {
              // Rate limit check
              const rlCheck = webRateLimiter.check(userId);
              if (!rlCheck.allowed) {
                return jsonResponse(res, { error: 'Rate limit exceeded', code: 'rate_limited', retry_after_ms: rlCheck.retryAfterMs }, 429);
              }

              // Plan enforcement: check daily web intel limit
              if (planEnforcer && orgId) {
                const webIntelCheck = await planEnforcer.checkLimit(orgId, 'webIntel', 1);
                if (!webIntelCheck.allowed) {
                  return jsonResponse(res, {
                    error: 'Plan limit exceeded',
                    message: webIntelCheck.reason,
                    limit: webIntelCheck.limit,
                    current: webIntelCheck.current,
                    plan: webIntelCheck.plan
                  }, 403);
                }
              }

              const usage = await webJobStore.getUsage(userId);
              if (usage.web_search_requests >= WEB_SEARCH_DAILY_LIMIT) {
                return jsonResponse(res, { error: 'Daily search quota exceeded', code: 'quota_exceeded', limit: WEB_SEARCH_DAILY_LIMIT, used: usage.web_search_requests }, 429);
              }
              // Monthly limit check
              const limits = await webJobStore.checkLimits(userId);
              if (limits.monthly.search.exceeded) {
                return jsonResponse(res, { error: 'Monthly search quota exceeded', code: 'monthly_quota_exceeded', limit: limits.monthly.search.hard, used: limits.monthly.search.used }, 429);
              }
              const { query, domains, limit: searchLimit } = body;
              if (!query) {
                return jsonResponse(res, { error: 'query is required' }, 400);
              }
              // Abuse detection
              const abuseCheck = detectAbuse({ userId, type: 'search', query, recentJobCount: usage.web_search_requests });
              if (abuseCheck.action === 'block') {
                return jsonResponse(res, { error: 'Request blocked', code: 'abuse_detected', reason: abuseCheck.reason }, 403);
              }
              webRateLimiter.record(userId);
              const job = await webJobStore.create({ type: 'search', params: { query, domains: domains || [], limit: searchLimit || 10 }, userId, orgId });
              setImmediate(async () => {
                try {
                  await webJobStore.update(job.id, { status: 'running' });
                  const result = await browserRuntime.search({ query, domains: domains || [], limit: searchLimit || 10 });
                  const resultCount = Array.isArray(result.results) ? result.results.length : 0;
                  const errors = Array.isArray(result.errors) ? result.errors : [];
                  if (resultCount === 0 && errors.length > 0) {
                    await webJobStore.update(job.id, {
                      status: 'failed',
                      error: errors[0]?.error || 'search_failed',
                      runtime_used: result.runtime_used,
                      fallback_applied: result.fallback_applied,
                      duration_ms: result.duration_ms,
                      pages_processed: 0,
                      results: []
                    });
                    return;
                  }
                  await webJobStore.update(job.id, {
                    status: 'succeeded',
                    results: result.results,
                    runtime_used: result.runtime_used,
                    fallback_applied: result.fallback_applied,
                    duration_ms: result.duration_ms,
                  });

                  // Record web intel usage
                  if (planEnforcer && orgId) {
                    planEnforcer.recordUsage(orgId, 'webIntel', 1);
                  }
                } catch (err) {
                  await webJobStore.update(job.id, { status: 'failed', error: err.message });
                  console.error(`[web-search] job ${job.id} failed:`, err.message);
                }
              });
              return jsonResponse(res, { job_id: job.id, status: 'queued', type: 'search' }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // Tavily Research — async comprehensive report with citations.
        // Submits a research task, polls Tavily until status='completed',
        // stores final markdown report + sources[] in job.results so the
        // existing job list/polling FE keeps working unchanged.
        case '/api/web/research/jobs':
          if (req.method === 'POST') {
            try {
              const rlCheck = webRateLimiter.check(userId);
              if (!rlCheck.allowed) {
                return jsonResponse(res, { error: 'Rate limit exceeded', code: 'rate_limited', retry_after_ms: rlCheck.retryAfterMs }, 429);
              }
              if (planEnforcer && orgId) {
                const webIntelCheck = await planEnforcer.checkLimit(orgId, 'webIntel', 1);
                if (!webIntelCheck.allowed) {
                  return jsonResponse(res, { error: 'Plan limit exceeded', message: webIntelCheck.reason, limit: webIntelCheck.limit, current: webIntelCheck.current, plan: webIntelCheck.plan }, 403);
                }
              }
              // Reuse the search quota (research counts as a heavier search).
              const usage = await webJobStore.getUsage(userId);
              if (usage.web_search_requests >= WEB_SEARCH_DAILY_LIMIT) {
                return jsonResponse(res, { error: 'Daily research quota exceeded', code: 'quota_exceeded', limit: WEB_SEARCH_DAILY_LIMIT, used: usage.web_search_requests }, 429);
              }

              const { input, model = 'auto', citation_format = 'numbered' } = body;
              if (!input || typeof input !== 'string') {
                return jsonResponse(res, { error: 'input is required' }, 400);
              }

              webRateLimiter.record(userId);
              const job = await webJobStore.create({
                type: 'research',
                params: { input, model, citation_format },
                userId,
                orgId,
              });

              setImmediate(async () => {
                const STREAM_TIMEOUT_MS = 8 * 60 * 1000; // 8min hard cap
                const PERSIST_THROTTLE_MS = 800;
                const started = Date.now();
                try {
                  await webJobStore.update(job.id, { status: 'running', progress: [] });

                  const { getTavilyClient } = await import('./web/tavily-client.js');
                  const tv = getTavilyClient();
                  if (!tv.isAvailable()) {
                    throw new Error('Tavily API key not configured');
                  }

                  // Consume the SSE stream from Tavily Research. Each event
                  // either: (a) names a tool call (Planning / WebSearch /
                  // ResearchSubtopic / Generating), (b) carries a tool
                  // response with discovered sources, (c) streams content
                  // chunks of the final markdown, or (d) emits a final
                  // sources array. Persist progress incrementally so the
                  // FE polling loop can render the run as it happens.
                  const progress = [];
                  let contentBuf = '';
                  let finalSources = [];
                  let lastPersist = 0;

                  const persist = async (force = false) => {
                    if (!force && Date.now() - lastPersist < PERSIST_THROTTLE_MS) return;
                    lastPersist = Date.now();
                    await webJobStore.update(job.id, {
                      progress,
                      partial_content: contentBuf,
                      partial_sources: finalSources,
                    });
                  };

                  const watchdog = setTimeout(() => {
                    throw new Error('Research stream timeout — 8min cap reached');
                  }, STREAM_TIMEOUT_MS);

                  try {
                    for await (const evt of tv.researchStream({
                      input,
                      model,
                      citationFormat: citation_format,
                    })) {
                      if (evt?.kind === 'done') break;
                      const delta = evt?.choices?.[0]?.delta;
                      if (!delta) continue;

                      // Tool calls / responses → progress timeline rows.
                      if (delta.tool_calls) {
                        const tc = delta.tool_calls;
                        const kind = tc.type; // 'tool_call' | 'tool_response'
                        const list = (tc.tool_call || tc.tool_response || []);
                        for (const t of list) {
                          progress.push({
                            ts: Date.now(),
                            kind,
                            tool: t.name,
                            id: t.id,
                            parent_id: t.parent_tool_call_id || null,
                            arguments: t.arguments || null,
                            queries: Array.isArray(t.queries) ? t.queries : undefined,
                            sources: Array.isArray(t.sources) ? t.sources.slice(0, 25) : undefined,
                          });
                        }
                      }

                      // Streaming content chunks.
                      if (typeof delta.content === 'string') {
                        contentBuf += delta.content;
                      } else if (delta.content && typeof delta.content === 'object') {
                        // Structured output: replace each chunk; usually a
                        // single object arrives in one event.
                        contentBuf = JSON.stringify(delta.content, null, 2);
                      }

                      // Final aggregate sources event.
                      if (Array.isArray(delta.sources)) {
                        finalSources = delta.sources;
                      }

                      await persist(false);
                    }
                  } finally {
                    clearTimeout(watchdog);
                  }

                  // If the stream ended without emitting an aggregate sources
                  // event, gather them from the tool_response progress rows.
                  if (finalSources.length === 0) {
                    const seen = new Set();
                    for (const p of progress) {
                      if (p.kind === 'tool_response' && Array.isArray(p.sources)) {
                        for (const s of p.sources) {
                          if (!s?.url || seen.has(s.url)) continue;
                          seen.add(s.url);
                          finalSources.push(s);
                        }
                      }
                    }
                  }

                  const reportText = contentBuf || '_No report content returned._';
                  const reportTitle = deriveResearchTitle(input, reportText);

                  await webJobStore.update(job.id, {
                    status: 'succeeded',
                    duration_ms: Date.now() - started,
                    runtime_used: 'tavily-research',
                    fallback_applied: false,
                    progress,
                    partial_content: contentBuf,
                    partial_sources: finalSources,
                    results: [{
                      type: 'research_report',
                      title: reportTitle,
                      content: reportText,
                      sources: finalSources,
                      model,
                      citation_format,
                    }],
                  });

                  if (planEnforcer && orgId) {
                    planEnforcer.recordUsage(orgId, 'webIntel', 1);
                  }
                } catch (err) {
                  await webJobStore.update(job.id, { status: 'failed', error: err.message });
                  console.error(`[web-research] job ${job.id} failed:`, err.message);
                }
              });

              return jsonResponse(res, { job_id: job.id, status: 'queued', type: 'research' }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/web/crawl/jobs':
          if (req.method === 'POST') {
            // Web crawl open to all authenticated users (entitlement gate removed — all keys get access)
            try {
              // Rate limit check
              const rlCheck = webRateLimiter.check(userId);
              if (!rlCheck.allowed) {
                return jsonResponse(res, { error: 'Rate limit exceeded', code: 'rate_limited', retry_after_ms: rlCheck.retryAfterMs }, 429);
              }

              // Plan enforcement: check daily web intel limit
              if (planEnforcer && orgId) {
                const webIntelCheck = await planEnforcer.checkLimit(orgId, 'webIntel', 1);
                if (!webIntelCheck.allowed) {
                  return jsonResponse(res, {
                    error: 'Plan limit exceeded',
                    message: webIntelCheck.reason,
                    limit: webIntelCheck.limit,
                    current: webIntelCheck.current,
                    plan: webIntelCheck.plan
                  }, 403);
                }
              }

              const usage = await webJobStore.getUsage(userId);
              if (usage.web_crawl_pages >= WEB_CRAWL_DAILY_LIMIT) {
                return jsonResponse(res, { error: 'Daily crawl quota exceeded', code: 'quota_exceeded', limit: WEB_CRAWL_DAILY_LIMIT, used: usage.web_crawl_pages }, 429);
              }
              // Monthly limit check
              const limits = await webJobStore.checkLimits(userId);
              if (limits.monthly.crawl.exceeded) {
                return jsonResponse(res, { error: 'Monthly crawl quota exceeded', code: 'monthly_quota_exceeded', limit: limits.monthly.crawl.hard, used: limits.monthly.crawl.used }, 429);
              }
              const { urls, depth, page_limit: pageLimit, include, exclude } = body;
              if (!urls || !Array.isArray(urls) || urls.length === 0) {
                return jsonResponse(res, { error: 'urls array is required' }, 400);
              }
              const normalizedInputUrls = urls.map((u) => normalizeWebUrl(u) || u);
              // Domain policy validation
              const domainErrors = [];
              for (const u of normalizedInputUrls) {
                const domainCheck = validateDomain(u);
                if (!domainCheck.allowed) domainErrors.push({ url: u, reason: domainCheck.reason });
              }
              if (domainErrors.length === normalizedInputUrls.length) {
                return jsonResponse(res, { error: 'All URLs blocked by policy', code: 'domain_blocked', details: domainErrors }, 403);
              }
              // Abuse detection
              const abuseCheck = detectAbuse({ userId, type: 'crawl', urls, recentJobCount: usage.web_crawl_pages });
              if (abuseCheck.action === 'block') {
                return jsonResponse(res, { error: 'Request blocked', code: 'abuse_detected', reason: abuseCheck.reason }, 403);
              }
              webRateLimiter.record(userId);
              // Filter allowed URLs
              const allowedUrls = domainErrors.length > 0
                ? normalizedInputUrls.filter(u => !domainErrors.find(e => e.url === u))
                : normalizedInputUrls;
              const requestedPageLimit = Number(pageLimit ?? 50);
              const normalizedPageLimit = Number.isFinite(requestedPageLimit) && requestedPageLimit > 0 ? requestedPageLimit : 50;
              const effectiveDepth = Number.isFinite(Number(depth)) ? Number(depth) : 1;
              const effectivePageLimit = Math.min(normalizedPageLimit, WEB_CRAWL_DAILY_LIMIT - usage.web_crawl_pages);
              const job = await webJobStore.create({ type: 'crawl', params: { urls: allowedUrls, depth: effectiveDepth, pageLimit: effectivePageLimit, include, exclude, domain_warnings: domainErrors }, userId, orgId });
              setImmediate(async () => {
                try {
                  await webJobStore.update(job.id, { status: 'running' });
                  const result = await browserRuntime.crawl({ urls: allowedUrls, depth: effectiveDepth, pageLimit: effectivePageLimit, include, exclude });
                  const pagesProcessed = Array.isArray(result.pages) ? result.pages.length : 0;
                  const errors = Array.isArray(result.errors) ? result.errors : [];
                  if (pagesProcessed === 0 && errors.length > 0) {
                    await webJobStore.update(job.id, {
                      status: 'failed',
                      error: errors[0]?.error || 'crawl_failed',
                      runtime_used: result.runtime_used,
                      fallback_applied: result.fallback_applied,
                      duration_ms: result.duration_ms,
                      pages_processed: 0,
                      results: []
                    });
                    return;
                  }
                  await webJobStore.update(job.id, {
                    status: 'succeeded',
                    results: result.pages,
                    runtime_used: result.runtime_used,
                    fallback_applied: result.fallback_applied,
                    duration_ms: result.duration_ms,
                    pages_processed: pagesProcessed,
                  });
                } catch (err) {
                  await webJobStore.update(job.id, { status: 'failed', error: err.message });
                  console.error(`[web-crawl] job ${job.id} failed:`, err.message);
                }
              });
              return jsonResponse(res, { job_id: job.id, status: 'queued', type: 'crawl' }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/web/jobs':
          if (req.method === 'GET') {
            try {
              const listType = url.searchParams.get('type') || undefined;
              const listLimit = Number(url.searchParams.get('limit') || 50);
              const jobs = await webJobStore.list({ userId, orgId }, { limit: listLimit, type: listType });
              return jsonResponse(res, { jobs });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/web/usage':
          if (req.method === 'GET') {
            try {
              const usage = await webJobStore.getUsage(userId);
              const now = new Date();
              const resetAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
              return jsonResponse(res, {
                web_search_requests: { used: usage.web_search_requests, limit: WEB_SEARCH_DAILY_LIMIT, reset_at: resetAt },
                web_crawl_pages: { used: usage.web_crawl_pages, limit: WEB_CRAWL_DAILY_LIMIT, reset_at: resetAt },
              });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case pathname.match(/^\/api\/web\/jobs\/([^/]+)$/)?.input: {
          if (req.method === 'GET') {
            try {
              const jobId = pathname.match(/^\/api\/web\/jobs\/([^/]+)$/)[1];
              const job = await webJobStore.get(jobId, { userId, orgId });
              if (!job) {
                return jsonResponse(res, { error: 'Job not found' }, 404);
              }
              return jsonResponse(res, job);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;
        }

        // Retry a failed web job
        case pathname.match(/^\/api\/web\/jobs\/([^/]+)\/retry$/)?.input: {
          if (req.method === 'POST') {
            try {
              const jobId = pathname.match(/^\/api\/web\/jobs\/([^/]+)\/retry$/)[1];
              const newJob = await webJobStore.retry(jobId, { userId, orgId });
              if (!newJob) {
                return jsonResponse(res, { error: 'Job not found or not retryable (must be failed)' }, 400);
              }
              // Re-execute the job
              setImmediate(async () => {
                try {
                  await webJobStore.update(newJob.id, { status: 'running' });
                  const p = newJob.params;
                  const result = newJob.type === 'search'
                    ? await browserRuntime.search({ query: p.query, domains: p.domains || [], limit: p.limit || 10 })
                    : await browserRuntime.crawl({ urls: p.urls, depth: p.depth || 1, pageLimit: p.pageLimit || 50, include: p.include, exclude: p.exclude });
                  const items = newJob.type === 'search' ? result.results : result.pages;
                  const count = Array.isArray(items) ? items.length : 0;
                  const errors = Array.isArray(result.errors) ? result.errors : [];
                  if (count === 0 && errors.length > 0) {
                    await webJobStore.update(newJob.id, { status: 'failed', error: errors[0]?.error || `${newJob.type}_failed`, runtime_used: result.runtime_used, fallback_applied: result.fallback_applied, duration_ms: result.duration_ms, pages_processed: 0, results: [] });
                  } else {
                    await webJobStore.update(newJob.id, { status: 'succeeded', results: items, runtime_used: result.runtime_used, fallback_applied: result.fallback_applied, duration_ms: result.duration_ms, pages_processed: newJob.type === 'crawl' ? count : undefined });

                    // Record web intel usage
                    if (planEnforcer && orgId) {
                      planEnforcer.recordUsage(orgId, 'webIntel', 1);
                    }
                  }
                } catch (err) {
                  await webJobStore.update(newJob.id, { status: 'failed', error: err.message });
                }
              });
              return jsonResponse(res, { job_id: newJob.id, status: 'queued', type: newJob.type, retried_from: jobId }, 202);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;
        }

        // Save web job result to memory
        case pathname.match(/^\/api\/web\/jobs\/([^/]+)\/save-to-memory$/)?.input: {
          if (req.method === 'POST') {
            try {
              const jobId = pathname.match(/^\/api\/web\/jobs\/([^/]+)\/save-to-memory$/)[1];
              const job = await webJobStore.get(jobId, { userId, orgId });
              if (!job) return jsonResponse(res, { error: 'Job not found' }, 404);
              if (job.status !== 'succeeded' || !Array.isArray(job.results) || job.results.length === 0) {
                return jsonResponse(res, { error: 'Job has no results to save' }, 400);
              }
              const { resultIndex, title, tags } = body;
              const items = typeof resultIndex === 'number' ? [job.results[resultIndex]].filter(Boolean) : job.results;
              if (items.length === 0) return jsonResponse(res, { error: 'Invalid result index' }, 400);
              if (!persistentMemoryEngine) {
                return jsonResponse(res, { error: 'Memory persistence unavailable' }, 503);
              }
              const savedIds = [];
              for (const item of items) {
                const content = item.snippet || item.text || item.content || JSON.stringify(item);
                const memTitle = title || item.title || item.url || `Web ${job.type} result`;
                const memTags = [...(tags || []), `web:${job.type}`, 'source:web-intelligence'];
                if (item.url) memTags.push(`url:${item.url}`);
                const filtered = filterContent(content);
                // Strip null bytes that PostgreSQL rejects (0x00)
                const cleanText = filtered.text.replace(/\x00/g, '');
                const cleanTitle = memTitle.replace(/\x00/g, '');
                const webPayload = {
                  user_id: userId,
                  org_id: orgId,
                  content: cleanText,
                  title: cleanTitle,
                  source_platform: 'web_intelligence',
                  tags: memTags,
                  memory_type: 'fact',
                  metadata: {
                    web_job_id: jobId,
                    url: item.url,
                    runtime_used: job.runtime_used,
                    crawled_at: job.created_at
                  }
                };
                const [routedWeb] = await buildRoutedIngestPayloads(webPayload, { smartIngestRouter });
                const ingestResult = await persistentMemoryEngine.ingestMemory(routedWeb);
                if (ingestResult?.memoryId) {
                  savedIds.push(ingestResult.memoryId);
                }
              }
              return jsonResponse(res, { saved: savedIds.length, memory_ids: savedIds });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;
        }

        // Admin metrics for web intelligence (requires web_admin or admin:* scope)
        case '/api/web/admin/metrics':
          if (req.method === 'GET') {
            if (!hasEntitlement(principal, 'web_admin')) {
              return jsonResponse(res, { error: 'Admin access required', code: 'insufficient_scope', required_entitlement: 'web_admin' }, 403);
            }
            try {
              // Platform-admin (scope '*') sees all; org-scoped admin sees own org only
              const isGlobalAdmin = principal.scopes?.includes('*') || principal.master;
              const metrics = await webJobStore.getMetrics(isGlobalAdmin ? undefined : orgId);
              const runtimeTelemetry = getTelemetry();
              return jsonResponse(res, { ...metrics, runtime_telemetry: runtimeTelemetry });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // Monthly usage
        case '/api/web/usage/monthly':
          if (req.method === 'GET') {
            try {
              const monthly = await webJobStore.getMonthlyUsage(userId);
              return jsonResponse(res, monthly);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // Usage export
        case '/api/web/usage/export':
          if (req.method === 'GET') {
            try {
              const from = url.searchParams.get('from');
              const to = url.searchParams.get('to');
              const exportData = await webJobStore.exportUsage({ userId, orgId }, { from, to });
              return jsonResponse(res, { usage: exportData });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // Limits check
        case '/api/web/limits':
          if (req.method === 'GET') {
            try {
              const limits = await webJobStore.checkLimits(userId);
              return jsonResponse(res, limits);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // Domain policy check
        case '/api/web/policy/check-domain':
          if (req.method === 'POST') {
            try {
              const { url: checkUrl } = body;
              if (!checkUrl) return jsonResponse(res, { error: 'url is required' }, 400);
              const normalizedUrl = normalizeWebUrl(checkUrl) || checkUrl;
              const domainResult = validateDomain(normalizedUrl);
              const robotsResult = getRobotsWarning(normalizedUrl);
              return jsonResponse(res, {
                ...domainResult,
                ...robotsResult,
                normalized_url: normalizedUrl,
                blocked: !domainResult.allowed,
                warnings: robotsResult.warning ? [robotsResult.warning] : [],
              });
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        // ==========================================
        // HOSTED MCP SERVICE (Phase 2: Context-as-a-Service)
        // ==========================================
        case pathname.match(/^\/api\/mcp\/servers\/([^\/]+)\/revoke$/)?.input:
          if (req.method === 'POST') {
            const pathUserId = pathname.match(/^\/api\/mcp\/servers\/([^\/]+)\/revoke$/)[1];

            if (userId !== pathUserId) {
              return jsonResponse(res, {
                error: 'Forbidden',
                message: 'User ID does not match authenticated user'
              }, 403);
            }

            await revokeAllConnections(pathUserId);
            return jsonResponse(res, {
              success: true,
              message: 'All MCP connections revoked'
            });
          }
          break;

        case pathname.match(/^\/api\/mcp\/servers\/([^\/]+)$/)?.input:
          if (req.method === 'GET') {
            const pathUserId = pathname.match(/^\/api\/mcp\/servers\/([^\/]+)$/)[1];
            const connectionToken = url.searchParams.get('token') || extractApiKey(req);

            if (connectionToken && await validateConnectionToken(connectionToken, pathUserId)) {
              try {
                const serverConfig = await getHostedServerByToken(connectionToken, pathUserId);
                return jsonResponse(res, serverConfig);
              } catch (error) {
                return jsonResponse(res, {
                  error: 'Failed to generate MCP server configuration',
                  message: error.message
                }, 500);
              }
            }

            // Verify user matches authenticated user
            if (userId !== pathUserId) {
              return jsonResponse(res, {
                error: 'Forbidden',
                message: 'User ID does not match authenticated user'
              }, 403);
            }

            try {
              const apiKey = req.headers['x-api-key'] || auth.principal?.rawKey || '';
              const serverConfig = generateHostedServer(userId, orgId, apiKey);
              return jsonResponse(res, serverConfig);
            } catch (error) {
              return jsonResponse(res, {
                error: 'Failed to generate MCP server configuration',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/integrations/webapp/prepare':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/integrations/webapp/prepare')) {
              return;
            }
            try {
              return jsonResponse(res, await buildContextPayload({ body, userId, orgId }));
            } catch (error) {
              return jsonResponse(res, {
                error: 'Webapp context preparation failed',
                message: error.message
              }, 400);
            }
          }
          break;

        case '/api/context':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/context')) {
              return;
            }
            try {
              return jsonResponse(res, await buildContextPayload({ body, userId, orgId }));
            } catch (error) {
              return jsonResponse(res, {
                error: 'Context preparation failed',
                message: error.message
              }, 400);
            }
          }
          break;

        case '/api/profiles':
          if (req.method === 'GET') {
            // GET /api/profiles — get all profile facts for authenticated user
            // Supports ?category=static&key=name filters
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            try {
              let facts = await profileStore.getProfile(userId, orgId);
              const categoryFilter = url.searchParams.get('category');
              const keyFilter = url.searchParams.get('key');
              if (categoryFilter) facts = facts.filter(f => f.category === categoryFilter);
              if (keyFilter) facts = facts.filter(f => f.key === keyFilter.toLowerCase().trim());
              const contextString = await profileStore.buildProfileContext(userId, orgId);
              return jsonResponse(res, { facts, context: contextString });
            } catch (err) {
              console.error('[profiles] GET failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'POST') {
            // POST /api/profiles — upsert a profile fact (or batch of facts if body is array)
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            try {
              const items = Array.isArray(body) ? body : [body];
              const results = [];
              for (const item of items) {
                const { category, key, value, confidence } = item;
                if (!key || !value) {
                  results.push({ error: 'key and value are required', key: key || null });
                  continue;
                }
                const result = await profileStore.upsertFact({ userId, orgId, category, key, value, confidence });
                auditLog({
                  userId,
                  organizationId: orgId,
                  eventType: 'profile.upsert',
                  eventCategory: 'data_modification',
                  action: result._wasUpdate ? 'update' : 'create',
                  resourceType: 'profile',
                  resourceId: result?.id || null,
                  newValue: { category, key, value },
                  previousValue: result._previousValue ? { value: result._previousValue } : undefined,
                  ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                  userAgent: req.headers['user-agent'] || null,
                });
                results.push({
                  success: true,
                  fact: result,
                  _previousValue: result._previousValue,
                  _wasUpdate: result._wasUpdate,
                  _wasContradiction: result._wasContradiction,
                });
              }
              // Single object for single input, array for batch
              return jsonResponse(res, Array.isArray(body) ? { results } : results[0]);
            } catch (err) {
              console.error('[profiles] POST failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'DELETE') {
            // DELETE /api/profiles?id=<factId>
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            const factId = url.searchParams.get('id') || body.id;
            if (!factId) return jsonResponse(res, { error: 'id is required' }, 400);
            try {
              await profileStore.deleteFact(factId, userId);
              return jsonResponse(res, { success: true });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/profiles/context':
          if (req.method === 'GET') {
            // GET /api/profiles/context — lightweight endpoint for LLM context injection
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            try {
              const contextString = await profileStore.buildProfileContext(userId, orgId);
              return jsonResponse(res, { context: contextString });
            } catch (err) {
              console.error('[profiles/context] GET failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/profiles/extract':
          if (req.method === 'POST') {
            // POST /api/profiles/extract — trigger auto-extraction from text content
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            const { content: extractContent } = body;
            if (!extractContent || typeof extractContent !== 'string') return jsonResponse(res, { error: 'content string is required' }, 400);
            try {
              const extracted = await profileStore.extractAndStore(extractContent, { userId, orgId, memoryId: null });
              return jsonResponse(res, { extracted, count: extracted.length });
            } catch (err) {
              console.error('[profiles/extract] POST failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/profiles/history':
          if (req.method === 'GET') {
            // GET /api/profiles/history?key=name — get version history for a profile fact
            if (!profileStore) return jsonResponse(res, { error: 'Profile store unavailable' }, 503);
            const historyKey = url.searchParams.get('key');
            if (!historyKey) return jsonResponse(res, { error: 'key query parameter is required' }, 400);
            try {
              const history = await profileStore.getFactHistory(userId, historyKey);
              return jsonResponse(res, { key: historyKey, history });
            } catch (err) {
              console.error('[profiles/history] GET failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/team/invites':
          if (!prisma) { jsonResponse(res, { error: 'Database unavailable' }, 503); break; }
          if (req.method === 'POST') {
            // POST /api/team/invites — create invite link (admin only)
            try {
              const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
              const memberRoles = new Set([
                ...(membership?.role ? [membership.role] : []),
                ...(Array.isArray(membership?.roles) ? membership.roles : []),
              ]);
              const isAdmin = membership?.isActive !== false && (
                memberRoles.has('admin') || memberRoles.has('owner') ||
                memberRoles.has('org_admin') || memberRoles.has('org_owner')
              );
              if (!isAdmin && !principal?.master) {
                return jsonResponse(res, { error: 'Admin/owner role required to send invites' }, 403);
              }
              const { email, role = 'member', expiresInDays = 7, teamIds = [], projectIds = [] } = body;
              if (!['member', 'admin'].includes(role)) return jsonResponse(res, { error: 'Valid role required: member or admin' }, 400);
              if (!Array.isArray(teamIds)) return jsonResponse(res, { error: 'teamIds must be an array' }, 400);
              if (!Array.isArray(projectIds)) return jsonResponse(res, { error: 'projectIds must be an array' }, 400);
              const token = crypto.randomUUID().replace(/-/g, '');
              const expiresAt = new Date(Date.now() + expiresInDays * 24 * 3600 * 1000);
              const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true } });
              const invite = await prisma.orgInvite.create({
                data: { orgId, email: email || null, role, token, expiresAt, createdBy: userId, teamIds, projectIds }
              });

              // Build the public join URL (frontend-facing).
              const FRONTEND = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
              const joinPath = `/hivemind/join/${org?.slug || orgId}/${token}`;
              const inviteUrl = `${FRONTEND}${joinPath}`;

              // Optional email dispatch — fires only when an explicit email
              // address is set on the invite AND a mail provider is
              // configured (RESEND_API_KEY or SMTP_*). Failures are
              // captured into the response, never block the invite.
              let emailReport = { attempted: false };
              if (email) {
                try {
                  const [{ sendEmail, buildInviteEmail }, projectRows, teamRows, inviter] = await Promise.all([
                    import('./services/email-sender.js'),
                    projectIds.length
                      ? prisma.project.findMany({ where: { id: { in: projectIds }, orgId }, select: { name: true } })
                      : Promise.resolve([]),
                    teamIds.length
                      ? prisma.team.findMany({ where: { id: { in: teamIds }, orgId }, select: { name: true } }).catch(() => [])
                      : Promise.resolve([]),
                    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null),
                  ]);
                  const tpl = buildInviteEmail({
                    orgName: org?.name || 'your team',
                    inviteUrl,
                    inviterEmail: inviter?.email || null,
                    projectNames: projectRows.map(p => p.name),
                    teamNames: teamRows.map(t => t.name),
                    role,
                    expiresAt,
                  });
                  const result = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
                  emailReport = { attempted: true, ...result };
                } catch (mailErr) {
                  emailReport = { attempted: true, ok: false, error: mailErr.message };
                }
              }

              // Audit log — includes whether email was sent.
              await writeAuditLog(prisma, {
                userId,
                orgId,
                eventType: 'invite_created',
                action: 'create',
                resourceType: 'invite',
                resourceId: invite.id,
                metadata: { email: email || 'link-only', role, teamIds, projectIds, expiresAt, email_dispatch: emailReport },
                ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null
              });

              return jsonResponse(res, {
                id: invite.id,
                token: invite.token,
                url: joinPath,
                full_url: inviteUrl,
                expiresAt: invite.expiresAt,
                teamIds: invite.teamIds,
                projectIds: invite.projectIds,
                email_dispatch: emailReport,
              });
            } catch (err) {
              console.error('[team] create invite failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'GET') {
            // GET /api/team/invites?status=all|pending|accepted|expired|revoked&project_id=<uuid>
            // Default returns ALL non-deleted invites so the share-modal status
            // list can render pending + accepted + expired + revoked groups.
            try {
              const membership = await prisma.userOrganization.findFirst({ where: { userId, orgId } });
              const memberRoles = new Set([
                ...(membership?.role ? [membership.role] : []),
                ...(Array.isArray(membership?.roles) ? membership.roles : []),
              ]);
              const isAdmin = membership?.isActive !== false && (
                memberRoles.has('admin') || memberRoles.has('owner') ||
                memberRoles.has('org_admin') || memberRoles.has('org_owner')
              );
              if (!isAdmin && !principal?.master) return jsonResponse(res, { error: 'Admin access required' }, 403);

              const status = (url.searchParams.get('status') || 'all').toLowerCase();
              const projectFilter = url.searchParams.get('project_id');
              const now = new Date();
              const where = { orgId };
              if (status === 'pending') {
                where.usedAt = null;
                where.revokedAt = null;
                where.expiresAt = { gt: now };
              } else if (status === 'accepted') {
                where.usedAt = { not: null };
              } else if (status === 'expired') {
                where.usedAt = null;
                where.revokedAt = null;
                where.expiresAt = { lte: now };
              } else if (status === 'revoked') {
                where.revokedAt = { not: null };
              }
              if (projectFilter) {
                where.projectIds = { has: projectFilter };
              }

              const rows = await prisma.orgInvite.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 200,
              });

              // Project + team name hydration for display.
              const projectIdSet = new Set();
              const teamIdSet = new Set();
              const createdBySet = new Set();
              for (const inv of rows) {
                (inv.projectIds || []).forEach(id => projectIdSet.add(id));
                (inv.teamIds || []).forEach(id => teamIdSet.add(id));
                if (inv.createdBy) createdBySet.add(inv.createdBy);
              }
              const [projRows, teamRows, userRows] = await Promise.all([
                projectIdSet.size
                  ? prisma.project.findMany({ where: { id: { in: [...projectIdSet] } }, select: { id: true, name: true, slug: true } })
                  : Promise.resolve([]),
                teamIdSet.size
                  ? prisma.team.findMany({ where: { id: { in: [...teamIdSet] } }, select: { id: true, name: true } }).catch(() => [])
                  : Promise.resolve([]),
                createdBySet.size
                  ? prisma.user.findMany({ where: { id: { in: [...createdBySet] } }, select: { id: true, email: true, displayName: true } }).catch(() => [])
                  : Promise.resolve([]),
              ]);
              const projById = Object.fromEntries(projRows.map(p => [p.id, p]));
              const teamById = Object.fromEntries(teamRows.map(t => [t.id, t]));
              const userById = Object.fromEntries(userRows.map(u => [u.id, u]));

              const FRONTEND = process.env.HIVEMIND_FRONTEND_URL || 'https://hivemind.davinciai.eu';
              const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
              const slug = org?.slug || orgId;

              const invites = rows.map(inv => {
                let derivedStatus = 'pending';
                if (inv.usedAt) derivedStatus = 'accepted';
                else if (inv.revokedAt) derivedStatus = 'revoked';
                else if (inv.expiresAt && inv.expiresAt < now) derivedStatus = 'expired';
                return {
                  ...inv,
                  status: derivedStatus,
                  url: `/hivemind/join/${slug}/${inv.token}`,
                  full_url: `${FRONTEND}/hivemind/join/${slug}/${inv.token}`,
                  projects: (inv.projectIds || []).map(id => projById[id]).filter(Boolean),
                  teams: (inv.teamIds || []).map(id => teamById[id]).filter(Boolean),
                  inviter: inv.createdBy ? userById[inv.createdBy] || null : null,
                };
              });
              return jsonResponse(res, { invites, count: invites.length });
            } catch (err) {
              console.error('[team] list invites failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/team/members':
          if (!prisma) { jsonResponse(res, { error: 'Database unavailable' }, 503); break; }
          if (req.method === 'GET') {
            // GET /api/team/members — list org members with roles
            try {
              const members = await prisma.userOrganization.findMany({
                where: { orgId },
                include: { user: { select: { id: true, email: true, displayName: true } } },
                orderBy: { invitedAt: 'asc' }
              });
              return jsonResponse(res, { members });
            } catch (err) {
              console.error('[team] list members failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/team/projects':
          if (!prisma) { jsonResponse(res, { error: 'Database unavailable' }, 503); break; }
          if (req.method === 'GET') {
            // GET /api/team/projects — list projects in org
            try {
              const projects = await prisma.project.findMany({
                where: { orgId },
                orderBy: { createdAt: 'desc' }
              });
              return jsonResponse(res, { projects });
            } catch (err) {
              console.error('[team] list projects failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          if (req.method === 'POST') {
            // POST /api/team/projects — create project
            try {
              const { name, slug, description, teamId = null, policy = null } = body;
              if (!name || !slug) return jsonResponse(res, { error: 'name and slug are required' }, 400);
              
              // Get org policy
              const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: { defaultProjectPolicy: true }
              });
              const effectivePolicy = policy || org?.defaultProjectPolicy || 'private';
              
              // Create project (Project.id has no @default — generate explicitly)
              const project = await prisma.project.create({
                data: {
                  id: crypto.randomUUID(),
                  orgId,
                  name,
                  slug,
                  description: description || null,
                  createdBy: userId,
                  teamId: teamId || null
                }
              });
              
              // Auto-grant access based on policy
              if (effectivePolicy === 'team_inherited' && teamId) {
                // Grant access to all team members
                const teamMembers = await prisma.teamMember.findMany({
                  where: { teamId },
                  select: { userId: true }
                });
                if (teamMembers.length > 0) {
                  const projectMemberships = teamMembers.map(m => ({
                    projectId: project.id,
                    userId: m.userId,
                    role: m.userId === userId ? 'owner' : 'member',
                    addedAt: new Date()
                  }));
                  await prisma.projectMember.createMany({ data: projectMemberships, skipDuplicates: true });
                  
                  // Invalidate access context cache for all team members
                  for (const member of teamMembers) {
                    invalidateAccessContextCache(member.userId, orgId);
                  }
                }
              } else {
                // Private: grant creator only
                await prisma.projectMember.create({
                  data: {
                    projectId: project.id,
                    userId,
                    role: 'owner',
                    addedAt: new Date()
                  }
                });
                invalidateAccessContextCache(userId, orgId);
              }
              
              // Audit log
              await writeAuditLog(prisma, {
                userId,
                orgId,
                eventType: 'project_created',
                action: 'create',
                resourceType: 'project',
                resourceId: project.id,
                metadata: { name: project.name, slug: project.slug, policy: effectivePolicy, teamId },
                ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null
              });
              
              return jsonResponse(res, { project, policy: effectivePolicy });
            } catch (err) {
              console.error('[team] create project failed:', err.message);
              // Sanitize Prisma error — don't leak SQL / stack to client.
              const code = err?.code || '';
              if (code === 'P2002') return jsonResponse(res, { error: 'slug already exists in this org' }, 409);
              if (code === 'P2003') return jsonResponse(res, { error: 'referenced team/org not found' }, 400);
              return jsonResponse(res, { error: 'Failed to create project' }, 500);
            }
          }
          break;

        case '/api/profile':
          if (req.method === 'GET' || req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/profile')) {
              return;
            }
            try {
              const project = req.method === 'POST'
                ? (body.project || null)
                : (url.searchParams.get('project') || null);
              const profile = await buildProfileSummary({ userId, orgId, project });
              return jsonResponse(res, {
                ok: true,
                profile: {
                  user_id: profile.user_id,
                  org_id: profile.org_id,
                  project: profile.project,
                  plan: profile.plan,
                  memory_count: profile.memory_count,
                  observation_count: profile.observation_count,
                  relationship_count: profile.relationship_count,
                  top_tags: profile.top_tags,
                  top_source_platforms: profile.top_source_platforms,
                  recent_titles: profile.recent_titles,
                  cognitive_profile: profile.cognitive_profile,
                },
                graph_summary: profile.graph_summary
              });
            } catch (error) {
              return jsonResponse(res, {
                error: 'Profile summary failed',
                message: error.message
              }, 400);
            }
          }
          break;

        case '/api/integrations/webapp/store':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/integrations/webapp/store')) {
              return;
            }
            try {
              const payload = buildWebappSavePayload(body, principal);
              const validation = validateCreateMemory(payload);
              if (!validation.success) {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'Webapp memory payload failed validation',
                  details: validation.error.details
                }, 400);
              }

              if (persistentMemoryEngine && prisma) {
                await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });
              }

              const webappPayload = {
                user_id: validation.data.user_id,
                org_id: validation.data.org_id,
                project: validation.data.project,
                content: validation.data.content,
                tags: validation.data.tags,
                memory_type: validation.data.memory_type,
                title: validation.data.title,
                document_date: validation.data.document_date,
                event_dates: validation.data.event_dates,
                metadata: validation.data.metadata,
                source_metadata: {
                  source_type: 'webapp',
                  source_id: validation.data.source_message_id || validation.data.source_session_id || null,
                  source_platform: validation.data.source_platform || 'webapp',
                  source_url: validation.data.source_url || null
                }
              };
              const [routedWebappPayload] = await buildRoutedIngestPayloads(webappPayload, { smartIngestRouter });
              const result = await persistentMemoryEngine.ingestMemory(routedWebappPayload);
              const memory = await persistentMemoryStore.getMemory(result.memoryId);
              if (memory) {
                await qdrantClient.storeMemory(memory, {
                  collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                });
                invalidateAggregateCache({ userId, orgId, project: memory.project || null });
                invalidateAggregateCache({ userId, orgId, project: null });
              }

              // Embed fact-memories in Qdrant (they only exist in Prisma after graph-engine creates them)
              if (result.factMemoryIds?.length > 0 && qdrantClient) {
                for (const factId of result.factMemoryIds) {
                  try {
                    const factMem = await persistentMemoryStore.getMemory(factId);
                    if (factMem) await qdrantClient.storeMemory(factMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                  } catch (factErr) {
                    console.warn(`[webapp] Fact Qdrant embed failed for ${factId}:`, factErr.message);
                  }
                }
              }

              return jsonResponse(res, {
                success: true,
                memory,
                relationships: result.edgesCreated,
                mutation: {
                  operation: result.operation,
                  deprecated_ids: result.deprecatedIds,
                  processing_ms: result.processingMs
                }
              }, 201);
            } catch (error) {
              return jsonResponse(res, {
                error: 'Webapp memory store failed',
                message: error.message
              }, 400);
            }
          }
          break;

        case '/api/memories/delete-all':
          if (req.method === 'DELETE') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories/delete-all')) return;
            try {
              const project = url.searchParams.get('project') || body.project || null;
              const memoryWhere = { userId, ...(project ? { project } : {}) };

              // Get all IDs first
              const allMemories = await prisma.memory.findMany({ where: memoryWhere, select: { id: true } });
              const ids = allMemories.map(m => m.id);

              if (ids.length > 0) {
                // Bulk Prisma: delete related tables then memories (4 queries total)
                await prisma.auditLog.updateMany({
                  where: { resourceId: { in: ids } },
                  data: { resourceId: null },
                });
                await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: ids } } });
                await prisma.memoryVersion.updateMany({
                  where: { relatedMemoryId: { in: ids } },
                  data: { relatedMemoryId: null },
                });
                await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: ids } } });
                await prisma.relationship.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
                await prisma.memory.deleteMany({ where: { id: { in: ids } } });

                // Bulk Qdrant: delete all points by user_id filter (1 API call)
                try {
                  const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
                  const qdrantCollection = process.env.QDRANT_COLLECTION || 'hivemind_memories';
                  const qdrantKey = process.env.QDRANT_API_KEY || '';
                  if (qdrantUrl) {
                    const filter = { must: [{ key: 'user_id', match: { value: userId } }] };
                    if (project) filter.must.push({ key: 'project', match: { value: project } });
                    await fetch(`${qdrantUrl}/collections/${qdrantCollection}/points/delete`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
                      body: JSON.stringify({ filter, wait: true }),
                    });
                  }
                } catch (qdrantErr) {
                  console.warn('[delete-all] Qdrant bulk delete failed:', qdrantErr.message);
                }
              }

              invalidateAggregateCache({ userId, orgId, project: project || null });
              invalidateAggregateCache({ userId, orgId, project: null });
              return jsonResponse(res, { success: true, deleted: ids.length, remaining: 0 });
            } catch (error) {
              return jsonResponse(res, { error: 'Delete all failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/memories/bulk-delete-by-tag':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories/bulk-delete-by-tag')) return;
            try {
              // Body: { tags: string[], date_to?: ISO, date_from?: ISO, dry_run?: boolean, project?: string }
              // Matches memories where tags hasSome <tags> AND createdAt within range.
              const requestedTags = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string' && t.length > 0) : [];
              if (requestedTags.length === 0) {
                return jsonResponse(res, { error: 'tags[] required' }, 400);
              }
              const dryRun = body.dry_run !== false;
              const project = body.project || null;

              const where = {
                userId,
                orgId,
                deletedAt: null,
                tags: { hasSome: requestedTags },
                ...(project ? { project } : {}),
              };
              if (body.date_from || body.date_to) {
                where.createdAt = {};
                if (body.date_from) where.createdAt.gte = new Date(body.date_from);
                if (body.date_to) where.createdAt.lte = new Date(body.date_to);
              }

              const matched = await prisma.memory.findMany({
                where,
                select: { id: true, title: true, tags: true, createdAt: true },
                take: 5000,
              });
              const ids = matched.map(m => m.id);

              if (dryRun) {
                return jsonResponse(res, {
                  dry_run: true,
                  matched_count: ids.length,
                  filter: { tags: requestedTags, date_from: body.date_from || null, date_to: body.date_to || null, project },
                  sample: matched.slice(0, 10).map(m => ({ id: m.id, title: m.title, tags: m.tags, created_at: m.createdAt })),
                });
              }

              let deletedCount = 0;
              if (ids.length > 0) {
                // Batch in chunks of 500 to avoid Prisma 30s socket timeout
                // on large cascade deletes. Each chunk = full 6-table cascade
                // for that subset, then Qdrant point delete for those IDs.
                const BATCH = 500;
                for (let i = 0; i < ids.length; i += BATCH) {
                  const chunk = ids.slice(i, i + BATCH);
                  try {
                    await prisma.auditLog.updateMany({ where: { resourceId: { in: chunk } }, data: { resourceId: null } });
                    await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: chunk } } });
                    await prisma.memoryVersion.updateMany({ where: { relatedMemoryId: { in: chunk } }, data: { relatedMemoryId: null } });
                    await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: chunk } } });
                    await prisma.relationship.deleteMany({ where: { OR: [{ fromId: { in: chunk } }, { toId: { in: chunk } }] } });
                    const r = await prisma.memory.deleteMany({ where: { id: { in: chunk } } });
                    deletedCount += r.count;
                  } catch (batchErr) {
                    console.warn(`[bulk-delete-by-tag] batch ${i}/${ids.length} failed:`, batchErr.message);
                  }

                  try {
                    const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
                    const qdrantCollection = process.env.QDRANT_COLLECTION || 'hivemind_memories';
                    const qdrantKey = process.env.QDRANT_API_KEY || '';
                    if (qdrantUrl) {
                      await fetch(`${qdrantUrl}/collections/${qdrantCollection}/points/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
                        body: JSON.stringify({ points: chunk, wait: false }),
                      });
                    }
                  } catch (qdrantErr) {
                    console.warn('[bulk-delete-by-tag] Qdrant batch delete failed:', qdrantErr.message);
                  }
                }

                invalidateAggregateCache({ userId, orgId, project: project || null });
                invalidateAggregateCache({ userId, orgId, project: null });
              }

              return jsonResponse(res, {
                dry_run: false,
                deleted: deletedCount,
                matched: ids.length,
                filter: { tags: requestedTags, date_from: body.date_from || null, date_to: body.date_to || null, project },
              });
            } catch (error) {
              return jsonResponse(res, { error: 'Bulk delete by tag failed', message: error.message }, 500);
            }
          }
          break;

        // ── Enrichment backfill ─────────────────────────────────────
        // POST /api/memory/enrichment/backfill
        //   Body (optional): { tags?: string[], memory_type?: string, limit?: number,
        //                      include_errors?: boolean }
        //   Action: enqueues all caller's memories missing enrichment
        //           (sourceMetadata.metadata.enrichment IS NULL) into the
        //           EnrichmentQueue. Orphan recovery: also re-enqueues
        //           anything stuck in_progress > 5min (likely killed by restart).
        //           Optional include_errors=true picks up error:* statuses for retry.
        //   Returns: { enqueued, queue_size, stats }
        case '/api/memory/enrichment/backfill':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memory/enrichment/backfill')) return;
            if (!enrichmentQueue) return jsonResponse(res, { error: 'enrichment queue unavailable' }, 503);
            try {
              const reqBody = body || {};
              const limit = Math.min(Number(reqBody.limit) || 2000, 10000);
              const tagFilter = Array.isArray(reqBody.tags) && reqBody.tags.length ? reqBody.tags : null;
              const memoryTypeFilter = typeof reqBody.memory_type === 'string' ? reqBody.memory_type : null;
              const includeErrors = reqBody.include_errors === true;

              // SQL: candidates are memories with no enrichment yet, or stuck
              // in_progress > 5min (orphan), or include_errors && error:*.
              // Scoped to caller's userId (per-tenant isolation).
              const orphanCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
              const conditions = [
                `m.user_id = $1::uuid`,
                `m.deleted_at IS NULL`,
                `m.is_latest = true`,
              ];
              const params = [userId];
              if (tagFilter) {
                params.push(tagFilter);
                conditions.push(`m.tags && $${params.length}::text[]`);
              }
              if (memoryTypeFilter) {
                params.push(memoryTypeFilter);
                conditions.push(`m.memory_type::text = $${params.length}`);
              }
              const statusClauses = [`(sm.metadata->'enrichment') IS NULL AND (sm.metadata->>'enrichment_status') IS NULL`];
              statusClauses.push(`((sm.metadata->>'enrichment_status') = 'in_progress' AND (sm.metadata->>'enrichment_started_at') < '${orphanCutoff}')`);
              if (includeErrors) {
                statusClauses.push(`(sm.metadata->>'enrichment_status') LIKE 'error:%'`);
              }
              conditions.push(`(${statusClauses.join(' OR ')})`);
              params.push(limit);
              const sql = `
                SELECT m.id, m.content, m.title, m.tags
                FROM memories m
                JOIN source_metadata sm ON sm.memory_id = m.id
                WHERE ${conditions.join(' AND ')}
                ORDER BY m.created_at DESC
                LIMIT $${params.length}::int
              `;
              const rows = await prisma.$queryRawUnsafe(sql, ...params);
              const items = (rows || []).map((r) => ({
                memoryId: r.id,
                payload: { content: r.content, title: r.title, tags: r.tags },
              }));
              const enqueued = enrichmentQueue.enqueueBatch(items);
              return jsonResponse(res, {
                candidates: items.length,
                enqueued,
                queue_size: enrichmentQueue.size(),
                stats: enrichmentQueue.stats(),
                filter: { tags: tagFilter, memory_type: memoryTypeFilter, include_errors: includeErrors, limit },
              });
            } catch (err) {
              console.error('[enrichment-backfill] error:', err);
              return jsonResponse(res, { error: 'backfill failed', message: err.message }, 500);
            }
          }
          break;

        // ── Canonical entities (Salesforce + cross-system memory layer) ─
        case '/api/entities':
          if (req.method === 'GET') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              const kind = url.searchParams.get('kind') || null;
              const search = url.searchParams.get('q') || null;
              const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
              const offset = parseInt(url.searchParams.get('offset') || '0', 10);
              const where = { organizationId: orgId };
              if (kind) where.entityKind = kind;
              if (search && search.length >= 2) {
                where.OR = [
                  { canonicalName: { contains: search, mode: 'insensitive' } },
                  { aliases: { has: search } },
                  { primaryEmail: { contains: search, mode: 'insensitive' } },
                ];
              }
              const [items, total] = await Promise.all([
                prisma.canonicalEntity.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
                prisma.canonicalEntity.count({ where }),
              ]);
              return jsonResponse(res, { items, total, limit, offset });
            } catch (err) { return jsonResponse(res, { error: err.message }, 500); }
          }
          break;

        case '/api/entities/stats':
          if (req.method === 'GET') {
            if (!entityResolver) return jsonResponse(res, { error: 'entity resolver unavailable' }, 503);
            try {
              const stats = await entityResolver.stats({ organizationId: orgId });
              return jsonResponse(res, stats);
            } catch (err) { return jsonResponse(res, { error: err.message }, 500); }
          }
          break;

        case '/api/entities/review-queue':
          if (req.method === 'GET') {
            if (!prisma) return jsonResponse(res, { error: 'service unavailable' }, 503);
            try {
              const status = url.searchParams.get('status') || 'pending';
              const items = await prisma.entityReviewCandidate.findMany({
                where: { organizationId: orgId, status },
                orderBy: { createdAt: 'desc' },
                take: 200,
              });
              return jsonResponse(res, { items, count: items.length });
            } catch (err) { return jsonResponse(res, { error: err.message }, 500); }
          }
          break;

        case '/api/entities/by-external-ref':
          if (req.method === 'GET') {
            if (!entityResolver) return jsonResponse(res, { error: 'entity resolver unavailable' }, 503);
            try {
              const system = url.searchParams.get('system');
              const externalId = url.searchParams.get('external_id');
              if (!system || !externalId) return jsonResponse(res, { error: 'system + external_id required' }, 400);
              const result = await entityResolver.findByExternalRef({ organizationId: orgId, system, externalId });
              return jsonResponse(res, result || { entity: null });
            } catch (err) { return jsonResponse(res, { error: err.message }, 500); }
          }
          break;

        // GET /api/memory/enrichment/stats — operator visibility
        case '/api/memory/enrichment/stats':
          if (req.method === 'GET') {
            if (!enrichmentQueue) return jsonResponse(res, { error: 'enrichment queue unavailable' }, 503);
            try {
              const counts = await prisma.$queryRawUnsafe(`
                SELECT
                  COUNT(*) FILTER (WHERE (sm.metadata->>'enrichment_status') = 'done')::int AS done,
                  COUNT(*) FILTER (WHERE (sm.metadata->>'enrichment_status') = 'in_progress')::int AS in_progress,
                  COUNT(*) FILTER (WHERE (sm.metadata->>'enrichment_status') LIKE 'error:%')::int AS errors,
                  COUNT(*) FILTER (WHERE (sm.metadata->'enrichment') IS NULL AND (sm.metadata->>'enrichment_status') IS NULL)::int AS missing
                FROM memories m
                JOIN source_metadata sm ON sm.memory_id = m.id
                WHERE m.user_id = $1::uuid AND m.deleted_at IS NULL AND m.is_latest = true
              `, userId);
              return jsonResponse(res, {
                queue: enrichmentQueue.stats(),
                memories: counts?.[0] || {},
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/memories':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories')) {
              return;
            }
            // Validate query parameters
            const queryParams = {
              user_id: userId,
              org_id: orgId
            };
            for (const key of ['project', 'memory_type', 'tags', 'is_latest', 'limit', 'offset', 'include_children']) {
              const value = url.searchParams.get(key);
              if (value !== null) {
                queryParams[key] = value;
              }
            }
            // Normalise include_children to a boolean — defaults to false so
            // the flat list view stays clean of legacy 'extracted-fact'
            // children. Set ?include_children=true to surface them again
            // (used by graph + audit views that intentionally show them).
            const includeChildren = (
              queryParams.include_children === 'true' ||
              queryParams.include_children === true
            );
            // containerTag → project mapping (containerTag is an alias for project)
            if (!queryParams.project && effectiveContainerTag) {
              queryParams.project = effectiveContainerTag;
            }

            const validation = validateMemoryQueryParams(queryParams);
            if (!validation.success) {
              return jsonResponse(res, { 
                error: 'Validation failed',
                details: validation.error.details 
              }, 400);
            }
            
            const { user_id, org_id, project, ...filters } = validation.data;
            
            const offset = filters.offset || 0;
            const limit = filters.limit || 50;

            // Parse tags: support comma-separated string or array
            let parsedTags = filters.tags;
            if (typeof parsedTags === 'string') {
              parsedTags = parsedTags.split(',').map(t => t.trim()).filter(Boolean);
            }

            const { memories, total } = await persistentMemoryStore.listMemories({
              user_id: userId,
              org_id: orgId,
              project,
              memory_type: filters.memory_type,
              tags: parsedTags,
              is_latest: filters.is_latest,
              offset,
              limit,
              include_children: includeChildren
            });

            return jsonResponse(res, {
              memories,
              pagination: {
                total,
                offset,
                limit,
                has_more: offset + limit < total
              }
            });
          } 
          
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories')) {
              return;
            }
            // Validate request body with scoping enforcement
            const scopedBody = {
              ...body,
              user_id: userId,  // Override with authenticated user
              org_id: orgId     // Override with authenticated org
            };
            // containerTag → project mapping
            if (!scopedBody.project && effectiveContainerTag) {
              scopedBody.project = effectiveContainerTag;
            }

            const validation = validateCreateMemory(scopedBody);
            if (!validation.success) {
              return jsonResponse(res, {
                error: 'Validation failed',
                message: 'Request body failed validation',
                details: validation.error.details
              }, 400);
            }

            // Plan enforcement: check memory limit before ingest
            if (planEnforcer && orgId) {
              const memoryLimitCheck = await planEnforcer.checkLimit(orgId, 'memories', 1);
              if (!memoryLimitCheck.allowed) {
                return jsonResponse(res, {
                  error: 'Plan limit exceeded',
                  message: memoryLimitCheck.reason,
                  limit: memoryLimitCheck.limit,
                  current: memoryLimitCheck.current,
                  plan: memoryLimitCheck.plan
                }, 403);
              }
            }
            
            try {
              if (!persistentMemoryEngine) {
                return jsonResponse(res, {
                  error: 'Persistent memory store unavailable',
                  message: '/api/memories requires Prisma-backed memory.'
                }, 503);
              }

              if (persistentMemoryEngine && prisma) {
                await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });
              }

              const source = validation.data.source_platform || validation.data.source_message_id || validation.data.source_session_id || validation.data.source_url
                ? {
                    type: validation.data.source_platform || 'manual',
                    id: validation.data.source_message_id || validation.data.source_session_id || null,
                    platform: validation.data.source_platform || null,
                    url: validation.data.source_url || null
                  }
                : undefined;

              const rawRelationship = body.relationship
                || validation.data.metadata?.relationship
                || (validation.data.supersedes_id
                  ? { type: 'Updates', target_id: validation.data.supersedes_id }
                  : undefined);
              const relationship = rawRelationship
                ? {
                    ...rawRelationship,
                    target_id: rawRelationship.target_id || rawRelationship.targetId
                  }
                : undefined;

              const ingestPayload = {
                user_id: validation.data.user_id,
                org_id: validation.data.org_id,
                project: validation.data.project,
                // V2 Teams + Projects scope routing (optional)
                scope: body.scope || undefined,
                primary_team_id: body.primary_team_id || null,
                project_ids: Array.isArray(body.project_ids) ? body.project_ids : [],
                __bypass_membership: body.__bypass_membership === true ? true : undefined,
                content: validation.data.content,
                tags: validation.data.tags,
                memory_type: validation.data.memory_type,
                title: validation.data.title,
                document_date: validation.data.document_date,
                event_dates: validation.data.event_dates,
                relationship,
                skipPredictCalibrate: body.skipPredictCalibrate === true,
                skipProcessing: body.skipProcessing === true,
                factAugmentOnly: body.factAugmentOnly === true,
                benchmarkEnrichment: body.benchmarkEnrichment === true,
                smartIngest: body.smartIngest !== false,
                metadata: {
                  ...validation.data.metadata,
                  source_platform: validation.data.source_platform || null,
                  source_session_id: validation.data.source_session_id || null,
                  source_message_id: validation.data.source_message_id || null,
                  source_url: validation.data.source_url || null
                },
                source_metadata: {
                  source_type: source?.type || 'manual',
                  source_id: source?.id || null,
                  source_platform: source?.platform || null,
                  source_url: source?.url || null
                }
              };

              // Determine sync vs async mode
              const syncMode = url.searchParams.get('sync') === 'true' || body.sync === true;
              const wantSmartRouting = body.smartIngest !== false && !body.skipProcessing;

              if (!syncMode) {
                // --- Async ingest: return job ID immediately ---
                const jobId = crypto.randomUUID();
                ingestTracker.createJob(jobId, { userId, orgId, title: validation.data.title });

                res.setHeader('X-Job-Id', jobId);
                jsonResponse(res, { success: true, job_id: jobId, status: 'queued' }, 202);

                // Process in background — smart routing (semantic recall +
                // triple-operator detection) runs HERE, not before 202, so
                // saves stay sub-second while still auto-building
                // Update/Extend/Derive edges against existing memories.
                (async () => {
                  try {
                    ingestTracker.updateJob(jobId, { status: 'processing', progress: 5 });

                    // Smart type-aware routing (vector recall + triple operator)
                    const ingestPayloads = await buildRoutedIngestPayloads(ingestPayload, {
                      smartIngestRouter,
                      enableSmartRouting: wantSmartRouting,
                    });

                    ingestTracker.updateJob(jobId, { status: 'processing', progress: 15 });

                    // Process all routed payloads. ingestRoutedPayload dispatches
                    // tree-shaped payloads (parent + sections + PartOf edges) to
                    // engine.ingestMemoryTree(); flat payloads go through the
                    // legacy ingestMemory() path unchanged.
                    const results = [];
                    for (const p of ingestPayloads) {
                      const result = await ingestRoutedPayload(p, persistentMemoryEngine);

                      // Handle predict-calibrate skipped memories
                      if (result.operation === 'skipped_redundant') {
                        continue;
                      }

                      // Tree path returns {parentId, childIds[]} — flatten so the
                      // post-ingest Qdrant + pageindex hooks still run on every row.
                      if (result.operation === 'tree_ingested') {
                        const parentResult = result.parentResult || { memoryId: result.parentId };
                        results.push(parentResult);
                        for (const childRes of (result.childResults || [])) {
                          results.push(childRes);
                        }
                        // Enrich the parent (not children — children are
                        // extracted facts that inherit parent context).
                        if (enrichmentQueue && parentResult.memoryId) {
                          enrichmentQueue.enqueue(parentResult.memoryId, {
                            content: p.parent?.content || p.content,
                            title: p.parent?.title || p.title,
                            tags: p.parent?.tags || p.tags,
                          });
                        }
                        continue;
                      }

                      results.push(result);

                      ingestTracker.updateJob(jobId, { status: 'embedding', progress: 60, memoryId: result.memoryId });

                      const memory = await persistentMemoryStore.getMemory(result.memoryId);
                      if (memory) {
                        await qdrantClient.storeMemory(memory, {
                          collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                        });
                        invalidateAggregateCache({ userId, orgId, project: memory.project || null });
                        invalidateAggregateCache({ userId, orgId, project: null });

                        // PageIndex assignment (project/halls/tags + keyword classification)
                        pageindexHook?.onMemoryIngested(memory, {
                          mutation: { operation: result.operation, deprecatedIds: result.deprecatedIds || [] }
                        }).catch(err => console.warn('[pageindex-hook] onMemoryIngested failed:', err.message));
                      }

                      // Enrichment queue — every save path enqueues for
                      // structured field extraction (summary/urgency/actions/
                      // decisions/blockers). Decoupled from this hot path.
                      if (enrichmentQueue && result.memoryId) {
                        enrichmentQueue.enqueue(result.memoryId, {
                          content: p.content,
                          title: p.title,
                          tags: p.tags,
                        });
                      }

                      // Auto-extract profile facts from ingested content
                      if (profileStore && p.content) {
                        profileStore.extractAndStore(p.content, {
                          userId, orgId, memoryId: result.memoryId,
                        }).catch(err => console.warn('[profile-extract] Auto-extraction failed:', err.message));
                      }

                      // Embed fact-memories in Qdrant
                      if (result.factMemoryIds?.length > 0 && qdrantClient) {
                        for (const factId of result.factMemoryIds) {
                          try {
                            const factMem = await persistentMemoryStore.getMemory(factId);
                            if (factMem) await qdrantClient.storeMemory(factMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                          } catch (factErr) {
                            console.warn(`[memories] Fact Qdrant embed failed for ${factId}:`, factErr.message);
                          }
                        }
                      }
                    }

                    if (results.length === 0) {
                      // All payloads were skipped as redundant
                      ingestTracker.updateJob(jobId, {
                        status: 'indexed',
                        progress: 100,
                        metadata: { userId, orgId, title: validation.data.title, skipped: true, operation: 'skipped_redundant' }
                      });
                      return;
                    }

                    ingestTracker.updateJob(jobId, { status: 'indexed', progress: 100, memoryId: results[0].memoryId, count: results.length });

                    // Dispatch webhook event
                    webhookManager?.dispatch('memory.created', { memoryId: results[0].memoryId, userId, orgId }, { userId, orgId }).catch(() => {});

                    // Record token usage after successful ingest
                    if (planEnforcer && orgId && validation.data.content) {
                      const actualTokens = Math.ceil(validation.data.content.length / 4);
                      planEnforcer.recordUsage(orgId, 'tokens', actualTokens);
                    }

                    // Record memory ingestion
                    if (planEnforcer && orgId) {
                      planEnforcer.recordUsage(orgId, 'memories', results.filter(r => !r.skipped).length);
                    }
                  } catch (err) {
                    console.error('[async-ingest] Job failed:', jobId, err);
                    ingestTracker.updateJob(jobId, { status: 'failed', error: err.message });
                  }
                })();

                return;
              }

              // --- Synchronous ingest (backwards-compatible with ?sync=true) ---
              // Smart routing runs inline here (caller explicitly asked for
              // sync completion, so the wait is acceptable).
              const ingestPayloads = await buildRoutedIngestPayloads(ingestPayload, {
                smartIngestRouter,
                enableSmartRouting: wantSmartRouting,
              });
              const syncResults = [];
              for (const p of ingestPayloads) {
                const result = await ingestRoutedPayload(p, persistentMemoryEngine);

                // Handle predict-calibrate skipped memories
                if (result.operation === 'skipped_redundant') {
                  syncResults.push({ skipped: true, ...result });
                  continue;
                }

                // Tree path returns aggregated parent + children. Flatten so
                // the post-ingest Qdrant + pageindex loop runs on every row.
                if (result.operation === 'tree_ingested') {
                  const allRows = [
                    result.parentResult || { memoryId: result.parentId },
                    ...(result.childResults || []),
                  ];
                  for (const r of allRows) {
                    syncResults.push(r);
                    const m = await persistentMemoryStore.getMemory(r.memoryId);
                    if (m) {
                      await qdrantClient.storeMemory(m, {
                        collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                      });
                      invalidateAggregateCache({ userId, orgId, project: m.project || null });
                      invalidateAggregateCache({ userId, orgId, project: null });
                      pageindexHook?.onMemoryIngested(m, {
                        mutation: { operation: r.operation || 'tree_child', deprecatedIds: r.deprecatedIds || [] }
                      }).catch(err => console.warn('[pageindex-hook] onMemoryIngested failed:', err.message));
                    }
                  }
                  continue;
                }

                syncResults.push(result);

                const memory = await persistentMemoryStore.getMemory(result.memoryId);
                if (memory) {
                  await qdrantClient.storeMemory(memory, {
                    collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                  });
                  invalidateAggregateCache({ userId, orgId, project: memory.project || null });
                  invalidateAggregateCache({ userId, orgId, project: null });

                  // PageIndex assignment (project/halls/tags + keyword classification)
                  pageindexHook?.onMemoryIngested(memory, {
                    mutation: { operation: result.operation, deprecatedIds: result.deprecatedIds || [] }
                  }).catch(err => console.warn('[pageindex-hook] onMemoryIngested failed:', err.message));
                }

                // Auto-extract profile facts from ingested content
                if (profileStore && p.content) {
                  profileStore.extractAndStore(p.content, {
                    userId, orgId, memoryId: result.memoryId,
                  }).catch(err => console.warn('[profile-extract] Auto-extraction failed:', err.message));
                }

                // Embed fact-memories in Qdrant (they only exist in Prisma after graph-engine creates them)
                if (result.factMemoryIds?.length > 0 && qdrantClient) {
                  for (const factId of result.factMemoryIds) {
                    try {
                      const factMem = await persistentMemoryStore.getMemory(factId);
                      if (factMem) await qdrantClient.storeMemory(factMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                    } catch (factErr) {
                      console.warn(`[memories] Fact Qdrant embed failed for ${factId}:`, factErr.message);
                    }
                  }
                }

                // Audit: memory created
                auditLog({
                  userId,
                  organizationId: orgId,
                  eventType: 'memory.create',
                  eventCategory: 'data_modification',
                  action: 'create',
                  resourceType: 'memory',
                  resourceId: result.memoryId || null,
                  ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                  userAgent: req.headers['user-agent'] || null,
                });

                // Dispatch webhook event
                webhookManager?.dispatch('memory.created', { memoryId: result.memoryId, userId, orgId }, { userId, orgId }).catch(() => {});
              }

              // Record token usage after successful sync ingest
              if (planEnforcer && orgId && validation.data.content) {
                const actualTokens = Math.ceil(validation.data.content.length / 4);
                planEnforcer.recordUsage(orgId, 'tokens', actualTokens);
              }

              // Record memory ingestion
              if (planEnforcer && orgId) {
                planEnforcer.recordUsage(orgId, 'memories', syncResults.filter(r => !r.skipped).length);
              }

              const firstSuccessResult = syncResults.find(r => !r.skipped);

              // All payloads skipped as redundant
              if (!firstSuccessResult) {
                const skippedResult = syncResults[0] || {};
                return jsonResponse(res, {
                  success: true,
                  skipped: true,
                  mutation: {
                    operation: skippedResult.operation,
                    reason: skippedResult.reason,
                    novelty_score: skippedResult.noveltyScore,
                    max_similarity: skippedResult.maxSimilarity,
                    processing_ms: skippedResult.processingMs
                  }
                }, 200);
              }

              const firstMemory = await persistentMemoryStore.getMemory(firstSuccessResult.memoryId);

              return jsonResponse(res, {
                success: true,
                memory: firstMemory,
                relationships: firstSuccessResult.edgesCreated,
                chunk_count: syncResults.filter(r => !r.skipped).length,
                mutation: {
                  operation: firstSuccessResult.operation,
                  deprecated_ids: firstSuccessResult.deprecatedIds,
                  processing_ms: firstSuccessResult.processingMs,
                  novelty_score: firstSuccessResult.noveltyScore ?? null,
                  delta_extracted: firstSuccessResult.deltaExtracted ?? false
                }
              }, 201);
            } catch (error) {
              console.error('Store memory failed:', error);
              return jsonResponse(res, {
                error: 'Memory storage failed',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/memories/ingest/status':
          if (req.method === 'GET') {
            const jobId = url.searchParams.get('job_id');
            if (jobId) {
              const job = ingestTracker.getJob(jobId);
              if (!job) return jsonResponse(res, { error: 'Job not found' }, 404);
              return jsonResponse(res, job);
            }
            // List recent jobs for this user
            const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
            const jobs = ingestTracker.getJobsByUser(userId, limitParam);
            return jsonResponse(res, { jobs });
          }
          break;

        case '/api/memories/search':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories/search')) {
              return;
            }
            // Validate search request with scoping enforcement
            const scopedBody = {
              ...body,
              user_id: userId,  // Override with authenticated user
              org_id: orgId     // Override with authenticated org
            };
            
            const validation = validateSearchMemory(scopedBody);
            if (!validation.success) {
              return jsonResponse(res, { 
                error: 'Validation failed',
                message: 'Search request failed validation',
                details: validation.error.details 
              }, 400);
            }
            
            try {
              const results = await persistentMemoryStore.searchMemories(validation.data);

              // ── Auto-routing: live Workspace fallback ──
              // body.include_live: 'auto' (default) | true | false
              //   'auto' → router decides (fresh markers / low recall / intent)
              //   true   → force MCP fan-out
              //   false  → memory-only
              const includeLive = body.include_live;
              let liveItems = [];
              let liveMeta = null;

              if (includeLive !== false) {
                try {
                  const { LiveQueryRouter } = await import('./connectors/providers/google/live-query-router.js');
                  const { decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
                  const router = new LiveQueryRouter({
                    prisma,
                    decryptToken,
                    refreshOAuthToken: refreshOAuthToken || null,
                  });

                  let services;
                  let reason;
                  if (includeLive === true) {
                    const c = router.classify(validation.data.query, results);
                    services = c.services.length > 0
                      ? c.services
                      : ['google_drive', 'google_calendar', 'gmail'];
                    reason = 'forced-include-live';
                  } else {
                    // 'auto' default
                    const c = router.classify(validation.data.query, results);
                    if (!c.needsLive) {
                      liveMeta = { decision: 'skipped', reason: c.reason };
                    } else {
                      services = c.services;
                      reason = c.reason;
                    }
                  }

                  if (services && services.length > 0) {
                    const fetched = await router.fetch(userId, validation.data.query, services);
                    liveItems = fetched;
                    liveMeta = {
                      decision: 'fetched',
                      reason,
                      services_queried: services,
                      item_count: fetched.length,
                    };

                    // Memory promotion: if a live item is recalled and has high
                    // confidence (>= 0.7) or is explicitly important, save as memory
                    // with low importance score (decays unless reinforced).
                    if (fetched.length > 0 && body.promote_to_memory === true) {
                      for (const item of fetched.slice(0, 3)) {
                        try {
                          const livePayload = {
                            user_id: userId,
                            org_id: orgId,
                            content: typeof item.text === 'string' ? item.text
                                   : item.snippet || item.summary || JSON.stringify(item).slice(0, 1000),
                            title: item.name || item.subject || item.summary || `Live result from ${item._source}`,
                            tags: ['live-query', `source:${item._source}`, 'auto-promoted'],
                            memory_type: 'fact',
                            importance_score: 0.4,
                            skip_fact_extraction: true,
                            source_metadata: {
                              source_type: 'live_query',
                              source_platform: item._source,
                              source_id: `live:${item.id || item._source}:${Date.now()}`,
                            },
                            metadata: {
                              live_query_source: item._source,
                              live_query_tool: item._tool,
                              promoted_at: new Date().toISOString(),
                              original_query: validation.data.query,
                            },
                          };
                          const [routedLive] = await buildRoutedIngestPayloads(livePayload, { smartIngestRouter });
                          await persistentMemoryEngine.ingestMemory(routedLive);
                        } catch (promoteErr) {
                          console.warn('[memory-promote] failed:', promoteErr.message);
                        }
                      }
                    }
                  }
                } catch (liveErr) {
                  console.warn('[search/live] router failed (non-fatal):', liveErr.message);
                  liveMeta = { decision: 'error', error: liveErr.message };
                }
              }

              return jsonResponse(res, {
                results,
                live_items: liveItems,
                live: liveMeta,
                search_params: {
                  query: validation.data.query,
                  project: validation.data.project,
                  memory_type: validation.data.memory_type,
                  count: results.length,
                  live_count: liveItems.length,
                }
              });
            } catch (error) {
              console.error('Search memories failed:', error);
              return jsonResponse(res, {
                error: 'Search failed',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/memories/query':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories/query')) {
              return;
            }
            if (!body.pattern) {
              return jsonResponse(res, { error: 'pattern is required' }, 400);
            }

            try {
              const result = await queryPersistedMemories(persistentMemoryStore, {
                ...body,
                user_id: userId,
                org_id: orgId
              });

              return jsonResponse(res, {
                pattern: body.pattern,
                result
              });
            } catch (error) {
              return jsonResponse(res, {
                error: error.message
              }, 400);
            }
          }
          break;

        case '/api/memories/code/ingest':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/memories/code/ingest')) {
              return;
            }
            if (!body.content || !body.filepath) {
              return jsonResponse(res, { error: 'content and filepath are required' }, 400);
            }

            try {
              if (persistentMemoryEngine && prisma) {
                await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });
              }

              const result = await persistentMemoryEngine.ingestCodeMemory({
                content: body.content,
                filepath: body.filepath,
                language: body.language,
                user_id: userId,
                org_id: orgId,
                project: body.project || null,
                tags: body.tags || [],
                source_metadata: {
                  source_type: body.source_platform || 'repository',
                  source_platform: body.source_platform || 'repository',
                  source_id: body.source_id || body.filepath,
                  source_url: body.source_url || null
                },
                metadata: {
                  repository: body.repository || null,
                  branch: body.branch || null,
                  commit_sha: body.commit_sha || null
                }
              });

              return jsonResponse(res, {
                success: true,
                ...result
              }, 201);
            } catch (error) {
              return jsonResponse(res, { error: error.message }, 500);
            }
          }
          break;

        case '/api/memories/traverse':
          if (req.method === 'POST') {
            // Prisma-backed BFS traversal. Old engine.traverse() used in-memory
            // sqlite which is invisible to production memories; this rewrite
            // walks the Postgres relationship table scoped to the caller's
            // tenant.
            try {
              const startId = body.start_id;
              if (!startId) {
                return jsonResponse(res, { error: 'start_id required' }, 400);
              }
              const maxDepth = Math.min(Math.max(parseInt(body.depth) || 2, 1), 5);
              const allowedTypes = (Array.isArray(body.relationship_types) && body.relationship_types.length > 0)
                ? body.relationship_types
                : ['Updates', 'Extends', 'Derives'];

              const startMem = await prisma.memory.findFirst({
                where: { id: startId, userId, orgId, deletedAt: null },
                include: { sourceMetadata: true }
              });
              if (!startMem) {
                return jsonResponse(res, { error: 'Memory not found or not accessible' }, 404);
              }

              const visited = new Set([startId]);
              const nodesById = new Map([[startId, startMem]]);
              const edges = [];
              let frontier = [startId];

              for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
                const rels = await prisma.relationship.findMany({
                  where: {
                    type: { in: allowedTypes },
                    OR: [
                      { fromId: { in: frontier } },
                      { toId: { in: frontier } }
                    ],
                    fromMemory: { userId, orgId, deletedAt: null },
                    toMemory: { userId, orgId, deletedAt: null }
                  },
                  select: { id: true, fromId: true, toId: true, type: true, confidence: true, createdBy: true, createdAt: true }
                });

                const nextFrontier = new Set();
                for (const rel of rels) {
                  edges.push({
                    id: rel.id,
                    from_id: rel.fromId,
                    to_id: rel.toId,
                    type: rel.type,
                    confidence: rel.confidence,
                    created_by: rel.createdBy || null,
                    created_at: rel.createdAt instanceof Date ? rel.createdAt.toISOString() : rel.createdAt
                  });
                  for (const nbr of [rel.fromId, rel.toId]) {
                    if (!visited.has(nbr)) {
                      visited.add(nbr);
                      nextFrontier.add(nbr);
                    }
                  }
                }

                if (nextFrontier.size > 0) {
                  const newMems = await prisma.memory.findMany({
                    where: {
                      id: { in: [...nextFrontier] },
                      userId,
                      orgId,
                      deletedAt: null
                    },
                    include: { sourceMetadata: true }
                  });
                  for (const m of newMems) nodesById.set(m.id, m);
                }

                frontier = [...nextFrontier];
              }

              const polishNode = (m) => ({
                id: m.id,
                title: m.title || '',
                content: (m.content || '').slice(0, 200),
                memory_type: m.memoryType || null,
                tags: m.tags || [],
                project: m.project || null,
                is_latest: m.isLatest,
                version: m.version || 1,
                created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
                document_date: m.documentDate instanceof Date ? m.documentDate.toISOString() : m.documentDate
              });

              return jsonResponse(res, {
                start_id: startId,
                depth: maxDepth,
                relationship_types: allowedTypes,
                nodes: [...nodesById.values()].map(polishNode),
                edges,
                paths: [] // path enumeration omitted for now — clients want nodes + edges
              });
            } catch (err) {
              console.error('[traverse] failed:', err.message);
              return jsonResponse(res, { error: 'Traversal failed', message: err.message }, 500);
            }
          }
          break;

        case '/api/memories/decay':
          if (req.method === 'POST') {
            const result = engine.calculateDecay(body.memory_id);
            jsonResponse(res, result);
          }
          break;

        case '/api/memories/reinforce':
          if (req.method === 'POST') {
            const result = engine.reinforceMemory(body.memory_id);
            jsonResponse(res, result);
          }
          break;

        case '/api/relationships':
          if (req.method === 'POST') {
            const rel = engine.createRelationship(body);
            jsonResponse(res, { success: true, relationship: rel });
          }
          break;

        case '/api/temporal/as-of':
          if (req.method === 'POST') {
            if (!biTemporalEngine) return jsonResponse(res, { error: 'Bi-temporal engine unavailable' }, 503);
            try {
              const txTime = body.transaction_time ? new Date(body.transaction_time) : null;
              const validTime = body.valid_time ? new Date(body.valid_time) : null;

              let result;
              if (txTime && validTime) {
                result = await biTemporalEngine.biTemporalSnapshot(userId, orgId, txTime, validTime);
              } else if (txTime) {
                result = await biTemporalEngine.asOfTransaction(userId, orgId, txTime);
              } else if (validTime) {
                result = await biTemporalEngine.asOfValid(userId, orgId, validTime);
              } else {
                return jsonResponse(res, { error: 'Provide transaction_time and/or valid_time' }, 400);
              }

              return jsonResponse(res, {
                query: { transaction_time: body.transaction_time, valid_time: body.valid_time },
                count: result.length,
                memories: result
              });
            } catch (error) {
              console.error('Temporal query failed:', error);
              return jsonResponse(res, { error: 'Temporal query failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/temporal/diff':
          if (req.method === 'POST') {
            if (!biTemporalEngine) return jsonResponse(res, { error: 'Bi-temporal engine unavailable' }, 503);
            try {
              if (!body.time_a || !body.time_b) {
                return jsonResponse(res, { error: 'Provide time_a and time_b' }, 400);
              }
              const diff = await biTemporalEngine.temporalDiff(
                userId,
                orgId,
                new Date(body.time_a),
                new Date(body.time_b),
                { tagsFilter: Array.isArray(body.tags_filter) ? body.tags_filter : [] }
              );
              return jsonResponse(res, diff);
            } catch (error) {
              console.error('Temporal diff failed:', error);
              return jsonResponse(res, { error: 'Temporal diff failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/temporal/timeline':
          if (req.method === 'POST') {
            if (!biTemporalEngine) return jsonResponse(res, { error: 'Bi-temporal engine unavailable' }, 503);
            try {
              if (!body.memory_id) return jsonResponse(res, { error: 'Provide memory_id' }, 400);
              const timeline = await biTemporalEngine.getTemporalTimeline(body.memory_id);
              return jsonResponse(res, { memory_id: body.memory_id, versions: timeline });
            } catch (error) {
              return jsonResponse(res, { error: 'Timeline failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/thought':
          if (req.method === 'POST') {
            if (!stigmergicCoT) return jsonResponse(res, { error: 'Stigmergic CoT unavailable' }, 503);
            try {
              const result = await stigmergicCoT.recordThought(body.agent_id || 'default', {
                userId, orgId,
                content: body.content,
                taskId: body.task_id,
                parentThoughtId: body.parent_thought_id,
                reasoning_type: body.reasoning_type || 'step',
                confidence: body.confidence || 1.0,
                metadata: body.metadata || {}
              });
              return jsonResponse(res, result, 201);
            } catch (error) {
              return jsonResponse(res, { error: 'Record thought failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/trace':
          if (req.method === 'POST') {
            if (!stigmergicCoT) return jsonResponse(res, { error: 'Stigmergic CoT unavailable' }, 503);
            try {
              const result = await stigmergicCoT.depositTrace(body.agent_id || 'default', {
                userId, orgId,
                action: body.action,
                result: body.result,
                success: body.success !== false,
                taskId: body.task_id,
                targetMemoryId: body.target_memory_id,
                metadata: body.metadata || {}
              });
              return jsonResponse(res, result, 201);
            } catch (error) {
              return jsonResponse(res, { error: 'Deposit trace failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/follow':
          if (req.method === 'POST') {
            if (!stigmergicCoT) return jsonResponse(res, { error: 'Stigmergic CoT unavailable' }, 503);
            try {
              const result = await stigmergicCoT.followTraces(userId, orgId, {
                taskId: body.task_id,
                action: body.action,
                limit: body.limit || 20
              });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Follow traces failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/prune':
          if (req.method === 'POST') {
            if (!stigmergicCoT) return jsonResponse(res, { error: 'Stigmergic CoT unavailable' }, 503);
            try {
              const result = await stigmergicCoT.pruneStaleTraces(userId, orgId, { maxAgeDays: body.max_age_days });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Prune failed', message: error.message }, 500);
            }
          }
          break;

        // ─── Trail Executor Endpoints ─────────────────────────────────────────────

        case '/api/swarm/execute':
          if (req.method === 'POST') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              if (!body.goal) return jsonResponse(res, { error: 'goal is required' }, 400);

              const agentId = body.agent_id || `agent_${userId}`;
              const config = {
                maxSteps: Math.min(body.max_steps || 10, 50),
                budget: {
                  maxTokens: body.budget?.max_tokens || 50000,
                  maxCostUsd: body.budget?.max_cost_usd || 1.0,
                  maxWallClockMs: body.budget?.max_wall_clock_ms || 60000,
                },
                routing: {
                  strategy: body.routing?.strategy || 'force_softmax',
                  temperature: body.routing?.temperature ?? 1.0,
                  topK: body.routing?.top_k,
                  forceWeights: body.routing?.force_weights || {
                    goalAttraction: 1.0,
                    affordanceAttraction: 1.0,
                    conflictRepulsion: 1.0,
                    congestionRepulsion: 1.0,
                    costRepulsion: 1.0,
                  },
                },
                promotionThreshold: body.promotion_threshold ?? 0.8,
                promotionRuleId: body.promotion_rule_id || 'default',
                initialContext: body.initial_context || undefined,
              };

              const result = await trailExecutor.execute(body.goal, agentId, config);

              // Store chain run for blueprint mining
              if (result.chainSummary && trailExecutor._store.storeChainRun) {
                trailExecutor._store.storeChainRun({
                  goalId: body.goal,
                  agentId: agentId,
                  toolSequence: result.chainSummary.toolSequence || [],
                  successRate: result.chainSummary.successRate ?? 1.0,
                  doneReason: result.chainSummary.doneReason || 'unknown',
                  totalLatencyMs: result.chainSummary.totalLatencyMs || 0,
                }).catch(() => {});
              }

              // Non-blocking: mine for blueprint candidates after each execution
              if (trailExecutor._chainMiner) {
                trailExecutor._chainMiner.mine(body.goal).catch(() => {});
              }

              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Trail execution failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/trails':
          if (req.method === 'POST') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              if (!body.goal_id) return jsonResponse(res, { error: 'goal_id is required' }, 400);
              if (!body.next_action?.tool) return jsonResponse(res, { error: 'next_action.tool is required' }, 400);

              const trail = {
                id: crypto.randomUUID(),
                goalId: body.goal_id,
                agentId: body.agent_id || `agent_${userId}`,
                status: 'active',
                kind: body.kind || 'raw',
                blueprintMeta: body.blueprint_meta || null,
                nextAction: {
                  tool: body.next_action.tool,
                  paramsTemplate: body.next_action.params_template || {},
                  version: body.next_action.version,
                },
                steps: [],
                executionEventIds: [],
                successScore: 0,
                confidence: body.confidence ?? 0.5,
                weight: body.weight ?? 0.5,
                decayRate: body.decay_rate ?? 0.05,
                tags: body.tags || [],
                createdAt: new Date().toISOString(),
              };

              await trailExecutor._store.putTrail(trail);
              return jsonResponse(res, trail, 201);
            } catch (error) {
              return jsonResponse(res, { error: 'Create trail failed', message: error.message }, 500);
            }
          }
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const goalId = url.searchParams.get('goal_id');
              const kindFilter = url.searchParams.get('kind');
              if (!goalId) return jsonResponse(res, { error: 'goal_id query param is required' }, 400);
              let trails = await trailExecutor._store.getCandidateTrails(goalId);
              if (kindFilter) {
                trails = trails.filter(t => (t.kind || 'raw') === kindFilter);
              }
              return jsonResponse(res, { trails, count: trails.length });
            } catch (error) {
              return jsonResponse(res, { error: 'List trails failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/executor/status':
          if (req.method === 'GET') {
            let agentCounts = { total: 0, active: 0, idle: 0, suspended: 0 };
            if (trailExecutor?._store?.listAgents) {
              try {
                const all = await trailExecutor._store.listAgents();
                agentCounts.total = all.length;
                agentCounts.active = all.filter(a => a.status === 'active').length;
                agentCounts.idle = all.filter(a => a.status === 'idle').length;
                agentCounts.suspended = all.filter(a => a.status === 'suspended').length;
              } catch { /* non-fatal */ }
            }
            return jsonResponse(res, {
              available: !!trailExecutor,
              store: trailExecutor?._store?.constructor?.name || 'none',
              tools: trailExecutor?._toolRegistry?.listTools()?.map(t => t.name) || [],
              agents: agentCounts,
            });
          }
          break;

        case '/api/swarm/blueprints/mine':
          if (req.method === 'POST') {
            if (!trailExecutor?._chainMiner) return jsonResponse(res, { error: 'ChainMiner unavailable' }, 503);
            try {
              if (!body.goal_id) return jsonResponse(res, { error: 'goal_id is required' }, 400);
              const mineResult = await trailExecutor._chainMiner.mine(body.goal_id);
              return jsonResponse(res, mineResult);
            } catch (error) {
              return jsonResponse(res, { error: 'Mining failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/blueprints':
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const goalId = url.searchParams.get('goal_id');
              const stateFilter = url.searchParams.get('state');
              if (!goalId) return jsonResponse(res, { error: 'goal_id query param is required' }, 400);

              const allTrails = await trailExecutor._store.getCandidateTrails(goalId);
              let blueprints = allTrails.filter(t => t.kind === 'blueprint');
              if (stateFilter) {
                blueprints = blueprints.filter(t => t.blueprintMeta?.state === stateFilter);
              }

              return jsonResponse(res, {
                blueprints: blueprints.map(b => ({
                  id: b.id,
                  chainSignature: b.blueprintMeta?.chainSignature,
                  state: b.blueprintMeta?.state,
                  version: b.blueprintMeta?.version,
                  promotionStats: b.blueprintMeta?.promotionStats,
                  sourceEventCount: b.blueprintMeta?.sourceEventCount,
                  promotedAt: b.blueprintMeta?.promotedAt,
                  actionSequence: b.blueprintMeta?.actionSequence,
                  weight: b.weight,
                })),
                count: blueprints.length,
              });
            } catch (error) {
              return jsonResponse(res, { error: 'List blueprints failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/agents':
          if (req.method === 'POST') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              if (!body.agent_id) return jsonResponse(res, { error: 'agent_id is required' }, 400);
              const existing = await trailExecutor._store.getAgent(body.agent_id);
              if (existing) return jsonResponse(res, { error: 'Agent already exists', agent: existing }, 409);
              const agent = await trailExecutor._store.ensureAgent(body.agent_id, {
                role: body.role || 'generalist',
                model: body.model || '',
                skills: body.skills || [],
                source: 'explicit',
              });
              return jsonResponse(res, { agent }, 201);
            } catch (error) {
              return jsonResponse(res, { error: 'Register agent failed', message: error.message }, 500);
            }
          }
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const filters = {};
              if (url.searchParams.get('role')) filters.role = url.searchParams.get('role');
              if (url.searchParams.get('status')) filters.status = url.searchParams.get('status');
              if (url.searchParams.get('source')) filters.source = url.searchParams.get('source');
              const agents = await trailExecutor._store.listAgents(filters);
              return jsonResponse(res, {
                agents: agents.map(a => ({
                  agent_id: a.agent_id, role: a.role, status: a.status,
                  source: a.source, skills: a.skills, last_seen_at: a.last_seen_at,
                })),
                count: agents.length,
              });
            } catch (error) {
              return jsonResponse(res, { error: 'List agents failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/dashboard/overview':
          if (req.method === 'GET') {
            if (!trailExecutor?._dashboard) return jsonResponse(res, { error: 'Dashboard unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const window = url.searchParams.get('window') || '7d';
              const result = await trailExecutor._dashboard.overview({ window });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Dashboard failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/dashboard/executions':
          if (req.method === 'GET') {
            if (!trailExecutor?._dashboard) return jsonResponse(res, { error: 'Dashboard unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const result = await trailExecutor._dashboard.executions({
                limit: parseInt(url.searchParams.get('limit') || '50'),
                agentId: url.searchParams.get('agent_id'),
                goal: url.searchParams.get('goal'),
                window: url.searchParams.get('window') || '7d',
              });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Dashboard failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/dashboard/blueprints':
          if (req.method === 'GET') {
            if (!trailExecutor?._dashboard) return jsonResponse(res, { error: 'Dashboard unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const result = await trailExecutor._dashboard.blueprints({ window: url.searchParams.get('window') || '7d' });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Dashboard failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/dashboard/agents':
          if (req.method === 'GET') {
            if (!trailExecutor?._dashboard) return jsonResponse(res, { error: 'Dashboard unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const result = await trailExecutor._dashboard.agents({ window: url.searchParams.get('window') || '7d' });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Dashboard failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/meta/evaluate':
          if (req.method === 'POST') {
            if (!trailExecutor?._metaEvaluator) return jsonResponse(res, { error: 'MetaEvaluator unavailable' }, 503);
            try {
              const result = await trailExecutor._metaEvaluator.evaluate({
                lookbackRuns: body.lookback_runs || 50,
                goalFilter: body.goal_filter,
                agentFilter: body.agent_filter,
              });
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Evaluation failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/meta/parameters':
          if (req.method === 'GET') {
            if (!trailExecutor?._parameterRegistry) return jsonResponse(res, { error: 'ParameterRegistry unavailable' }, 503);
            try {
              const all = await trailExecutor._parameterRegistry.getAll();
              return jsonResponse(res, { parameters: all, count: Object.keys(all).length });
            } catch (error) {
              return jsonResponse(res, { error: 'Get parameters failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/meta/apply':
          if (req.method === 'POST') {
            if (!trailExecutor?._parameterRegistry) return jsonResponse(res, { error: 'ParameterRegistry unavailable' }, 503);
            try {
              if (!body.changes || !Array.isArray(body.changes)) return jsonResponse(res, { error: 'changes array is required' }, 400);
              const result = await trailExecutor._parameterRegistry.applyRecommendations(body.changes, body.updated_by || 'admin');

              // Log the apply action as observation
              if (trailExecutor._store.writeObservation) {
                trailExecutor._store.writeObservation({
                  id: crypto.randomUUID(),
                  agent_id: 'meta_apply',
                  kind: 'meta_apply',
                  content: { changes: result.changes, updated_by: body.updated_by || 'admin' },
                  certainty: 1.0,
                }).catch(() => {});
              }

              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Apply failed', message: error.message }, 400);
            }
          }
          break;

        case '/api/swarm/meta/rollback':
          if (req.method === 'POST') {
            if (!trailExecutor?._parameterRegistry) return jsonResponse(res, { error: 'ParameterRegistry unavailable' }, 503);
            try {
              if (!body.param) return jsonResponse(res, { error: 'param is required' }, 400);
              const result = await trailExecutor._parameterRegistry.rollback(body.param);
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Rollback failed', message: error.message }, 400);
            }
          }
          break;

        case '/api/consensus/evaluate':
          if (req.method === 'POST') {
            try {
              if (!body.content) return jsonResponse(res, { error: 'Provide content to evaluate' }, 400);

              // Get related existing memories for context
              const relatedMemories = persistentMemoryStore
                ? await persistentMemoryStore.searchMemories({
                    query: body.content,
                    user_id: userId,
                    org_id: orgId,
                    n_results: 5
                  })
                : [];

              const result = byzantineConsensus.evaluateUpdate(
                { content: body.content, memory_type: body.memory_type || 'fact' },
                relatedMemories,
                body.external_votes || []
              );

              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Consensus evaluation failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/cognitive-frame':
          if (req.method === 'POST') {
            if (!cognitiveOperator) {
              return jsonResponse(res, { error: 'Cognitive operator unavailable' }, 503);
            }
            try {
              const frameResult = await cognitiveOperator.assembleFrame(userId, orgId, {
                query: body.query || body.query_context || '',
                project: body.project || null,
                maxTokens: body.max_tokens || 4000
              });

              const injection = cognitiveOperator.prioritizeForInjection(frameResult, body.context_budget || 2000);
              const payload = cognitiveOperator.formatInjectionPayload(injection.injected);

              return jsonResponse(res, {
                intent: frameResult.intent,
                dynamic_weights: frameResult.dynamicWeights,
                frame: frameResult.frame,
                token_count: frameResult.tokenCount,
                injection: {
                  injected_count: injection.injected.length,
                  dropped_count: injection.dropped.length,
                  total_tokens: injection.totalTokens,
                  payload
                }
              });
            } catch (error) {
              console.error('Cognitive frame failed:', error);
              return jsonResponse(res, { error: 'Cognitive frame assembly failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/context/monitor':
          if (req.method === 'POST') {
            if (!contextAutopilot) {
              return jsonResponse(res, { error: 'Context autopilot unavailable' }, 503);
            }
            try {
              const tokenCount = body.token_count || body.tokens_used || 0;
              const sessionId = body.session_id || 'default';
              const status = contextAutopilot.monitorContext(sessionId, tokenCount);
              return jsonResponse(res, status);
            } catch (error) {
              return jsonResponse(res, { error: 'Monitor failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/context/archive':
          if (req.method === 'POST') {
            if (!contextAutopilot) {
              return jsonResponse(res, { error: 'Context autopilot unavailable' }, 503);
            }
            try {
              const sessionId = body.session_id || 'default';
              const turns = body.turns || body.messages || [];
              const result = contextAutopilot.archiveTurns(sessionId, turns);
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Archive failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/context/compact':
          if (req.method === 'POST') {
            if (!contextAutopilot) {
              return jsonResponse(res, { error: 'Context autopilot unavailable' }, 503);
            }
            try {
              const sessionId = body.session_id || 'default';
              const result = await contextAutopilot.compactSession(sessionId, {
                userId,
                orgId,
                project: body.project || null,
                recentMessages: body.recent_messages || []
              });
              return jsonResponse(res, result);
            } catch (error) {
              console.error('Compaction failed:', error);
              return jsonResponse(res, { error: 'Compaction failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/coherence-check':
          if (req.method === 'POST') {
            if (!cognitiveOperator) {
              return jsonResponse(res, { error: 'Cognitive operator unavailable' }, 503);
            }
            try {
              const allLatest = await persistentMemoryStore.listLatestMemories({
                user_id: userId,
                org_id: orgId,
                project: body.project || null
              });

              const coherence = cognitiveOperator.maintainCoherence(allLatest, {
                content: body.content,
                memory_type: body.memory_type || 'fact'
              });

              return jsonResponse(res, coherence);
            } catch (error) {
              console.error('Coherence check failed:', error);
              return jsonResponse(res, { error: 'Coherence check failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/recall':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/recall')) {
              return;
            }
            try {
              // Apply dynamic weights from Operator Layer if available
              let recallWeights = body.weights;
              if (cognitiveOperator && !recallWeights) {
                const intent = detectQueryIntent(body.query_context || body.context || '');
                recallWeights = computeDynamicWeights(intent);
              }

              const temporalExpansion = expandTemporalQuery(body.query_context || body.context || '');

              // Rewrite query for better semantic coverage
              const rewritten = rewriteQuery(body.query_context || body.context || '');
              const effectiveRecallQuery = rewritten.expanded || body.query_context || body.context;


              // containerTag → project mapping for recall
              const recallProject = body.project || effectiveContainerTag || null;

              const recallAccessCtx = await buildAccessContext(userId, orgId);

              // Bi-temporal filter: when valid_at is set, return only memories
              // that were valid at that timestamp (valid_from <= valid_at AND
              // (valid_to IS NULL OR valid_to > valid_at)). Caller can also
              // pass transaction_at to filter by when the system learned them.
              const validAt = body.valid_at ? new Date(body.valid_at) : null;
              const transactionAt = body.transaction_at ? new Date(body.transaction_at) : null;
              const bitemporalFilter = (validAt || transactionAt)
                ? { valid_at: validAt, transaction_at: transactionAt }
                : null;

              const result = await recallPersistedMemories(persistentMemoryStore, {
                query_context: effectiveRecallQuery,
                user_id: userId,
                org_id: orgId,
                project: recallProject,
                source_platforms: body.source_platforms || [],
                tags: body.tags || [],
                preferred_project: body.preferred_project || recallProject,
                preferred_source_platforms: body.preferred_source_platforms || [],
                preferred_tags: body.preferred_tags || [],
                date_range: body.date_range || temporalExpansion.dateRange || null,
                max_memories: body.max_memories || 5,
                weights: recallWeights,
                // Type-specific filters (exposed for retrieval routing)
                is_latest: body.is_latest,              // boolean — filter to latest versions only
                include_expired: body.include_expired,  // boolean — include expired memories
                sort: body.sort,                        // 'score' | 'date_asc' | 'date_desc'
                preference_boost: body.preference_boost,      // boolean — boost preference/opinion memories
                include_superseded: body.include_superseded,  // boolean — traverse Updates chain for version history
                access_context: recallAccessCtx,
                scope_filter: body.scope_filter || null,
                bitemporal: bitemporalFilter,
              });

              // Post-filter for bi-temporal when retriever doesn't honor it
              // natively. Drops memories whose creation post-dates transaction_at
              // OR whose valid_from is after valid_at.
              if (bitemporalFilter && Array.isArray(result?.memories)) {
                const filtered = result.memories.filter(m => {
                  const created = m.created_at ? new Date(m.created_at) : null;
                  const validFrom = m.metadata?.valid_from ? new Date(m.metadata.valid_from) : created;
                  const validTo = m.metadata?.valid_to ? new Date(m.metadata.valid_to) : null;
                  if (bitemporalFilter.transaction_at && created && created > bitemporalFilter.transaction_at) return false;
                  if (bitemporalFilter.valid_at) {
                    if (validFrom && validFrom > bitemporalFilter.valid_at) return false;
                    if (validTo && validTo <= bitemporalFilter.valid_at) return false;
                  }
                  return true;
                });
                result.memories = filtered;
                result.bitemporal_filter_applied = {
                  valid_at: bitemporalFilter.valid_at?.toISOString() || null,
                  transaction_at: bitemporalFilter.transaction_at?.toISOString() || null,
                  kept: filtered.length,
                };
              }

              // Apply memory type boosts from Operator Layer
              if (cognitiveOperator && result.memories) {
                const intent = detectQueryIntent(body.query_context || body.context || '');
                for (const m of result.memories) {
                  const boost = getMemoryTypeBoost(intent, m.memory_type || 'fact');
                  if (boost !== 1.0) {
                    m.score = (m.score || 0) * boost;
                    m.operator_boost = boost;
                  }
                }
                // Re-sort after boosts (only if no explicit sort mode requested)
                if (!body.sort || body.sort === 'score') {
                  result.memories.sort((a, b) => (b.score || 0) - (a.score || 0));
                }
                result.intent = intent;
              }

              // Phase 3: cross-cluster entity-overlap boost for synthesis memories
              if (result.memories && result.memories.length > 1) {
                try {
                  const clusterIndex = new ClusterIndex({ prisma });
                  result.memories = await crossClusterEntityBoost(result.memories, {
                    clusterIndex, organizationId: orgId,
                  });
                } catch (boostErr) {
                  console.warn('[api/recall] cross-cluster boost failed:', boostErr.message);
                }
              }

              // Inject parent chunks for fact-memories
              const injectParentChunks = body.inject_parent_chunks !== false;
              if (injectParentChunks && result.memories && result.memories.length > 0) {
                for (const mem of result.memories) {
                  if ((mem.tags || []).includes('extracted-fact') && mem.metadata?.parent_memory_id) {
                    try {
                      const parent = await persistentMemoryStore.getMemory(mem.metadata.parent_memory_id);
                      if (parent) {
                        mem.parent_chunk = parent.content;
                        mem.parent_document_date = parent.document_date;
                      }
                    } catch {}
                  }
                }
              }

              // Deduplicate semantically similar memories
              if (result.memories && result.memories.length > 1) {
                const before = result.memories.length;
                result.memories = deduplicateResults(result.memories);
                result.dedup = { before, after: result.memories.length, collapsed: before - result.memories.length };
              }

              // Annotate memories that have known contradictions
              if (persistentMemoryStore && result.memories) {
                for (const mem of result.memories) {
                  try {
                    const contradictions = await persistentMemoryStore.getRelationships(mem.id, 'Contradicts');
                    if (contradictions && contradictions.length > 0) {
                      mem._contradictions = contradictions.map(c => ({
                        contradicts_memory_id: c.from_id === mem.id ? c.to_id : c.from_id,
                        confidence: c.confidence,
                        type: c.metadata?.contradiction_type || 'unknown',
                      }));
                    }
                  } catch {}
                }
              }

              // Inject user profile context into recall result
              if (profileStore) {
                try {
                  result.user_profile = await profileStore.buildProfileContext(userId, orgId);
                } catch (profileErr) {
                  console.warn('[recall] Profile injection failed:', profileErr.message);
                }
              }

              // Attach query rewrite metadata for debugging/transparency
              result.query_rewrite = {
                expanded: rewritten.expanded,
                entities: rewritten.entities,
                stripped: rewritten.stripped,
              };

              // ─── Recall v3.1: memory-first event-driven fan-out via RecallRouter ───
              // Keeps /api/recall's enrichment pipeline (bi-temporal, operator
              // boost, parent-chunk inject, contradictions, profile, dedupe)
              // and only delegates the evidence/live fan-out to the unified
              // router so HTTP callers get the same memory-first behavior as
              // the agent tool (no regex classifier, anchors come from tags).
              const mode = body.mode || 'auto';
              const wantEvidence = mode === 'evidence' || mode === 'hybrid' || mode === 'auto';
              const memoryHits = Array.isArray(result.memories) ? result.memories : [];
              result.mode_used = mode;

              if (wantEvidence && mode !== 'memory') {
                // 1. Inline evidence_links per memory (SQL join — independent
                //    of vector search; required for citation UI).
                try {
                  const memIds = memoryHits.map(m => m.id).filter(Boolean);
                  if (memIds.length) {
                    const links = await prisma.memoryEvidenceLink.findMany({
                      where: { memoryId: { in: memIds } },
                      select: {
                        memoryId: true,
                        segmentId: true,
                        documentId: true,
                        linkType: true,
                        confidence: true,
                        excerpt: true,
                        document: { select: { id: true, title: true, sourcePlatform: true } },
                      },
                    });
                    const byMemory = new Map();
                    for (const l of links) {
                      if (!byMemory.has(l.memoryId)) byMemory.set(l.memoryId, []);
                      byMemory.get(l.memoryId).push({
                        segment_id: l.segmentId,
                        document_id: l.documentId,
                        document_title: l.document?.title || null,
                        source_platform: l.document?.sourcePlatform || null,
                        link_type: l.linkType,
                        confidence: l.confidence,
                        excerpt: l.excerpt,
                      });
                    }
                    for (const mem of memoryHits) {
                      mem.evidence = byMemory.get(mem.id) || [];
                    }
                  }
                } catch (evErr) {
                  console.warn(`[recall] evidence attach failed: ${evErr.message}`);
                }

                // 2. Memory-first fan-out via RecallRouter (event-driven).
                //    Replaces the old "sparseMemories || citationIntent" regex
                //    heuristic with the tag-driven inspection logic.
                try {
                  const { recallEnhance } = await import('./memory/recall-router.js');
                  const enhanced = await recallEnhance({
                    memories: memoryHits,
                    query: body.query_context || body.context || '',
                    ctx: { userId, orgId },
                    evidenceService: evidenceRetrieval,
                    prisma,
                    includeLive: body.include_live !== false,
                  });
                  // Dedup evidence against inline-attached links (same segment
                  // can't show up twice in the result).
                  const attachedSegIds = new Set(
                    memoryHits.flatMap(m => (m.evidence || []).map(e => e.segment_id))
                  );
                  result.evidence = (enhanced.evidence || [])
                    .filter(e => !attachedSegIds.has(e.segmentId));
                  result.evidence_count = result.evidence.length;
                  result.live = enhanced.live || [];
                  result.live_count = result.live.length;
                  result.recall_trace = enhanced.trace;
                } catch (enhErr) {
                  console.warn(`[recall] router enhance failed: ${enhErr.message}`);
                  result.evidence = [];
                  result.live = [];
                }
              }

              // Record search usage after successful recall
              if (planEnforcer && orgId) {
                planEnforcer.recordUsage(orgId, 'searches', 1);
              }

              // ── Promote synthesized[]/raw[] to top-level response ────────────
              // recallPersistedMemories now returns both synthesized[] + raw[]
              // alongside the backwards-compat flat memories[].
              // Expose them at the top level so callers can use rich rendering.
              if (Array.isArray(result.synthesized)) {
                // Already set by persisted-retrieval; just ensure it's present
              } else {
                result.synthesized = [];
              }
              if (!Array.isArray(result.raw)) {
                result.raw = [];
              }

              // Slim response — default ON for mode=auto/memory/hybrid/evidence
              // Caller can opt back into full payload via body.verbose=true
              if (!body.verbose) {
                const SLIM_MEM_KEYS = ['id','title','content','memory_type','tags','score','created_at','document_date','project','source','evidence','_synthesis_boosted','_cross_cluster_boost','_cross_cluster_overlap','synthesis_cluster_hash','synthesis_revision','synthesis_confidence','synthesis_evidence_ids','source_metadata'];
                const slimMem = (m) => {
                  const out = {};
                  for (const k of SLIM_MEM_KEYS) if (m[k] !== undefined) out[k] = m[k];
                  return out;
                };
                result.memories = (result.memories || []).map(slimMem);
                // Slim synthesized[] — keep claim/type/confidence/evidence/revision
                result.synthesized = (result.synthesized || []).map(s => ({
                  id:         s.id,
                  type:       s.type,
                  claim:      s.claim,
                  title:      s.title,
                  confidence: s.confidence,
                  revision:   s.revision,
                  evidence:   (s.evidence || []).map(e => ({
                    id:      e.id,
                    title:   e.title,
                    snippet: (e.snippet || '').slice(0, 200),
                  })),
                  score:      s.score,
                  created_at: s.created_at,
                }));
                // Slim raw[] same as memories slim
                result.raw = (result.raw || []).map(slimMem);
                // Drop heavy top-level noise
                delete result.injectionText;
                delete result.user_profile;
                delete result.expansion_stats;
                delete result.dedup;
                delete result.query_rewrite;
                delete result.intent;
                // Trim evidence snippet payloads
                if (Array.isArray(result.evidence)) {
                  result.evidence = result.evidence.map(e => ({
                    segment_id: e.segmentId || e.segment_id,
                    document_id: e.documentId || e.document_id,
                    document_title: e.document?.title || e.document_title || null,
                    score: e.score,
                    snippet: (e.snippet || e.content || '').slice(0, 200),
                  }));
                }
              }

              jsonResponse(res, result);
            } catch (error) {
              console.error('Auto recall failed:', error);
              return jsonResponse(res, {
                error: 'Recall failed',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/graph/intelligent':
          // Rich graph: memories + documents + entities + typed relationships
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/intelligent')) return;
            try {
              const limit = Math.min(Number(url.searchParams.get('limit') || 500), 2000);
              const entityFilter = url.searchParams.get('entity') || null;
              const memTypeFilter = url.searchParams.get('memory_type') || null;
              const docFilter = url.searchParams.get('document_id') || null;

              // 1. Memories scoped to user/org
              const includeChildren = url.searchParams.get('include_children') === 'true';
              const memWhere = {
                userId, orgId, deletedAt: null, isLatest: true,
                ...(memTypeFilter ? { memoryType: memTypeFilter } : {}),
                ...(includeChildren ? {} : { NOT: { tags: { has: 'extracted-fact' } } }),
              };
              const memories = await prisma.memory.findMany({
                where: memWhere,
                orderBy: { updatedAt: 'desc' },
                take: limit,
                select: {
                  id: true, title: true, content: true, memoryType: true,
                  tags: true, importanceScore: true, createdAt: true, updatedAt: true,
                  sourcePlatform: true,
                },
              });
              const memoryIds = memories.map(m => m.id);

              // 2. Relationships between these memories
              const relationships = await prisma.relationship.findMany({
                where: { OR: [{ fromId: { in: memoryIds } }, { toId: { in: memoryIds } }] },
                select: { id: true, fromId: true, toId: true, type: true, confidence: true, createdBy: true },
              });

              // 3. Evidence links → documents
              const evLinks = await prisma.memoryEvidenceLink.findMany({
                where: { memoryId: { in: memoryIds } },
                select: { memoryId: true, segmentId: true, documentId: true, linkType: true, confidence: true },
              });
              const docIds = [...new Set(evLinks.map(l => l.documentId).filter(Boolean))];
              const documents = docIds.length ? await prisma.knowledgeDocument.findMany({
                where: { id: { in: docIds }, orgId },
                select: { id: true, title: true, sourcePlatform: true, documentType: true, documentDate: true, wordCount: true },
              }) : [];

              // 4. Entity mentions → entities
              const mentions = await prisma.entityMention.findMany({
                where: { memoryId: { in: memoryIds } },
                select: { entityId: true, memoryId: true, confidence: true },
              });
              const entityIds = [...new Set(mentions.map(m => m.entityId))];
              const entities = entityIds.length ? await prisma.entity.findMany({
                where: {
                  id: { in: entityIds },
                  orgId,
                  ...(entityFilter ? { canonicalName: { contains: entityFilter, mode: 'insensitive' } } : {}),
                },
                select: { id: true, canonicalName: true, entityType: true, mentionCount: true, aliases: true },
              }) : [];

              // 5. Build node + edge arrays
              const nodes = [];
              for (const m of memories) {
                if (docFilter && !evLinks.some(l => l.memoryId === m.id && l.documentId === docFilter)) continue;
                nodes.push({
                  id: m.id,
                  kind: 'memory',
                  label: (m.title || m.content || '').slice(0, 60),
                  memory_type: m.memoryType,
                  importance: m.importanceScore || 0.5,
                  tags: m.tags || [],
                  source: m.sourcePlatform,
                  createdAt: m.createdAt,
                  size: 1 + Math.log2(1 + (m.importanceScore || 0.5) * 10),
                });
              }
              for (const d of documents) {
                nodes.push({
                  id: d.id,
                  kind: 'document',
                  label: (d.title || '').slice(0, 60),
                  doc_type: d.documentType,
                  source: d.sourcePlatform,
                  word_count: d.wordCount,
                  createdAt: d.documentDate,
                });
              }
              for (const e of entities) {
                nodes.push({
                  id: e.id,
                  kind: 'entity',
                  label: e.canonicalName,
                  entity_type: e.entityType,
                  mention_count: e.mentionCount || 1,
                  aliases: e.aliases || [],
                });
              }

              const edges = [];
              // memory<->memory relationships
              for (const r of relationships) {
                edges.push({
                  id: r.id,
                  source: r.fromId,
                  target: r.toId,
                  type: String(r.type).toLowerCase(),
                  confidence: r.confidence ?? 1.0,
                  created_by: r.createdBy,
                });
              }
              // memory -> document
              for (const l of evLinks) {
                if (!l.documentId) continue;
                edges.push({
                  id: `ev_${l.memoryId}_${l.documentId}`,
                  source: l.memoryId,
                  target: l.documentId,
                  type: 'derived_from',
                  confidence: l.confidence ?? 0.9,
                  kind: 'evidence',
                });
              }
              // memory -> entity
              for (const m of mentions) {
                edges.push({
                  id: `em_${m.memoryId}_${m.entityId}`,
                  source: m.memoryId,
                  target: m.entityId,
                  type: 'mentions',
                  confidence: m.confidence ?? 0.7,
                  kind: 'mention',
                });
              }

              return jsonResponse(res, {
                nodes,
                edges,
                counts: {
                  memories: memories.length,
                  documents: documents.length,
                  entities: entities.length,
                  relationships: relationships.length,
                  evidence_links: evLinks.length,
                  mentions: mentions.length,
                },
              });
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/graph':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph')) {
              return;
            }
            let releaseSlot = null;
            try {
              const graphProject = url.searchParams.get('project') || null;
              const graphScope = url.searchParams.get('scope') || 'personal';
              // Phase 7: in-process cache to absorb FE auto-refresh + repeat reads
              const { getGraphCache, setGraphCache } = await import('./memory/graph-cache.js');
              const cacheKey = {
                userId,
                orgId,
                project: graphProject,
                scope: graphScope,
                limit: url.searchParams.get('limit') || '',
                edges: url.searchParams.get('include_edges') !== 'false' ? 1 : 0,
                residents: url.searchParams.get('include_residents') !== 'false' ? 1 : 0,
              };
              const cached = await getGraphCache(cacheKey);
              if (cached) {
                return jsonResponse(res, cached);
              }
              // Per-tenant concurrency gate: prevent one tenant from
              // spawning N parallel expensive graph builds and starving others.
              const { acquireTenantSlot } = await import('./memory/tenant-gate.js');
              try {
                releaseSlot = await acquireTenantSlot(userId || orgId || 'anon', '/api/graph');
              } catch (gateErr) {
                return jsonResponse(res, {
                  error: 'Too many concurrent graph queries',
                  message: 'Another graph build is in progress for this tenant. Retry shortly.',
                  retryAfter: 3,
                }, 429);
              }
              // Hard cap raised to 50000 — full memory libraries should be visualisable.
              // Pass limit=0 to mean "no cap" (will be clamped to 50000 max).
              const rawLimit = parseInt(url.searchParams.get('limit'));
              const graphLimit = !rawLimit || rawLimit <= 0
                ? 50000
                : Math.min(rawLimit, 50000);
              // Layered priority budgeting only kicks in when limit is small enough that
              // we have to ration; with large budgets (>2000) we just fetch everything
              // sorted by updatedAt so users see their full graph spread out.
              const useLayeredBudget = graphLimit <= 2000;
              const includeEdges = url.searchParams.get('include_edges') !== 'false';
              const includeResidents = url.searchParams.get('include_residents') !== 'false';
              // Only LATEST versions render in the graph by default.
              // Without isLatest filter, every Update edge effectively
              // doubles the node count (old + new version both show up).
              //
              // ?include_superseded=true (2026-05-21) keeps superseded
              // versions in the node set so Supermemory-style "you said
              // X, then updated to Y" chains render with both endpoints
              // visible. FE can dim the older nodes via the is_latest
              // flag that ships on each node payload.
              const includeSuperseded =
                url.searchParams.get('include_superseded') === 'true';
              // Match /api/memories default: exclude 'extracted-fact' children
              // unless caller asks for them. Without this filter the graph
              // shows ~3× the user's actual memory count (parent + N child
              // facts per memory), which mismatches the list-view total.
              const includeChildren =
                url.searchParams.get('include_children') === 'true';
              // Mirrors HIDDEN_CHILD_TAGS in prisma-graph-store.listMemories.
              const HIDDEN_CHILD_TAGS_GRAPH = ['extracted-fact', 'tara-turn', 'tara-insight'];
              const baseWhere = {
                orgId: orgId,
                deletedAt: null,
                ...(includeSuperseded ? {} : { isLatest: true }),
                ...(graphProject ? { project: graphProject } : {}),
                ...(includeChildren ? {} : { AND: HIDDEN_CHILD_TAGS_GRAPH.map((t) => ({ NOT: { tags: { has: t } } })) }),
              };
              const scopeWhere = graphScope === 'team'
                ? {
                    ...baseWhere,
                    visibility: 'organization',
                  }
                : graphScope === 'all'
                  ? {
                      ...baseWhere,
                      OR: [
                        { userId, visibility: 'private' },
                        { visibility: 'organization' },
                      ],
                    }
                  : {
                      ...baseWhere,
                      userId,
                    };

              // ── Node selection ──
              // Two modes:
              //   useLayeredBudget=true  → small limit, ration via 3-layer priority (high-value, connected, recent)
              //   useLayeredBudget=false → big limit, fetch ALL matching memories sorted by recency
              let highValueNodes = [];
              const seenIds = new Set();
              if (useLayeredBudget) {
                // Layer 1: High-value nodes (facts, observations, promoted-risks) — always shown
                highValueNodes = await prisma.memory.findMany({
                  where: {
                    ...scopeWhere,
                    tags: { hasSome: ['extracted-fact', 'promoted-risk', 'observation', 'turing-verified'] },
                  },
                  include: { sourceMetadata: true },
                  orderBy: { importanceScore: 'desc' },
                  take: Math.floor(graphLimit * 0.25), // 25% of budget
                });
                for (const r of highValueNodes) seenIds.add(r.id);
              }

              // Layer 2: Connected nodes (have relationships) — show the graph structure
              const relationshipScope = graphScope === 'all'
                ? { orgId, deletedAt: null, OR: [{ userId, visibility: 'private' }, { visibility: 'organization' }] }
                : graphScope === 'team'
                  ? { orgId, deletedAt: null, visibility: 'organization' }
                  : { userId, orgId, deletedAt: null };
              // Fetch relationships in priority order — TARA chains and curated edges first, bulk last.
              // Edge caps scale with node budget so a full-graph view also gets a full edge set.
              const priorityCap = useLayeredBudget ? 500 : Math.min(graphLimit * 2, 50000);
              const bulkCap = useLayeredBudget ? 1500 : Math.min(graphLimit * 4, 200000);
              const [priorityRels, bulkRels] = await Promise.all([
                // Priority: TARA chains, turing, memory_processor (meaningful edges)
                prisma.relationship.findMany({
                  where: {
                    createdBy: { in: ['tara', 'tara-clinical', 'turing-reconciliation', 'memory_processor'] },
                    OR: [
                      { fromMemory: relationshipScope },
                      { toMemory: relationshipScope },
                    ],
                  },
                  select: { fromId: true, toId: true, type: true, confidence: true, createdBy: true },
                  take: priorityCap,
                }),
                // Bulk: everything else (conflict-detector, system)
                prisma.relationship.findMany({
                  where: {
                    createdBy: { notIn: ['tara', 'tara-clinical', 'turing-reconciliation', 'memory_processor'] },
                    OR: [
                      { fromMemory: relationshipScope },
                      { toMemory: relationshipScope },
                    ],
                  },
                  select: { fromId: true, toId: true, type: true, confidence: true, createdBy: true },
                  take: bulkCap,
                }),
              ]);
              const allRelationships = [...priorityRels, ...bulkRels];
              const connectedNodeIds = new Set();
              for (const rel of allRelationships) {
                connectedNodeIds.add(rel.fromId);
                connectedNodeIds.add(rel.toId);
              }
              // Remove already-loaded IDs
              for (const id of seenIds) connectedNodeIds.delete(id);

              let connectedNodes = [];
              if (useLayeredBudget) {
                const connectedBudget = Math.floor(graphLimit * 0.35); // 35% of budget
                connectedNodes = connectedNodeIds.size > 0
                  ? await prisma.memory.findMany({
                      where: { id: { in: [...connectedNodeIds].slice(0, connectedBudget) }, ...scopeWhere },
                      include: { sourceMetadata: true },
                    })
                  : [];
                for (const r of connectedNodes) seenIds.add(r.id);
              }

              // Recent / fill layer.
              // Layered mode → fill remaining budget after layer 1+2.
              // Unbounded mode → fetch up to graphLimit memories sorted by updatedAt desc; this is the path
              // when the caller wants the full graph. We still exclude already-loaded ids (which are 0 in
              // unbounded mode unless caller pre-warmed).
              const recentBudget = useLayeredBudget ? (graphLimit - seenIds.size) : graphLimit;
              const recentNodes = recentBudget > 0
                ? await prisma.memory.findMany({
                    where: {
                      ...scopeWhere,
                      ...(seenIds.size > 0 ? { id: { notIn: [...seenIds] } } : {}),
                    },
                    include: { sourceMetadata: true },
                    orderBy: { updatedAt: 'desc' },
                    take: recentBudget,
                  })
                : [];

              // Merge all layers
              const allRecords = [...highValueNodes, ...connectedNodes, ...recentNodes];

              const now = Date.now();
              const projectSet = new Set();
              const tagSet = new Set();

              const nodes = allRecords.map(r => {
                const updatedAt = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
                const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
                const daysSinceUpdate = (now - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
                const temporalWeight = Math.exp(-daysSinceUpdate / 30);

                if (r.project) projectSet.add(r.project);
                if (r.tags) r.tags.forEach(t => tagSet.add(t));

                // Classify node layer for frontend visualization
                const isFact = (r.tags || []).includes('extracted-fact');
                const isObservation = (r.tags || []).includes('observation') || r.memoryType === 'observation';
                const isPromotedRisk = (r.tags || []).includes('promoted-risk');
                const isTuringVerified = (r.tags || []).includes('turing-verified');
                const isTaraTurn = (r.tags || []).includes('tara-turn');
                const isTaraInsight = (r.tags || []).includes('tara-insight');
                const nodeLayer = isTaraInsight ? 'tara-insight' : isTaraTurn ? 'tara' : isPromotedRisk ? 'promoted' : isTuringVerified ? 'verified' : isFact ? 'fact' : isObservation ? 'observation' : 'memory';

                return {
                  id: r.id,
                  title: r.title || '',
                  content: (r.content || '').slice(0, 200),
                  memoryType: r.memoryType || null,
                  tags: r.tags || [],
                  project: r.project || null,
                  userId: r.userId,
                  visibility: r.visibility,
                  sourcePlatform: r.sourceMetadata?.sourcePlatform || r.sourcePlatform || null,
                  importanceScore: r.importanceScore,
                  strength: r.strength,
                  recallCount: r.recallCount,
                  isLatest: r.isLatest,
                  createdAt: createdAt.toISOString(),
                  updatedAt: updatedAt.toISOString(),
                  daysSinceUpdate: Math.round(daysSinceUpdate * 100) / 100,
                  temporalWeight: Math.round(temporalWeight * 10000) / 10000,
                  nodeLayer, // 'fact' | 'observation' | 'promoted' | 'verified' | 'memory'
                };
              });

              // Build edges from relationships
              const nodeIdSet = new Set(allRecords.map(r => r.id));
              // Materialize filtered edges once — clustering needs them even
              // when the caller asked for include_edges=false.
              const filteredEdges = allRelationships
                .filter(r => nodeIdSet.has(r.fromId) && nodeIdSet.has(r.toId))
                .map(r => ({
                  source: r.fromId,
                  target: r.toId,
                  type: r.type,
                  confidence: r.confidence,
                  createdBy: r.createdBy || null, // 'turing' | 'memory_processor' | 'system'
                }));
              const edges = includeEdges ? filteredEdges : [];

              // ── Cluster computation (Phase 2 of GRAPH_MEMORY_UPGRADE) ──
              // Run Louvain community detection over the current node+edge set
              // so the frontend can render mind-group constellations instead of
              // a hairball. Pure function, no DB writes, ~50ms for 5k nodes.
              let clusterMetaList = [];
              try {
                const { clusterGraph } = await import('./memory/graph-clusterer.js');
                const clusterInput = nodes.map(n => ({
                  id: n.id,
                  tags: n.tags,
                  importanceScore: n.importanceScore,
                }));
                const { nodeMeta, clusters: computedClusters } = clusterGraph(
                  clusterInput,
                  filteredEdges,
                  { resolution: 1.05 },
                );
                clusterMetaList = computedClusters;
                for (const node of nodes) {
                  const m = nodeMeta[node.id];
                  if (m) {
                    node.clusterId = m.clusterId;
                    node.clusterRole = m.clusterRole;
                    node.hubScore = m.hubScore;
                    node.bridgeScore = m.bridgeScore;
                  } else {
                    // Disconnected nodes still need a stable cluster id so the FE
                    // forceCluster doesn't NaN them.
                    node.clusterId = '_orphan';
                    node.clusterRole = 'spoke';
                    node.hubScore = 0;
                    node.bridgeScore = 0;
                  }
                }
              } catch (clusterErr) {
                console.warn('[graph] clustering failed (non-fatal):', clusterErr.message);
              }

              // ── Resident overlay data ──
              let residentActivity = null;
              const obsStore = trailExecutor?._store || null;
              if (includeResidents && obsStore?.listObservations) {
                try {
                  const recentObs = await obsStore.listObservations({
                    limit: 50,
                  });
                  // Group observations by agent
                  const byAgent = { faraday: [], feynman: [], turing: [] };
                  for (const obs of recentObs) {
                    const agent = obs.agent_id || 'unknown';
                    if (byAgent[agent]) byAgent[agent].push(obs);
                  }

                  // Extract node IDs touched by residents
                  const residentTouchedIds = new Set();
                  const hypotheses = [];
                  const verifications = [];
                  const graphActions = [];

                  for (const obs of recentObs) {
                    const content = obs.content || {};
                    const relIds = content.related_memory_ids || content.evidence_refs || [];
                    const targetIds = content.target_memory_ids || [];
                    for (const id of [...relIds, ...targetIds]) residentTouchedIds.add(id);

                    if (obs.kind === 'hypothesis') {
                      hypotheses.push({
                        id: obs.id,
                        summary: content.summary || '',
                        type: content.hypothesis_type || 'unknown',
                        confidence: obs.certainty || 0,
                        relatedNodeIds: relIds,
                      });
                    }
                    if (obs.kind === 'verification') {
                      verifications.push({
                        id: obs.id,
                        verdict: content.verdict || 'unknown',
                        summary: content.summary || '',
                        confidence: obs.certainty || 0,
                        relatedNodeIds: content.related_memory_ids || [],
                        graphActions: content.graph_actions || [],
                      });
                    }
                    if (['merge_candidate', 'promotion_candidate', 'relationship_candidate', 'noise_reduction_candidate'].includes(obs.kind)) {
                      graphActions.push({
                        id: obs.id,
                        kind: obs.kind,
                        recommendation: content.recommendation || obs.kind,
                        summary: content.summary || '',
                        confidence: obs.certainty || 0,
                        targetNodeIds: content.target_memory_ids || [],
                      });
                    }
                  }

                  residentActivity = {
                    touchedNodeIds: [...residentTouchedIds],
                    observations: { faraday: byAgent.faraday.length, feynman: byAgent.feynman.length, turing: byAgent.turing.length },
                    hypotheses,
                    verifications,
                    graphActions,
                  };
                } catch (resErr) {
                  console.warn('[graph] Resident overlay failed:', resErr.message);
                }
              }

              // Count total memories for context
              const totalCount = await prisma.memory.count({ where: scopeWhere });

              // Record graph query usage
              if (planEnforcer && orgId) {
                planEnforcer.recordUsage(orgId, 'graphQueries', 1);
              }

              // Step C: strip large `content` from graph nodes — visualization
              // doesn't need full document text. Cuts payload ~80%.
              const slimNodes = nodes.map((node) => {
                const slim = { ...node };
                if (slim.content && slim.content.length > 200) {
                  slim.contentPreview = slim.content.slice(0, 180) + '…';
                  delete slim.content;
                }
                // Drop heavy nested objects rarely needed for layout
                delete slim.sourceMetadata;
                delete slim.metadata;
                return slim;
              });

              // Total relationships across the user's graph (DB-level count,
              // not clipped to the visible node window). FE can show this
              // alongside edgeCount so the profile/graph counts reconcile.
              let totalRelationships = 0;
              try {
                const relCountRows = await prisma.$queryRawUnsafe(
                  `SELECT COUNT(*)::int AS c FROM "relationships" r
                   JOIN "memories" m ON r."from_id" = m."id"
                   WHERE m."user_id" = $1::uuid AND m."deleted_at" IS NULL AND m."is_latest" = true`,
                  userId,
                );
                totalRelationships = relCountRows?.[0]?.c || 0;
              } catch { /* non-fatal */ }

              const responsePayload = {
                nodes: slimNodes,
                edges,
                residentActivity,
                meta: {
                  nodeCount: slimNodes.length,
                  edgeCount: edges.length,
                  totalMemories: totalCount,
                  totalRelationships,
                  scope: graphScope,
                  loadedLayers: {
                    highValue: highValueNodes.length,
                    connected: connectedNodes.length,
                    recent: recentNodes.length,
                  },
                  projects: Array.from(projectSet).sort(),
                  tags: Array.from(tagSet).sort(),
                  clusters: clusterMetaList, // [{id, size, label, topTags, hubNodeId}]
                  clusterCount: clusterMetaList.length,
                  cachedAt: new Date().toISOString(),
                  payloadSlimmed: true,
                },
              };
              setGraphCache(cacheKey, responsePayload);
              if (releaseSlot) releaseSlot();

              // Step A: HTTP cache headers for instant browser re-renders.
              //   max-age=60        → browser uses local cache for 60s
              //   stale-while-revalidate=300 → serve stale instantly while fetching fresh
              //   private           → don't cache in shared CDNs (per-tenant data)
              res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
              // Weak ETag from cluster count + node count + timestamp — cheap, no body hash
              res.setHeader('ETag', `W/"g-${slimNodes.length}-${edges.length}-${clusterMetaList.length}-${Math.floor(Date.now()/60000)}"`);
              return jsonResponse(res, responsePayload);
            } catch (error) {
              if (typeof releaseSlot === 'function') releaseSlot();
              console.error('Graph endpoint failed:', error);
              return jsonResponse(res, {
                error: 'Graph generation failed',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/graph/hygiene/scan':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/hygiene/scan')) {
              return;
            }
            if (!hygieneScanner) {
              return jsonResponse(res, { error: 'Graph hygiene scanner not available' }, 503);
            }
            try {
              // ── NL intent parsing ──
              // If caller passes body.goal (free text), parse it into a
              // structured intent: categories, filter (source/tags/dates),
              // safety_class. Falls back to keyword regex when LLM
              // unavailable, then to the full default category set.
              let parsedIntent = null;
              if (typeof body.goal === 'string' && body.goal.trim()) {
                try {
                  const { parseIntent } = await import('./resident/nl-intent-parser.js');
                  parsedIntent = await parseIntent(body.goal);
                } catch (intentErr) {
                  console.warn('[hygiene-scan] intent parse failed (non-fatal):', intentErr.message);
                }
              }
              const categories = body.categories
                || parsedIntent?.categories
                || ['duplicates', 'noise', 'stale', 'orphans', 'artifacts', 'contradictions'];
              const limit = Math.min(parseInt(body.limit) || 100, 500);
              const scanResult = await hygieneScanner.scan(userId, orgId, {
                categories,
                limit,
                filter: parsedIntent?.filter || null,
              });
              if (parsedIntent) {
                scanResult.intent = parsedIntent;
              }

              // ── LLM-targeted pass (intent-aware, no heuristic clustering) ──
              // When user typed a free-text goal AND safety is destructive/
              // mutate, ask the LLM to evaluate each candidate memory against
              // that exact instruction and surface only those it judges a
              // clear match. This is what makes AgentSwarm respond to NL
              // prompts ("delete memories about Solvis") instead of always
              // returning the same generic clusters.
              const safety = parsedIntent?.safety_class;
              if (body.goal && typeof body.goal === 'string' && body.goal.trim().length > 3
                  && (safety === 'destructive' || safety === 'mutate')) {
                try {
                  const { evaluateMemoriesAgainstGoal } = await import('./resident/llm-targeted-scanner.js');

                  // Pull a tenant-scoped pool of latest memories. Narrow by
                  // filter.tags / keywords / date if NL parser produced them.
                  const poolWhere = { userId, orgId, deletedAt: null, isLatest: true };
                  const f = parsedIntent?.filter;
                  if (f?.tags?.length > 0) poolWhere.tags = { hasSome: f.tags };
                  if (f?.date_from || f?.date_to) {
                    poolWhere.createdAt = {};
                    if (f.date_from) poolWhere.createdAt.gte = new Date(f.date_from);
                    if (f.date_to) poolWhere.createdAt.lte = new Date(f.date_to);
                  }
                  const candidates = await prisma.memory.findMany({
                    where: poolWhere,
                    select: { id: true, title: true, content: true, tags: true, createdAt: true },
                    orderBy: { createdAt: 'desc' },
                    take: 300,
                  });
                  let pool = candidates;
                  if (Array.isArray(f?.keywords) && f.keywords.length > 0) {
                    const kws = f.keywords.map(k => String(k).toLowerCase());
                    pool = pool.filter(m => {
                      const hay = `${m.title || ''} ${m.content || ''} ${(m.tags || []).join(' ')}`.toLowerCase();
                      return kws.some(kw => hay.includes(kw));
                    });
                  }

                  const matches = await evaluateMemoriesAgainstGoal(body.goal, pool.map(m => ({
                    id: m.id,
                    title: m.title,
                    content: m.content,
                    tags: m.tags,
                    created_at: m.createdAt?.toISOString?.() || null,
                  })));

                  const byId = new Map(pool.map(m => [m.id, m]));
                  const targetedProposals = matches.map(ev => {
                    const mem = byId.get(ev.id);
                    return {
                      id: `targeted-${ev.id}`,
                      category: 'targeted',
                      severity: ev.action === 'delete' ? 'high' : 'medium',
                      confidence: Math.max(0, Math.min(1, ev.confidence || 0.7)),
                      suggestedAction: ev.action,
                      reason: ev.reason,
                      memories: mem ? [{
                        id: mem.id,
                        title: mem.title || null,
                        content_preview: (mem.content || '').slice(0, 240),
                        created_at: mem.createdAt?.toISOString?.() || null,
                        importance_score: null,
                        // is_canonical=false: this memory is the TARGET of the
                        // action, not a "keep" canonical reference. UI shows
                        // "keep" chip when true — wrong signal for delete.
                        is_canonical: false,
                      }] : [],
                      metadata: { llm_targeted: true, goal: body.goal },
                    };
                  });

                  // Merge into the proposals list, preserving heuristic finds
                  scanResult.proposals = [...targetedProposals, ...(scanResult.proposals || [])];
                  scanResult.stats = scanResult.stats || {};
                  scanResult.stats.scanned = (scanResult.stats.scanned || 0) + pool.length;
                  scanResult.stats.llm_targeted_matches = targetedProposals.length;
                  scanResult.stats.llm_targeted_pool = pool.length;
                } catch (targetErr) {
                  console.warn('[hygiene-scan] LLM-targeted pass failed (non-fatal):', targetErr.message);
                }
              }

              // ── LLM verification gate ──
              // Re-rank heuristic proposals with Groq for grounded confidence.
              // Skip verification on category:'targeted' — those already came
              // from a per-memory LLM evaluation and don't need re-ranking.
              try {
                const { verifyProposals, filterForQueue } = await import('./resident/llm-proposal-verifier.js');
                const targeted = (scanResult.proposals || []).filter(p => p.category === 'targeted');
                const heuristic = (scanResult.proposals || []).filter(p => p.category !== 'targeted');
                const verified = await verifyProposals(heuristic);
                const queued = filterForQueue(verified);
                scanResult.proposals = [...targeted, ...queued];
                scanResult.stats = scanResult.stats || {};
                scanResult.stats.llm_verified = verified.length;
                scanResult.stats.llm_dropped = verified.filter(v => v.verdict === 'drop').length;
                scanResult.stats.queued_for_approval = scanResult.proposals.length;
              } catch (verifyErr) {
                console.warn('[hygiene-scan] LLM verify failed (non-fatal):', verifyErr.message);
              }

              auditLog({
                userId,
                organizationId: orgId,
                eventType: 'graph.hygiene.scan',
                eventCategory: 'data_access',
                action: 'scan',
                resourceType: 'graph',
                metadata: {
                  categories,
                  proposalCount: scanResult.proposals?.length || 0,
                  llm_verified: scanResult.stats?.llm_verified || 0,
                  llm_dropped: scanResult.stats?.llm_dropped || 0,
                },
                ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
              });
              jsonResponse(res, scanResult);
            } catch (error) {
              console.error('Graph hygiene scan failed:', error);
              return jsonResponse(res, { error: 'Hygiene scan failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/graph/hygiene/execute':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/hygiene/execute')) {
              return;
            }
            if (!hygieneScanner) {
              return jsonResponse(res, { error: 'Graph hygiene scanner not available' }, 503);
            }
            try {
              const { proposals, action } = body;
              if (!proposals || !Array.isArray(proposals) || proposals.length === 0) {
                return jsonResponse(res, { error: 'proposals array is required' }, 400);
              }
              if (!action || !['merge', 'archive_duplicates', 'delete', 'archive', 'suppress', 'resolve', 'link_update_chain'].includes(action)) {
                return jsonResponse(res, { error: 'action must be one of: merge, archive_duplicates, delete, archive, suppress, resolve, link_update_chain' }, 400);
              }
              const results = await hygieneScanner.executeProposals(proposals, action);
              auditLog({
                userId,
                organizationId: orgId,
                eventType: 'graph.hygiene.execute',
                eventCategory: 'data_modification',
                action: action,
                resourceType: 'graph',
                metadata: { proposalCount: proposals.length, action, results },
                ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
              });
              jsonResponse(res, { results });
            } catch (error) {
              console.error('Graph hygiene execute failed:', error);
              return jsonResponse(res, { error: 'Hygiene execute failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/graph/hygiene/stats':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/hygiene/stats')) {
              return;
            }
            try {
              const total_memories = await prisma.memory.count({ where: { userId, orgId, isLatest: true } });
              const noise_estimate = await prisma.memory.count({ where: { userId, orgId, content: { contains: 'unsubscribe' } } });
              const artifact_count = await prisma.memory.count({
                where: {
                  userId,
                  orgId,
                  OR: [
                    { title: { startsWith: 'TARA Turn' } },
                    { title: { startsWith: 'Clinical Insight' } },
                    { title: { startsWith: 'Session:' } },
                  ],
                },
              });

              // Estimate duplicates: memories with identical titles
              const userIdUuid = userId;
              const orgIdUuid = orgId;
              const duplicateGroups = await prisma.$queryRaw`
                SELECT COUNT(*)::int as cnt FROM (
                  SELECT title FROM memories
                  WHERE user_id = ${userIdUuid}::uuid AND org_id = ${orgIdUuid}::uuid AND deleted_at IS NULL
                  GROUP BY title HAVING COUNT(*) > 1
                ) sub
              `;
              const duplicate_estimate = Number(duplicateGroups[0]?.cnt || 0);

              // Orphan estimate: memories with no relationships
              const connected = await prisma.$queryRaw`
                SELECT COUNT(DISTINCT m.id)::int as cnt FROM memories m
                INNER JOIN relationships r ON m.id = r.from_id OR m.id = r.to_id
                WHERE m.user_id = ${userIdUuid}::uuid AND m.org_id = ${orgIdUuid}::uuid AND m.deleted_at IS NULL
              `;
              const orphan_estimate = Math.max(0, total_memories - Number(connected[0]?.cnt || 0));

              // Stale estimate: memories not updated in 90+ days
              const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
              const stale_estimate = await prisma.memory.count({
                where: { userId, orgId, deletedAt: null, updatedAt: { lt: staleDate } },
              });

              jsonResponse(res, {
                total_memories,
                noise_estimate,
                duplicate_estimate,
                orphan_estimate,
                stale_estimate,
                artifact_count,
              });
            } catch (error) {
              console.error('Graph hygiene stats failed:', error);
              return jsonResponse(res, { error: 'Hygiene stats failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/session/end':
          if (req.method === 'POST') {
            const result = engine.sessionEndHook({
              session_content: body.content,
              user_id: userId,
              org_id: orgId
            });
            jsonResponse(res, result);
          }
          break;

        case '/api/graph/backfill':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/backfill')) {
              return;
            }
            try {
              if (!smartIngestRouter || !persistentMemoryStore) {
                return jsonResponse(res, { error: 'Graph backfill unavailable' }, 503);
              }

              const backfillProject = body.project || null;
              const backfillBatchSize = Math.min(parseInt(body.batch_size, 10) || 200, 1000);
              const backfillDryRun = body.dry_run !== false;

              const orphanWhere = {
                userId,
                orgId,
                deletedAt: null,
                isLatest: true,
                ...(backfillProject ? { project: backfillProject } : {}),
                outgoingRelationships: { none: {} },
                incomingRelationships: { none: {} },
              };

              const [totalOrphans, orphans] = await Promise.all([
                prisma.memory.count({ where: orphanWhere }),
                prisma.memory.findMany({
                  where: orphanWhere,
                  orderBy: { updatedAt: 'desc' },
                  take: backfillBatchSize,
                  select: {
                    id: true,
                    content: true,
                    title: true,
                    tags: true,
                    memoryType: true,
                    project: true,
                    metadata: true,
                    sourceMetadata: true,
                  },
                }),
              ]);

              const results = [];
              let edgesProposed = 0;
              let edgesApplied = 0;

              for (const orphan of orphans) {
                const payload = {
                  user_id: userId,
                  org_id: orgId,
                  project: orphan.project,
                  content: orphan.content,
                  title: orphan.title,
                  tags: orphan.tags || [],
                  memory_type: orphan.memoryType,
                  metadata: orphan.metadata || {},
                  source_metadata: orphan.sourceMetadata || {},
                  skip_fact_extraction: true,
                };

                try {
                  const routedPayloads = await smartIngestRouter.route(payload);
                  for (const routed of routedPayloads) {
                    const relationship = routed.relationship;
                    const relationshipType = typeof relationship === 'string' ? relationship : relationship?.type;
                    const relationshipTarget = routed.related_to || relationship?.target_id || relationship?.targetId || null;

                    if (!relationshipType || !relationshipTarget || relationshipTarget === orphan.id) {
                      continue;
                    }

                    edgesProposed += 1;

                    if (!backfillDryRun) {
                      await persistentMemoryStore.createRelationship({
                        id: crypto.randomUUID(),
                        from_id: relationshipType === 'Derives' ? relationshipTarget : orphan.id,
                        to_id: relationshipType === 'Derives' ? orphan.id : relationshipTarget,
                        type: relationshipType,
                        confidence: relationship?.confidence || 0.85,
                        metadata: {
                          backfilled: true,
                          source: 'graph_backfill',
                          reason: relationship?.reason || 'router_replay',
                        },
                        created_by: 'graph_backfill',
                      });
                      edgesApplied += 1;
                    }

                    results.push({
                      memory_id: orphan.id,
                      title: orphan.title || null,
                      relationship: relationshipType,
                      related_to: relationshipTarget,
                    });
                  }
                } catch (routeErr) {
                  results.push({
                    memory_id: orphan.id,
                    title: orphan.title || null,
                    error: routeErr.message,
                  });
                }
              }

              return jsonResponse(res, {
                dry_run: backfillDryRun,
                total_orphans: totalOrphans,
                processed: orphans.length,
                edges_proposed: edgesProposed,
                edges_applied: edgesApplied,
                sample: results.slice(0, 50),
              });
            } catch (error) {
              console.error('[graph-backfill] failed:', error);
              return jsonResponse(res, { error: 'Graph backfill failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/stats':
        case '/api/graph/quality':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph/quality')) {
              return;
            }
            try {
              const qualityProject = url.searchParams.get('project') || null;
              const memoryWhere = {
                userId,
                orgId,
                deletedAt: null,
                isLatest: true,
                ...(qualityProject ? { project: qualityProject } : {}),
              };

              const [nodes, orphanIds, relTypeCounts, duplicateGroups] = await Promise.all([
                prisma.memory.count({ where: memoryWhere }),
                prisma.memory.findMany({
                  where: {
                    ...memoryWhere,
                    outgoingRelationships: { none: {} },
                    incomingRelationships: { none: {} },
                  },
                  select: { id: true },
                }),
                prisma.relationship.groupBy({
                  by: ['type'],
                  where: {
                    fromMemory: memoryWhere,
                    toMemory: { userId, orgId, deletedAt: null, ...(qualityProject ? { project: qualityProject } : {}) },
                  },
                  _count: { type: true },
                }),
                prisma.$queryRaw`
                  SELECT COUNT(*)::int AS cnt FROM (
                    SELECT r.from_id, r.to_id, r.type, COUNT(*)
                    FROM relationships r
                    JOIN memories mf ON mf.id = r.from_id
                    JOIN memories mt ON mt.id = r.to_id
                    WHERE mf.user_id = ${userId}::uuid
                      AND mf.org_id = ${orgId}::uuid
                      AND mf.deleted_at IS NULL
                      AND mt.deleted_at IS NULL
                      ${qualityProject ? Prisma.sql`AND mf.project = ${qualityProject} AND mt.project = ${qualityProject}` : Prisma.sql``}
                    GROUP BY r.from_id, r.to_id, r.type
                    HAVING COUNT(*) > 1
                  ) dupes
                `,
              ]);

              const edges = relTypeCounts.reduce((sum, row) => sum + (row._count?.type || 0), 0);
              const isolatedNodes = orphanIds.length;
              const isolatedPct = nodes > 0 ? Number(((isolatedNodes / nodes) * 100).toFixed(2)) : 0;
              const avgEdgesPerNode = nodes > 0 ? Number((edges / nodes).toFixed(3)) : 0;

              return jsonResponse(res, {
                project: qualityProject,
                nodes,
                edges,
                isolated_nodes: isolatedNodes,
                isolated_pct: isolatedPct,
                avg_edges_per_node: avgEdgesPerNode,
                duplicate_edge_groups: Number(duplicateGroups[0]?.cnt || 0),
                relationship_types: relTypeCounts.map(row => ({ type: row.type, count: row._count.type })),
              });
            } catch (error) {
              console.error('[graph-quality] failed:', error);
              return jsonResponse(res, { error: 'Graph quality probe failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/stats':
          const stats = engine.getStats(userId, orgId);
          jsonResponse(res, stats);
          break;

        // ==========================================
        // PageIndex API Endpoints (dynamic routes)
        // ==========================================

        // Get tree (static route)
        case '/api/pageindex/tree':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/pageindex/tree')) {
              return;
            }
            try {
              const depth = parseInt(url.searchParams.get('depth')) || 4;
              const rootPath = url.searchParams.get('rootPath') || '/hivemind';

              const { PageIndexService } = await import('./services/pageindex-service.js');
              const pageindexService = new PageIndexService({ prisma });
              const tree = await pageindexService.getTree(userId, { depth, rootPath });

              jsonResponse(res, { tree: tree || [] });
            } catch (error) {
              console.error('PageIndex tree fetch failed:', error);
              jsonResponse(res, { tree: [] });
            }
          }
          break;

        // ==========================================
        // Three-Tier Retrieval API Endpoints
        // ==========================================

        // PageIndex-Powered Hybrid Search
        case '/api/search/pageindex':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/search/pageindex')) {
              return;
            }
            try {
              const { query, limit = 20, project } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              // containerTag → project mapping for search
              const searchProject = project || effectiveContainerTag || null;

              // Use PageIndexSearcher if available, else fall back to quick search
              if (pageindexSearcher) {
                const results = await pageindexSearcher.search(query, {
                  userId,
                  orgId,
                  limit,
                  project: searchProject,
                });

                // Record search usage
                if (planEnforcer && orgId) {
                  planEnforcer.recordUsage(orgId, 'searches', 1);
                }

                jsonResponse(res, {
                  results,
                  source: 'pageindex-hybrid',
                  count: results.length,
                });
              } else {
                // Fallback to three-tier quick search
                const result = await threeTierRetrieval.quickSearch(query, {
                  userId,
                  orgId,
                  limit,
                  project: searchProject,
                });

                jsonResponse(res, result);
              }
            } catch (error) {
              console.error('PageIndex search failed:', error);
              return jsonResponse(res, {
                error: 'PageIndex search failed',
                message: error.message,
                requestId: crypto.randomUUID()
              }, 500);
            }
          }
          break;

        case '/api/search/quick':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/search/quick')) {
              return;
            }
            try {
              const { query, memory_type, tags, source_platform, limit, score_threshold, project } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              // containerTag → project mapping for search
              const searchProject = project || effectiveContainerTag || null;

              // Use PageIndex first if available (complete topic retrieval), then fall back to three-tier
              if (pageindexSearcher) {
                const results = await pageindexSearcher.search(query, {
                  userId,
                  orgId,
                  limit: limit || 10,
                  project: searchProject,
                });

                // Record search usage
                if (planEnforcer && orgId) {
                  planEnforcer.recordUsage(orgId, 'searches', 1);
                }

                jsonResponse(res, {
                  results,
                  source: 'pageindex-hybrid',
                  count: results.length,
                });
              } else {
                // Fallback to three-tier quick search
                const result = await threeTierRetrieval.quickSearch(query, {
                  userId,
                  orgId,
                  project: searchProject,
                  memoryType: memory_type,
                  tags,
                  sourcePlatform: source_platform,
                  limit: limit || 10,
                  scoreThreshold: score_threshold ?? parseFloat(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || '0.15')
                });

                // Record search usage after successful quick search
                if (planEnforcer && orgId) {
                  planEnforcer.recordUsage(orgId, 'searches', 1);
                }

                jsonResponse(res, result);
              }
            } catch (error) {
              console.error('QuickSearch failed:', error);
              return jsonResponse(res, {
                error: 'QuickSearch failed',
                message: error.message,
                requestId: error.requestId || crypto.randomUUID()
              }, 500);
            }
          }
          break;

        case '/api/search/panorama':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/search/panorama')) {
              return;
            }
            try {
              const {
                query,
                project,
                include_expired,
                include_historical,
                date_range,
                temporal_status,
                limit,
                include_timeline
              } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              const searchProject = project || effectiveContainerTag || null;
              const result = await threeTierRetrieval.panoramaSearch(query, {
                userId,
                orgId,
                project: searchProject,
                includeExpired: include_expired !== false,
                includeHistorical: include_historical !== false,
                dateRange: date_range,
                temporalStatus: temporal_status,
                limit: limit || 50,
                includeTimeline: include_timeline !== false
              });

              if (searchProject && Array.isArray(result.results) && result.results.length === 0) {
                const scopedFallback = await persistentMemoryStore.searchMemories({
                  query,
                  user_id: userId,
                  org_id: orgId,
                  project: searchProject,
                  is_latest: include_historical !== false ? undefined : true,
                  n_results: limit || 50
                });

                if (scopedFallback.length > 0) {
                  result.results = scopedFallback;
                  if (result.categories) {
                    result.categories.historical = scopedFallback;
                  }
                  result.metadata = {
                    ...(result.metadata || {}),
                    fallback: 'route_scoped_memory_search'
                  };
                }
              }

              jsonResponse(res, result);
            } catch (error) {
              console.error('PanoramaSearch failed:', error);
              return jsonResponse(res, {
                error: 'PanoramaSearch failed',
                message: error.message,
                requestId: error.requestId || crypto.randomUUID()
              }, 500);
            }
          }
          break;

        case '/api/search/insight':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/search/insight')) {
              return;
            }
            if (!groqClient.isAvailable()) {
              return jsonResponse(res, {
                error: 'LLM not configured',
                message: 'InsightForge requires Groq API key. Set GROQ_API_KEY.'
              }, 503);
            }
            try {
              const {
                query,
                project,
                simulation_requirement,
                sub_query_limit,
                results_per_sub_query,
                include_analysis
              } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              const searchProject = project || effectiveContainerTag || null;
              const result = await threeTierRetrieval.insightForge(query, {
                userId,
                orgId,
                project: searchProject,
                simulationRequirement: simulation_requirement,
                subQueryLimit: sub_query_limit || 5,
                resultsPerSubQuery: results_per_sub_query || 15,
                includeAnalysis: include_analysis !== false
              });

              if (searchProject && Array.isArray(result.results)) {
                result.results = result.results.filter((entry) => {
                  const scopedProject = entry?.project || entry?.payload?.project || entry?.memory?.project || null;
                  return scopedProject === searchProject;
                });
              }

              jsonResponse(res, result);
            } catch (error) {
              console.error('InsightForge failed:', error);
              return jsonResponse(res, {
                error: 'InsightForge failed',
                message: error.message,
                requestId: error.requestId || crypto.randomUUID()
              }, 500);
            }
          }
          break;

        case '/api/search/compare':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/search/compare')) {
              return;
            }
            try {
              const { query, tier } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              const result = await threeTierRetrieval.compareTiers(query, {
                userId,
                orgId,
                tier: tier || 'auto'
              });

              jsonResponse(res, result);
            } catch (error) {
              console.error('Tier comparison failed:', error);
              return jsonResponse(res, {
                error: 'Tier comparison failed',
                message: error.message,
                requestId: error.requestId || crypto.randomUUID()
              }, 500);
            }
          }
          break;

        // ==========================================
        // Retrieval Evaluation API Endpoints
        // ==========================================

        case '/api/evaluate/retrieval':
          if (req.method === 'POST') {
            try {
              const {
                query,
                relevant_memories,
                method = 'hybrid',
                category = 'general',
                limit = 20
              } = body;

              // Single query evaluation
              if (query && relevant_memories) {
                const evaluation = await retrievalEvaluator.evaluateQuery(
                  query,
                  relevant_memories,
                  {
                    userId,
                    orgId,
                    method,
                    category,
                    limit
                  }
                );

                return jsonResponse(res, {
                  success: true,
                  evaluation
                });
              }

              // Batch evaluation
              const {
                queries,
                methods = ['hybrid'],
                sample_size,
                dataset,
                category: batchCategory,
                difficulty
              } = body;

              let testQueries = queries;

              // Use built-in test dataset if no queries provided
              if (!testQueries) {
                // 1. If explicit dataset requested, try that
                if (dataset) {
                  try {
                    testQueries = getQueriesForDataset(dataset);
                  } catch (error) {
                    // If 'tenant' or other named dataset fails, fall through to auto-gen
                    if (dataset !== 'default') testQueries = null;
                    else throw error;
                  }
                }

                // 2. Auto-generate from user's actual memories (works for any user)
                if (!testQueries && userId) {
                  try {
                    testQueries = await generateEvalQueries(userId, orgId, {
                      maxQueries: sample_size || 20,
                      maxMemories: 300
                    });
                  } catch (autoErr) {
                    console.warn('[EVAL] Auto-generation failed, falling back to default:', autoErr.message, autoErr.stack);
                    testQueries = null;
                  }
                }

                // 3. Fallback to static dataset
                if (!testQueries || testQueries.length === 0) {
                  if (sample_size) {
                    testQueries = getSampleQueries(sample_size);
                  } else if (batchCategory) {
                    testQueries = getQueriesByCategory(batchCategory);
                  } else if (difficulty) {
                    testQueries = getQueriesByDifficulty(difficulty);
                  } else {
                    testQueries = TEST_QUERIES;
                  }
                }

                // Apply sample_size if set
                if (sample_size && testQueries.length > sample_size) {
                  testQueries = testQueries.slice(0, sample_size);
                }
              }

              const report = await retrievalEvaluator.evaluateBatch(testQueries, {
                userId,
                orgId,
                methods,
                warmup: true
              });
              persistEvaluationReport(report);

              return jsonResponse(res, {
                success: true,
                report
              });
            } catch (error) {
              console.error('Retrieval evaluation failed:', error);
              return jsonResponse(res, {
                error: 'Evaluation failed',
                message: error.message,
                requestId: crypto.randomUUID()
              }, 500);
            }
          }
          break;

        case '/api/evaluate/results':
          if (req.method === 'GET') {
            try {
              const reportId = url.searchParams.get('evaluation_id');
              const latestReport = reportId
                ? getEvaluationReportById(reportId)
                : retrievalEvaluator.getLatestReport() || loadEvaluationReports().slice(-1)[0];

              if (!latestReport) {
                return jsonResponse(res, {
                  error: 'No evaluation results available',
                  message: 'Run an evaluation first using POST /api/evaluate/retrieval'
                }, 404);
              }

              return jsonResponse(res, {
                success: true,
                report: latestReport
              });
            } catch (error) {
              console.error('Failed to get evaluation results:', error);
              return jsonResponse(res, {
                error: 'Failed to retrieve results',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/evaluate/history':
          if (req.method === 'GET') {
            try {
              const history = loadEvaluationReports();
              const limit = parseInt(url.searchParams.get('limit'), 10) || 10;

              return jsonResponse(res, {
                success: true,
                count: history.length,
                history: history.slice(-limit).map(h => ({
                  evaluationId: h.evaluationId,
                  timestamp: h.timestamp,
                  summary: h.summary,
                  targets: h.targets
                }))
              });
            } catch (error) {
              console.error('Failed to get evaluation history:', error);
              return jsonResponse(res, {
                error: 'Failed to retrieve history',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/evaluate/compare':
          if (req.method === 'POST') {
            try {
              const { baseline_id, current_id } = body;
              const history = loadEvaluationReports();

              const baseline = baseline_id
                ? history.find(h => h.evaluationId === baseline_id)
                : history.length > 1 ? history[history.length - 2] : null;

              const current = current_id
                ? history.find(h => h.evaluationId === current_id)
                : history.length > 0 ? history[history.length - 1] : null;

              if (!baseline || !current) {
                return jsonResponse(res, {
                  error: 'Comparison failed',
                  message: 'Both baseline and current reports are required. Run at least 2 evaluations.'
                }, 400);
              }

              const comparison = retrievalEvaluator.compareReports(baseline, current);

              return jsonResponse(res, {
                success: true,
                comparison
              });
            } catch (error) {
              console.error('Evaluation comparison failed:', error);
              return jsonResponse(res, {
                error: 'Comparison failed',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/evaluate/dataset':
          if (req.method === 'GET') {
            try {
              const filteredCategory = url.searchParams.get('category');
              const filteredDifficulty = url.searchParams.get('difficulty');
              let queries = TEST_QUERIES;

              if (filteredCategory) {
                queries = queries.filter(query => query.category === filteredCategory);
              }

              if (filteredDifficulty) {
                queries = queries.filter(query => query.difficulty === filteredDifficulty);
              }

              const stats = {
                total: queries.length,
                categories: queries.reduce((accumulator, query) => {
                  accumulator[query.category] = (accumulator[query.category] || 0) + 1;
                  return accumulator;
                }, {}),
                difficulties: queries.reduce((accumulator, query) => {
                  accumulator[query.difficulty] = (accumulator[query.difficulty] || 0) + 1;
                  return accumulator;
                }, {}),
              };

              return jsonResponse(res, {
                success: true,
                dataset: {
                  stats,
                  queries: queries.map(q => ({
                    query: q.query,
                    category: q.category,
                    difficulty: q.difficulty,
                    relevantCount: q.relevantMemories.length,
                    tags: q.tags
                  }))
                }
              });
            } catch (error) {
              console.error('Failed to get dataset info:', error);
              return jsonResponse(res, {
                error: 'Failed to retrieve dataset',
                message: error.message
              }, 500);
            }
          }
          break;

        case '/api/billing/usage':
          if (req.method === 'GET') {
            if (!planEnforcer) {
              // Fallback to legacy usage tracker if plan enforcer unavailable
              if (!usageTracker || !planStore) return jsonResponse(res, { error: 'Billing not available' }, 503);
              const billingPlan = await planStore.getOrgPlan(orgId);
              const billingUsage = await usageTracker.getUsage(orgId);
              const billingLimits = await usageTracker.checkLimits(orgId, billingPlan.id);
              return jsonResponse(res, { plan: billingPlan.id, planName: billingPlan.name, usage: billingUsage, limits: billingPlan.limits, warnings: billingLimits.warnings });
            }
            const usageSummary = await planEnforcer.getUsageSummary(orgId);
            return jsonResponse(res, usageSummary);
          }
          break;

        case '/api/billing/plans':
          if (req.method === 'GET') {
            const { getAllPlans } = await import('./billing/plans.js');
            return jsonResponse(res, { plans: getAllPlans() });
          }
          break;

        case '/api/billing/upgrade':
          if (req.method === 'POST') {
            const { plan } = body;
            const validPlans = ['free', 'pro', 'scale', 'enterprise'];
            if (!plan || !validPlans.includes(plan)) {
              return jsonResponse(res, { error: 'Invalid plan', valid: validPlans }, 400);
            }
            try {
              const oldPlan = planStore ? (await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }))?.plan : null;
              await planStore.setOrgPlan(orgId, plan);
              planStore.invalidate(orgId);
              invalidateAggregateCache({ userId, orgId });
              // Audit: plan upgrade (fire-and-forget, uses the NEW plan for the check
              // so the first upgrade to scale/enterprise is still captured)
              if (auditLogger && (plan === 'scale' || plan === 'enterprise')) {
                auditLogger.log({
                  userId,
                  organizationId: orgId,
                  eventType: 'billing.upgrade',
                  eventCategory: 'system',
                  action: 'update',
                  resourceType: 'plan',
                  oldValue: { plan: oldPlan },
                  newValue: { plan },
                  ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
                  userAgent: req.headers['user-agent'] || null,
                });
              }
              return jsonResponse(res, { success: true, plan, message: `Upgraded to ${plan}` });
            } catch (err) {
              return jsonResponse(res, { error: 'Upgrade failed', message: err.message }, 500);
            }
          }
          break;

        // ── Webhooks (Scale / Enterprise) ──
        case '/api/webhooks':
          if (!webhookManager) {
            return jsonResponse(res, { error: 'Webhook system unavailable' }, 503);
          }
          if (req.method === 'GET') {
            // Plan gate
            try {
              const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
              if (!org || (org.plan !== 'scale' && org.plan !== 'enterprise')) {
                return jsonResponse(res, { error: 'Webhooks require Scale or Enterprise plan' }, 403);
              }
            } catch {
              return jsonResponse(res, { error: 'Plan check failed' }, 500);
            }
            try {
              const webhooks = await webhookManager.list(orgId);
              return jsonResponse(res, { webhooks });
            } catch (err) {
              return jsonResponse(res, { error: 'Failed to list webhooks', message: err.message }, 500);
            }
          }
          if (req.method === 'POST') {
            // Plan gate
            try {
              const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
              if (!org || (org.plan !== 'scale' && org.plan !== 'enterprise')) {
                return jsonResponse(res, { error: 'Webhooks require Scale or Enterprise plan' }, 403);
              }
            } catch {
              return jsonResponse(res, { error: 'Plan check failed' }, 500);
            }
            const { url, events, secret } = body;
            if (!url || !events) {
              return jsonResponse(res, { error: 'url and events are required' }, 400);
            }
            try {
              const webhook = await webhookManager.create({ orgId, userId, url, events, secret });
              return jsonResponse(res, { webhook }, 201);
            } catch (err) {
              return jsonResponse(res, { error: err.message }, 400);
            }
          }
          break;

        // ── Audit Logs (Scale / Enterprise) ──
        case '/api/audit/logs':
          if (req.method === 'GET') {
            if (!auditLogger) return jsonResponse(res, { error: 'Audit logging unavailable' }, 503);
            // Plan gate
            try {
              const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
              if (!org || (org.plan !== 'scale' && org.plan !== 'enterprise')) {
                return jsonResponse(res, { error: 'Audit logs require Scale or Enterprise plan' }, 403);
              }
            } catch {
              return jsonResponse(res, { error: 'Plan check failed' }, 500);
            }
            try {
              const result = await auditLogger.query({
                organizationId: orgId,
                userId: url.searchParams.get('user_id') || undefined,
                eventCategory: url.searchParams.get('category') || undefined,
                action: url.searchParams.get('action') || undefined,
                resourceType: url.searchParams.get('resource_type') || undefined,
                from: url.searchParams.get('from') || undefined,
                to: url.searchParams.get('to') || undefined,
                limit: parseInt(url.searchParams.get('limit') || '50'),
                offset: parseInt(url.searchParams.get('offset') || '0'),
              });
              return jsonResponse(res, result);
            } catch (err) {
              return jsonResponse(res, { error: 'Audit query failed', message: err.message }, 500);
            }
          }
          break;

        // ── TARA Voice Agent Routes ──
        case '/api/tara/stream':
          if (req.method === 'POST') {
            if (!taraHandler) return jsonResponse(res, { error: 'TARA not available' }, 503);
            // Don't use jsonResponse — stream handler writes NDJSON directly
            await taraHandler.handleStream(body, { userId, orgId, res });
            return; // Response already ended by stream handler
          }
          break;

        case '/api/tara/config':
          if (req.method === 'GET') {
            if (!taraHandler) return jsonResponse(res, { error: 'TARA not available' }, 503);
            const tenantId = url.searchParams.get('tenant_id') || body.tenant_id || 'default';
            const agentName = url.searchParams.get('agent_name') || body.agent_name || 'default';
            const taraConfig = await taraHandler.configStore.getConfig(
              tenantId,
              agentName,
              { userId, orgId }
            );
            return jsonResponse(res, { config: taraConfig });
          }
          if (req.method === 'POST') {
            if (!taraHandler) return jsonResponse(res, { error: 'TARA not available' }, 503);
            const cfgTenantId = body.tenant_id || 'default';
            const cfgAgentName = body.agent_name || 'default';
            const configId = await taraHandler.configStore.saveConfig(
              cfgTenantId, cfgAgentName, body, { userId, orgId }
            );
            // Invalidate config cache so next stream_tara call picks up new config
            taraHandler.invalidateConfigCache(cfgTenantId, cfgAgentName);
            return jsonResponse(res, { success: true, config_id: configId });
          }
          break;

        case '/api/tara/sessions':
          if (req.method === 'GET') {
            if (!taraHandler) return jsonResponse(res, { error: 'TARA not available' }, 503);
            const sessions = await taraHandler.sessionManager.listSessions({ userId, orgId });
            return jsonResponse(res, { sessions });
          }
          break;

        case '/api/tara/analyze_session':
          if (req.method === 'POST') {
            if (!persistentMemoryStore) return jsonResponse(res, { error: 'Persistent memory not available' }, 503);

            // Lazy init analytics engine
            if (!taraAnalytics) {
              taraAnalytics = new SessionAnalytics({
                llmBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
                llmApiKey: process.env.GROQ_API_KEY || '',
                model: process.env.ANALYTICS_MODEL || 'openai/gpt-oss-120b',
              });
            }

            const { session_id, user_id, org_id, tenant_id, turns, metadata, memory_stats } = body;

            if (!session_id || !turns || !Array.isArray(turns)) {
              return jsonResponse(res, { error: 'session_id and turns array are required' }, 400);
            }

            // Fetch full turn history from memory if not provided
            let fullTurns = turns;
            if (turns.length === 0 && session_id) {
              try {
                const { memories } = await persistentMemoryStore.listMemories({
                  user_id: user_id || userId,
                  org_id: org_id || orgId,
                  tags: ['tara-turn', `sid:${session_id}`],
                  limit: 50,
                });
                fullTurns = (memories || []).map(m => {
                  const content = m.content || '';
                  const userMatch = content.match(/User: ([\s\S]*?)(?:\n|$)/);
                  const assistantMatch = content.match(/Assistant: ([\s\S]*?)(?:\n|$)/);
                  return [
                    userMatch ? { role: 'user', content: userMatch[1].trim(), timestamp: m.created_at } : null,
                    assistantMatch ? { role: 'assistant', content: assistantMatch[1].trim(), timestamp: m.created_at } : null,
                  ].filter(Boolean);
                }).flat();
              } catch (err) {
                console.warn('[tara/analyze] Failed to fetch turn history:', err.message);
              }
            }

            // Run analytics
            const analytics = await taraAnalytics.analyze({
              sessionId: session_id,
              userId: user_id || userId,
              orgId: org_id || orgId,
              tenantId: tenant_id || 'default',
              turns: fullTurns,
              metadata: metadata || {},
              memoryStats: memory_stats || {},
            });

            if (!analytics) {
              return jsonResponse(res, { error: 'Analytics failed' }, 500);
            }

            // Format for orchestrator contract
            const orchestratorReport = {
              brief_context: analytics.brief_context,
              analysis: analytics.analysis,
              business_signals: analytics.business_signals,
              metrics: analytics.metrics,
              hivemind_updates: analytics.hivemind_updates,
            };

            return jsonResponse(res, { report: orchestratorReport });
          }
          break;

        case '/api/tara/end_session':
          if (req.method === 'POST') {
            if (!taraHandler) return jsonResponse(res, { error: 'TARA not available' }, 503);
            if (!persistentMemoryStore) return jsonResponse(res, { error: 'Persistent memory not available' }, 503);

            const { session_id, user_id, org_id, tenant_id } = body;

            if (!session_id) {
              return jsonResponse(res, { error: 'session_id is required' }, 400);
            }

            // Lazy init analytics engine
            if (!taraAnalytics) {
              taraAnalytics = new SessionAnalytics({
                llmBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
                llmApiKey: process.env.GROQ_API_KEY || '',
                model: process.env.ANALYTICS_MODEL || 'openai/gpt-oss-120b',
              });
            }

            // Get session data from handler (includes memory stats)
            const sessionData = await taraHandler.getSessionAnalyticsData(session_id, {
              userId: user_id || userId,
              orgId: org_id || orgId,
            });

            if (!sessionData) {
              return jsonResponse(res, { error: 'Session not found' }, 404);
            }

            // Run analytics
            const analytics = await taraAnalytics.analyze({
              sessionId: session_id,
              userId: sessionData.userId,
              orgId: sessionData.orgId,
              tenantId: sessionData.tenantId,
              turns: sessionData.turns,
              metadata: sessionData.metadata,
              memoryStats: sessionData.memory_stats,
            });

            // Cleanup session stats
            taraHandler.cleanupSessionStats(session_id);

            if (!analytics) {
              return jsonResponse(res, { error: 'Analytics failed' }, 500);
            }

            // Persist a single rollup memory per session so the Memories
            // flat list shows ONE card per conversation instead of N
            // turn cards. Turn + insight rows are kept (and excluded
            // from the flat list by tag) so MemoryGraph.jsx can still
            // render the full structure. PartOf edges anchor the
            // children to this summary.
            try {
              const sUserId = sessionData.userId || userId;
              const sOrgId  = sessionData.orgId  || orgId;
              const briefContext = analytics.brief_context || '';
              const analysisObj  = analytics.analysis || {};
              const sigObj       = analytics.business_signals || {};
              const metricsObj   = analytics.metrics || {};
              const topicSnippet = (sessionData.turns?.[0]?.content || '').slice(0, 80);

              const summaryLines = [
                briefContext,
                analysisObj.user_type ? `\n**User type:** ${analysisObj.user_type}` : null,
                analysisObj.dominant_emotion ? `**Emotion:** ${analysisObj.dominant_emotion}` : null,
                analysisObj.resolution_status ? `**Resolution:** ${analysisObj.resolution_status}` : null,
                analysisObj.key_topics?.length ? `**Topics:** ${analysisObj.key_topics.join(', ')}` : null,
                Array.isArray(sigObj.opportunities) && sigObj.opportunities.length
                  ? `**Opportunities:** ${sigObj.opportunities.slice(0, 3).join('; ')}`
                  : null,
                metricsObj.sentiment_trend ? `**Sentiment:** ${metricsObj.sentiment_trend}` : null,
              ].filter(Boolean).join('\n');

              const summaryContent = summaryLines || `Voice session ${session_id} (no narrated summary).`;
              const summaryTitle = topicSnippet
                ? `Voice session — ${topicSnippet}${topicSnippet.length === 80 ? '…' : ''}`
                : `Voice session ${session_id.slice(0, 8)}`;

              const saved = await persistentMemoryStore.createMemory({
                user_id: sUserId,
                org_id: sOrgId,
                title: summaryTitle,
                content: summaryContent,
                memory_type: 'summary',
                tags: ['tara-session-summary', `sid:${session_id}`],
                source_metadata: {
                  source_platform: 'tara-voice',
                  source_id: session_id,
                },
                metadata: {
                  tara_session_id: session_id,
                  turn_count: sessionData.turns?.length || 0,
                  metrics: metricsObj,
                  user_type: analysisObj.user_type,
                  resolution_status: analysisObj.resolution_status,
                },
              });

              // Link every turn + insight memory of this session under
              // the summary via PartOf so the graph view shows the
              // session as a single rooted tree.
              try {
                const summaryId = saved?.id || saved?.memoryId;
                if (summaryId) {
                  const { memories: turnRows } = await persistentMemoryStore.listMemories({
                    user_id: sUserId,
                    org_id: sOrgId,
                    tags: [`sid:${session_id}`],
                    include_children: true,
                    limit: 200,
                  });
                  for (const t of (turnRows || [])) {
                    if (t.id === summaryId) continue;
                    if (!(t.tags || []).some(tag => tag === 'tara-turn' || tag === 'tara-insight')) continue;
                    try {
                      await persistentMemoryStore.createRelationship({
                        from_id: t.id,
                        to_id: summaryId,
                        type: 'PartOf',
                        confidence: 1.0,
                        metadata: { reason: 'voice-session-rollup' },
                        created_by: 'tara-end-session',
                      });
                    } catch { /* idempotency conflicts are fine */ }
                  }
                }
              } catch (linkErr) {
                console.warn('[tara/end_session] PartOf link failed:', linkErr.message);
              }
            } catch (summaryErr) {
              console.warn('[tara/end_session] Summary memory write failed:', summaryErr.message);
            }

            // Format for orchestrator contract
            const orchestratorReport = {
              brief_context: analytics.brief_context,
              analysis: analytics.analysis,
              business_signals: analytics.business_signals,
              metrics: analytics.metrics,
              hivemind_updates: analytics.hivemind_updates,
            };

            return jsonResponse(res, { report: orchestratorReport });
          }
          break;

        // ==========================================
        // INGEST — distill external AI chat session into memories
        // ==========================================
        case '/api/ingest/chat-session':
          if (req.method === 'POST') {
            const { platform, url, parsed, transcript = [], raw_summary } = body;
            // Project scope from caller (extension scope pill).
            const ingestProjectId = (body?.project_id || (Array.isArray(body?.project_ids) ? body.project_ids[0] : null)) || null;
            if (!parsed || !Array.isArray(parsed.memories) || parsed.memories.length === 0) {
              return jsonResponse(res, { error: 'parsed.memories[] required (run extension structured-ingest first)' }, 400);
            }
            const groqKey = process.env.GROQ_API_KEY;
            if (!groqKey) {
              return jsonResponse(res, { error: 'distill not available — no LLM key configured' }, 503);
            }
            try {
              const { distillChatSession } = await import('./services/chat-ingest-distill.js');
              const distillAccessCtx = await buildAccessContext(userId, orgId);
              const result = await distillChatSession({
                candidates: parsed.memories,
                platform: platform || 'unknown',
                url: url || '',
                userId,
                orgId,
                projectId: ingestProjectId,
                apiKey: groqKey,
                ctx: {
                  persistentMemoryStore,
                  persistentMemoryEngine,
                  smartIngestRouter,
                  buildRoutedIngestPayloads,
                  accessContext: distillAccessCtx,
                  projectId: ingestProjectId,
                },
              });

              // Also save the session-level rollup so /timeline shows the
              // whole conversation as one anchor node.
              try {
                if (raw_summary && parsed.title && persistentMemoryEngine?.ingestMemory) {
                  const rollupPayload = {
                    title: parsed.title.slice(0, 80),
                    content: `${parsed.summary || ''}\n\n${raw_summary}`.slice(0, 8000),
                    tags: ['ai-chat-session', `from-${(platform || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '')}`, 'session-rollup'],
                    memory_type: 'conversation',
                    user_id: userId,
                    org_id: orgId,
                    ...(ingestProjectId ? { project_id: ingestProjectId, project_ids: [ingestProjectId] } : {}),
                    source_metadata: { source_platform: 'ai-chat', host_platform: platform, url, via: 'chat-ingest-distill' },
                  };
                  const [routed] = await buildRoutedIngestPayloads(rollupPayload, { smartIngestRouter });
                  persistentMemoryEngine.ingestMemory(routed).catch((e) =>
                    console.warn('[ingest/chat-session] rollup save failed:', e.message)
                  );
                }
              } catch {}

              return jsonResponse(res, {
                ok: true,
                platform,
                url,
                ...result,
                open_questions: parsed.open_questions || [],
              });
            } catch (err) {
              console.error('[ingest/chat-session] failed:', err);
              return jsonResponse(res, { error: err.message || 'distill failed' }, 500);
            }
          }
          break;

        // ==========================================
        // TRANSLATE — runtime auto-translate for the <T> React component
        // ==========================================
        // Body: { texts: string[], target_lang: string }
        // Returns: { translations: string[] }  (same order, same length)
        //
        // Used by the frontend's runtime <T> auto-translate component to
        // batch-translate any hardcoded English JSX text into the user's
        // chosen UI language. Cached in-memory + on disk (sha256(text)+lang
        // key) so repeated calls are free.
        case '/api/translate':
          if (req.method === 'POST') {
            const { texts, target_lang } = body;
            if (!Array.isArray(texts) || texts.length === 0) {
              return jsonResponse(res, { error: 'texts[] required' }, 400);
            }
            if (texts.length > 200) {
              return jsonResponse(res, { error: 'max 200 strings per batch' }, 400);
            }
            const lang = String(target_lang || '').toLowerCase().slice(0, 8);
            if (!lang || lang === 'en') {
              return jsonResponse(res, { translations: texts });
            }
            const groqKey = process.env.GROQ_API_KEY;
            if (!groqKey) {
              return jsonResponse(res, { error: 'translate unavailable — no LLM key' }, 503);
            }
            try {
              const { translateBatch } = await import('./services/translate-cache.js');
              const translations = await translateBatch({ texts, lang, apiKey: groqKey });
              return jsonResponse(res, { translations });
            } catch (err) {
              console.warn('[translate] failed:', err.message);
              return jsonResponse(res, { error: err.message, translations: texts });
            }
          }
          break;

        // ==========================================
        // PENDING WRITES — agent draft-approval gate
        // GET    /api/pending-writes               list drafts
        // POST   /api/pending-writes/:id/approve   approve + execute
        // POST   /api/pending-writes/:id/cancel    cancel
        // ==========================================
        case '/api/pending-writes':
          if (req.method === 'GET') {
            if (!prisma) return jsonResponse(res, { error: 'db unavailable' }, 503);
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
            const statusFilter = url.searchParams.get('status');
            const rows = await prisma.pendingWrite.findMany({
              where: { userId, ...(statusFilter ? { status: statusFilter } : {}) },
              orderBy: { createdAt: 'desc' },
              take: limit,
              select: {
                id: true, provider: true, toolName: true, toolArgs: true,
                preview: true, status: true, errorMsg: true,
                createdAt: true, approvedAt: true, sentAt: true,
              },
            });
            return jsonResponse(res, { drafts: rows });
          }
          break;

        // ==========================================
        // PENDING WRITES — approve / cancel by id
        // ==========================================
        // dispatched below via regex match outside the switch

        // ==========================================
        // CHAT — Talk to HIVE (memory-augmented LLM)
        // ==========================================
        case '/api/chat':
          if (req.method === 'POST') {
            const { message, model = 'openai/gpt-oss-120b', history = [], stream: wantStream = false, language = null } = body;
            // Project scope from caller — when set, all recall/save tool
            // calls dispatched by the ReAct agent are auto-bound to this
            // project, and the auto-saved conversation memory inherits it.
            const requestProjectId = (body?.project_id || (Array.isArray(body?.project_ids) ? body.project_ids[0] : null)) || null;
            if (!message || typeof message !== 'string') {
              return jsonResponse(res, { error: 'message is required' }, 400);
            }

            const groqKey = process.env.GROQ_API_KEY;
            if (!groqKey) {
              return jsonResponse(res, { error: 'Chat not available — no LLM API key configured' }, 503);
            }

            // ─── Two-Loop ReAct Agent (default path) ─────────────────────
            // The agent uses Groq tool-calling to pick from ~19 HIVEMIND
            // tools dynamically (recall, save, update, traverse_graph, at,
            // diff, timeline, web_search, ...). Falls back to legacy
            // recall-then-LLM flow on HIVEMIND_AGENT_MODE=off or on error.
            const agentEnabled = process.env.HIVEMIND_AGENT_MODE !== 'off';
            if (agentEnabled) {
              try {
                // Still honour the onboarding state machine — it cannot be
                // LLM-picked because it needs to gate the very first turn
                // before the LLM ever runs.
                let agentAssistantName = null;
                let agentOrgName = 'your organisation';
                try {
                  const {
                    getAssistantName, extractNameFromReply, buildAssistantNamePayload, ASSISTANT_IDENTITY,
                    hasShownOnboardingIntro, markOnboardingShown,
                  } = await import('./services/assistant-identity.js');
                  if (persistentMemoryStore) {
                    const lookup = await getAssistantName(persistentMemoryStore, { userId, orgId });
                    agentAssistantName = lookup.name;
                  }
                  if (orgId && prisma) {
                    try {
                      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
                      if (org?.name) agentOrgName = org.name;
                    } catch {}
                  }
                  const introShown = persistentMemoryStore
                    ? await hasShownOnboardingIntro(persistentMemoryStore, { userId, orgId })
                    : false;
                  if (!agentAssistantName && !introShown) {
                    if (persistentMemoryStore) await markOnboardingShown(persistentMemoryStore, { userId, orgId });
                    return jsonResponse(res, {
                      response: `Hi — I'm ${agentOrgName}'s second brain. I store, connect, and recall everything you and your team tell me.\n\nGot a name for me? Pick something short (max 32 chars). Say "skip" to use the default ("${ASSISTANT_IDENTITY.DEFAULT_NAME}").`,
                      sources: [], usage: null, assistant_name: null,
                      onboarding: { step: 'ask_name', org_name: agentOrgName },
                    });
                  }
                  if (!agentAssistantName && introShown) {
                    const extracted = extractNameFromReply(message);
                    const finalName = extracted || ASSISTANT_IDENTITY.DEFAULT_NAME;
                    try {
                      const payload = buildAssistantNamePayload({ name: finalName, userId, orgId });
                      if (persistentMemoryEngine?.ingestMemory) {
                        await persistentMemoryEngine.ingestMemory({ ...payload, skipProcessing: true, smartIngest: false });
                      }
                    } catch {}
                    agentAssistantName = finalName;
                    return jsonResponse(res, {
                      response: extracted
                        ? `Got it — I'll go by **${finalName}** from now on. What can I help you with?`
                        : `Going with the default — call me **${finalName}**. What can I help you with?`,
                      sources: [], usage: null, assistant_name: finalName,
                      onboarding: { step: 'name_saved', name: finalName, org_name: agentOrgName },
                    });
                  }
                } catch {}

                // v2 = plan-then-act pipeline (4 LLM steps, structured
                // JSON I/O, language-aware, evidence-audited). Default
                // ON; flip HIVEMIND_AGENT_V1=true to fall back to the
                // legacy two-loop ReAct path.
                const useV2 = process.env.HIVEMIND_AGENT_V1 !== 'true';
                const { runReactAgent } = useV2
                  ? await import('./agent/react-agent-v2.js').then(m => ({ runReactAgent: m.runReactAgentV2 }))
                  : await import('./agent/react-agent.js');
                const agentAccessCtx = await buildAccessContext(userId, orgId);

                // SSE branch — for browser ext + in-app streaming tool timeline.
                if (wantStream) {
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                  });
                  const emit = (evt) => {
                    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {}
                  };
                  try {
                    const result = await runReactAgent({
                      message, history, model, apiKey: groqKey,
                      assistantName: agentAssistantName, orgName: agentOrgName,
                      language,
                      ctx: {
                        userId, orgId,
                        projectId: requestProjectId,
                        prisma,
                        persistentMemoryStore, persistentMemoryEngine, evidenceRetrieval,
                        smartIngestRouter,
                        buildRoutedIngestPayloads,
                        accessContext: agentAccessCtx,
                        webIntelligence: globalThis.webIntelligence || null,
                      },
                      onEvent: emit,
                    });
                    emit({ type: 'done', ...result });
                  } catch (agentErr) {
                    emit({ type: 'error', error: agentErr.message });
                  }
                  try { res.end(); } catch {}
                  return;
                }

                const result = await runReactAgent({
                  message, history, model, apiKey: groqKey,
                  assistantName: agentAssistantName, orgName: agentOrgName,
                  language,
                  ctx: {
                    userId, orgId,
                    projectId: requestProjectId,
                    prisma,
                    persistentMemoryStore, persistentMemoryEngine, evidenceRetrieval,
                    smartIngestRouter,
                    buildRoutedIngestPayloads,
                    ingestRoutedPayload,                 // tree-aware dispatch
                    accessContext: agentAccessCtx,
                    webIntelligence: globalThis.webIntelligence || null,
                  },
                });

                // Auto-save the turn so the conversation lands in HIVEMIND
                // even when the LLM forgot to call hivemind_save_memory.
                // Skip when the agent ALREADY saved an explicit memory —
                // duplicating would create a noisy turn-log alongside the
                // curated fact. Also skip operator inference + contradiction
                // detection on the conversation log itself: it's an audit
                // record, not a fact-claim, and treating it as one was
                // producing the 100+ false-positive contradiction edges.
                try {
                  // Skip auto-save when agent already saved/logged an explicit
                  // memory this turn. Match on tool name + "saved"/"logged"
                  // prefix in summary — covers both hivemind_save_memory and
                  // hivemind_log_decision. Permissive on the id suffix because
                  // older summaries occasionally omitted it.
                  const SAVE_TOOLS = new Set(['hivemind_save_memory', 'hivemind_log_decision']);
                  const alreadySaved = Array.isArray(result.steps)
                    && result.steps.some(s =>
                      SAVE_TOOLS.has(s?.tool) && /^(saved|logged)\b/i.test(String(s?.result_summary || '').trim())
                    );
                  if (persistentMemoryEngine?.ingestMemory && result.response && !alreadySaved) {
                    const convoPayload = {
                      title: `Chat turn — ${new Date().toISOString().slice(0, 10)}`,
                      content: `User: ${message}\n\nAssistant: ${result.response}`,
                      tags: ['chat', 'talk-to-hive', 'react-agent', 'conversation-log'],
                      memory_type: 'conversation',
                      user_id: userId,
                      org_id: orgId,
                      ...(requestProjectId ? { project_id: requestProjectId, project_ids: [requestProjectId] } : {}),
                      source_metadata: { source_platform: 'talk-to-hive', via: 'react-agent' },
                      // Conversation logs bypass operator inference and
                      // contradiction detection. They still get timestamp
                      // tags + indexed for retrieval, but don't fan out
                      // into Updates/Contradicts edges against every prior
                      // chat turn.
                      skipSmartRouting: true,
                      skip_contradiction_detection: true,
                      skip_relationship_classification: true,
                    };
                    persistentMemoryEngine.ingestMemory(convoPayload)
                      .catch((e) => console.warn('[chat:react-agent] auto-save failed:', e.message));
                  }
                } catch {}

                return jsonResponse(res, result);
              } catch (agentErr) {
                console.warn('[chat:react-agent] failed, falling back to legacy:', agentErr.message);
                // Fall through to legacy implementation below.
              }
            }

            // ─── Assistant identity onboarding ───
            // Per-user: on the very first chat, HIVEMIND introduces itself as
            // "<orgName>'s second brain" and asks for a name. The user's
            // reply is parsed and persisted as a memory tagged
            // `assistant-name`. Every subsequent chat reads that memory and
            // addresses itself by the chosen name.
            let assistantName = null;
            let assistantNameMemoryId = null;
            let orgName = 'your organisation';
            try {
              const {
                getAssistantName, extractNameFromReply, buildAssistantNamePayload, ASSISTANT_IDENTITY,
                hasShownOnboardingIntro, markOnboardingShown,
              } = await import('./services/assistant-identity.js');
              if (persistentMemoryStore) {
                const lookup = await getAssistantName(persistentMemoryStore, { userId, orgId });
                assistantName = lookup.name;
                assistantNameMemoryId = lookup.memoryId;
              }
              // Resolve org name (best-effort, falls back gracefully).
              if (orgId && prisma) {
                try {
                  const org = await prisma.organization.findUnique({
                    where: { id: orgId },
                    select: { name: true, slug: true },
                  });
                  if (org?.name) orgName = org.name;
                } catch {}
              }

              // Onboarding state via PERSISTENT sentinel (not history regex):
              //   • introShown=false, name=null  → STATE 1: ask once, mark shown
              //   • introShown=true,  name=null  → STATE 2: parse this turn as name reply
              //   • name=*                       → skip onboarding entirely
              // Survives empty-history sessions / new tabs / API reconnects.
              const introShown = persistentMemoryStore
                ? await hasShownOnboardingIntro(persistentMemoryStore, { userId, orgId })
                : false;

              // STATE 1: no name set, intro never shown → ask now + persist sentinel.
              if (!assistantName && !introShown) {
                const intro =
                  `Hi — I'm ${orgName}'s second brain. I store, connect, and recall everything you and your team tell me.\n\n` +
                  `Got a name for me? Pick something short (max 32 chars). Say "skip" to use the default ("${ASSISTANT_IDENTITY.DEFAULT_NAME}").`;
                // Persist the "intro shown" sentinel BEFORE responding so a
                // racing follow-up turn can't re-trigger State 1.
                if (persistentMemoryStore) {
                  await markOnboardingShown(persistentMemoryStore, { userId, orgId });
                }
                return jsonResponse(res, {
                  response: intro,
                  sources: [],
                  usage: null,
                  assistant_name: null,
                  onboarding: { step: 'ask_name', org_name: orgName },
                });
              }

              // STATE 2: no name set, intro was shown → this turn is the name reply.
              if (!assistantName && introShown) {
                const extracted = extractNameFromReply(message);
                const finalName = extracted || ASSISTANT_IDENTITY.DEFAULT_NAME;
                // Save it via the standard ingest pipeline. Skip processing so
                // the LLM fact-extraction doesn't misinterpret "User chose to
                // name their HIVEMIND assistant 'Sage'" as "User's name is
                // Sage" — that pollution caused false claims in later
                // "what's my name" queries.
                try {
                  const payload = buildAssistantNamePayload({
                    name: finalName,
                    userId,
                    orgId,
                    prevMemoryId: assistantNameMemoryId,
                  });
                  if (persistentMemoryEngine?.ingestMemory) {
                    await persistentMemoryEngine.ingestMemory({
                      ...payload,
                      skipProcessing: true,
                      smartIngest: false, // identity config, not knowledge
                    });
                  }
                } catch (saveErr) {
                  console.warn('[chat:onboarding] save name failed:', saveErr.message);
                }
                assistantName = finalName;
                const ack = extracted
                  ? `Got it — I'll go by **${finalName}** from now on. What can I help you with?`
                  : `Going with the default — call me **${finalName}**. What can I help you with?`;
                return jsonResponse(res, {
                  response: ack,
                  sources: [],
                  usage: null,
                  assistant_name: finalName,
                  onboarding: { step: 'name_saved', name: finalName, org_name: orgName },
                });
              }
            } catch (idErr) {
              console.warn('[chat:onboarding] identity load failed:', idErr.message);
            }

            // ─── Slack action intent (Talk-to-HIVE write actions) ───
            // Browser-origin requests must never be interpreted as Slack actions.
            const isBrowserOrigin = Boolean(body?.browser_origin) || /<METADATA:BROWSER_CONTEXT>/i.test(message || '');
            try {
              const { detectSlackAction, stripPendingSentinel } = await import('./connectors/providers/slack/action-detector.js');
              const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant')?.content || null;
              const slackIntent = isBrowserOrigin
                ? { matched: false }
                : detectSlackAction(message, { lastAssistantTurn: lastAssistant });

              if (slackIntent.matched) {
                // STAGE — write intent detected, ask user to confirm.
                if (slackIntent.phase === 'stage') {
                  return jsonResponse(res, {
                    response: slackIntent.draftAck,  // contains sentinel for next turn
                    sources: [],
                    usage: null,
                    assistant_name: assistantName,
                    slack_action: { phase: 'stage', action_type: slackIntent.action_type },
                  });
                }
                if (slackIntent.phase === 'clarify') {
                  return jsonResponse(res, {
                    response: slackIntent.clarify,
                    sources: [],
                    usage: null,
                    assistant_name: assistantName,
                    slack_action: { phase: 'clarify' },
                  });
                }
                if (slackIntent.phase === 'cancel') {
                  return jsonResponse(res, {
                    response: 'Cancelled. Nothing was sent to Slack.',
                    sources: [],
                    usage: null,
                    assistant_name: assistantName,
                    slack_action: { phase: 'cancel' },
                  });
                }

                // EXECUTE — either read action (search/history) or confirmed write.
                if (slackIntent.phase === 'execute' && prisma) {
                  try {
                    const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
                    const { SlackBridge } = await import('./connectors/providers/slack/bridge.js');
                    const connStore = new ConnectorStore(prisma);
                    const bridge = new SlackBridge({ connectorStore: connStore });
                    const a = slackIntent.action_type;
                    const p = slackIntent.payload || {};
                    let result = null;
                    let summary = '';

                    if (a === 'slack_post') {
                      result = await bridge.postMessage(userId, p.channel, p.text, { threadTs: p.thread_ts });
                      const permalink = result?.permalink || result?.message?.permalink || null;
                      summary = permalink
                        ? `Sent to **${p.channel.startsWith('#') || p.channel.startsWith('@') ? p.channel : '#' + p.channel}**. [View](${permalink})`
                        : `Sent to **${p.channel}**.`;
                      // Audit + auto-ingest mirroring the employees endpoint.
                      try {
                        auditLog({
                          organizationId: orgId, userId,
                          actorType: 'user', actorUserId: userId,
                          eventType: 'action.slack_post.executed', eventCategory: 'chat',
                          action: 'execute', resourceType: 'slack_channel', resourceId: p.channel,
                          metadata: { via: 'talk-to-hive', preview: p.text.slice(0, 200) },
                        });
                      } catch {}
                      if (persistentMemoryEngine?.ingestMemory) {
                        const slackPostPayload = {
                          content: p.text,
                          title: `You → ${p.channel}`,
                          tags: ['slack', 'talk-to-hive', 'auto-ingest', 'live-slack'],
                          memory_type: 'note',
                          user_id: userId,
                          org_id: orgId,
                          source_metadata: { source_platform: 'slack', channel: p.channel, via: 'talk-to-hive' },
                          skip_fact_extraction: true,
                        };
                        buildRoutedIngestPayloads(slackPostPayload, { smartIngestRouter }).then(([routed]) =>
                          persistentMemoryEngine.ingestMemory(routed)
                        ).catch(err => console.warn('[chat:slack-post] auto-ingest failed:', err.message));
                      }
                    } else if (a === 'slack_react') {
                      result = await bridge._call('reactions.add',
                        { channel: p.channel, timestamp: p.ts, name: p.emoji },
                        await connStore.getAccessToken(userId, 'slack'), 'POST');
                      summary = `Reacted with :${p.emoji}:`;
                    } else if (a === 'slack_search') {
                      result = await bridge.searchMessages(userId, p.query, { count: p.count || 10 });
                      const hits = Array.isArray(result) ? result : (result?.matches || []);
                      summary = hits.length > 0
                        ? `Found ${hits.length} match${hits.length > 1 ? 'es' : ''}:\n\n` +
                          hits.slice(0, 5).map((h, i) => `${i + 1}. **#${h.channel?.name || h.channel || '?'}** · ${h.username || h.user || ''} — ${(h.text || '').slice(0, 160)}`).join('\n')
                        : `No Slack messages matched "${p.query}".`;
                    } else if (a === 'slack_history') {
                      result = await bridge.getChannelHistory(userId, p.channel, { limit: p.limit || 50 });
                      const msgs = Array.isArray(result) ? result : (result?.messages || []);
                      summary = msgs.length > 0
                        ? `Last ${msgs.length} message${msgs.length > 1 ? 's' : ''} in **#${p.channel}**:\n\n` +
                          msgs.slice(0, 10).map(m => `· ${m.username || m.user || ''}: ${(m.text || '').slice(0, 160)}`).join('\n')
                        : `No recent messages in **#${p.channel}**.`;
                    }

                    return jsonResponse(res, {
                      response: stripPendingSentinel(summary),
                      sources: [],
                      usage: null,
                      assistant_name: assistantName,
                      slack_action: { phase: 'executed', action_type: a, ok: true },
                    });
                  } catch (slackExecErr) {
                    console.warn('[chat:slack-action] execute failed:', slackExecErr.message);
                    const errMsg = /not connected|no token/i.test(slackExecErr.message)
                      ? 'Slack isn\'t connected for your account. Connect it in **Settings → Connectors → Slack** first.'
                      : `Slack action failed: ${slackExecErr.message}`;
                    return jsonResponse(res, {
                      response: errMsg,
                      sources: [],
                      usage: null,
                      assistant_name: assistantName,
                      slack_action: { phase: 'failed', error: slackExecErr.message },
                    });
                  }
                }
              }
            } catch (slackDetectErr) {
              console.warn('[chat:slack-action] detector failed:', slackDetectErr.message);
              // Fall through to normal chat flow on any detector failure.
            }

            try {
              // --- Classify user intent ---
              let msgTrimmed = message.trim();
              
              // Strip <METADATA:*> blocks for fact extraction (browser extension context)
              // Keep them in the full message for LLM context, but don't extract as facts
              msgTrimmed = msgTrimmed.replace(/<METADATA:[^>]*>[\s\S]*?<\/METADATA:[^>]*>/gi, '').trim();
              
              const isQuestion = /^(what|when|where|who|how|why|do |does |did |is |are |can |could |tell me|show me|list |describe )/i.test(msgTrimmed);
              const isMetaQuery = /\b(what do you know|what have (i|you)|tell me about me|who am i|my profile|summarize my|everything about me|about myself)\b/i.test(msgTrimmed);
              const isAggregateQuery = /\b(what products|what services|list all|everything about|all .{0,20} (we|I|you) (have|know|sell|offer|make))\b/i.test(msgTrimmed);
              const isDeclarative = !isQuestion && msgTrimmed.length > 5 && !/^(hi|hey|hello|yo|thanks|ok|okay|yes|no|sure)\b/i.test(msgTrimmed);
              const isUpdateStatement = /\b(no longer|not anymore|changed|updated|now (is|uses|works)|switched to|replaced|resigned|quit|left|moved to|new |instead of)\b/i.test(msgTrimmed);
              const hasMemoryKeywords = /\b(remember|save|don't forget|note that|update|my new|i just|i got|i moved|i changed|i bought|i sold|i started|i stopped|i am|i'm)\b/i.test(msgTrimmed);
              const isRecencyQuery = /\b(latest|newest|most recent|last message|last email|just now|right now|current)\b/i.test(message);
              const toneGuidance = inferChatToneGuidance(message);

              // Step 1: Recall memories for context
              let memories = [];
              let injectionText = '';

              if (persistentMemoryStore) {
                try {
                  const chatIntent = detectQueryIntent(message);
                  const chatWeights = computeDynamicWeights(chatIntent);

                  // Bi-temporal detection — if user references a date or
                  // says "as of X" / "back in", flip recall into time-travel
                  // mode via valid_at. Matches hivemind_at MCP semantics.
                  let chatValidAt = null;
                  try {
                    const m = message.match(/\b(?:as of|back in|on|before|by)\s+([A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|Q[1-4]\s+\d{4})/i);
                    if (m && m[1]) {
                      const parsed = new Date(m[1]);
                      if (!Number.isNaN(parsed.getTime())) chatValidAt = parsed;
                    }
                  } catch { /* no temporal hint */ }

                  // Auto-infer tags from the query phrasing (decision/bug/refactor/
                  // file:<path>/fn:<name>/...). These are passed as preferred_tags
                  // to the recall layer — soft +0.08 score boost per overlap, never
                  // a hard filter — so the right memories rise to the top without
                  // hiding paraphrased matches.
                  let inferredTags = [];
                  let inferredType = null;
                  try {
                    const { inferQueryTags, inferMemoryType } = await import('./services/query-tag-inference.js');
                    inferredTags = inferQueryTags(message);
                    inferredType = inferMemoryType(message);
                    if (inferredTags.length > 0) {
                      console.log('[chat] inferred preferred_tags:', inferredTags, 'memory_type:', inferredType || '(any)');
                    }
                  } catch (tagErr) {
                    console.warn('[chat] tag inference failed:', tagErr.message);
                  }

                  // For meta-queries ("what do you know about me"), broaden the search
                  const recallQueries = isMetaQuery
                    ? [message, 'personal facts about user', 'user preferences decisions']
                    : isAggregateQuery
                    ? [message, message.replace(/\b(what|list|all|everything)\b/gi, '').trim()]
                    : [message];

                  let allRecalled = [];
                  const chatAccessCtx = await buildAccessContext(userId, orgId);
                  for (const q of recallQueries) {
                    if (!q || q.length < 3) continue;
                    try {
                      const recallResult = await recallPersistedMemories(persistentMemoryStore, {
                        query_context: q,
                        user_id: userId,
                        org_id: orgId,
                        max_memories: isMetaQuery ? 20 : isAggregateQuery ? 15 : isRecencyQuery ? 15 : 10,
                        inject_parent_chunks: true,
                        weights: chatWeights,
                        preference_boost: chatIntent.type === 'preference',
                        // Boost cognition-loop canonicals (synthesis + drift-compacted
                        // summaries) — they're the highest-density truth in the graph.
                        preferred_tags: [
                          ...inferredTags,
                          'canonical-summary',
                          'synthesized',
                          'cognition-loop',
                        ],
                        access_context: chatAccessCtx,
                        // Bi-temporal time-travel for date-shaped questions
                        ...(chatValidAt ? { bitemporal: { valid_at: chatValidAt } } : {}),
                      });
                      const recalled = recallResult.memories || [];
                      injectionText = injectionText || recallResult.injectionText || '';
                      // Merge, dedup by id
                      const existingIds = new Set(allRecalled.map(m => m.id));
                      for (const m of recalled) {
                        if (!existingIds.has(m.id)) {
                          existingIds.add(m.id);
                          allRecalled.push(m);
                        }
                      }
                    } catch {}
                  }

                  let recalledMemories = allRecalled;

                  // Inject parent chunks for fact-memories (richer context)
                  for (const mem of recalledMemories) {
                    if ((mem.tags || []).includes('extracted-fact') && mem.metadata?.parent_memory_id) {
                      try {
                        const parent = await persistentMemoryStore.getMemory(mem.metadata.parent_memory_id);
                        if (parent) mem.parent_chunk = parent.content;
                      } catch {}
                    }
                  }

                  // For meta-queries, prioritize facts and personal content
                  if (isMetaQuery) {
                    recalledMemories.sort((a, b) => {
                      const aIsFact = (a.memory_type === 'fact' || (a.tags || []).includes('extracted-fact')) ? 1 : 0;
                      const bIsFact = (b.memory_type === 'fact' || (b.tags || []).includes('extracted-fact')) ? 1 : 0;
                      const aIsPersonal = (a.tags || []).includes('sent-by-user') ? 1 : 0;
                      const bIsPersonal = (b.tags || []).includes('sent-by-user') ? 1 : 0;
                      return (bIsFact + bIsPersonal) - (aIsFact + aIsPersonal) || (b.score || 0) - (a.score || 0);
                    });
                  }

                  // For recency queries, re-sort by created_at descending
                  if (isRecencyQuery && recalledMemories.length > 0) {
                    recalledMemories.sort((a, b) => {
                      const dateA = new Date(a.created_at || a.document_date || 0);
                      const dateB = new Date(b.created_at || b.document_date || 0);
                      return dateB - dateA;
                    });
                    try {
                      const newest = await persistentMemoryStore.listLatestMemories({
                        user_id: userId, org_id: orgId,
                      });
                      const recentReal = newest
                        .filter(m => !(m.tags || []).includes('observation') && !(m.tags || []).includes('longmemeval'))
                        .slice(0, 5);
                      const existingIds = new Set(recalledMemories.map(m => m.id));
                      for (const m of recentReal) {
                        if (!existingIds.has(m.id)) {
                          m._recencyInjected = true;
                          recalledMemories.unshift(m);
                        }
                      }
                    } catch {}
                  }

                  // Filter out irrelevant results - lower threshold for better recall
                  const CHAT_MIN_SCORE = 0.05; // Lowered from 0.12 to allow more relevant memories
                  // Identity / voice-profile config memories must NEVER pollute the
                  // user-knowledge recall context. They're consumed elsewhere
                  // (assistant-identity loader + voice-profile loader) and
                  // including them here causes the LLM to confuse "the user
                  // named the assistant Sage" with "the user IS named Sage".
                  const CONFIG_TAGS = new Set(['assistant-name', 'voice-profile', 'org-voice', 'user-voice']);
                  const relevantMemories = recalledMemories.filter(m => {
                    const tags = m.tags || [];
                    if (tags.some(t => CONFIG_TAGS.has(t))) return false;
                    if (m._recencyInjected) return true;
                    // Always include high confidence memories, lower threshold for others
                    return (m.score || 0) >= CHAT_MIN_SCORE || (m.vectorScore || 0) >= 0.3;
                  });

                  // Debug logging for chat recall
                  console.log('[chat] Recall stats: %d total, %d relevant, scores:', recalledMemories.length, relevantMemories.length, relevantMemories.slice(0, 3).map(m => ({ score: m.score, vectorScore: m.vectorScore, content: (m.content||'').slice(0,50) })));

                  // Decision-first sort when the user asks about choices.
                  const isDecisionQuery = /\b(decide|decision|chose|chosen|picked|selected|why did (we|i|you)|why use|why prefer|trade-off)\b/i.test(message);
                  if (isDecisionQuery) {
                    relevantMemories.sort((a, b) => {
                      const aDec = (a.memory_type === 'decision' || (a.tags || []).includes('decision')) ? 1 : 0;
                      const bDec = (b.memory_type === 'decision' || (b.tags || []).includes('decision')) ? 1 : 0;
                      return bDec - aDec || (b.score || 0) - (a.score || 0);
                    });
                  }

                  // Variable per-memory content limit: top 3 get full reasoning,
                  // rest get a tighter slice. This prevents "I couldn't find
                  // info" caused by truncating the most relevant decision/code
                  // block mid-sentence.
                  memories = relevantMemories.slice(0, isMetaQuery ? 20 : 15).map((m, idx) => {
                    const isFact = (m.tags || []).includes('extracted-fact');
                    const cap = idx < 3 ? 2400 : isFact ? 400 : 700;
                    return {
                      id: m.id,
                      title: m.title || (m.content || '').slice(0, 60),
                      content: (m.content || '').slice(0, cap),
                      parent_chunk: m.parent_chunk ? m.parent_chunk.slice(0, idx < 3 ? 1200 : 500) : undefined,
                      score: m.score || 0,
                      tags: m.tags || [],
                      memory_type: m.memory_type,
                      created_at: m.created_at,
                      document_date: m.document_date,
                    };
                  });

                  // Graph-expand the top match: pull memories linked via
                  // Updates / Extends / Derives one hop away. This surfaces
                  // related decisions / refactors / bug fixes the recall
                  // didn't score high but are structurally connected.
                  if (memories.length > 0 && prisma) {
                    try {
                      const topId = memories[0].id;
                      const links = await prisma.relationship.findMany({
                        where: {
                          OR: [{ fromId: topId }, { toId: topId }],
                          type: { in: ['Updates', 'Extends', 'Derives'] },
                          fromMemory: { userId, orgId, deletedAt: null },
                          toMemory: { userId, orgId, deletedAt: null },
                        },
                        select: { fromId: true, toId: true, type: true },
                        take: 5,
                      });
                      const seen = new Set(memories.map(m => m.id));
                      const connectedIds = [];
                      for (const r of links) {
                        const nbr = r.fromId === topId ? r.toId : r.fromId;
                        if (!seen.has(nbr)) { seen.add(nbr); connectedIds.push(nbr); }
                      }
                      if (connectedIds.length > 0) {
                        const connectedMems = await prisma.memory.findMany({
                          where: { id: { in: connectedIds }, userId, orgId, deletedAt: null },
                          select: {
                            id: true, title: true, content: true, tags: true,
                            memoryType: true, createdAt: true, documentDate: true
                          },
                        });
                        for (const cm of connectedMems) {
                          memories.push({
                            id: cm.id,
                            title: cm.title || (cm.content || '').slice(0, 60),
                            content: (cm.content || '').slice(0, 1200),
                            score: 0.5, // synthetic — graph-expanded
                            tags: cm.tags || [],
                            memory_type: cm.memoryType,
                            created_at: cm.createdAt,
                            document_date: cm.documentDate,
                            _graphExpanded: true,
                          });
                        }
                      }
                    } catch (gErr) {
                      console.warn('[chat] graph expand failed:', gErr.message);
                    }
                  }
                } catch (recallErr) {
                  console.warn('[chat] Recall failed:', recallErr.message);
                }
              }

              // Inject persistent user profile (sanitized — drop any user-profile
              // bleed from /api/recall's injectionText that could conflict with
              // explicit prompt structure).
              let profileContext = '';
              if (profileStore) {
                try {
                  profileContext = await profileStore.buildProfileContext(userId, orgId);
                } catch {}
              }

              // Drop the recall-side injection_text — it includes a
              // <chain-of-note> block that fights our explicit system prompt.
              // We have the memories + their scores; we don't need the
              // pre-baked CoT scaffolding.
              injectionText = '';

              // Load voice profile (org-voice + user-voice memories).
              let voiceFragment = '';
              try {
                const { loadVoiceProfile } = await import('./services/voice-profile.js');
                voiceFragment = await loadVoiceProfile(persistentMemoryStore, { userId, orgId });
              } catch (vErr) {
                console.warn('[chat] voice profile load failed:', vErr.message);
              }

              // Step 1.5: Slack live fallback — when local recall is thin and
              // query has Slack-shaped signals, fetch live Slack via SlackBridge,
              // merge into LLM context, and auto-ingest top hits for next time.
              let slackHits = [];
              let slackBridgeFired = false;
              try {
                const { slackShapeDetector, SlackBridge } =
                  await import('./connectors/providers/slack/bridge.js');
                const strongMems = memories.filter(m => (m.score || 0) >= 0.3).length;
                const detected = slackShapeDetector(message);
                console.log('[chat][slack-gate] userId=%s prisma=%s strongMems=%d detected=%s',
                  userId, !!prisma, strongMems, detected);
                if (prisma && userId && strongMems < 3 && detected) {
                  const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
                  const connStore = new ConnectorStore(prisma);
                  const token = await connStore.getAccessToken(userId, 'slack').catch((err) => {
                    console.warn('[chat][slack-gate] getAccessToken errored:', err.message);
                    return null;
                  });
                  console.log('[chat][slack-gate] token=%s', token ? 'present' : 'missing');
                  if (token) {
                    const bridge = new SlackBridge({ connectorStore: connStore });
                    slackHits = await bridge.searchMessages(userId, message, { count: 8 }).catch(err => {
                      console.warn('[chat] Slack live search failed:', err.message, err.code || '');
                      return [];
                    });
                    console.log('[chat][slack-gate] searchMessages returned %d hits for query=%j', slackHits.length, message);
                    if (slackHits.length > 0) {
                      slackBridgeFired = true;
                      console.log('[chat] Slack fallback fired: %d hits', slackHits.length);
                      // Auto-ingest top 5 so next recall is cached
                      if (persistentMemoryEngine) {
                        for (const hit of slackHits.slice(0, 5)) {
                          const content = (hit.text || '').trim();
                          if (!content || content.length < 15) continue;
                          const where = hit.channel_name ? `#${hit.channel_name}` : (hit.channel_id || 'unknown');
                          const who = hit.username || hit.user || 'unknown';
                          const slackFallbackPayload = {
                            content,
                            title: `Slack ${where} · ${who}: ${content.slice(0, 60)}`,
                            tags: ['slack', 'live-slack', 'auto-ingest', `slack:${where}`],
                            memory_type: 'note',
                            user_id: userId,
                            org_id: orgId,
                            source_metadata: {
                              source_platform: 'slack',
                              source_url: hit.permalink,
                              channel_id: hit.channel_id,
                              channel_name: hit.channel_name,
                              ts: hit.ts,
                              user: hit.user,
                            },
                            skip_fact_extraction: true,
                          };
                          buildRoutedIngestPayloads(slackFallbackPayload, { smartIngestRouter }).then(([routed]) =>
                            persistentMemoryEngine.ingestMemory(routed)
                          ).catch(err => console.warn('[chat] Slack auto-ingest failed:', err.message));
                        }
                      }
                    }
                  }
                }
              } catch (slackErr) {
                console.warn('[chat] Slack fallback hook errored:', slackErr.message);
              }

              // Step 1.6: Google Workspace live fallback — same pattern as Slack.
              // When recall is thin OR query has fresh/intent markers, call live
              // MCP tools (Calendar/Drive/Gmail/etc.) and merge hits into context.
              let googleHits = [];
              let googleBridgeFired = false;
              try {
                if (prisma && userId) {
                  const { LiveQueryRouter } = await import('./connectors/providers/google/live-query-router.js');
                  const { decryptToken, refreshOAuthToken } = await import('./connectors/framework/connector-store.js');
                  const router = new LiveQueryRouter({
                    prisma,
                    decryptToken,
                    refreshOAuthToken: refreshOAuthToken || null,
                  });
                  const classification = router.classify(message, memories);
                  console.log('[chat][google-gate] decision=%s reason=%s services=%j',
                    classification.needsLive ? 'fetched' : 'skipped',
                    classification.reason,
                    classification.services);
                  if (classification.needsLive && classification.services.length > 0) {
                    const connectedSvcs = await router.getConnectedServices(userId, classification.services);
                    console.log('[chat][google-gate] connected=%j (requested=%j)', connectedSvcs, classification.services);
                    googleHits = await router.fetch(userId, message, classification.services).catch(err => {
                      console.warn('[chat] Google live fetch failed:', err.message);
                      return [];
                    });
                    console.log('[chat][google-gate] fetch returned %d hits', googleHits.length);
                    if (googleHits.length > 0) {
                      googleBridgeFired = true;
                      console.log('[chat] Google live fallback fired: %d hits across [%s]',
                        googleHits.length, classification.services.join(', '));
                    }
                  }
                }
              } catch (googleErr) {
                console.warn('[chat] Google fallback hook errored:', googleErr.message);
              }

              // Step 2: Build system prompt — second-brain aware
              const recencyHint = isRecencyQuery ? '\n\nIMPORTANT: The user is asking about their MOST RECENT activity. Memories are sorted newest-first. Focus on the FIRST memory.' : '';
              const metaHint = isMetaQuery ? '\n\nIMPORTANT: The user is asking what you know ABOUT THEM. Summarize key personal facts, preferences, decisions, and topics from ALL memories below. Group by topic. Include names, companies, roles, and key decisions.' : '';
              const aggregateHint = isAggregateQuery ? '\n\nIMPORTANT: The user wants a COMPREHENSIVE list. Go through ALL memories below and extract every relevant item. Do not stop at the first one you find.' : '';
              const declarativeHint = (isDeclarative && !isQuestion) ? '\n\nIMPORTANT: The user may be TELLING you a new fact, not asking a question. If they are stating something new (e.g. "X is Y", "I started Z"), acknowledge it naturally: "Got it — [fact]." or "Noted, [fact]." Do NOT say "I don\'t have that in my memory" when the user is clearly informing you of something new.' : '';
              const updateHint = isUpdateStatement ? '\n\nIMPORTANT: The user is UPDATING a previous fact. Acknowledge the change and confirm what the new state is. Example: "Updated — [new fact]. Previously it was [old fact]."' : '';
              const profileSection = profileContext ? `\n\nUser Profile:\n${profileContext}\n` : '';
              const voiceSection = voiceFragment ? `\n\n${voiceFragment}\n` : '';
              const displayName = assistantName || 'HIVEMIND';
              const identityLine = assistantName
                ? `You are ${displayName}, a HIVEMIND assistant. The user gave YOU the name ${displayName}; ${displayName} is YOUR name, NOT the user's. When asked "what is your name", answer ${displayName}. When asked "what is my name" or "who am I", use Retrieved Memories or User Profile — never answer ${displayName}.`
                : `You are HIVEMIND, the user's memory-aware assistant.`;
              const systemPrompt = `${identityLine}
You help the user store, connect, and recall information accurately. Speak clearly and directly as HIVEMIND. Do not claim to work for any company unless the user explicitly asks about a real organisation in retrieved context.
${voiceSection}${profileSection}${recencyHint}${metaHint}${aggregateHint}${declarativeHint}${updateHint}
Rules:
- BELOW is a section called "Retrieved Memories" — ALWAYS read and use it to answer the user's question
- Answer questions DIRECTLY using the memories provided — look at the Retrieved Memories section first
- Be concise — 1-3 sentences for simple questions, more for complex ones
- If memories contain the answer, give it confidently — even if wording differs. "CEO" = "managing director" = "Geschäftsführer" = "head of company". Make reasonable semantic connections between synonyms, translations, and equivalent roles/concepts.
- If memories conflict, prefer the most recent one and note the change
- If user is TELLING you something new (a statement, not a question), acknowledge it: "Got it" or "Noted" and confirm the fact. You are their second brain — everything they tell you is worth remembering.
- If user is UPDATING a fact ("no longer", "changed", "resigned", "switched to"), confirm the update and reference what changed
- Only say "I don't have that in my memory" when the Retrieved Memories section is completely empty or shows "No specific memories found"
- CRITICAL: Distinguish between things the USER did/said/decided vs things they merely RECEIVED or READ. An email FROM someone else is NOT the user's project.
- NEVER list memories one by one, evaluate them, or show reasoning about each memory. NEVER output "Memory 1:", "Memory notes", "Notes on each memory", "Not relevant", etc. Go straight to the answer.
- Do NOT say "Based on my memories" or "According to my records" — just answer
- ${toneGuidance}

${injectionText}`;

              // Step 3: Build memory context for the LLM
              let memoryContext = '';
              if (memories.length > 0) {
                const factMems = memories.filter(m => (m.tags || []).includes('extracted-fact') || m.memory_type === 'fact');
                const regularMems = memories.filter(m => !(m.tags || []).includes('extracted-fact') && m.memory_type !== 'fact' && !(m.tags || []).includes('observation'));
                const obsMems = memories.filter(m => (m.tags || []).includes('observation'));

                const parts = [];
                if (factMems.length > 0) {
                  parts.push('Key Facts:\n' + factMems.map(m => {
                    const date = m.document_date ? ` [${String(m.document_date).slice(0, 10)}]` : '';
                    return `• ${m.content}${date}`;
                  }).join('\n'));
                }
                if (obsMems.length > 0) {
                  parts.push('Observations:\n' + obsMems.map(m => `• ${m.content}`).join('\n'));
                }
                for (const m of regularMems.slice(0, 8)) {
                  const date = m.document_date ? ` [${String(m.document_date).slice(0, 10)}]` : '';
                  const sentByUser = (m.tags || []).includes('sent-by-user');
                  const isNewsletter = (m.tags || []).includes('newsletter');
                  const attrHint = sentByUser ? ' [sent by user]' : isNewsletter ? ' [newsletter/external]' : '';
                  parts.push(`Memory${date}${attrHint}: ${m.content}`);
                  if (m.parent_chunk) parts.push(`Full context: ${m.parent_chunk}`);
                }
                memoryContext = '\n\nRetrieved Memories:\n' + parts.join('\n\n');
                console.log('[chat] Sent %d memories to LLM (%d facts, %d regular, %d obs)', memories.length, factMems.length, regularMems.length, obsMems.length);
              } else {
                console.log('[chat] No memories found for query:', message.slice(0, 100));
                // Add a hint to the system prompt when no memories found
                memoryContext = '\n\nRetrieved Memories:\nNo specific memories found about this topic. Respond naturally based on general knowledge.';
              }

              // Append live Slack hits (white-labelled as "From your Slack")
              if (slackBridgeFired && slackHits.length > 0) {
                const { formatSlackHitForContext } = await import('./connectors/providers/slack/bridge.js');
                const slackBlock = slackHits.slice(0, 8).map(formatSlackHitForContext).join('\n');
                memoryContext += `\n\nFrom your Slack (live):\n${slackBlock}\n\nUse the lines above to answer if relevant. Prefix the answer with "From your Slack:" when the answer comes primarily from these live results.`;
              }

              // Append live Google Workspace hits (grouped per source service)
              if (googleBridgeFired && googleHits.length > 0) {
                // Group by _source so LLM sees [Calendar / Drive / Gmail] cleanly
                const grouped = {};
                for (const hit of googleHits.slice(0, 20)) {
                  const src = hit._source || 'google';
                  if (!grouped[src]) grouped[src] = [];
                  grouped[src].push(hit);
                }
                const formatHit = (hit) => {
                  // Text-typed results come back as { text: "<verbose>", _service }
                  if (typeof hit.text === 'string') {
                    return `- ${hit.text.split('\n').slice(0, 8).join('\n  ').slice(0, 600)}`;
                  }
                  // Structured event/file objects
                  if (hit.summary || hit.subject || hit.name) {
                    const when = hit.start?.dateTime || hit.start?.date || hit.modifiedTime || hit.date || '';
                    return `- ${hit.summary || hit.subject || hit.name}${when ? ` · ${when}` : ''}${hit.location ? ` @ ${hit.location}` : ''}`;
                  }
                  return `- ${JSON.stringify(hit).slice(0, 300)}`;
                };
                const labelOf = (src) => ({
                  google_calendar: 'Calendar',
                  google_drive: 'Drive',
                  google_docs: 'Docs',
                  google_sheets: 'Sheets',
                  google_contacts: 'Contacts',
                  google_tasks: 'Tasks',
                  gmail: 'Gmail',
                }[src] || src);
                const blocks = Object.entries(grouped).map(([src, hits]) =>
                  `From your ${labelOf(src)} (live):\n${hits.map(formatHit).join('\n')}`
                ).join('\n\n');
                memoryContext += `\n\n${blocks}\n\nUse the lines above to answer. Prefix the answer with "From your <source>:" when answering from live results. These reflect the user's actual Google data right now.`;
              }

              // Step 4: Build message history for Groq
              const groqMessages = [
                { role: 'system', content: systemPrompt + memoryContext },
                ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: message },
              ];

              const modelMap = {
                'llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
                'gpt-oss-120b': 'openai/gpt-oss-120b',
                'gpt-oss-20b': 'openai/gpt-oss-20b',
              };
              const groqModel = modelMap[model] || model;
              const groqParams = {
                model: groqModel,
                messages: groqMessages,
                max_tokens: 700,
                temperature: 0.25,
              };
              if (groqModel.includes('gpt-oss')) {
                // GPT-OSS models: enable reasoning for better performance
                // reasoning_effort: low/medium/high controls reasoning depth
                groqParams.reasoning_effort = 'medium';
                groqParams.max_completion_tokens = 1024;
                groqParams.temperature = 0.6; // Recommended 0.5-0.7 for reasoning models
                groqParams.top_p = 0.95;
                delete groqParams.max_tokens; // Use max_completion_tokens instead
              }

              const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(groqParams),
              });

              if (!groqResp.ok) {
                const errText = await groqResp.text();
                throw new Error(`Groq ${groqResp.status}: ${errText.slice(0, 200)}`);
              }

              const groqData = await groqResp.json();
              // gpt-oss-* reasoning models put visible output in
              // reasoning_content on Groq. Coalesce both so chat doesn't
              // return empty when those models are selected.
              const _msg = groqData.choices?.[0]?.message || {};
              const response = String(_msg.content || _msg.reasoning_content || '')
                .replace(/[\uD800-\uDFFF]/g, '').trim();

              // Step 5: Smart fact ingestion — extract clean facts, route through SmartIngestRouter
              if (persistentMemoryEngine && response.length > 20) {
                // Treat command-shaped queries as questions (they are not user-facts).
                // Without this, "summarize my latest slack thread" gets ingested as a
                // fact, and on the next call recall finds it → blocks the live Slack
                // fallback (self-poisoning loop).
                const isCommandQuery = /^(summarize|summarise|find|search|show|tell|list|describe|explain|recap|fetch|pull|get|give me)\b/i.test(msgTrimmed);
                const shouldIngest = (isDeclarative || hasMemoryKeywords || isUpdateStatement)
                  && !isCommandQuery;

                if (shouldIngest) {
                  // Extract the core fact from user's statement (not the full turn)
                  const factContent = msgTrimmed;
                  const factTitle = `Fact: ${msgTrimmed.slice(0, 80)}`;

                  const chatFactPayload = {
                    content: factContent,
                    title: factTitle,
                    // 'extracted-fact' tag was removed (2026-05-21) — chat
                    // ingests are top-level memories, NOT children of a
                    // parent doc. Keeping the tag here made the new
                    // listMemories exclusion swallow legit chat saves.
                    tags: ['chat', 'talk-to-hive'],
                    memory_type: 'fact',
                    user_id: userId,
                    org_id: orgId,
                    source_metadata: { source_platform: 'chat' },
                    skip_fact_extraction: true,
                  };
                  buildRoutedIngestPayloads(chatFactPayload, { smartIngestRouter }).then((routedPayloads) => {
                    for (const routedPayload of routedPayloads) {
                      persistentMemoryEngine.ingestMemory(routedPayload).catch(err => console.warn('[chat] Fact ingest failed:', err.message));
                    }
                  }).catch(err => console.warn('[chat] Smart routing failed:', err.message));
                }
              }

              return jsonResponse(res, {
                response,
                sources: memories,
                slack_used: slackBridgeFired,
                slack_hits: slackBridgeFired ? slackHits.slice(0, 8).map(h => ({
                  channel: h.channel_name ? `#${h.channel_name}` : h.channel_id,
                  user: h.username || h.user,
                  ts: h.ts,
                  permalink: h.permalink,
                  preview: (h.text || '').slice(0, 200),
                })) : undefined,
                model: groqModel,
                usage: {
                  prompt_tokens: groqData.usage?.prompt_tokens,
                  completion_tokens: groqData.usage?.completion_tokens,
                },
                assistant_name: assistantName || null,
                org_name: orgName,
              });
            } catch (chatErr) {
              console.error('[chat] Failed:', chatErr.message);
              return jsonResponse(res, { error: chatErr.message }, 500);
            }
          }
          break;

        // ─── Phase 1: Evidence Retrieval & Feature Flags ────────────────────────

        case '/api/features':
          if (req.method === 'GET') {
            return jsonResponse(res, {
              document_first_ingest: process.env.ENABLE_DOCUMENT_FIRST_INGEST === 'true' && !!documentFirstIngestion,
              evidence_recall: process.env.ENABLE_EVIDENCE_RECALL === 'true' && !!evidenceRetrieval,
              memory_promotion_jobs: process.env.ENABLE_MEMORY_PROMOTION_JOBS === 'true',
              evidence_collection: process.env.EVIDENCE_QDRANT_COLLECTION || null,
              memory_collection: process.env.MEMORY_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION || null
            });
          }
          break;

        case '/api/evidence/search':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/evidence/search')) return;
            if (!evidenceRetrieval) {
              return jsonResponse(res, { error: 'Evidence retrieval not enabled. Set ENABLE_EVIDENCE_RECALL=true' }, 501);
            }
            const { query, limit, documentId } = body;
            if (!query) return jsonResponse(res, { error: 'query is required' }, 400);
            try {
              const results = await evidenceRetrieval.retrieveEvidence({
                query, userId, orgId, limit: limit || 10, documentId
              });
              return jsonResponse(res, { success: true, mode: 'evidence', results, count: results.length });
            } catch (err) {
              console.error('[evidence/search] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/evidence/hybrid':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/evidence/hybrid')) return;
            if (!evidenceRetrieval) {
              return jsonResponse(res, { error: 'Evidence retrieval not enabled. Set ENABLE_EVIDENCE_RECALL=true' }, 501);
            }
            const { query, memoryLimit, evidenceLimit } = body;
            if (!query) return jsonResponse(res, { error: 'query is required' }, 400);
            try {
              const result = await evidenceRetrieval.retrieveHybrid({
                query, userId, orgId, memoryLimit: memoryLimit || 5, evidenceLimit: evidenceLimit || 5
              });
              return jsonResponse(res, {
                success: true, mode: 'hybrid',
                memories: result.memories, evidence: result.evidence,
                memoriesCount: result.memories.length, evidenceCount: result.evidence.length
              });
            } catch (err) {
              console.error('[evidence/hybrid] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/evidence/memory':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/evidence/memory')) return;
            if (!evidenceRetrieval) {
              return jsonResponse(res, { error: 'Evidence retrieval not enabled. Set ENABLE_EVIDENCE_RECALL=true' }, 501);
            }
            const memoryId = url.searchParams.get('memoryId') || body?.memoryId;
            if (!memoryId) return jsonResponse(res, { error: 'memoryId query parameter is required' }, 400);
            try {
              const evidenceLinks = await evidenceRetrieval.getMemoryEvidence(memoryId);
              return jsonResponse(res, { success: true, memoryId, evidenceLinks, count: evidenceLinks.length });
            } catch (err) {
              console.error('[evidence/memory] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/evidence/document':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/evidence/document')) return;
            if (!evidenceRetrieval) {
              return jsonResponse(res, { error: 'Evidence retrieval not enabled. Set ENABLE_EVIDENCE_RECALL=true' }, 501);
            }
            const documentId = url.searchParams.get('documentId') || body?.documentId;
            if (!documentId) return jsonResponse(res, { error: 'documentId query parameter is required' }, 400);
            try {
              const result = await evidenceRetrieval.getDocumentEvidence({ documentId, userId, orgId });
              if (!result) return jsonResponse(res, { error: 'Document not found or access denied' }, 404);
              return jsonResponse(res, {
                success: true,
                document: result.document,
                segments: result.segments,
                linkedMemories: result.linkedMemories,
                segmentCount: result.segments.length,
                memoryCount: result.linkedMemories.length
              });
            } catch (err) {
              console.error('[evidence/document] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        // ─── Phase 1: Document Browser Routes ───────────────────────────────────

        case '/api/documents':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/documents')) return;
            if (!documentFirstIngestion) {
              return jsonResponse(res, { error: 'Document-first ingestion not enabled. Set ENABLE_DOCUMENT_FIRST_INGEST=true' }, 501);
            }

            const limit = parseInt(url.searchParams.get('limit') || '20');
            const offset = parseInt(url.searchParams.get('offset') || '0');
            const documentType = url.searchParams.get('document_type');
            const tags = url.searchParams.get('tags');

            try {
              const where = {
                userId,
                orgId,
                ...(documentType ? { documentType } : {}),
                ...(tags ? { tags: { hasSome: tags.split(',').map(t => t.trim()) } } : {})
              };

              const [documents, total] = await Promise.all([
                prisma.knowledgeDocument.findMany({
                  where,
                  orderBy: { createdAt: 'desc' },
                  take: limit,
                  skip: offset,
                  select: {
                    id: true,
                    title: true,
                    documentType: true,
                    sourcePlatform: true,
                    sourceUrl: true,
                    documentDate: true,
                    wordCount: true,
                    parseStatus: true,
                    parseEngine: true,
                    structureExtracted: true,
                    tags: true,
                    createdAt: true,
                    updatedAt: true,
                    _count: {
                      select: {
                        segments: true,
                        memoryLinks: true
                      }
                    }
                  }
                }),
                prisma.knowledgeDocument.count({ where })
              ]);

              const enriched = documents.map(doc => ({
                ...doc,
                segmentCount: doc._count.segments,
                promotedCount: doc._count.memoryLinks,
                _count: undefined
              }));

              return jsonResponse(res, {
                documents: enriched,
                pagination: {
                  total,
                  limit,
                  offset,
                  hasMore: offset + limit < total
                }
              });
            } catch (err) {
              console.error('[documents] List failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        case '/api/documents/search':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/documents/search')) return;
            if (!documentFirstIngestion) {
              return jsonResponse(res, { error: 'Document-first ingestion not enabled' }, 501);
            }

            const query = url.searchParams.get('q');
            const limit = parseInt(url.searchParams.get('limit') || '20');

            if (!query) return jsonResponse(res, { error: 'q query parameter is required' }, 400);

            try {
              const documents = await prisma.knowledgeDocument.findMany({
                where: {
                  userId,
                  orgId,
                  OR: [
                    { title: { contains: query, mode: 'insensitive' } },
                    { tags: { hasSome: [query] } },
                    { sourcePlatform: { contains: query, mode: 'insensitive' } }
                  ]
                },
                orderBy: { createdAt: 'desc' },
                take: limit,
                select: {
                  id: true,
                  title: true,
                  documentType: true,
                  sourcePlatform: true,
                  sourceUrl: true,
                  documentDate: true,
                  wordCount: true,
                  parseEngine: true,
                  tags: true,
                  createdAt: true,
                  _count: {
                    select: {
                      segments: true,
                      memoryLinks: true
                    }
                  }
                }
              });

              const enriched = documents.map(doc => ({
                ...doc,
                segmentCount: doc._count.segments,
                promotedCount: doc._count.memoryLinks,
                _count: undefined
              }));

              return jsonResponse(res, { results: enriched });
            } catch (err) {
              console.error('[documents/search] Failed:', err.message);
              return jsonResponse(res, { error: err.message }, 500);
            }
          }
          break;

        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      console.error('API Error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

async function writeAuditLog(prisma, {
  userId,
  orgId,
  eventType,
  action,
  resourceType = null,
  resourceId = null,
  metadata = {},
  oldValue = null,
  newValue = null,
  ipAddress = null,
  userAgent = null
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        organizationId: orgId,
        eventType,
        action,
        eventCategory: 'access_management',
        resourceType,
        resourceId,
        metadata,
        oldValue,
        newValue,
        ipAddress,
        userAgent,
        createdAt: new Date()
      }
    });
  } catch (err) {
    console.error('[audit] Failed to write log:', err.message);
  }
}

function jsonResponse(res, data, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function inferChatToneGuidance(text = '') {
  const input = String(text || '').trim();
  if (!input) {
    return 'Match the user tone: direct, natural, and concise.';
  }

  const lower = input.toLowerCase();
  const terse = input.length < 80 || /(?:^|\s)(pls|plz|quick|just|now|fix|do it)(?:\s|$)/i.test(lower);
  const casual = /\b(hey|yo|bro|lol|wtf|pls|gonna|wanna|u|ur)\b/i.test(lower);
  const formal = /\b(please|could you|would you|kindly)\b/i.test(lower);

  if (formal) {
    return 'Match the user tone: calm, clear, and professional.';
  }
  if (casual) {
    return 'Match the user tone: casual and natural, without sounding forced.';
  }
  if (terse) {
    return 'Match the user tone: highly direct and compact.';
  }
  return 'Match the user tone: direct, natural, and concise.';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Parse multipart/form-data into parts.
 * Each part has: { name, filename, contentType, data (Buffer), value (string for text fields) }
 */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let pos = 0;
  // Skip preamble — find first boundary
  const firstBoundary = buffer.indexOf(boundaryBuf, pos);
  if (firstBoundary < 0) return parts;
  pos = firstBoundary + boundaryBuf.length + 2; // skip boundary + \r\n

  while (pos < buffer.length) {
    // Find next boundary
    const nextBoundary = buffer.indexOf(boundaryBuf, pos);
    if (nextBoundary < 0) break;

    // Part data is between pos and nextBoundary - 2 (strip trailing \r\n)
    const partData = buffer.subarray(pos, nextBoundary - 2);

    // Split headers from body (separated by \r\n\r\n)
    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd < 0) { pos = nextBoundary + boundaryBuf.length + 2; continue; }

    const headerStr = partData.subarray(0, headerEnd).toString('utf-8');
    const bodyBuf = partData.subarray(headerEnd + 4);

    // Parse Content-Disposition
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    const part = {
      name: nameMatch?.[1] || null,
      filename: filenameMatch?.[1] || null,
      contentType: ctMatch?.[1]?.trim() || null,
      data: bodyBuf,
      value: !filenameMatch ? bodyBuf.toString('utf-8').trim() : null,
    };

    parts.push(part);

    // Check for end boundary
    const afterBoundary = buffer.subarray(nextBoundary + boundaryBuf.length, nextBoundary + boundaryBuf.length + 2);
    if (afterBoundary.toString() === '--') break;

    pos = nextBoundary + boundaryBuf.length + 2;
  }

  return parts;
}

async function ensureQdrantSearchIndexes() {
  if (process.env.USE_QDRANT_STORAGE === 'false') {
    return;
  }

  try {
    await qdrantCollections.createAllCollections();
    console.log('✅ Qdrant collections verified');
  } catch (error) {
    console.error('⚠️  Failed to verify Qdrant collections:', error.message);
  }
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🧠 HIVE-MIND Server Running                              ║
║                                                            ║
║   Local: http://localhost:${PORT}                          ║
║                                                            ║
║   Features:                                                ║
║   • Triple-Operator Memory (Updates/Extends/Derives)       ║
║   • Graph Traversal                                        ║
║   • Ebbinghaus Decay                                       ║
║   • Auto-Recall                                            ║
║   • Three-Tier Retrieval (Quick/Panorama/Insight)          ║
║   • Retrieval Quality Evaluation                           ║
║                                                            ║
║   Search API Endpoints:                                    ║
║   • POST /api/search/quick    - Fast semantic search       ║
║   • POST /api/search/panorama - Historical search          ║
║   • POST /api/search/insight  - LLM-powered analysis       ║
║   • POST /api/search/compare  - Compare all tiers          ║
║                                                            ║
║   Evaluation API Endpoints:                                ║
║   • POST /api/evaluate/retrieval - Run evaluation          ║
║   • GET  /api/evaluate/results   - Get latest results      ║
║   • GET  /api/evaluate/history   - Get evaluation history  ║
║   • POST /api/evaluate/compare   - Compare evaluations     ║
║   • GET  /api/evaluate/dataset   - Get test dataset info   ║
║                                                            ║
║   Open your browser to get started!                        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

  ensureQdrantSearchIndexes();

  // Start DR server in same process — shared memoryStore, prisma, recallFn
  (async () => {
    try {
      const { startDRServer } = await import('./deep-research/dr-server.js');
      const drPort = parseInt(process.env.DR_PORT || '8055', 10);
      await startDRServer({
        memoryStore: persistentMemoryStore,
        prisma,
        recallFn: recallPersistedMemories,
        browserRuntime,
        authenticateFn: async (apiKey) => {
          try {
            const record = await authenticatePersistedApiKey(prisma, apiKey);
            if (!record) return null;
            return { userId: record.userId, orgId: record.orgId };
          } catch { return null; }
        },
        port: drPort,
      });
    } catch (err) {
      console.error('[DR Server] Failed to start:', err.message);
    }
  })();
});
