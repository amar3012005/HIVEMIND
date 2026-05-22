/**
 * ChatGPT Connector Adapter
 *
 * Thin REST wrapper over HIVEMIND's MCP tool registry. ChatGPT custom-GPT /
 * plugin / connector calls these endpoints — they resolve the user from the
 * OAuth Bearer token (already issued by core's existing /oauth/token flow)
 * and dispatch to the same internal tool handlers the agent uses.
 *
 * Five operationIds exposed to ChatGPT:
 *   searchMemory          → hivemind_recall
 *   saveMemory            → hivemind_save_memory
 *   listMemories          → hivemind_list_memories
 *   queryMemoryWithAI     → hivemind_query_with_ai
 *   webSearch             → hivemind_web_search + poll
 *
 * Deliberately narrow. Coding / temporal / graph traversal NOT exposed —
 * add later once the consumer flow is stable.
 *
 * Tenancy: ALL user_id / org_id / scope come from the validated Bearer
 * token's principal. The body NEVER carries them. Never trust client
 * tenancy claims.
 */

import { dispatchTool } from '../agent/tool-registry.js';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 30_000;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendErr(res, statusCode, msg, extras = {}) {
  return sendJson(res, statusCode, { error: msg, ...extras });
}

/**
 * Build the tool-dispatch context from the authenticated principal +
 * shared engine handles passed in from server.js mount point.
 */
function buildCtx(principal, deps) {
  return {
    userId: principal.userId,
    orgId:  principal.orgId,
    scopes: principal.scopes || [],
    accessContext: deps.accessContext || null,
    persistentMemoryStore: deps.persistentMemoryStore,
    persistentMemoryEngine: deps.persistentMemoryEngine,
    smartIngestRouter: deps.smartIngestRouter,
    buildRoutedIngestPayloads: deps.buildRoutedIngestPayloads,
    ingestRoutedPayload: deps.ingestRoutedPayload,
    webIntelligence: deps.webIntelligence,
    prisma: deps.prisma,
  };
}

/**
 * Scope check — ChatGPT's OAuth flow currently mints tokens with no scope
 * filtering (existing apiKey rows have full scopes). When the OAuth client
 * is registered with narrow scopes in OpenAI's dashboard, the resulting
 * access_token will carry them in metadata. Treat absent/'*' as full
 * access (matches MCP behavior).
 */
function hasScope(principal, required) {
  const s = principal.scopes || [];
  if (s.includes('*') || s.includes('admin')) return true;
  return s.includes(required);
}

// ── Endpoint: POST /v1/chatgpt/memory/search ────────────────────────────
export async function searchMemory({ body, principal, deps, res }) {
  if (!hasScope(principal, 'memory:read')) {
    return sendErr(res, 403, 'Insufficient scope: memory:read required');
  }
  const query = (body?.query || '').trim();
  if (!query) return sendErr(res, 400, 'query is required');

  const ctx = buildCtx(principal, deps);
  const result = await dispatchTool(
    'hivemind_recall',
    {
      query,
      mode: ['quick', 'panorama', 'insight'].includes(body?.mode) ? body.mode : 'quick',
      limit: Math.min(Math.max(parseInt(body?.limit, 10) || 10, 1), 50),
      tags: Array.isArray(body?.tags) ? body.tags : undefined,
      include_live: false, // ChatGPT-facing — don't fan out to Google Workspace by default
    },
    ctx,
  );
  if (result?.error) return sendErr(res, 500, result.error);

  return sendJson(res, 200, {
    count: result?.count || 0,
    memories: (result?.memories || []).map((m) => ({
      id: m.id,
      title: m.title,
      content: (m.content || '').slice(0, 1200),
      memory_type: m.memory_type,
      tags: m.tags,
      score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
      created_at: m.created_at,
    })),
  });
}

// ── Endpoint: POST /v1/chatgpt/memory/save ─────────────────────────────
export async function saveMemory({ body, principal, deps, res }) {
  if (!hasScope(principal, 'memory:write')) {
    return sendErr(res, 403, 'Insufficient scope: memory:write required');
  }
  const title = (body?.title || '').trim();
  const content = (body?.content || '').trim();
  if (!title) return sendErr(res, 400, 'title is required');
  if (!content) return sendErr(res, 400, 'content is required');

  const tags = Array.isArray(body?.tags) ? body.tags.filter((t) => typeof t === 'string') : [];
  if (tags.length < 2) return sendErr(res, 400, 'tags must contain at least 2 entries');

  const ALLOWED_TYPES = ['fact', 'preference', 'decision', 'goal', 'event', 'lesson', 'relationship'];
  const memory_type = ALLOWED_TYPES.includes(body?.memory_type) ? body.memory_type : 'fact';

  const ctx = buildCtx(principal, deps);
  const result = await dispatchTool(
    'hivemind_save_memory',
    { title, content, tags, memory_type },
    ctx,
  );
  if (result?.error) return sendErr(res, 500, result.error);

  return sendJson(res, 200, {
    saved: true,
    id: result?.id || null,
    title: result?.title || title,
  });
}

// ── Endpoint: GET /v1/chatgpt/memory/list ──────────────────────────────
export async function listMemories({ query, principal, deps, res }) {
  if (!hasScope(principal, 'memory:read')) {
    return sendErr(res, 403, 'Insufficient scope: memory:read required');
  }
  const ctx = buildCtx(principal, deps);
  const result = await dispatchTool(
    'hivemind_list_memories',
    {
      limit: Math.min(Math.max(parseInt(query?.limit, 10) || 20, 1), 100),
      memory_type: query?.memory_type || undefined,
      tag: query?.tag || undefined,
    },
    ctx,
  );
  if (result?.error) return sendErr(res, 500, result.error);

  return sendJson(res, 200, {
    count: result?.count || (result?.memories?.length || 0),
    memories: (result?.memories || []).map((m) => ({
      id: m.id,
      title: m.title,
      content: (m.content || '').slice(0, 800),
      memory_type: m.memory_type,
      tags: m.tags,
      created_at: m.created_at,
    })),
  });
}

// ── Endpoint: POST /v1/chatgpt/memory/query ────────────────────────────
export async function queryMemoryWithAI({ body, principal, deps, res }) {
  if (!hasScope(principal, 'memory:read')) {
    return sendErr(res, 403, 'Insufficient scope: memory:read required');
  }
  const question = (body?.question || '').trim();
  if (!question) return sendErr(res, 400, 'question is required');

  const ctx = buildCtx(principal, deps);
  const result = await dispatchTool('hivemind_query_with_ai', { query: question }, ctx);
  if (result?.error) return sendErr(res, 500, result.error);

  const citations = Array.isArray(result?.memories)
    ? result.memories.slice(0, 8).map((m) => ({
        memory_id: m.id,
        title: m.title || '',
        score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
      }))
    : [];

  return sendJson(res, 200, {
    answer: result?.answer || result?.response || '',
    citations,
  });
}

// ── Endpoint: POST /v1/chatgpt/web/search ──────────────────────────────
// Submit + poll. ChatGPT can't async — we hide the job_id behind a sync
// response. Bounded by POLL_TIMEOUT_MS.
export async function webSearch({ body, principal, deps, res }) {
  if (!hasScope(principal, 'web:search')) {
    return sendErr(res, 403, 'Insufficient scope: web:search required');
  }
  const query = (body?.query || '').trim();
  if (!query) return sendErr(res, 400, 'query is required');

  const ctx = buildCtx(principal, deps);
  const submit = await dispatchTool(
    'hivemind_web_search',
    {
      query,
      limit: Math.min(Math.max(parseInt(body?.limit, 10) || 5, 1), 20),
    },
    ctx,
  );
  if (submit?.error) return sendErr(res, 502, submit.error);

  const jobId = submit?.job_id || submit?.id;
  if (!jobId) {
    // Some web backends return results synchronously — pass through.
    if (Array.isArray(submit?.results)) {
      return sendJson(res, 200, { query, results: submit.results.slice(0, 20) });
    }
    return sendErr(res, 502, 'web search did not return a job id or results');
  }

  // Poll
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await dispatchTool('hivemind_web_job_status', { job_id: jobId }, ctx);
    if (status?.error) return sendErr(res, 502, status.error);
    if (status?.status === 'done' || status?.results) {
      return sendJson(res, 200, {
        query,
        results: (status.results || []).slice(0, 20).map((r) => ({
          title: r.title || '',
          url: r.url || '',
          snippet: r.snippet || r.summary || '',
          published: r.published || r.date || null,
        })),
      });
    }
    if (status?.status === 'failed') {
      return sendErr(res, 502, status.error || 'web search job failed');
    }
  }
  return sendErr(res, 504, 'web search timed out', { job_id: jobId });
}

/**
 * Route table — { 'METHOD /v1/chatgpt/path': handlerFn }
 * Handler signature: ({ body, query, principal, deps, res })
 */
export const CHATGPT_ROUTES = {
  'POST /v1/chatgpt/memory/search':  searchMemory,
  'POST /v1/chatgpt/memory/save':    saveMemory,
  'GET  /v1/chatgpt/memory/list':    listMemories,
  'POST /v1/chatgpt/memory/query':   queryMemoryWithAI,
  'POST /v1/chatgpt/web/search':     webSearch,
};

/**
 * Single entry point. Returns true if it handled the request (so caller
 * can `return;`), false otherwise. Auth resolution is done OUTSIDE so we
 * reuse server.js's existing authenticate() pipeline — including OAuth
 * Bearer tokens minted via /oauth/token.
 */
export async function handleChatgptRequest({ req, res, pathname, query, principal, deps }) {
  const key = `${req.method.toUpperCase().padEnd(4)}${pathname}`.trim();
  // Normalise so 'POST /v1/...' and 'GET  /v1/...' both match table keys.
  const tableKey = `${req.method} ${pathname}`.replace(/\s+/g, ' ').replace(/GET /, 'GET  ').replace(/ {2,}/g, '  ');
  // Simpler: explicit lookup
  const lookup = `${req.method} ${pathname}`;
  const exact = Object.keys(CHATGPT_ROUTES).find((k) => k.replace(/\s+/g, ' ') === lookup);
  if (!exact) return false;

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw) return resolve({});
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('invalid JSON body')); }
        });
        req.on('error', reject);
      });
    } catch (err) {
      sendErr(res, 400, err.message);
      return true;
    }
  }

  try {
    await CHATGPT_ROUTES[exact]({ body, query, principal, deps, res });
  } catch (err) {
    console.warn('[chatgpt-adapter]', exact, 'failed:', err.message);
    sendErr(res, 500, err.message || 'internal error');
  }
  return true;
}
