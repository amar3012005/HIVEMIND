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
const { MemoryGraphEngine } = await import('./memory/graph-engine.js');
const { PrismaGraphStore } = await import('./memory/prisma-graph-store.js');
const { CognitiveOperator, detectQueryIntent, computeDynamicWeights, getMemoryTypeBoost } = await import('./memory/operator-layer.js');
const { ContextAutopilot, scoreForRetention } = await import('./memory/context-autopilot.js');
const { BiTemporalEngine } = await import('./memory/bi-temporal.js');
const { StigmergicCoT } = await import('./memory/stigmergic-cot.js');
const { ByzantineConsensus } = await import('./memory/byzantine-consensus.js');
const { queryPersistedMemories, recallPersistedMemories } = await import('./memory/persisted-retrieval.js');
const { expandTemporalQuery } = await import('./search/time-aware-expander.js');
const { authenticatePersistedApiKey, hasEntitlement, hashApiKey: hashPersistedApiKey } = await import('./auth/api-keys.js');
const { WebJobStore } = await import('./web/web-job-store.js');
const { BrowserRuntime, getTelemetry } = await import('./web/browser-runtime.js');
const { validateDomain, filterContent, UserRateLimiter, detectAbuse, getRobotsWarning } = await import('./web/web-policy.js');
const webRateLimiter = new UserRateLimiter({ maxPerMinute: 10, maxPerHour: 60 });
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
  path.join(PROJECT_ROOT, 'client.html')
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

// Web Intelligence
const WEB_JOBS_FILE = path.join(DATA_DIR, 'web-jobs.json');
const webJobStore = new WebJobStore(WEB_JOBS_FILE);
const browserRuntime = new BrowserRuntime();
const WEB_SEARCH_DAILY_LIMIT = Number(process.env.HIVEMIND_WEB_SEARCH_DAILY_LIMIT || 100);
const WEB_CRAWL_DAILY_LIMIT = Number(process.env.HIVEMIND_WEB_CRAWL_DAILY_LIMIT || 500);

installConsoleCapture('core');

// Initialize memory engine with SQLite
const engine = new MemoryEngine('./hivemind.db');
const prisma = getPrismaClient();
const usageTracker = prisma ? new UsageTracker(prisma) : null;
const planStore = prisma ? new PlanStore(prisma) : null;
const persistentMemoryStore = prisma ? new PrismaGraphStore(prisma) : null;
const persistentMemoryEngine = persistentMemoryStore ? new MemoryGraphEngine({
  store: persistentMemoryStore,
  predictCalibrate: true,
  predictCalibrateOptions: {
    strongMatchThreshold: 0.70,
    partialMatchThreshold: 0.50,
    sentenceNoveltyThreshold: 0.35,
    topK: 5,
    minSimilarityForComparison: 0.15
  }
}) : null;
const cognitiveOperator = persistentMemoryStore ? new CognitiveOperator({ store: persistentMemoryStore }) : null;
const biTemporalEngine = persistentMemoryStore ? new BiTemporalEngine({ store: persistentMemoryStore, prisma }) : null;
const stigmergicCoT = persistentMemoryStore ? new StigmergicCoT({ store: persistentMemoryStore, traceTTLMinutes: 30 }) : null;
const byzantineConsensus = new ByzantineConsensus({ commitThreshold: 80 });

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
const contextAutopilot = persistentMemoryStore ? new ContextAutopilot({
  store: persistentMemoryStore,
  maxContextTokens: 128_000,
  compactionThreshold: 0.80,
  criticalMemoryCount: 15
}) : null;
const qdrantClient = getQdrantClient();
const qdrantCollections = getQdrantCollections();
const groqClient = getGroqClient();

// Initialize Three-Tier Retrieval
const threeTierRetrieval = new ThreeTierRetrieval({
  vectorStore: qdrantClient,
  graphStore: persistentMemoryStore,
  llmClient: groqClient.isAvailable() ? groqClient : null
});

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
  path.join(REPO_ROOT, 'src', 'ingestion'),
  path.join(PROJECT_ROOT, 'ingestion')
];
const CONTEXT_CACHE_TTL_MS = Number(process.env.HIVEMIND_CONTEXT_CACHE_TTL_MS || 15000);
const aggregateCache = new Map();

// OAuth 2.0 authorization code store (in-memory, 5 min TTL)
const OAUTH_BASE_URL = process.env.HIVEMIND_OAUTH_BASE_URL || 'https://core.hivemind.davinciai.eu:8050';
const OAUTH_SCOPES_SUPPORTED = ['memory:read', 'memory:write', 'mcp', 'web_search', 'web_crawl'];
const oauthCodeStore = new Map(); // code -> { clientId, redirectUri, scope, codeChallenge, codeChallengeMethod, userId, orgId, expiresAt }
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanExpiredOAuthCodes() {
  const now = Date.now();
  for (const [code, entry] of oauthCodeStore) {
    if (now > entry.expiresAt) oauthCodeStore.delete(code);
  }
}
setInterval(cleanExpiredOAuthCodes, 60_000);

const ALLOWED_ORIGINS = (process.env.HIVEMIND_ALLOWED_ORIGINS || 'https://hivemind.davinciai.eu')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

function loadIngestionPipeline() {
  for (const candidate of INGESTION_MODULE_CANDIDATES) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const { createIngestionPipeline } = require(candidate);
    return createIngestionPipeline();
  }

  return null;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Secret, X-User-Id, X-Org-Id');
}

const ingestionPipeline = loadIngestionPipeline();
const mcpIngestionService = new MCPIngestionService({ ingestionPipeline });

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
    // Fast count queries instead of loading all records
    const where = { userId, orgId, deletedAt: null, isLatest: true };
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
    // Relationship count — use raw query since model name may vary
    let relationships = 0;
    try {
      const relRows = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int as c FROM "MemoryRelationship"');
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

    const summary = {
      user_id: userId,
      org_id: orgId,
      project,
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
    max_memories: maxMemories
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

function generateApiKeyRecord({ label, userId, orgId, scopes = ['memory:read', 'memory:write'], containerTags = null }) {
  const rawKey = generateRawApiKey();
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    label: label || 'ultimate-user-key',
    keyHash: hashApiKey(rawKey),
    keyPreview: `${rawKey.slice(0, 12)}...${rawKey.slice(-6)}`,
    userId: userId || DEFAULT_USER,
    orgId: orgId || DEFAULT_ORG,
    scopes,
    containerTags: Array.isArray(containerTags) && containerTags.length > 0 ? containerTags : null,
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
    if (persistedRecord.description) {
      try {
        const meta = JSON.parse(persistedRecord.description);
        if (Array.isArray(meta.containerTags)) {
          persistedContainerTags = meta.containerTags;
        }
      } catch {
        // description is plain text, not JSON — no containerTags
      }
    }
    return {
      ok: true,
      principal: {
        keyId: persistedRecord.id,
        userId: persistedRecord.userId || DEFAULT_USER,
        orgId: persistedRecord.orgId || DEFAULT_ORG,
        scopes: persistedRecord.scopes || [],
        containerTags: persistedContainerTags,
        rawKey: apiKey,
        persisted: true
      }
    };
  }

  const keyHash = hashApiKey(apiKey);
  const store = loadApiKeyStore();
  const record = store.keys.find(k => k.keyHash === keyHash && !k.revokedAt);
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

  if (pathname === '/health') {
    return jsonResponse(res, {
      ok: true,
      service: 'hivemind-api',
      port: process.env.PORT || 3000
    });
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
        result = await handleToolCall(body.params || {}, userId, orgId, apiClient);
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

  // ── OAuth 2.0 Discovery & Endpoints ──────────────────────────────────────

  if (pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    return jsonResponse(res, {
      resource: OAUTH_BASE_URL,
      authorization_servers: [OAUTH_BASE_URL],
      scopes_supported: OAUTH_SCOPES_SUPPORTED
    });
  }

  if (pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    return jsonResponse(res, {
      issuer: OAUTH_BASE_URL,
      authorization_endpoint: `${OAUTH_BASE_URL}/oauth/authorize`,
      token_endpoint: `${OAUTH_BASE_URL}/oauth/token`,
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    });
  }

  if (pathname === '/oauth/authorize' && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const scope = url.searchParams.get('scope') || '';
    const state = url.searchParams.get('state') || '';
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';

    if (!clientId || !redirectUri) {
      return jsonResponse(res, { error: 'invalid_request', error_description: 'client_id and redirect_uri are required' }, 400);
    }

    // Check for session cookie (simple cookie-based auth: hivemind_session=<admin_secret>)
    const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
      const [k, ...v] = c.trim().split('=');
      if (k) acc[k.trim()] = v.join('=').trim();
      return acc;
    }, {});
    const isLoggedIn = cookies['hivemind_session'] === ADMIN_SECRET;

    if (isLoggedIn) {
      // Show consent page
      const requestedScopes = scope ? scope.split(/[\s+]/).filter(s => OAUTH_SCOPES_SUPPORTED.includes(s)) : ['memory:read'];
      const scopeListHtml = requestedScopes.map(s => `<li><code>${s}</code></li>`).join('');
      const consentHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HIVEMIND - Authorize Application</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#16161e;border:1px solid #2a2a3a;border-radius:12px;padding:2rem;max-width:420px;width:90%}
  h1{font-size:1.3rem;margin:0 0 0.5rem;color:#a78bfa}
  h2{font-size:1rem;margin:0 0 1rem;color:#888}
  .app-name{color:#60a5fa;font-weight:600}
  ul{padding-left:1.2rem;margin:0.5rem 0 1.5rem}
  li{margin:0.3rem 0}
  code{background:#1e1e2e;padding:2px 6px;border-radius:4px;font-size:0.85rem}
  .actions{display:flex;gap:0.75rem}
  button{flex:1;padding:0.6rem;border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:500}
  .approve{background:#22c55e;color:#000} .approve:hover{background:#16a34a}
  .deny{background:#333;color:#ccc} .deny:hover{background:#444}
</style></head><body>
<div class="card">
  <h1>Authorize Application</h1>
  <h2><span class="app-name">${clientId.replace(/[<>&"']/g, '')}</span> wants to access your HIVEMIND memories</h2>
  <p>This application is requesting the following permissions:</p>
  <ul>${scopeListHtml}</ul>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId.replace(/"/g, '&quot;')}">
    <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}">
    <input type="hidden" name="scope" value="${requestedScopes.join(' ')}">
    <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge" value="${codeChallenge.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod.replace(/"/g, '&quot;')}">
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </div>
  </form>
</div></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(consentHtml);
      return;
    }

    // Not logged in — show login form
    const loginHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HIVEMIND - Sign In</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#16161e;border:1px solid #2a2a3a;border-radius:12px;padding:2rem;max-width:380px;width:90%}
  h1{font-size:1.3rem;margin:0 0 0.3rem;color:#a78bfa}
  p{color:#888;font-size:0.9rem;margin:0 0 1.2rem}
  label{display:block;font-size:0.85rem;color:#aaa;margin-bottom:0.3rem}
  input[type=password]{width:100%;padding:0.55rem;border:1px solid #333;border-radius:6px;background:#1e1e2e;color:#e0e0e0;font-size:0.95rem;box-sizing:border-box;margin-bottom:1rem}
  button{width:100%;padding:0.6rem;background:#a78bfa;color:#000;border:none;border-radius:8px;font-size:0.95rem;cursor:pointer;font-weight:500}
  button:hover{background:#8b5cf6}
</style></head><body>
<div class="card">
  <h1>Sign in to HIVEMIND</h1>
  <p>An application wants to connect to your memories.</p>
  <form method="POST" action="/oauth/login">
    <input type="hidden" name="client_id" value="${clientId.replace(/"/g, '&quot;')}">
    <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}">
    <input type="hidden" name="scope" value="${scope.replace(/"/g, '&quot;')}">
    <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge" value="${codeChallenge.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod.replace(/"/g, '&quot;')}">
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

  // OAuth login POST — validates admin secret, sets session cookie, redirects to consent
  if (pathname === '/oauth/login' && req.method === 'POST') {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    const params = new URLSearchParams(rawBody);
    const secret = params.get('admin_secret') || '';

    if (secret !== ADMIN_SECRET) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(401);
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>HIVEMIND</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#16161e;border:1px solid #2a2a3a;border-radius:12px;padding:2rem;max-width:380px;width:90%;text-align:center}
a{color:#a78bfa}</style></head><body>
<div class="card"><h2 style="color:#f87171">Invalid credentials</h2><p><a href="javascript:history.back()">Try again</a></p></div></body></html>`);
      return;
    }

    // Redirect back to /oauth/authorize with all params preserved
    const authorizeParams = new URLSearchParams();
    for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
      const val = params.get(key);
      if (val) authorizeParams.set(key, val);
    }

    res.setHeader('Set-Cookie', `hivemind_session=${ADMIN_SECRET}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
    res.writeHead(302, { Location: `/oauth/authorize?${authorizeParams.toString()}` });
    res.end();
    return;
  }

  // OAuth authorize POST — user approved or denied consent
  if (pathname === '/oauth/authorize' && req.method === 'POST') {
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
    const codeChallenge = params.get('code_challenge') || '';
    const codeChallengeMethod = params.get('code_challenge_method') || '';

    if (action === 'deny') {
      const denyUrl = new URL(redirectUri);
      denyUrl.searchParams.set('error', 'access_denied');
      if (state) denyUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: denyUrl.toString() });
      res.end();
      return;
    }

    // Generate authorization code
    const code = crypto.randomBytes(32).toString('hex');
    oauthCodeStore.set(code, {
      clientId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      userId: DEFAULT_USER,
      orgId: DEFAULT_ORG,
      expiresAt: Date.now() + OAUTH_CODE_TTL_MS
    });

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);
    res.writeHead(302, { Location: callbackUrl.toString() });
    res.end();
    return;
  }

  // OAuth token endpoint
  if (pathname === '/oauth/token' && req.method === 'POST') {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });

    // Support both application/x-www-form-urlencoded and application/json
    let tokenParams;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) {
      try { tokenParams = JSON.parse(rawBody); } catch { tokenParams = {}; }
    } else {
      const parsed = new URLSearchParams(rawBody);
      tokenParams = Object.fromEntries(parsed.entries());
    }

    const grantType = tokenParams.grant_type;
    const code = tokenParams.code || '';
    const redirectUri = tokenParams.redirect_uri || '';
    const clientId = tokenParams.client_id || '';
    const codeVerifier = tokenParams.code_verifier || '';

    if (grantType !== 'authorization_code') {
      return jsonResponse(res, { error: 'unsupported_grant_type' }, 400);
    }

    const entry = oauthCodeStore.get(code);
    if (!entry) {
      return jsonResponse(res, { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' }, 400);
    }

    // Consume code immediately (one-time use)
    oauthCodeStore.delete(code);

    if (Date.now() > entry.expiresAt) {
      return jsonResponse(res, { error: 'invalid_grant', error_description: 'Authorization code has expired.' }, 400);
    }

    if (entry.clientId !== clientId) {
      return jsonResponse(res, { error: 'invalid_grant', error_description: 'client_id mismatch.' }, 400);
    }

    if (entry.redirectUri !== redirectUri) {
      return jsonResponse(res, { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' }, 400);
    }

    // PKCE validation (S256)
    if (entry.codeChallenge) {
      if (!codeVerifier) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'code_verifier is required for PKCE.' }, 400);
      }
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      if (expectedChallenge !== entry.codeChallenge) {
        return jsonResponse(res, { error: 'invalid_grant', error_description: 'PKCE code_verifier validation failed.' }, 400);
      }
    }

    // Generate API key with requested scopes
    const requestedScopes = entry.scope
      ? entry.scope.split(/[\s+]/).filter(s => OAUTH_SCOPES_SUPPORTED.includes(s))
      : ['memory:read'];

    const { rawKey, record } = generateApiKeyRecord({
      label: `oauth-${clientId}`,
      userId: entry.userId,
      orgId: entry.orgId,
      scopes: requestedScopes
    });
    const store = loadApiKeyStore();
    store.keys.push(record);
    saveApiKeyStore(store);

    return jsonResponse(res, {
      access_token: rawKey,
      token_type: 'bearer',
      scope: requestedScopes.join(' ')
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
          return jsonResponse(res, { error: 'Unauthorized' }, 401);
        }

        const serverConfig = await getHostedServerByToken(token, pathUserId);
        if (!serverConfig) {
          return jsonResponse(res, { error: 'Unauthorized' }, 401);
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
            result = await handleToolCall(body.params || {}, pathUserId, connectionOrgId, apiClient);
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
          return jsonResponse(res, { error: 'Unauthorized' }, 401);
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

      // Protect all non-key-management API endpoints
      const auth = await authenticateApiKey(req);
      if (!auth.ok) {
        return jsonResponse(res, { error: auth.error }, auth.status || 401);
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

      if ((pathname === '/api/mcp/rpc' || pathname === '/api/mcp/message') && req.method === 'POST') {
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
            result = await handleToolCall(body.params || {}, userId, orgId, apiClient);
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

      // Handle /api/memories/:id routes (dynamic ID matching)
      if (pathname.startsWith('/api/memories/') && pathname !== '/api/memories/search' && pathname !== '/api/memories/query' && pathname !== '/api/memories/code/ingest' && pathname !== '/api/memories/traverse' && pathname !== '/api/memories/decay' && pathname !== '/api/memories/reinforce' && pathname !== '/api/memories/delete-all') {
        if (req.method === 'GET') {
          if (!ensurePersistedMemoryOrFail(res, '/api/memories/:id')) {
            return;
          }
          const memoryId = pathname.split('/api/memories/')[1];
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

          const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
          const { SyncEngine } = await import('./connectors/framework/sync-engine.js');
          const cStore = new ConnectorStore(prisma);
          const syncEngine = new SyncEngine({
            connectorStore: cStore,
            memoryEngine: persistentMemoryEngine,
            memoryStore: persistentMemoryStore,
            prisma,
            trailExecutor,
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

      // ── Usage tracking + plan enforcement ──
      if (usageTracker && planStore && orgId) {
        const orgPlan = await planStore.getOrgPlan(orgId);
        const limits = await usageTracker.checkLimits(orgId, orgPlan.id);

        // Enforce hard limits for free tier
        if (!limits.allowed) {
          return jsonResponse(res, {
            error: 'Usage limit exceeded',
            exceeded: limits.exceeded,
            usage: limits.usage,
            plan: orgPlan.id,
            upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing',
          }, 429);
        }

        // Set warning headers
        if (limits.warnings.length > 0) {
          res.setHeader('X-HiveMind-Usage-Warning', limits.warnings[0]);
        }

        // Track search queries
        if (pathname.includes('/search') || pathname.includes('/recall')) {
          usageTracker.recordQuery(orgId).catch(() => {});
        }

        // Track token usage (estimate from request body)
        if (body?.content) {
          const estimatedTokens = Math.ceil((body.content.length || 0) / 4);
          usageTracker.recordTokens(orgId, estimatedTokens).catch(() => {});
        }

        // Feature gating — only gate web search/crawl creation, not status/admin endpoints
        if (!orgPlan.features.webIntelligence && req.method === 'POST' && (pathname === '/api/web/search/jobs' || pathname === '/api/web/crawl/jobs')) {
          return jsonResponse(res, { error: 'Web Intelligence requires Pro plan or higher', upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing' }, 403);
        }
        if (pathname.includes('/swarm') && !orgPlan.features.agentSwarm) {
          return jsonResponse(res, { error: 'Agent Swarm requires Scale plan or higher', upgrade_url: 'https://hivemind.davinciai.eu/hivemind/app/billing' }, 403);
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
            const { buildAuthUrl } = await import('./connectors/providers/gmail/oauth.js');
            const gmailRedirectUri = `${process.env.HIVEMIND_BASE_URL || getHostedApiBaseUrl(req)}/api/connectors/gmail/callback`;
            const gmailState = Buffer.from(JSON.stringify({ userId, orgId })).toString('base64url');
            const authorizationUrl = buildAuthUrl({ redirectUri: gmailRedirectUri, state: gmailState });
            return jsonResponse(res, { url: authorizationUrl, redirect_uri: gmailRedirectUri });
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
              let stateUserId = userId, stateOrgId = orgId;
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

              // Store connection via ConnectorStore
              const { ConnectorStore } = await import('./connectors/framework/connector-store.js');
              const connStore = new ConnectorStore(prisma);

              const tokenExpiresAt = tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000)
                : null;

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

              // Do NOT auto-sync — redirect to frontend with needs_config flag
              // User will configure filters (labels, date range, exclusions) before sync starts
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
                email: connection.platformUserId,
                status: connection.syncStatus,
                last_synced: connection.lastSyncedAt,
                last_error: connection.lastErrorMessage,
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
                          const gmailResult = await persistentMemoryEngine.ingestMemory({
                            content,
                            title: subject,
                            tags,
                            memory_type: 'event',
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
                          });
                          // Embed thread memory in Qdrant for vector search
                          if (gmailResult?.memoryId && qdrantClient) {
                            try {
                              const gmailMem = await persistentMemoryStore.getMemory(gmailResult.memoryId);
                              if (gmailMem) await qdrantClient.storeMemory(gmailMem, { collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT' });
                            } catch {}
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
        // KNOWLEDGE BASE — Document Upload
        // ==========================================

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
              const customTags = parts.find(p => p.name === 'tags')?.value || '';
              const userTags = customTags ? customTags.split(',').map(t => t.trim()).filter(Boolean) : [];

              // Validate file size (max 10MB)
              if (filePart.data.length > 10 * 1024 * 1024) {
                return jsonResponse(res, { error: 'File too large. Maximum 10MB.' }, 413);
              }

              // Validate file type
              const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/csv'];
              const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
              const allowedExts = ['pdf', 'docx', 'txt', 'md', 'csv'];
              if (!allowedTypes.includes(filePart.contentType) && !allowedExts.includes(ext)) {
                return jsonResponse(res, { error: `Unsupported file type: ${filePart.contentType || ext}. Allowed: PDF, DOCX, TXT, MD, CSV` }, 415);
              }

              const { processDocument } = await import('./knowledge/document-chunker.js');
              const { summary, chunks } = await processDocument(
                filePart.data,
                filePart.contentType || `text/${ext}`,
                filePart.filename,
                { user_id: userId, org_id: orgId, project: containerTag, tags: userTags }
              );

              // Ingest summary + chunks in background, return immediately
              const uploadId = crypto.randomUUID();
              console.log(`[knowledge] Upload id=${uploadId} file=${filePart.filename} chunks=${chunks.length}`);

              // Start background ingestion
              (async () => {
                let ingested = 0;
                let failed = 0;
                const collectionName = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';

                const ingestAndEmbed = async (payload) => {
                  const result = await persistentMemoryEngine.ingestMemory(payload);
                  // Also embed in Qdrant for vector search
                  if (result?.memoryId && qdrantClient) {
                    try {
                      const memory = await persistentMemoryStore.getMemory(result.memoryId);
                      if (memory) {
                        await qdrantClient.storeMemory(memory, { collectionName });
                      }
                    } catch (embedErr) {
                      console.warn(`[knowledge] Qdrant embed failed for ${result.memoryId}:`, embedErr.message);
                    }
                  }
                };

                try {
                  await ingestAndEmbed(summary);
                  ingested++;

                  for (const chunk of chunks) {
                    try {
                      await ingestAndEmbed(chunk);
                      ingested++;
                    } catch (chunkErr) {
                      console.warn(`[knowledge] Chunk ${chunk.metadata?.chunk_index} failed:`, chunkErr.message);
                      failed++;
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

        case '/api/web/crawl/jobs':
          if (req.method === 'POST') {
            // Web crawl open to all authenticated users (entitlement gate removed — all keys get access)
            try {
              // Rate limit check
              const rlCheck = webRateLimiter.check(userId);
              if (!rlCheck.allowed) {
                return jsonResponse(res, { error: 'Rate limit exceeded', code: 'rate_limited', retry_after_ms: rlCheck.retryAfterMs }, 429);
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
              // Domain policy validation
              const domainErrors = [];
              for (const u of urls) {
                const domainCheck = validateDomain(u);
                if (!domainCheck.allowed) domainErrors.push({ url: u, reason: domainCheck.reason });
              }
              if (domainErrors.length === urls.length) {
                return jsonResponse(res, { error: 'All URLs blocked by policy', code: 'domain_blocked', details: domainErrors }, 403);
              }
              // Abuse detection
              const abuseCheck = detectAbuse({ userId, type: 'crawl', urls, recentJobCount: usage.web_crawl_pages });
              if (abuseCheck.action === 'block') {
                return jsonResponse(res, { error: 'Request blocked', code: 'abuse_detected', reason: abuseCheck.reason }, 403);
              }
              webRateLimiter.record(userId);
              // Filter allowed URLs
              const allowedUrls = domainErrors.length > 0 ? urls.filter(u => !domainErrors.find(e => e.url === u)) : urls;
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
                const ingestResult = await persistentMemoryEngine.ingestMemory({
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
                });
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
              const domainResult = validateDomain(checkUrl);
              const robotsResult = getRobotsWarning(checkUrl);
              return jsonResponse(res, { ...domainResult, ...robotsResult });
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

              const result = await persistentMemoryEngine.ingestMemory({
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
              });
              const memory = await persistentMemoryStore.getMemory(result.memoryId);
              if (memory) {
                await qdrantClient.storeMemory(memory, {
                  collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                });
                invalidateAggregateCache({ userId, orgId, project: memory.project || null });
                invalidateAggregateCache({ userId, orgId, project: null });
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
              const memoryWhere = {
                userId,
                ...(project ? { project } : {})
              };

              // Phase 1: Use store.deleteMemory() (same as frontend) for clean deletes
              let storeDeleted = 0;
              for (let round = 0; round < 100; round++) {
                const batch = await prisma.memory.findMany({
                  where: memoryWhere,
                  select: { id: true },
                  take: 200,
                });
                if (batch.length === 0) break;
                for (const m of batch) {
                  try {
                    await persistentMemoryStore.deleteMemory(m.id);
                    storeDeleted++;
                  } catch {}
                }
              }

              // Phase 2: Force-delete any stubborn records via raw SQL
              let sqlDeleted = 0;
              const stubborn = await prisma.memory.count({ where: memoryWhere });
              if (stubborn > 0) {
                const memoryIds = await prisma.memory.findMany({
                  where: memoryWhere,
                  select: { id: true }
                });
                const ids = memoryIds.map(record => record.id);
                if (ids.length > 0) {
                  await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: ids } } });
                  await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: ids } } });
                  await prisma.relationship.deleteMany({
                    where: {
                      OR: [
                        { fromId: { in: ids } },
                        { toId: { in: ids } }
                      ]
                    }
                  });
                  const result = await prisma.memory.deleteMany({ where: { id: { in: ids } } });
                  sqlDeleted = result.count || 0;
                }
              }

              const remaining = await prisma.memory.count({ where: memoryWhere });
              invalidateAggregateCache({ userId, orgId, project: project || null });
              invalidateAggregateCache({ userId, orgId, project: null });
              return jsonResponse(res, { success: true, project, storeDeleted, sqlDeleted, remaining });
            } catch (error) {
              return jsonResponse(res, { error: 'Delete all failed', message: error.message }, 500);
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
            for (const key of ['project', 'memory_type', 'tags', 'is_latest', 'limit', 'offset']) {
              const value = url.searchParams.get(key);
              if (value !== null) {
                queryParams[key] = value;
              }
            }
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

            const { memories, total } = await persistentMemoryStore.listMemories({
              user_id: userId,
              org_id: orgId,
              project,
              memory_type: filters.memory_type,
              tags: filters.tags,
              is_latest: filters.is_latest,
              offset,
              limit
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

              const result = await persistentMemoryEngine.ingestMemory({
                user_id: validation.data.user_id,
                org_id: validation.data.org_id,
                project: validation.data.project,
                content: validation.data.content,
                tags: validation.data.tags,
                memory_type: validation.data.memory_type,
                title: validation.data.title,
                document_date: validation.data.document_date,
                event_dates: validation.data.event_dates,
                relationship,
                skipPredictCalibrate: body.skipPredictCalibrate === true,
                skipProcessing: body.skipProcessing === true,
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
              });

              // Handle predict-calibrate skipped memories
              if (result.operation === 'skipped_redundant') {
                return jsonResponse(res, {
                  success: true,
                  skipped: true,
                  mutation: {
                    operation: result.operation,
                    reason: result.reason,
                    novelty_score: result.noveltyScore,
                    max_similarity: result.maxSimilarity,
                    processing_ms: result.processingMs
                  }
                }, 200);
              }

              const memory = await persistentMemoryStore.getMemory(result.memoryId);
              if (memory) {
                await qdrantClient.storeMemory(memory, {
                  collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
                });
                invalidateAggregateCache({ userId, orgId, project: memory.project || null });
                invalidateAggregateCache({ userId, orgId, project: null });
              }
              return jsonResponse(res, {
                success: true,
                memory,
                relationships: result.edgesCreated,
                mutation: {
                  operation: result.operation,
                  deprecated_ids: result.deprecatedIds,
                  processing_ms: result.processingMs,
                  novelty_score: result.noveltyScore ?? null,
                  delta_extracted: result.deltaExtracted ?? false
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
              return jsonResponse(res, {
                results,
                search_params: {
                  query: validation.data.query,
                  project: validation.data.project,
                  memory_type: validation.data.memory_type,
                  count: results.length
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
            const result = engine.traverse({
              start_id: body.start_id,
              depth: body.depth || 3,
              relationship_types: body.relationship_types || ['Updates', 'Extends', 'Derives']
            });
            jsonResponse(res, result);
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
              const diff = await biTemporalEngine.temporalDiff(userId, orgId, new Date(body.time_a), new Date(body.time_b));
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

              // containerTag → project mapping for recall
              const recallProject = body.project || effectiveContainerTag || null;

              const result = await recallPersistedMemories(persistentMemoryStore, {
                query_context: body.query_context || body.context,
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
                weights: recallWeights
              });

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
                // Re-sort after boosts
                result.memories.sort((a, b) => (b.score || 0) - (a.score || 0));
                result.intent = intent;
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

        case '/api/graph':
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/graph')) {
              return;
            }
            try {
              const graphProject = url.searchParams.get('project') || null;
              const graphLimit = Math.min(parseInt(url.searchParams.get('limit')) || 200, 500);
              const includeEdges = url.searchParams.get('include_edges') !== 'false';

              const scopeWhere = {
                userId: userId,
                orgId: orgId,
                deletedAt: null,
                ...(graphProject ? { project: graphProject } : {})
              };

              const memoryRecords = await prisma.memory.findMany({
                where: scopeWhere,
                include: {
                  sourceMetadata: true
                },
                orderBy: { updatedAt: 'desc' },
                take: graphLimit
              });

              const now = Date.now();
              const projectSet = new Set();
              const tagSet = new Set();

              const nodes = memoryRecords.map(r => {
                const updatedAt = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
                const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
                const daysSinceUpdate = (now - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
                const temporalWeight = Math.exp(-daysSinceUpdate / 30);

                if (r.project) projectSet.add(r.project);
                if (r.tags) r.tags.forEach(t => tagSet.add(t));

                return {
                  id: r.id,
                  title: r.title || '',
                  content: (r.content || '').slice(0, 200),
                  memoryType: r.memoryType || null,
                  tags: r.tags || [],
                  project: r.project || null,
                  sourcePlatform: r.sourceMetadata?.sourcePlatform || r.sourcePlatform || null,
                  importanceScore: r.importanceScore,
                  strength: r.strength,
                  recallCount: r.recallCount,
                  isLatest: r.isLatest,
                  createdAt: createdAt.toISOString(),
                  updatedAt: updatedAt.toISOString(),
                  daysSinceUpdate: Math.round(daysSinceUpdate * 100) / 100,
                  temporalWeight: Math.round(temporalWeight * 10000) / 10000
                };
              });

              let edges = [];
              if (includeEdges && memoryRecords.length > 0) {
                const memoryIds = memoryRecords.map(r => r.id);
                const relRecords = await prisma.relationship.findMany({
                  where: {
                    fromId: { in: memoryIds },
                    toId: { in: memoryIds }
                  },
                  orderBy: { createdAt: 'desc' }
                });

                edges = relRecords.map(r => ({
                  source: r.fromId,
                  target: r.toId,
                  type: r.type,
                  confidence: r.confidence
                }));
              }

              return jsonResponse(res, {
                nodes,
                edges,
                meta: {
                  nodeCount: nodes.length,
                  edgeCount: edges.length,
                  projects: Array.from(projectSet).sort(),
                  tags: Array.from(tagSet).sort()
                }
              });
            } catch (error) {
              console.error('Graph endpoint failed:', error);
              return jsonResponse(res, {
                error: 'Graph generation failed',
                message: error.message
              }, 500);
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

        case '/api/stats':
          const stats = engine.getStats(userId, orgId);
          jsonResponse(res, stats);
          break;

        // ==========================================
        // Three-Tier Retrieval API Endpoints
        // ==========================================

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

              jsonResponse(res, result);
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
            if (!usageTracker || !planStore) return jsonResponse(res, { error: 'Billing not available' }, 503);
            const billingPlan = await planStore.getOrgPlan(orgId);
            const billingUsage = await usageTracker.getUsage(orgId);
            const billingLimits = await usageTracker.checkLimits(orgId, billingPlan.id);
            return jsonResponse(res, { plan: billingPlan.id, planName: billingPlan.name, usage: billingUsage, limits: billingPlan.limits, warnings: billingLimits.warnings });
          }
          break;

        case '/api/billing/plans':
          if (req.method === 'GET') {
            const { getAllPlans } = await import('./billing/plans.js');
            return jsonResponse(res, { plans: getAllPlans() });
          }
          break;

        // ==========================================
        // CHAT — Talk to HIVE (memory-augmented LLM)
        // ==========================================
        case '/api/chat':
          if (req.method === 'POST') {
            const { message, model = 'llama-3.3-70b-versatile', history = [] } = body;
            if (!message || typeof message !== 'string') {
              return jsonResponse(res, { error: 'message is required' }, 400);
            }

            const groqKey = process.env.GROQ_API_KEY;
            if (!groqKey) {
              return jsonResponse(res, { error: 'Chat not available — no LLM API key configured' }, 503);
            }

            try {
              // Step 1: Recall memories for context
              let memories = [];
              let injectionText = '';
              let userProfileText = '';
              const isRecencyQuery = /\b(latest|newest|most recent|last message|last email|just now|right now|current)\b/i.test(message);

              if (persistentMemoryStore) {
                try {

                  const recallResult = await recallPersistedMemories(persistentMemoryStore, {
                    query_context: message,
                    user_id: userId,
                    org_id: orgId,
                    max_memories: isRecencyQuery ? 10 : 5,
                  });
                  let recalledMemories = recallResult.memories || [];

                  // For recency queries, re-sort by created_at descending
                  if (isRecencyQuery && recalledMemories.length > 0) {
                    recalledMemories.sort((a, b) => {
                      const dateA = new Date(a.created_at || a.document_date || 0);
                      const dateB = new Date(b.created_at || b.document_date || 0);
                      return dateB - dateA;
                    });
                    // Also fetch the absolutely newest memories directly from store
                    try {
                      const newest = await persistentMemoryStore.listLatestMemories({
                        user_id: userId, org_id: orgId,
                      });
                      // Get top 5 newest non-observation, non-longmemeval memories
                      const recentReal = newest
                        .filter(m => !(m.tags || []).includes('observation') && !(m.tags || []).includes('longmemeval'))
                        .slice(0, 5);
                      // Prepend to recall results (dedup by id)
                      const existingIds = new Set(recalledMemories.map(m => m.id));
                      for (const m of recentReal) {
                        if (!existingIds.has(m.id)) {
                          recalledMemories.unshift(m);
                        }
                      }
                    } catch {}
                  }

                  memories = recalledMemories.slice(0, 10).map(m => ({
                    id: m.id,
                    title: m.title || (m.content || '').slice(0, 60),
                    content: (m.content || '').slice(0, 300),
                    score: m.score || 0,
                    tags: m.tags || [],
                    created_at: m.created_at,
                  }));
                  injectionText = recallResult.injectionText || '';
                } catch (recallErr) {
                  console.warn('[chat] Recall failed:', recallErr.message);
                }
              }

              // Step 2: Build system prompt with user profile + memories
              const recencyHint = isRecencyQuery ? '\n\nIMPORTANT: The user is asking about their MOST RECENT activity. The memories below are sorted newest-first. Focus on the FIRST memory — that is the most recent one. Include its date/time.' : '';
              const systemPrompt = `You are HIVE, a personal AI assistant with persistent memory. You remember everything the user has shared across conversations, emails, documents, and notes.
${recencyHint}
${injectionText ? `Here is what you currently know about the user:\n\n${injectionText}` : ''}

BEHAVIOR:
- When the user ASKS a question: answer using their memories. Cite specific facts naturally.
- When the user TELLS you something new (a fact, preference, update, event): acknowledge it naturally in your response. Say something like "Got it" or "I'll keep that in mind" — the memory system stores it automatically in the background.
- When the user CORRECTS something: acknowledge the update. For example "Updated — I now know your new address is..."
- Be conversational, warm, and concise. Never robotic.
- If you don't have the information in memory, say so honestly.
- Never hallucinate facts not present in the provided context.`;

              // Step 3: Build message history for Groq
              const groqMessages = [
                { role: 'system', content: systemPrompt },
                ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: message },
              ];

              // Step 4: Call Groq
              const modelMap = {
                'llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
                'gpt-oss-120b': 'openai/gpt-oss-120b',
                'gpt-oss-20b': 'openai/gpt-oss-20b',
              };
              const groqModel = modelMap[model] || model;
              const groqParams = {
                model: groqModel,
                messages: groqMessages,
                max_tokens: 1000,
                temperature: 0.7,
              };
              if (groqModel.includes('gpt-oss')) {
                groqParams.include_reasoning = false;
                groqParams.max_tokens = 1500; // extra headroom for reasoning
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
              const response = (groqData.choices[0]?.message?.content || '')
                .replace(/[\uD800-\uDFFF]/g, '').trim();

              // Step 5: Save this conversation turn as a memory (observation)
              // Only save when the user is TELLING something new, not asking a question
              if (persistentMemoryEngine && response.length > 20) {
                const isQuestion = /^(what|when|where|who|how|why|do |does |did |is |are |can |could |tell me|show me)/i.test(message.trim());
                const hasMemoryKeywords = /\b(remember|save|don't forget|note that|update|my new|i just|i got|i moved|i changed|i bought|i sold)\b/i.test(message.trim());

                if (!isQuestion || hasMemoryKeywords) {
                  persistentMemoryEngine.ingestMemory({
                    content: `User: ${message}\nAssistant: ${response}`,
                    title: `Chat: ${message.slice(0, 50)}`,
                    tags: ['chat', 'talk-to-hive'],
                    memory_type: 'event',
                    user_id: userId,
                    org_id: orgId,
                  }).catch(() => {}); // fire and forget
                }
              }

              return jsonResponse(res, {
                response,
                sources: memories,
                model: groqModel,
                usage: {
                  prompt_tokens: groqData.usage?.prompt_tokens,
                  completion_tokens: groqData.usage?.completion_tokens,
                },
              });
            } catch (chatErr) {
              console.error('[chat] Failed:', chatErr.message);
              return jsonResponse(res, { error: chatErr.message }, 500);
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

function jsonResponse(res, data, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
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
});
