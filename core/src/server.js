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
const { queryPersistedMemories, recallPersistedMemories } = await import('./memory/persisted-retrieval.js');
const { authenticatePersistedApiKey, hasEntitlement } = await import('./auth/api-keys.js');
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

// Evaluation imports
const { RetrievalEvaluator } = await import('./external/evaluation/retrieval-evaluator.js');
const { TEST_QUERIES, getSampleQueries, getQueriesByCategory, getQueriesByDifficulty, getQueriesForDataset } = await import('./external/evaluation/test-dataset.js');
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
const persistentMemoryStore = prisma ? new PrismaGraphStore(prisma) : null;
const persistentMemoryEngine = persistentMemoryStore ? new MemoryGraphEngine({ store: persistentMemoryStore }) : null;
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
  if (cached) {
    return cached;
  }

  const latestMemories = await persistentMemoryStore.listLatestMemories({
    user_id: userId,
    org_id: orgId,
    project
  });
  const relationships = await persistentMemoryStore.listRelationships({
    user_id: userId,
    org_id: orgId,
    project
  });

  const relationshipTypes = relationships.reduce((accumulator, relationship) => {
    accumulator[relationship.type] = (accumulator[relationship.type] || 0) + 1;
    return accumulator;
  }, {});

  const summary = {
    user_id: userId,
    org_id: orgId,
    project,
    memory_count: latestMemories.length,
    relationship_count: relationships.length,
    top_tags: countTopValues(latestMemories.flatMap(memory => memory.tags || [])),
    top_source_platforms: countTopValues(
      latestMemories.map(memory => memory.source_metadata?.source_platform || memory.source || null)
    ),
    recent_titles: latestMemories
      .map(memory => memory.title)
      .filter(Boolean)
      .slice(0, 3),
    graph_summary: {
      included_count: latestMemories.length,
      relationship_types: relationshipTypes
    }
  };
  setAggregateCache(cacheKey, summary);
  return summary;
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

function generateApiKeyRecord({ label, userId, orgId, scopes = ['memory:read', 'memory:write'] }) {
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
  if (MASTER_API_KEY && apiKey === MASTER_API_KEY) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'], master: true, rawKey: apiKey } };
  }

  const persistedRecord = await authenticatePersistedApiKey(prisma, apiKey);
  if (persistedRecord) {
    return {
      ok: true,
      principal: {
        keyId: persistedRecord.id,
        userId: persistedRecord.userId || DEFAULT_USER,
        orgId: persistedRecord.orgId || DEFAULT_ORG,
        scopes: persistedRecord.scopes || [],
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

  // API Routes
  if (pathname.startsWith('/api/')) {
    try {
      const body = req.method !== 'GET' ? await parseBody(req) : {};

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
          scopes: body.scopes
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
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
          revoked_at: k.revokedAt
        }));
        return jsonResponse(res, { keys });
      }

      // Protect all non-key-management API endpoints
      const auth = await authenticateApiKey(req);
      if (!auth.ok) {
        return jsonResponse(res, { error: auth.error }, auth.status || 401);
      }
      const principal = auth.principal;
      const userId = principal.userId || DEFAULT_USER;
      const orgId = principal.orgId || DEFAULT_ORG;

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
      if (pathname.startsWith('/api/memories/') && pathname !== '/api/memories/search' && pathname !== '/api/memories/query' && pathname !== '/api/memories/code/ingest' && pathname !== '/api/memories/traverse' && pathname !== '/api/memories/decay' && pathname !== '/api/memories/reinforce') {
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
            if (!hasEntitlement(principal, 'web_search')) {
              return jsonResponse(res, { error: 'Feature not enabled', code: 'feature_not_enabled', required_entitlement: 'web_search' }, 403);
            }
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
            if (!hasEntitlement(principal, 'web_crawl')) {
              return jsonResponse(res, { error: 'Feature not enabled', code: 'feature_not_enabled', required_entitlement: 'web_crawl' }, 403);
            }
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
              const savedIds = [];
              for (const item of items) {
                const content = item.snippet || item.text || item.content || JSON.stringify(item);
                const memTitle = title || item.title || item.url || `Web ${job.type} result`;
                const memTags = [...(tags || []), `web:${job.type}`, 'source:web-intelligence'];
                if (item.url) memTags.push(`url:${item.url}`);
                const filtered = filterContent(content);
                const mem = await persistentMemoryStore.addMemory({
                  content: filtered.text,
                  title: memTitle,
                  source_platform: 'web_intelligence',
                  tags: memTags,
                  metadata: { web_job_id: jobId, url: item.url, runtime_used: job.runtime_used, crawled_at: job.created_at },
                }, userId, orgId);
                if (mem?.id) savedIds.push(mem.id);
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
            if (!hasEntitlement(principal, 'web_search') && !hasEntitlement(principal, 'web_crawl')) {
              return jsonResponse(
                res,
                {
                  error: 'Feature not enabled',
                  code: 'feature_not_enabled',
                  required_entitlements: ['web_search', 'web_crawl'],
                },
                403
              );
            }
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
          if (req.method === 'GET') {
            if (!ensurePersistedMemoryOrFail(res, '/api/profile')) {
              return;
            }
            try {
              const project = url.searchParams.get('project') || null;
              const profile = await buildProfileSummary({ userId, orgId, project });
              return jsonResponse(res, {
                ok: true,
                profile: {
                  user_id: profile.user_id,
                  org_id: profile.org_id,
                  project: profile.project,
                  memory_count: profile.memory_count,
                  relationship_count: profile.relationship_count,
                  top_tags: profile.top_tags,
                  top_source_platforms: profile.top_source_platforms,
                  recent_titles: profile.recent_titles
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

        case '/api/recall':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/recall')) {
              return;
            }
            try {
              const result = await recallPersistedMemories(persistentMemoryStore, {
                query_context: body.query_context || body.context,
                user_id: userId,
                org_id: orgId,
                project: body.project || null,
                source_platforms: body.source_platforms || [],
                tags: body.tags || [],
                preferred_project: body.preferred_project || body.project || null,
                preferred_source_platforms: body.preferred_source_platforms || [],
                preferred_tags: body.preferred_tags || [],
                max_memories: body.max_memories || 5,
                weights: body.weights
              });
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
              const { query, memory_type, tags, source_platform, limit, score_threshold } = body;

              if (!query || typeof query !== 'string') {
                return jsonResponse(res, {
                  error: 'Validation failed',
                  message: 'query is required and must be a string'
                }, 400);
              }

              const result = await threeTierRetrieval.quickSearch(query, {
                userId,
                orgId,
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

              const result = await threeTierRetrieval.panoramaSearch(query, {
                userId,
                orgId,
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

              const result = await threeTierRetrieval.insightForge(query, {
                userId,
                orgId,
                simulationRequirement: simulation_requirement,
                subQueryLimit: sub_query_limit || 5,
                resultsPerSubQuery: results_per_sub_query || 15,
                includeAnalysis: include_analysis !== false
              });

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
                const selectedDataset = dataset || (userId && userId !== DEFAULT_USER ? 'tenant' : 'default');

                if (selectedDataset) {
                  try {
                    testQueries = getQueriesForDataset(selectedDataset);
                  } catch (error) {
                    if (dataset) {
                      throw error;
                    }
                    testQueries = null;
                  }
                }

                if (testQueries) {
                  if (sample_size) {
                    testQueries = testQueries.slice(0, sample_size);
                  }
                } else if (sample_size) {
                  testQueries = getSampleQueries(sample_size);
                } else if (batchCategory) {
                  testQueries = getQueriesByCategory(batchCategory);
                } else if (difficulty) {
                  testQueries = getQueriesByDifficulty(difficulty);
                } else {
                  testQueries = TEST_QUERIES;
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
