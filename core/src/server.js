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
const { getQdrantClient } = await import('./vector/qdrant-client.js');
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
  validateMemoryQueryParams
} = await import('./api/validators/memory.validators.js');

// Three-Tier Retrieval imports
const { ThreeTierRetrieval } = await import('./external/search/three-tier-retrieval.js');

// Evaluation imports
const { RetrievalEvaluator } = await import('./external/evaluation/retrieval-evaluator.js');
const { TEST_QUERIES, getSampleQueries } = await import('./external/evaluation/test-dataset.js');
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

// Initialize memory engine with SQLite
const engine = new MemoryEngine('./hivemind.db');
const prisma = getPrismaClient();
const persistentMemoryStore = prisma ? new PrismaGraphStore(prisma) : null;
const persistentMemoryEngine = persistentMemoryStore ? new MemoryGraphEngine({ store: persistentMemoryStore }) : null;
const qdrantClient = getQdrantClient();

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
const API_KEY_REQUIRED = process.env.HIVEMIND_API_KEY_REQUIRED !== 'false';
const MASTER_API_KEY = process.env.HIVEMIND_MASTER_API_KEY || '';
// Test API key for development/testing (accepted when NODE_ENV is not 'production')
// Must be set via HIVEMIND_TEST_API_KEY environment variable in non-production environments
const TEST_API_KEY = process.env.HIVEMIND_TEST_API_KEY || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REQUIRE_PERSISTED_MEMORY = IS_PRODUCTION || process.env.HIVEMIND_REQUIRE_PERSISTED_MEMORY === 'true';
const groqClient = getGroqClient();
const INGESTION_MODULE_CANDIDATES = [
  path.join(REPO_ROOT, 'src', 'ingestion'),
  path.join(PROJECT_ROOT, 'ingestion')
];

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

function authenticateApiKey(req) {
  if (!API_KEY_REQUIRED) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'] } };
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return { ok: false, status: 401, error: 'Missing API key. Use Authorization: Bearer <key> or X-API-Key header.' };
  }

  // Accept test API key in non-production environments
  if (!IS_PRODUCTION && apiKey === TEST_API_KEY) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'], testKey: true } };
  }

  // Accept master API key in any environment
  if (MASTER_API_KEY && apiKey === MASTER_API_KEY) {
    return { ok: true, principal: { userId: DEFAULT_USER, orgId: DEFAULT_ORG, scopes: ['*'], master: true } };
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
      scopes: record.scopes || []
    }
  };
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

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
      const auth = authenticateApiKey(req);
      if (!auth.ok) {
        return jsonResponse(res, { error: auth.error }, auth.status || 401);
      }
      const principal = auth.principal;
      const userId = principal.userId || DEFAULT_USER;
      const orgId = principal.orgId || DEFAULT_ORG;

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

        case '/api/integrations/webapp/prepare':
          if (req.method === 'POST') {
            if (!ensurePersistedMemoryOrFail(res, '/api/integrations/webapp/prepare')) {
              return;
            }
            try {
              const platform = normalizeWebappPlatform(body.platform);
              const preferredSources = [...new Set([
                ...(body.preferred_source_platforms || []),
                ...(platform ? [platform] : [])
              ])];
              const preferredTags = body.preferred_tags || [];
              const maxMemories = body.max_memories || 5;
              const recall = await recallPersistedMemories(persistentMemoryStore, {
                query_context: body.query || body.user_prompt || body.prompt || '',
                user_id: userId,
                org_id: orgId,
                project: body.project || null,
                source_platforms: body.source_platforms || [],
                tags: body.tags || [],
                preferred_project: body.preferred_project || body.project || null,
                preferred_source_platforms: preferredSources,
                preferred_tags: preferredTags,
                max_memories: maxMemories
              });

              const context = buildWebappContextResponse(recall, {
                query: body.query || body.user_prompt || body.prompt || '',
                platform,
                project: body.project || null,
                preferredSources,
                preferredTags,
                maxMemories
              });

              return jsonResponse(res, {
                ...context,
                prompt_envelope: buildPromptEnvelope(body, context.context)
              });
            } catch (error) {
              return jsonResponse(res, {
                error: 'Webapp context preparation failed',
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
                  collectionName: `hivemind_${userId}`
                });
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

            if (persistentMemoryStore) {
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

            const memories = engine.getAllMemories(userId, orgId);
            const filteredMemories = memories.filter(m => {
              if (project && m.project !== project) return false;
              if (filters.memory_type && m.memory_type !== filters.memory_type) return false;
              if (filters.tags && filters.tags.length > 0) {
                if (!m.tags || !filters.tags.some(t => m.tags.includes(t))) return false;
              }
              if (filters.is_latest !== undefined && m.is_latest !== filters.is_latest) return false;
              return true;
            });
            const paginatedMemories = filteredMemories.slice(offset, offset + limit);
            
            return jsonResponse(res, { 
              memories: paginatedMemories,
              pagination: {
                total: filteredMemories.length,
                offset,
                limit,
                has_more: offset + limit < filteredMemories.length
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
                  message: '/api/memories/code/ingest requires Prisma-backed memory.'
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

              const engineInput = {
                ...validation.data,
                source,
                relationship,
                metadata: {
                  ...validation.data.metadata,
                  source_platform: validation.data.source_platform || null,
                  source_session_id: validation.data.source_session_id || null,
                  source_message_id: validation.data.source_message_id || null,
                  source_url: validation.data.source_url || null
                }
              };

              if (persistentMemoryEngine && persistentMemoryStore) {
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
                  metadata: engineInput.metadata,
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
                    collectionName: `hivemind_${userId}`
                  });
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
              }

              const memory = await engine.storeMemory(engineInput);
              return jsonResponse(res, { 
                success: true, 
                memory: memory.memory || null,
                memories: memory.memories || null,
                relationships: memory.relationships || [],
                mutation: memory.mutation || null
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
              if (persistentMemoryStore) {
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
              }

              const results = await engine.searchMemories(validation.data);
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
              if (REQUIRE_PERSISTED_MEMORY) {
                return jsonResponse(res, {
                  error: 'Search failed',
                  message: error.message
                }, 500);
              }
              // Return empty results on error
              return jsonResponse(res, {
                results: [],
                warning: 'Search failed: ' + error.message
              });
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
              if (persistentMemoryStore) {
                const result = await queryPersistedMemories(persistentMemoryStore, {
                  ...body,
                  user_id: userId,
                  org_id: orgId
                });

                return jsonResponse(res, {
                  pattern: body.pattern,
                  result
                });
              }

              const result = engine.queryMemories({
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
              if (persistentMemoryStore) {
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
                break;
              }

              const result = await engine.autoRecall({
                query_context: body.query_context || body.context,
                user_id: userId,
                max_memories: body.max_memories || 5,
                weights: body.weights
              });
              jsonResponse(res, result);
            } catch (error) {
              console.error('Auto recall failed:', error);
              if (REQUIRE_PERSISTED_MEMORY) {
                return jsonResponse(res, {
                  error: 'Recall failed',
                  message: error.message
                }, 500);
              }
              // Return empty result on error
              jsonResponse(res, { 
                memories: [], 
                context: null,
                warning: 'Recall failed: ' + error.message 
              });
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
                scoreThreshold: score_threshold || 0.3
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
                category: batchCategory,
                difficulty
              } = body;

              let testQueries = queries;

              // Use built-in test dataset if no queries provided
              if (!testQueries) {
                if (sample_size) {
                  testQueries = getSampleQueries(sample_size);
                } else if (batchCategory) {
                  const { getQueriesByCategory } = await import('../../src/evaluation/test-dataset.js');
                  testQueries = getQueriesByCategory(batchCategory);
                } else if (difficulty) {
                  const { getQueriesByDifficulty } = await import('../../src/evaluation/test-dataset.js');
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
              const latestReport = retrievalEvaluator.getLatestReport();

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
              const history = retrievalEvaluator.getEvaluationHistory();
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
              const history = retrievalEvaluator.getEvaluationHistory();

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
              const { getDatasetStats } = await import('../../src/evaluation/test-dataset.js');
              const stats = getDatasetStats();

              return jsonResponse(res, {
                success: true,
                dataset: {
                  stats,
                  queries: TEST_QUERIES.map(q => ({
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
});
