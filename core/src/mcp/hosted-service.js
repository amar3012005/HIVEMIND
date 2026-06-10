/**
 * Hosted MCP Service
 * "Context-as-a-Service" - Cloud-hosted MCP server for cross-platform AI memory
 *
 * Transforms HIVE-MIND from local-only MCP to hosted service where users simply
 * paste a URL into Claude Desktop, Cursor, or ChatGPT instead of running Node.js locally.
 *
 * Endpoint: GET /api/mcp/servers/:userId
 * Returns: MCP-compatible configuration for that specific user
 *
 * Features:
 * - User-specific MCP server configuration
 * - API key authentication
 * - Proxy MCP requests to HIVE-MIND API
 * - Support for stdio-to-HTTP bridge
 *
 * @module mcp/hosted-service
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Redis from 'ioredis';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  publicBaseUrl: process.env.HIVEMIND_PUBLIC_BASE_URL
    || process.env.HIVEMIND_EXTERNAL_URL
    || 'https://core.hivemind.davinciai.eu:8050',
  internalBaseUrl: process.env.HIVEMIND_INTERNAL_BASE_URL
    || process.env.HIVEMIND_BASE_URL
    || null,
  apiVersion: '2024-11-05',
  protocolVersion: '2024-11-05',
  serverName: 'hivemind-hosted-mcp',
  serverVersion: '2.0.0',
  bridgePackageName: process.env.HIVEMIND_MCP_BRIDGE_PACKAGE || '@amar_528/mcp-bridge',
  tokenSecret: process.env.HIVEMIND_MCP_TOKEN_SECRET || process.env.MCP_SECRET_KEY || 'change-me-in-production',
  connectionTtlMs: Number(process.env.HIVEMIND_MCP_CONNECTION_TTL_MS || 24 * 60 * 60 * 1000),
  redisUrl: process.env.HIVEMIND_MCP_REDIS_URL || process.env.REDIS_URL || null,
  redisHost: process.env.REDIS_HOST || null,
  redisPort: Number(process.env.REDIS_PORT || 6379),
  redisPassword: process.env.REDIS_PASSWORD || null,
  redisPrefix: process.env.HIVEMIND_MCP_REDIS_PREFIX || 'hivemind:mcp',
  maxToolsPerRequest: 64,
  maxConnectionsPerUser: 10
};

// In-memory connection tracking remains the safe fallback.
const userConnections = new Map();
const revokedAfterByUser = new Map();
let redisClientPromise = null;
let redisWarningLogged = false;

function redisKey(kind, userId, token = null) {
  return token
    ? `${CONFIG.redisPrefix}:${kind}:${userId}:${token}`
    : `${CONFIG.redisPrefix}:${kind}:${userId}`;
}

async function getRedisClient() {
  const hasRedisConfig = CONFIG.redisUrl || CONFIG.redisHost;
  if (!hasRedisConfig) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = CONFIG.redisUrl
        ? new Redis(CONFIG.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false
          })
        : new Redis({
            host: CONFIG.redisHost,
            port: CONFIG.redisPort,
            password: CONFIG.redisPassword || undefined,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false
          });

      client.on('error', () => {});

      if (client.status === 'wait') {
        await client.connect();
      }

      await client.ping();
      return client;
    })().catch(error => {
      if (!redisWarningLogged) {
        console.warn('[hosted-mcp] Redis unavailable, falling back to in-memory state:', error.message);
        redisWarningLogged = true;
      }
      redisClientPromise = null;
      return null;
    });
  }

  return redisClientPromise;
}

async function persistConnectionState(connection) {
  const client = await getRedisClient();
  if (!client) return;

  const ttlSeconds = Math.max(Math.ceil((new Date(connection.expiresAt).getTime() - Date.now()) / 1000), 1);
  await client.set(
    redisKey('connection', connection.userId, connection.token),
    JSON.stringify(connection),
    'EX',
    ttlSeconds
  );
}

async function loadPersistedConnection(userId, token) {
  const client = await getRedisClient();
  if (!client) return null;

  const raw = await client.get(redisKey('connection', userId, token));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function markConnectionRevoked(userId, token, expiresAt) {
  const client = await getRedisClient();
  if (!client) return;

  const ttlSeconds = Math.max(Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000), 1);
  await client.set(redisKey('revoked', userId, token), '1', 'EX', ttlSeconds);
}

async function isExplicitlyRevoked(userId, token) {
  const client = await getRedisClient();
  if (!client) return false;

  const revoked = await client.get(redisKey('revoked', userId, token));
  return revoked === '1';
}

async function getRevokedAfter(userId) {
  const client = await getRedisClient();
  const inMemory = revokedAfterByUser.get(userId) || 0;
  if (!client) {
    return inMemory;
  }

  const raw = await client.get(redisKey('revoked-after', userId));
  return Math.max(inMemory, raw ? Number(raw) : 0);
}

async function setRevokedAfter(userId, timestampMs) {
  revokedAfterByUser.set(userId, timestampMs);
  const client = await getRedisClient();
  if (!client) return;

  await client.set(
    redisKey('revoked-after', userId),
    String(timestampMs),
    'PX',
    CONFIG.connectionTtlMs
  );
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function base64UrlDecode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function getDescriptorUrl(userId) {
  return `${CONFIG.publicBaseUrl}/api/mcp/servers/${userId}`;
}

function getSimpleDescriptorUrl(userId, token) {
  return `${getDescriptorUrl(userId)}?token=${token}`;
}

function getRpcUrl(userId, token) {
  return `${CONFIG.publicBaseUrl}/api/mcp/servers/${userId}/rpc?token=${token}`;
}

function getSseUrl(userId, token) {
  return `${CONFIG.publicBaseUrl}/api/mcp/servers/${userId}/sse?token=${token}`;
}

function getMessageUrl(userId, token) {
  return `${CONFIG.publicBaseUrl}/api/mcp/servers/${userId}/message?token=${token}`;
}

function signTokenPayload(encodedPayload) {
  return crypto
    .createHmac('sha256', CONFIG.tokenSecret)
    .update(encodedPayload)
    .digest('base64url');
}

function buildConnectionPayload(userId, orgId, serverId) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + CONFIG.connectionTtlMs;

  return {
    sub: userId,
    org: orgId || null,
    sid: serverId,
    iat: issuedAt,
    exp: expiresAt
  };
}

function parseSignedConnectionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = signTokenPayload(encodedPayload);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  const payload = base64UrlDecode(encodedPayload);
  if (!payload?.sub || !payload?.exp || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

function createSignedConnectionToken(userId, orgId, serverId) {
  const payload = buildConnectionPayload(userId, orgId, serverId);
  const encodedPayload = base64UrlEncode(payload);
  const signature = signTokenPayload(encodedPayload);
  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: new Date(payload.exp).toISOString()
  };
}

async function isTokenRevoked(token, userId) {
  if (!token || !userId) return true;

  const revokedAfter = await getRevokedAfter(userId);
  const signedPayload = parseSignedConnectionToken(token);
  if (signedPayload?.sub === userId) {
    return signedPayload.iat <= revokedAfter || await isExplicitlyRevoked(userId, token);
  }

  const connections = userConnections.get(userId) || [];
  const connection = connections.find(item => item.token === token);
  if (connection?.revoked) {
    return true;
  }

  return await isExplicitlyRevoked(userId, token);
}

function formatToolContent(data) {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }]
  };
}

function formatToolError(name, error) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `Error executing ${name}: ${error.message}`
    }]
  };
}

/**
 * Strip noisy internal fields from a memory record before returning to the
 * MCP client. Whitelist approach: caller-relevant fields only. Drops
 * semantic_provenance, _searchMethod, vector_score, keyword_score,
 * graph_score, policy_score, processed_at, factSentences,
 * extracted_facts, parent_chunk, parent_document_date, semantic_relationship,
 * semantic_role, semantic_*_ids, _normalized, _normalizer, source_message_id,
 * source_session_id, expansion_metadata, operator_boost, etc.
 *
 * Content is NOT truncated here — call polishMemory(m, { contentLimit: N })
 * to truncate when needed (e.g. query_with_ai).
 */
function polishMemory(m, opts = {}) {
  if (!m || typeof m !== 'object') return m;
  const contentLimit = typeof opts.contentLimit === 'number' ? opts.contentLimit : null;
  const meta = m.metadata || {};
  const srcMeta = m.source_metadata || {};
  return {
    id: m.id,
    title: m.title || '',
    content: contentLimit ? (m.content || '').slice(0, contentLimit) : (m.content || ''),
    memory_type: m.memory_type || null,
    tags: m.tags || [],
    project: m.project || null,
    visibility: m.visibility || null,
    is_latest: m.is_latest,
    version: m.version || 1,
    importance_score: m.importance_score ?? null,
    score: typeof m.score === 'number' ? Math.round(m.score * 1000) / 1000 : undefined,
    created_at: m.created_at,
    updated_at: m.updated_at,
    document_date: m.document_date,
    source_type: meta.source_type || srcMeta.source_type || null,
    source_platform: srcMeta.source_platform || null,
    source_url: srcMeta.source_url || null,
    file_path: meta.file_path || null,
    function_name: meta.function_name || null,
    language: meta.language || null,
    affected_files: Array.isArray(meta.affected_files) ? meta.affected_files : undefined,
    alternatives: Array.isArray(meta.alternatives) ? meta.alternatives : undefined,
    refactor_type: meta.refactor_type || undefined,
    old_name: meta.old_name || undefined,
    new_name: meta.new_name || undefined,
    test_cases: Array.isArray(meta.test_cases) ? meta.test_cases : undefined,
    coverage_pct: typeof meta.coverage_pct === 'number' ? meta.coverage_pct : undefined,
    parent_memory_id: meta.parent_memory_id || undefined,
    // Cognition layer fields — pass through so MCP clients (Claude Desktop,
    // agents) can prefer synthesis-tier rows and walk evidence chains.
    ...(m.synthesis_confidence    != null ? { synthesis_confidence:    m.synthesis_confidence    } : {}),
    ...(m.synthesis_revision      != null ? { synthesis_revision:      m.synthesis_revision      } : {}),
    ...(m.synthesis_cluster_hash         ? { synthesis_cluster_hash:  m.synthesis_cluster_hash  } : {}),
    ...(Array.isArray(m.synthesis_evidence_ids) && m.synthesis_evidence_ids.length
        ? { synthesis_evidence_ids: m.synthesis_evidence_ids } : {}),
    ...(m._cross_cluster_boost   != null ? { _cross_cluster_boost:    m._cross_cluster_boost    } : {}),
    ...(m._cross_cluster_overlap != null ? { _cross_cluster_overlap:  m._cross_cluster_overlap  } : {}),
    ...(m._synthesis_boosted             ? { _synthesis_boosted:      true                       } : {}),
  };
}

function polishMemories(arr, opts = {}) {
  if (!Array.isArray(arr)) return arr;
  return arr.map(m => polishMemory(m, opts));
}

function relationshipTypeToGraphTypes(relationship) {
  switch (relationship) {
    case 'update':
      return ['Updates'];
    case 'extend':
      return ['Extends'];
    case 'derive':
      return ['Derives'];
    default:
      return ['Updates', 'Extends', 'Derives'];
  }
}

// ==========================================
// Hosted MCP Server Generator
// ==========================================

/**
 * Generate hosted MCP server configuration for a user
 * @param {string} userId - User identifier
 * @param {string} orgId - Organization identifier
 * @param {string} apiKey - User's API key for authentication
 * @returns {Object} Hosted MCP server configuration
 */
export function generateHostedServer(userId, orgId, apiKey) {
  const serverId = uuidv4();
  const { token: connectionToken, expiresAt } = createSignedConnectionToken(userId, orgId, serverId);

  const serverConfig = {
    // MCP Protocol Metadata
    mcp: {
      protocolVersion: CONFIG.protocolVersion,
      serverInfo: {
        name: CONFIG.serverName,
        version: CONFIG.serverVersion,
        vendor: 'hivemind',
        features: {
          tools: true,
          resources: true,
          prompts: true,
          logging: true,
          completions: false
        }
      },
      capabilities: {
        tools: {
          listChanged: true
        },
        resources: {
          subscribe: true,
          listChanged: true
        },
        prompts: {
          listChanged: true
        }
      }
    },

    // Connection Configuration
    connection: {
      serverId,
      userId,
      orgId,
      baseUrl: CONFIG.publicBaseUrl,
      internalBaseUrl: CONFIG.internalBaseUrl,
      endpoints: {
        // SSE endpoint for real-time updates
        sse: getSseUrl(userId, connectionToken),
        // Message endpoint for tool calls
        message: getMessageUrl(userId, connectionToken),
        // JSON-RPC endpoint for stdio bridge
        jsonrpc: getRpcUrl(userId, connectionToken)
      },
      token: connectionToken,
      expiresAt
    },

    // Available Tools (HIVE-MIND capabilities exposed as MCP tools)
    // Descriptor shows all tools; actual calls are entitlement-gated at execution time
    tools: generateToolsManifest(userId, orgId, { scopes: ['*'] }),

    // Available Resources
    resources: generateResourcesManifest(userId, orgId),

    // Available Prompts
    prompts: generatePromptsManifest(userId, orgId),

    // Client Configuration for Claude Desktop/Cursor/Antigravity/VS Code
    clientConfig: generateClientConfig(userId, orgId, connectionToken),
    ingestion: generateIngestionConfig(userId, orgId),

    // System prompt for AI platforms — tells Claude/Cursor/Antigravity how to use HIVEMIND tools
    systemPrompt: generateSystemPrompt(userId, orgId)
  };

  // Track connection
  void trackConnection(userId, serverConfig);

  return serverConfig;
}

/**
 * Generate MCP tools manifest for HIVE-MIND capabilities
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {object} [options={}]
 * @param {string[]} [options.scopes] - User entitlement scopes (used to gate web tools)
 * @returns {Array} MCP tools manifest
 */
function generateToolsManifest(userId, orgId, options = {}) {
  const scopes = Array.isArray(options.scopes) ? options.scopes : [];
  const scopeSet = new Set(scopes);
  // Full HIVEMIND-native toolset is exposed to every authenticated MCP client by
  // default. The previous scope-gating silently hid 23 of 34 tools: the OAuth→
  // internal scope map (server.js) emits names ('mcp', 'memory:read', 'web:search')
  // that NEVER matched the gate's expected names ('coding', 'web_search',
  // 'web_crawl', 'slack:act'), so every OAuth / Claude connection fell through to
  // only the 10 always-on core tools — regardless of what the user consented to.
  // These tools read/write HIVEMIND's OWN graph or server-side-keyed services
  // (same trust level as the always-on memory tools), so they are on by default.
  // Power users / restricted integrations can opt a group OUT with a negative
  // scope: '!coding', '!web', '!slack'. '*' or an empty scope list = everything.
  const hasAll = scopeSet.has('*') || scopes.length === 0;
  const hasCoding = hasAll || !scopeSet.has('!coding');
  const hasWebSearch = hasAll || !scopeSet.has('!web');
  const hasWebCrawl = hasWebSearch;
  const hasAnyWeb = hasWebSearch || hasWebCrawl;
  // Write gate for the "Default Access" (read-only) OAuth tier. The token's
  // stored scopes are the INTERNAL scopes (server.js createOAuthAccessToken
  // persists internalScopes): Full Access carries 'memory:write', the read-only
  // tier does not. When write is not granted, mutating tools are filtered out of
  // the manifest so a read-only consent is actually enforced, not just cosmetic.
  const canWrite = hasAll || scopeSet.has('memory:write') || scopeSet.has('memory.write');

  const tools = [
    {
      name: 'hivemind_save_memory',
      description: `Save information to HIVE-MIND persistent memory.

BI-TEMPORAL VERSIONING (every save = a new version row):
Every call writes a versioned snapshot. Past versions stay queryable via hivemind_at / hivemind_diff / hivemind_timeline. When relationship="update" the prior version is marked superseded but stays in the ledger — you can still answer "what did we believe on date X". Treat saves like git commits on a fact, not destructive updates.

SELF-EVOLVING GRAPH:
On every save the server runs semantic recall against past memories + a triple-operator detector. If the new content updates / extends / contradicts a prior memory the right edge type (Updates / Extends / Derives / Contradicts) is auto-added. No manual relationship needed for most cases.

PROJECT SCOPING (IMPORTANT — keeps the org knowledge structured):
The org has ONE shared HIVEMIND by default. Admins can create sub-HIVEMINDs called projects (e.g. "SOLVIS", "Q2-Planning"). Rule:
  • BEFORE saving, call hivemind_list_projects and match the content to the best-fitting project by name + description. If one clearly fits, save with its project_id so the memory lands in that project.
  • If the user names a project ("save this to SOLVIS"), pass project="<name>" or project_id="<uuid>".
  • If no project clearly fits and the user hasn't named one: if they have access to projects, the server returns needs_project_choice with the list — pick the obvious match or ASK which project (or org-wide), then re-call with project_id (omit for org-wide).
  • If the user has NO accessible projects, the save goes org-wide automatically — no need to ask.
  • Genuinely org-wide facts/preferences: omit project.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short, descriptive title for the memory'
          },
          content: {
            type: 'string',
            description: 'The content to remember — text, code, conversation summary, decision rationale.'
          },
          source_type: {
            type: 'string',
            enum: ['text', 'code', 'conversation', 'documentation', 'decision'],
            description: 'Type of content being stored',
            default: 'text'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorizing (e.g., ["react", "api-design", "bug-fix"]).'
          },
          project: {
            type: 'string',
            description: 'Project NAME or slug (e.g. "SOLVIS"). Server resolves to project_id. Use this when the user mentions a project by name. Omit for org-wide.'
          },
          project_id: {
            type: 'string',
            description: 'Project UUID. Use this only when you already have the canonical id (e.g. from hivemind_list_projects). Otherwise use the project field with the name.'
          },
          org_id: {
            type: 'string',
            description: 'Optional org UUID. The connection defaults to one org; pass another org id (from hivemind_list_projects other_orgs) to operate there instead — membership-validated, your role in that org applies.',
          },
          relationship: {
            type: 'string',
            enum: ['update', 'extend', 'derive'],
            description: 'How this relates to an existing memory: update (replaces), extend (adds nuance), derive (inferred from).'
          },
          related_to: {
            type: 'string',
            description: 'Memory ID this relates to (required when relationship is set).'
          }
        },
        required: ['title', 'content']
      }
    },
    {
      name: 'hivemind_list_projects',
      description: 'List the projects (sub-HIVEMINDs) in the current org with rich metadata per project: name, description, status, created_at, last_updated, member_count, memory_count, and people (member names + roles). CALL THIS FIRST when working with HIVEMIND memory: if the user task clearly belongs to one project (match by name/description), pass that project_id to hivemind_recall (scopes recall to that project + org-wide facts, excluding other projects) and to hivemind_save_memory (files the memory in that project). If no project clearly fits, omit project for an org-wide search/save. This keeps the org knowledge structured and on-topic.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: {
            type: 'string',
            description: 'Optional org UUID. The connection defaults to one org; pass another org id (from hivemind_list_projects other_orgs) to operate there instead — membership-validated, your role in that org applies.',
          },
        },
      },
    },
    {
      name: 'hivemind_create_project',
      description: `Create a new project (a sub-HIVEMIND) inside the current org. A project is a focused, named knowledge bucket (e.g. "SOLVIS", "Q3-Launch", "ACME-Account") that scopes memories so recall stays on-topic. The calling user becomes the project owner.

WHEN TO USE:
  • The user explicitly asks to create/start a project ("make a project for the SOLVIS account", "spin up a workspace for Q3 planning").
  • You are about to save a cluster of related memories that clearly belong to a NEW initiative that does not yet exist in hivemind_list_projects.

WORKFLOW (avoid duplicates):
  1. Call hivemind_list_projects FIRST and check whether a project with the same name/topic already exists — if so, reuse its project_id instead of creating a duplicate.
  2. Only call this when no fitting project exists.
  3. A 'description' is REQUIRED and should be a 1–2 sentence summary of the project's purpose — it powers project matching in later hivemind_list_projects / save / recall calls, so make it specific.
  4. After creation, use the returned project_id with hivemind_save_memory and hivemind_recall to file and retrieve that project's memories.

Returns the created project: { id, name, slug, description, status, created_at }. The slug is auto-derived from the name and de-duplicated.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Project name (human-readable, e.g. "SOLVIS Account"). The slug is auto-generated from this.',
          },
          description: {
            type: 'string',
            description: 'REQUIRED. 1–2 sentence summary of what this project is for. Drives project matching in list/save/recall, so be specific about scope and topic.',
          },
          team_id: {
            type: 'string',
            description: 'Optional team UUID to attach the project to a team workspace. Omit for an org-level project.',
          },
        },
        required: ['name', 'description'],
      },
    },
    {
      name: 'hivemind_recall',
      description: 'Search and retrieve relevant memories from HIVE-MIND. Use this to find previously stored information, code patterns, or context from past conversations. PROJECT WORKFLOW: for best results call hivemind_list_projects first; if the query clearly belongs to one project, pass its `project_id` to scope recall to that project + org-wide facts (other projects excluded); if it does not clearly fit a project, omit project_id for a whole-org recall. PERSON/TIME: pass `author` (member name/email/id) to return only that member memories, and `date_range` to bound time — together they answer "what did <person> update today / this week", optionally scoped to a project.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: {
            type: 'string',
            description: 'Optional org UUID. The connection defaults to one org; pass another org id (from hivemind_list_projects other_orgs) to operate there instead — membership-validated, your role in that org applies.',
          },
          query: {
            type: 'string',
            description: 'Search query - describe what you are looking for'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of memories to return',
            default: 5,
            minimum: 1,
            maximum: 20
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by specific tags'
          },
          project: {
            type: 'string',
            description: 'Filter by project'
          },
          project_id: {
            type: 'string',
            description: 'HIVEMIND project id (from hivemind_list_projects). When set, recall is scoped to that project PLUS org-wide/personal facts, and excludes other projects. Omit for a whole-org search.'
          },
          source_type: {
            type: 'string',
            enum: ['text', 'code', 'conversation', 'documentation', 'decision'],
            description: 'Filter by content type'
          },
          mode: {
            type: 'string',
            enum: ['quick', 'panorama', 'insight'],
            description: 'Search mode: quick (fast semantic), panorama (temporal/historical), insight (AI-powered sub-queries)'
          },
          valid_at: {
            type: 'string',
            description: 'Bi-temporal filter: only return memories that were valid in the world at this ISO timestamp. Use to answer "what did we know about X on date Y" / "what was the price/policy/contract clause on date Y".'
          },
          transaction_at: {
            type: 'string',
            description: 'Bi-temporal filter: only return memories the system had learned by this ISO timestamp (excludes future writes that happened after the cutoff).'
          },
          author: {
            type: 'string',
            description: 'Person filter — a member name, email, or user id. Returns only memories owned by that person. Combine with date_range to answer "what did <person> update today" (e.g. author="Maya Ortiz", date_range={start:<today ISO>}). Omit for everyone.'
          },
          date_range: {
            type: 'object',
            description: 'Restrict to a time window: { start: ISO, end?: ISO }. Use with author for "what did X do today/this week".',
            properties: { start: { type: 'string' }, end: { type: 'string' } }
          }
        },
        required: ['query']
      }
    },
    {
      name: 'hivemind_get_memory',
      description: 'Get a specific memory by its ID. Use when you have a memory ID and need the full details.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'The unique memory ID'
          }
        },
        required: ['memory_id']
      }
    },
    {
      name: 'hivemind_list_memories',
      description: 'List all memories with filtering and pagination. Use for browsing or when you need an overview.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: {
            type: 'string',
            description: 'Optional org UUID. The connection defaults to one org; pass another org id (from hivemind_list_projects other_orgs) to operate there instead — membership-validated, your role in that org applies.',
          },
          project: {
            type: 'string',
            description: 'Filter by project'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID for scoped listing. Omit for org-wide list.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by tags'
          },
          source_type: {
            type: 'string',
            enum: ['text', 'code', 'conversation', 'documentation', 'decision'],
            description: 'Filter by content type'
          },
          limit: {
            type: 'integer',
            description: 'Maximum memories to return',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          page: {
            type: 'integer',
            description: 'Page number for pagination',
            default: 1
          }
        }
      }
    },
    {
      name: 'hivemind_update_memory',
      description: 'Update an existing memory. Use when you need to correct or modify previously stored information.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'The memory ID to update'
          },
          title: {
            type: 'string',
            description: 'New title (optional)'
          },
          content: {
            type: 'string',
            description: 'New content (optional)'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'New tags (replaces existing)'
          }
        },
        required: ['memory_id']
      }
    },
    {
      name: 'hivemind_delete_memory',
      description: 'Delete a memory by ID. Use with caution - deletion is permanent.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'The memory ID to delete'
          },
          reason: {
            type: 'string',
            description: 'Reason for deletion (for audit log)'
          }
        },
        required: ['memory_id']
      }
    },
    {
      name: 'hivemind_save_conversation',
      description: 'Save the current conversation to HIVE-MIND for future reference. Use at the end of meaningful conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title describing the conversation topic'
          },
          messages: {
            type: 'array',
            description: 'Conversation messages to save',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                content: { type: 'string' }
              }
            }
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for this conversation'
          },
          project: {
            type: 'string',
            description: 'Project this conversation relates to'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID to scope this conversation. Omit for org-wide storage.'
          },
          platform: {
            type: 'string',
            enum: ['claude', 'cursor', 'chatgpt', 'other'],
            description: 'Which platform this conversation is from'
          }
        },
        required: ['title', 'messages']
      }
    },
    {
      name: 'hivemind_traverse_graph',
      description: 'Traverse the memory graph to find connected memories. Use for discovering related context and knowledge connections.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'Starting memory ID'
          },
          relationship: {
            type: 'string',
            enum: ['update', 'extend', 'derive', 'all'],
            description: 'Type of relationships to follow'
          },
          depth: {
            type: 'integer',
            description: 'How many hops to traverse',
            default: 2,
            minimum: 1,
            maximum: 5
          }
        },
        required: ['memory_id']
      }
    },
    {
      name: 'hivemind_query_with_ai',
      description: 'Ask a natural language question that HIVE-MIND answers using AI-powered retrieval. Best for complex questions requiring synthesis.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The natural language question to ask'
          },
          context_limit: {
            type: 'integer',
            description: 'How many memories to use as context',
            default: 5
          }
        },
        required: ['question']
      }
    },
  ];

  // ── Coding Intelligence tools (platform/scope-gated) ───────
  if (hasCoding) {
    tools.push(
    {
      name: 'hivemind_ingest_code',
      description: 'Save a code file or snippet to HIVE-MIND memory with auto-detected language and structural metadata. Use after editing files so future sessions can recall the codebase context. The AI coding assistant should call this after writing or significantly modifying any file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or relative path to the file (e.g., src/auth/middleware.ts)'
          },
          content: {
            type: 'string',
            description: 'Full file content or relevant snippet'
          },
          summary: {
            type: 'string',
            description: 'Human-readable summary of what this code does (1-3 sentences)'
          },
          project: {
            type: 'string',
            description: 'Project this file belongs to'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID to scope this code memory. Omit for org-wide storage.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional tags (e.g., ["auth", "middleware", "jwt"])'
          },
          related_to: {
            type: 'string',
            description: 'Memory ID of previous version of this file (for update tracking)'
          }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: 'hivemind_recall_bugs',
      description: 'Recall past bug patterns, fixes, and gotchas related to the current code context. Use before writing code in an area to avoid repeating known bugs. Returns relevant bug memories with fix context.',
      inputSchema: {
        type: 'object',
        properties: {
          context: {
            type: 'string',
            description: 'Describe what you are about to implement or the error you are seeing (e.g., "Prisma deleteMany with large IN arrays", "JWT expiry check")'
          },
          file_path: {
            type: 'string',
            description: 'File currently being edited (used to narrow search)'
          },
          project: {
            type: 'string',
            description: 'Project filter'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID for scoped recall. Omit for org-wide search.'
          },
          limit: {
            type: 'integer',
            description: 'Max results',
            default: 5,
            minimum: 1,
            maximum: 20
          }
        },
        required: ['context']
      }
    },
    {
      name: 'hivemind_set_assistant_name',
      description: 'Per-user setting: choose what HIVEMIND should call itself in Talk to HIVE chats (e.g. "Sage", "Brain", "Iris"). Stored as a personal memory tagged assistant-name. Re-running with a different name updates via Smart Ingest UPDATE relationship. Pass empty string or "default" to reset.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short name (max 32 chars). "skip", "default", or empty resets to "HIVE".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'hivemind_set_voice',
      description: 'Save the voice profile that "Talk to HIVE" uses when answering. This is how the user / organisation actually speaks — tone, terminology, do/don\'t rules, signature phrases, example outputs. Loaded into every chat system prompt. Use scope="organization" for company-wide voice (visible to every member), scope="personal" for individual voice. Re-running with the same scope updates the profile via Smart Ingest.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['organization', 'personal'],
            description: 'organization = applied to all org members. personal = applied only to the calling user.',
          },
          content: {
            type: 'string',
            description: 'Markdown / freeform text describing tone, terminology, do/don\'t rules, signature phrases, example outputs. Examples:\n\n# Tone\n- Direct, no hedging\n- Active voice\n- Numbers over adjectives\n\n# Terminology\n- "customer" not "user"\n- "ARR" not "revenue"\n\n# Do not\n- Apologize for limitations\n- Say "I think"\n\n# Signature phrases\n- "Ship it."\n- "What does the data say?"',
          },
          title: {
            type: 'string',
            description: 'Optional override title. Defaults to "Organisation voice profile" or "Personal voice profile".',
          },
        },
        required: ['scope', 'content'],
      },
    },
    {
      name: 'hivemind_log_decision',
      description: 'Save an architectural or technical decision to HIVE-MIND. Use when you choose between options (e.g., library choice, algorithm, API design). This creates a permanent decision record that future sessions can recall with hivemind_why_code.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short decision title (e.g., "Use SSE instead of WebSocket for delete progress")'
          },
          decision: {
            type: 'string',
            description: 'What was decided'
          },
          rationale: {
            type: 'string',
            description: 'Why this decision was made'
          },
          alternatives: {
            type: 'array',
            items: { type: 'string' },
            description: 'Options that were considered but not chosen'
          },
          affected_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files impacted by this decision'
          },
          project: {
            type: 'string',
            description: 'Project this decision belongs to'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID to scope this decision. Omit for org-wide storage.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorizing (e.g., ["api-design", "performance", "security"])'
          },
          related_to: {
            type: 'string',
            description: 'Memory ID of earlier related decision (creates decision chain)'
          }
        },
        required: ['title', 'decision', 'rationale']
      }
    },
    {
      name: 'hivemind_track_refactor',
      description: 'Record a code refactoring or rename so future sessions understand how code evolved. Creates a DERIVE relationship between old and new versions. Use after renames, moves, splits, or significant restructuring.',
      inputSchema: {
        type: 'object',
        properties: {
          refactor_type: {
            type: 'string',
            enum: ['rename', 'move', 'split', 'merge', 'restructure', 'extract'],
            description: 'Type of refactoring performed'
          },
          old_name: {
            type: 'string',
            description: 'Original name, path, or identifier'
          },
          new_name: {
            type: 'string',
            description: 'New name, path, or identifier'
          },
          reason: {
            type: 'string',
            description: 'Why this refactoring was done'
          },
          affected_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of files changed'
          },
          project: {
            type: 'string',
            description: 'Project this refactoring belongs to'
          },
          related_to: {
            type: 'string',
            description: 'Memory ID of the original code memory (will create DERIVE relationship)'
          }
        },
        required: ['refactor_type', 'old_name', 'new_name', 'reason']
      }
    },
    {
      name: 'hivemind_test_coverage',
      description: 'Save or recall test coverage information for functions/modules. Use to record which functions have tests (and what those tests cover), or to recall coverage before modifying code.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['save', 'recall'],
            description: 'save: store coverage info. recall: retrieve coverage for a function/file'
          },
          function_name: {
            type: 'string',
            description: 'Function, class, or module name'
          },
          file_path: {
            type: 'string',
            description: 'File path containing the function'
          },
          test_file: {
            type: 'string',
            description: 'Path to test file (for save action)'
          },
          test_cases: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of test case descriptions (for save action)'
          },
          coverage_pct: {
            type: 'number',
            description: 'Coverage percentage if known (for save action)'
          },
          project: {
            type: 'string',
            description: 'Project filter'
          }
        },
        required: ['action', 'function_name']
      }
    },
    {
      name: 'hivemind_why_code',
      description: 'Ask "why does this code exist/work this way?" — returns relevant decisions, bug fixes, and historical context for a piece of code. Use before modifying code you did not write or do not remember the context for.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you want to understand (e.g., "why is batch size 5000 in delete account", "why use SSE not polling")'
          },
          file_path: {
            type: 'string',
            description: 'File path for narrowing context'
          },
          function_name: {
            type: 'string',
            description: 'Function or class name for narrowing context'
          },
          project: {
            type: 'string',
            description: 'Project filter'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID for scoped recall. Omit for org-wide search.'
          },
          limit: {
            type: 'integer',
            description: 'Max context memories to retrieve',
            default: 8,
            minimum: 1,
            maximum: 20
          }
        },
        required: ['query']
      }
    },
    {
      name: 'hivemind_at',
      description: `Bi-temporal time-travel: return any memory (contracts, catalogs, SOPs, code, decisions, meeting notes) as the system knew it at a given timestamp.

ENTERPRISE EXAMPLES:
  • "What did our supplier contract say on Nov 1?" → hivemind_at({transaction_time:"2025-11-01T00:00:00Z", memory_query:"supplier contract"})
  • "Price of SolvisLea Pro in Q2 2025?" → hivemind_at({valid_time:"2025-06-30T00:00:00Z", memory_query:"SolvisLea Pro price"})
  • "Incident response SOP before March update?" → hivemind_at({transaction_time:"2026-02-28T00:00:00Z", memory_query:"incident response"})

transaction_time = when WE learned it. valid_time = when it was TRUE in the world.`,
      inputSchema: {
        type: 'object',
        properties: {
          transaction_time: { type: 'string', description: 'ISO timestamp — when the system learned the fact.' },
          valid_time: { type: 'string', description: 'ISO timestamp — when the fact was true in the world.' },
          memory_query: { type: 'string', description: 'Optional semantic filter on the time-traveled set (e.g. "supplier contract").' },
          file_path: { type: 'string', description: 'Optional file:<path> tag filter (code use).' },
          project: { type: 'string' },
          project_id: { type: 'string' },
        }
      }
    },
    {
      name: 'hivemind_diff',
      description: `Bi-temporal diff: what changed between two timestamps across any memory class.

ENTERPRISE EXAMPLES:
  • "What changed in our vendor agreement Oct 2024 → Oct 2025?" → hivemind_diff({time_a:"2024-10-01", time_b:"2025-10-01", tags:["vendor","agreement"]})
  • "Catalog price delta PL Neuheiten 2024 vs 2025?" → hivemind_diff({time_a:"2024-12-31", time_b:"2025-12-31", tags:["catalog"]})
  • "What policy clauses were added in the new HR handbook?" → hivemind_diff({time_a:"2025-01-01", time_b:"2026-01-01", tags:["hr","policy"]})`,
      inputSchema: {
        type: 'object',
        properties: {
          time_a: { type: 'string', description: 'Earlier ISO timestamp' },
          time_b: { type: 'string', description: 'Later ISO timestamp' },
          file_path: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag intersection filter, e.g. ["contract","vendor"]' },
        },
        required: ['time_a', 'time_b']
      }
    },
    {
      name: 'hivemind_timeline',
      description: `Full version chain for a single memory — every revision with valid_from / valid_to / superseded_by / reason.

ENTERPRISE EXAMPLES:
  • "Show every revision of the SolvisLea Pro datasheet from launch → today"
  • "Meeting decision chain for the Q2 architecture pivot"
  • "Contract amendment chain for vendor X"`,
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'Memory UUID — direct.' },
          file_path: { type: 'string', description: 'Or resolve via file:<path> tag (code use).' },
        }
      }
    },
    {
      name: 'hivemind_code_at',
      description: '[ALIAS of hivemind_at — kept for back-compat] Bi-temporal time-travel query.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_time: {
            type: 'string',
            description: 'ISO timestamp — when the system learned the fact (e.g. "2026-05-01T00:00:00Z"). Required if valid_time omitted.'
          },
          valid_time: {
            type: 'string',
            description: 'ISO timestamp — when the fact was true in the world. Required if transaction_time omitted.'
          },
          file_path: {
            type: 'string',
            description: 'Optional file path filter (post-filters memories tagged file:<path>)'
          },
          project: {
            type: 'string',
            description: 'Optional project filter (client-side post-filter)'
          },
          project_id: {
            type: 'string',
            description: 'Optional HIVEMIND project ID for scoped time-travel. Omit for org-wide search.'
          }
        }
      }
    },
    {
      name: 'hivemind_code_diff',
      description: '[ALIAS of hivemind_diff — kept for back-compat] Bi-temporal diff between two timestamps.',
      inputSchema: {
        type: 'object',
        properties: {
          time_a: {
            type: 'string',
            description: 'Earlier ISO timestamp'
          },
          time_b: {
            type: 'string',
            description: 'Later ISO timestamp'
          },
          file_path: {
            type: 'string',
            description: 'Optional file path filter — translated to tag file:<path>'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional additional tags — AND-intersected with file_path. E.g. ["fn:generateToolsManifest", "decision"]'
          }
        },
        required: ['time_a', 'time_b']
      }
    },
    {
      name: 'hivemind_code_timeline',
      description: '[ALIAS of hivemind_timeline — kept for back-compat] Full MemoryVersion ledger.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: {
            type: 'string',
            description: 'Memory UUID to fetch timeline for'
          },
          file_path: {
            type: 'string',
            description: 'Alternative: file path — resolves to the latest memory tagged file:<path> and walks its chain'
          }
        }
      }
    }
    );
  }

  // ── Web Intelligence tools (scope-gated) ──────────────────
  if (hasWebSearch) {
    tools.push({
      name: 'hivemind_web_search',
      description: 'Search the web and return structured results. Requires web_search entitlement. Returns async job receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          domains: { type: 'array', items: { type: 'string' }, description: 'Optional domain allowlist' },
          limit: { type: 'number', description: 'Max results (default: 10)' }
        },
        required: ['query']
      }
    });
  }
  if (hasWebCrawl) {
    tools.push({
      name: 'hivemind_web_crawl',
      description: 'Crawl web pages and extract content. Requires web_crawl entitlement. Returns async job receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'Seed URLs to crawl' },
          depth: { type: 'number', description: 'Crawl depth (default: 1, max: 3)' },
          page_limit: { type: 'number', description: 'Max pages (default: 10, max: 50)' }
        },
        required: ['urls']
      }
    });
  }
  if (hasAnyWeb) {
    tools.push({
      name: 'hivemind_web_job_status',
      description: 'Check status of a web search or crawl job.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job ID from search/crawl submission' }
        },
        required: ['job_id']
      }
    });
    tools.push({
      name: 'hivemind_web_usage',
      description: 'Check web intelligence quota and usage.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    });
  }

  // ── Slack action tools (Digital Employee scope: slack:act) ──
  const hasSlackAct = hasAll || !scopeSet.has('!slack');
  if (hasSlackAct) {
    tools.push({
      name: 'hivemind_slack_post',
      description: 'Post a message to a Slack channel or thread. Routes through HIVEMIND policy gate (channel allowlist, rate limit, work hours). Use when a Digital Employee needs to reply or broadcast in Slack.',
      inputSchema: {
        type: 'object',
        properties: {
          channel:   { type: 'string', description: 'Slack channel ID (e.g. C01ABCDEF)' },
          text:      { type: 'string', description: 'Message text (mrkdwn supported)' },
          thread_ts: { type: 'string', description: 'Optional thread timestamp to reply in-thread' }
        },
        required: ['channel', 'text']
      }
    });
    tools.push({
      name: 'hivemind_slack_react',
      description: 'Add an emoji reaction to a Slack message. Policy-gated like slack_post.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Slack channel ID' },
          ts:      { type: 'string', description: 'Message timestamp to react to' },
          emoji:   { type: 'string', description: 'Emoji name without colons (e.g. "thumbsup")' }
        },
        required: ['channel', 'ts', 'emoji']
      }
    });
    tools.push({
      name: 'hivemind_slack_search',
      description: 'Search messages across the employee\'s Slack workspace. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Slack search query' },
          count: { type: 'number', description: 'Max results (default 10, max 50)' }
        },
        required: ['query']
      }
    });
    tools.push({
      name: 'hivemind_slack_history',
      description: 'Fetch recent messages from a Slack channel. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Slack channel ID' },
          limit:   { type: 'number', description: 'Max messages (default 50, max 200)' },
          since:   { type: 'string', description: 'Optional ISO timestamp lower bound' }
        },
        required: ['channel']
      }
    });
  }

  if (!canWrite) {
    // Read-only ("Default Access") OAuth tier — drop every mutating tool so the
    // consent is enforced, not decorative. Read / recall / time-travel / project
    // listing / web-read tools remain available.
    const WRITE_TOOLS = new Set([
      'hivemind_save_memory', 'hivemind_update_memory', 'hivemind_delete_memory',
      'hivemind_save_conversation', 'hivemind_create_project', 'hivemind_ingest_code',
      'hivemind_log_decision', 'hivemind_track_refactor', 'hivemind_test_coverage',
      'hivemind_set_assistant_name', 'hivemind_set_voice',
      'hivemind_slack_post', 'hivemind_slack_react',
    ]);
    return tools.filter(t => !WRITE_TOOLS.has(t.name));
  }

  return tools;
}

/**
 * Generate MCP resources manifest
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @returns {Array} MCP resources manifest
 */
function generateResourcesManifest(userId, orgId) {
  return [
    {
      uri: `hivemind://memories/recent`,
      name: 'Recent Memories',
      description: 'Recently added or accessed memories',
      mimeType: 'application/json'
    },
    {
      uri: `hivemind://memories/favorites`,
      name: 'Favorite Memories',
      description: 'Frequently accessed or tagged memories',
      mimeType: 'application/json'
    },
    {
      uri: `hivemind://memories/by-project`,
      name: 'Memories by Project',
      description: 'All memories organized by project',
      mimeType: 'application/json'
    },
    {
      uri: `hivemind://memories/by-tag`,
      name: 'Memories by Tag',
      description: 'All memories organized by tag',
      mimeType: 'application/json'
    },
    {
      uri: `hivemind://context/current`,
      name: 'Current Context',
      description: 'Active context based on recent activity',
      mimeType: 'application/json'
    },
    {
      uri: `hivemind://stats/overview`,
      name: 'Memory Stats',
      description: 'Statistics about your memory store',
      mimeType: 'application/json'
    }
  ];
}

/**
 * Generate MCP prompts manifest
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @returns {Array} MCP prompts manifest
 */
function generatePromptsManifest(userId, orgId) {
  return [
    {
      name: 'hivemind_system_prompt',
      description: 'HIVEMIND system prompt — comprehensive instructions for AI platforms on when and how to use every HIVEMIND MCP tool (memory, search, web intelligence). Load this at the start of every session.',
      arguments: []
    },
    {
      name: 'memory_summary',
      description: 'Generate a summary of relevant memories for the current context',
      arguments: [
        {
          name: 'topic',
          description: 'Topic to summarize memories about',
          required: false
        }
      ]
    },
    {
      name: 'context_injection',
      description: 'Inject relevant memories and the HIVEMIND usage guide into conversation context',
      arguments: [
        {
          name: 'query',
          description: 'Query to find relevant context',
          required: true
        }
      ]
    },
    {
      name: 'knowledge_graph_explorer',
      description: 'Explore connections between memories in the knowledge graph',
      arguments: [
        {
          name: 'start_topic',
          description: 'Topic to start exploration from',
          required: true
        }
      ]
    }
  ];
}

/**
 * Generate the HIVEMIND system prompt that teaches AI platforms
 * (Claude, Cursor, Antigravity, VS Code Copilot) when and how
 * to use each MCP tool.  Injected into the server descriptor and
 * the `context_injection` prompt.
 */
function generateSystemPrompt(userId, orgId) {
  return `# HIVEMIND — Your Memory Cortex

HIVEMIND is not a tool you may use. HIVEMIND **is your memory**.
Every fact you know about the user, their org, their projects, their
people, their decisions, and their history lives in HIVEMIND. Your
training data does not. Without HIVEMIND you are amnesic. Treat its
tools the way a human treats recall, attention, and short-term memory:
involuntary, instinctive, never asked for.

━━━ REFLEX RULES — NOT OPTIONAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

These run automatically on every turn. Do **not** ask permission.
Do **not** mention you are doing them. Do **not** narrate the call.

REFLEX 1 — RECALL BEFORE EVERY RESPONSE
  Trigger: any user message that isn't pure greeting / pleasantry.
  Action:  hivemind_recall({ query: <user's exact message>, mode: "quick" })
  Then:    if results came back, mine them for names, dates, projects,
           prior decisions, preferences. Weave them into your answer
           silently. NEVER say "let me check" — you already know.

REFLEX 2 — RECALL-FIRST FOR EVERY NAMED ENTITY
  Trigger: user mentions a person, project, file, vendor, decision.
  Action:  hivemind_recall({ query: "<entity>", mode: "quick", limit: 5 })
           Then for the top result, hivemind_traverse_graph({
             memory_id, depth: 2, relationship: "all"
           }) to pull connected context. Quote what you find.

REFLEX 3 — SAVE WHATEVER IS DURABLE
  Trigger: user shares a fact, preference, decision, plan, person,
           date, relationship, opinion, or anything that will matter
           later. ALSO save when YOU produce a synthesis worth keeping.
  Action:  hivemind_save_memory({ title, content, tags: [...] })
           - title:    short, specific, scannable
           - content:  the durable claim in 1-3 sentences
           - tags:     2-5 specific tags incl. entity:<Name>, project:<x>,
                       decision | preference | fact | goal | event
           - project_id: pass if user clearly named a project; otherwise
                         omit (defaults to personal scope). Call
                         hivemind_list_projects first if unsure which.
  Do NOT save: greetings, thanks, trivial chat, sensitive credentials.
  Do NOT ask "should I save this?" — save and move on.

REFLEX 4 — UPDATE ON CONTRADICTION
  Trigger: user corrects a previous fact ("actually it's X, not Y"),
           or announces a switch ("we're moving from X to Y").
  Action:  hivemind_save_memory({ ..., relationship: "update",
                                  related_to: <prior_memory_id> })
           HIVEMIND auto-marks the old version superseded. Acknowledge
           briefly ("Got it — updated") and continue.

REFLEX 5 — TIME-TRAVEL FOR TEMPORAL QUESTIONS
  Trigger: any "as of <date>", "back in <date>", "what did we know
           when X happened", "what changed between A and B".
  Action:  hivemind_at({ transaction_time | valid_time, memory_query })
           or hivemind_diff({ time_a, time_b, tags }) for deltas
           or hivemind_timeline({ memory_id }) for one memory's history.

REFLEX 6 — WEB ONLY WHEN HIVEMIND IS SILENT
  Trigger: question needs live external info (today's news, current
           prices, public companies you haven't tracked, recent events
           after your knowledge cutoff).
  Action:  hivemind_web_search → hivemind_web_job_status (poll) →
           read results → ALWAYS save useful findings back to memory
           with source URL in tags.
  Hard rule: NEVER hit web for facts about the user / their org / their
           people / their projects. Those live in HIVEMIND. If recall
           returned nothing, say "I don't have that yet" — do NOT
           fabricate and do NOT search the public web for them.

REFLEX 7 — END-OF-SESSION ROLLUP
  Trigger: the conversation produced multiple durable claims, decisions,
           or a meaningful synthesis.
  Action:  hivemind_save_conversation({ title, messages: <compact
           summary>, tags: ["session", ...] })

━━━ INVISIBILITY RULE — ABSOLUTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You never reveal the machinery. Forbidden phrasing:
  ✗ "Let me check HIVEMIND"
  ✗ "Searching memory…"
  ✗ "According to memory <id>…"
  ✗ "I'll save this to HIVEMIND"
  ✗ "Calling hivemind_recall…"
  ✗ "Based on retrieved memories…"
Allowed phrasing:
  ✓ "You mentioned last week that…"
  ✓ "As I recall, Ceyda is leading…"
  ✓ "From your earlier decision on the BGE-M3 switch…"
  ✓ "Got it, updated."
  ✓ (silently use it; don't even reference it)

━━━ COMPLETE TOOL CATALOGUE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## MEMORY (use on EVERY non-trivial turn)
hivemind_recall          { query, mode: quick|panorama|insight, limit, tags?, project_id? }
hivemind_list_memories   { tags?, limit, memory_type?, project_id? }
hivemind_get_memory      { memory_id }
hivemind_save_memory     { title, content, tags, project_id?, relationship?, related_to? }
hivemind_update_memory   { memory_id, title?, content?, tags? }
hivemind_delete_memory   { memory_id, reason }
hivemind_save_conversation { title, messages, tags, platform }
hivemind_traverse_graph  { memory_id, depth, relationship: all|Updates|Extends|Derives|Contradicts|PartOf|Mentions }
hivemind_query_with_ai   { question, context_limit }
hivemind_recall_bugs     { context, file_path?, project_id? }
hivemind_why_code        { query, file_path?, function_name?, project_id? }
hivemind_list_projects   { query? }   ← call when user names a project you don't recognise

## TIME-TRAVEL (use on every temporal question)
hivemind_at        { transaction_time | valid_time, memory_query? }
hivemind_diff      { time_a, time_b, tags?, file_path? }
hivemind_timeline  { memory_id | file_path }

## WEB (use only when HIVEMIND is silent on external facts)
hivemind_web_search       { query, domains?, limit }   → returns job_id
hivemind_web_crawl        { urls, depth, page_limit }  → returns job_id
hivemind_web_job_status   { job_id }                   ← poll every 3-5s
hivemind_web_usage        {}

## CODE / DECISION
hivemind_ingest_code      { file_path, content, summary, tags }
hivemind_log_decision     { title, decision, rationale, alternatives, affected_files, tags }
hivemind_track_refactor   { refactor_type, old_name, new_name, reason }
hivemind_test_coverage    { action: save|recall, function_name, file_path?, test_file?, test_cases? }

━━━ DECISION SEQUENCE ON EVERY USER TURN ━━━━━━━━━━━━━━━━━━━━━━

1. RECALL (Reflex 1).
2. If named entities → also Reflex 2 (recall-then-traverse for each).
3. If temporal phrasing → Reflex 5 (time-travel tools).
4. If recall returned useful context → use it in answer; do NOT search web.
5. If recall was empty AND question is about external world → Reflex 6 (web).
6. Compose response, grounded in recall results, citing nothing aloud.
7. SAVE new durable facts (Reflex 3). UPDATE on contradictions (Reflex 4).
8. On session close → Reflex 7 (save_conversation).

━━━ FAILURE MODES TO AVOID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✗ Answering from training data alone — assume your training is stale.
✗ Hallucinating about the user or their people — always recall first.
✗ Asking "should I save this?" — just save it.
✗ Asking "want me to look that up?" — call the tool silently.
✗ Saving everything (including chit-chat) — pick durable claims only.
✗ Skipping save on a meaningful decision — that's the most expensive miss.
✗ Searching the web for facts that belong in HIVEMIND.

━━━ CONTEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

User ID: ${userId}
Org ID:  ${orgId}

You are this user's second brain. Act like it.
`;
}

/**
 * Generate client configuration for Claude Desktop/Cursor
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {string} token - Connection token
 * @returns {Object} Client configuration
 */
function buildBridgeInvocationConfig(userId, orgId, token) {
  return {
    command: 'npx',
    args: [
      '-y',
      CONFIG.bridgePackageName,
      'hosted',
      '--url',
      getDescriptorUrl(userId),
      '--user-id',
      userId
    ],
    env: {
      HIVEMIND_API_KEY: 'YOUR_API_KEY',
      HIVEMIND_CONNECTION_TOKEN: token,
      HIVEMIND_USER_ID: userId,
      HIVEMIND_ORG_ID: orgId
    },
    descriptorUrl: getDescriptorUrl(userId),
    rpcUrl: getRpcUrl(userId, token),
    token,
    package: CONFIG.bridgePackageName
  };
}

function buildPublishedBridgeConfig(userId) {
  return {
    command: 'npx',
    args: [
      '-y',
      CONFIG.bridgePackageName,
      'hosted'
    ],
    env: {
      HIVEMIND_API_URL: CONFIG.publicBaseUrl,
      HIVEMIND_API_KEY: 'YOUR_API_KEY',
      HIVEMIND_USER_ID: userId
    },
    package: CONFIG.bridgePackageName,
    compatibility: 'published-npm'
  };
}

function generateIngestionConfig(userId, orgId) {
  const authHeaders = {
    'X-API-Key': 'YOUR_API_KEY',
    'X-User-Id': userId,
    'X-Org-Id': orgId
  };

  return {
    xdata: {
      raw: {
        endpoint: `${CONFIG.publicBaseUrl}/api/ingest`,
        method: 'POST',
        headers: authHeaders,
        example: {
          source_type: 'text',
          content: 'Raw external data to ingest',
          title: 'Imported XData',
          project: 'antigravity',
          tags: ['xdata', 'import'],
          metadata: {
            source_system: 'external-webapp'
          }
        }
      },
      code: {
        endpoint: `${CONFIG.publicBaseUrl}/api/memories/code/ingest`,
        method: 'POST',
        headers: authHeaders,
        example: {
          filepath: 'src/example.ts',
          content: 'export const answer = 42;',
          language: 'typescript',
          project: 'antigravity',
          tags: ['code', 'xdata'],
          source_platform: 'vscode'
        }
      }
    },
    webapp: {
      prepare: {
        endpoint: `${CONFIG.publicBaseUrl}/api/integrations/webapp/prepare`,
        method: 'POST',
        headers: authHeaders,
        example: {
          platform: 'chatgpt',
          query: 'What do we already know about xdata ingestion?',
          project: 'antigravity',
          preferred_source_platforms: ['claude', 'antigravity'],
          preferred_tags: ['xdata'],
          max_memories: 5
        }
      },
      store: {
        endpoint: `${CONFIG.publicBaseUrl}/api/integrations/webapp/store`,
        method: 'POST',
        headers: authHeaders,
        example: {
          platform: 'chatgpt',
          content: 'Imported xdata summary from web workflow',
          memory_type: 'fact',
          title: 'XData import summary',
          project: 'antigravity',
          tags: ['xdata', 'webapp']
        }
      }
    },
    mcpConnector: {
      register: {
        endpoint: `${CONFIG.publicBaseUrl}/api/connectors/mcp/endpoints`,
        method: 'POST',
        headers: authHeaders,
        example: {
          name: 'linear-prod',
          transport: 'streamable-http',
          url: 'https://linear.example.com/mcp',
          bearer_token: 'YOUR_CONNECTOR_TOKEN',
          adapter_type: 'linear',
          default_project: 'antigravity',
          default_tags: ['xdata', 'linear']
        }
      },
      inspect: {
        endpoint: `${CONFIG.publicBaseUrl}/api/connectors/mcp/inspect`,
        method: 'POST',
        headers: authHeaders,
        example: {
          name: 'linear-prod'
        }
      },
      ingest: {
        endpoint: `${CONFIG.publicBaseUrl}/api/connectors/mcp/ingest`,
        method: 'POST',
        headers: authHeaders,
        example: {
          endpoint_name: 'linear-prod',
          adapter: 'linear',
          project: 'antigravity',
          tags: ['xdata', 'linear'],
          operation: {
            type: 'tool',
            name: 'list_issues',
            arguments: {
              team: 'HM'
            }
          }
        }
      }
    }
  };
}

function generateClientConfig(userId, orgId, token) {
  const bridge = buildBridgeInvocationConfig(userId, orgId, token);
  const publishedBridge = buildPublishedBridgeConfig(userId);
  const descriptorUrl = getDescriptorUrl(userId);
  const simpleUrl = getSimpleDescriptorUrl(userId, token);

  return {
    bridge,
    publishedBridge,
    claudeDesktop: {
      mcpServers: {
        hivemind: publishedBridge
      }
    },

    antigravity: {
      mcp_servers: {
        hivemind: {
          ...publishedBridge,
          env: {
            ...publishedBridge.env,
            NODE_NO_WARNINGS: '1'
          }
        }
      }
    },

    vscode: {
      mcpServers: {
        hivemind: {
          ...publishedBridge
        }
      }
    },

    cursor: {
      mcpServers: {
        hivemind: {
          ...publishedBridge
        }
      }
    },

    http: {
      endpoint: getRpcUrl(userId, token),
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-User-Id': userId,
        'X-Org-Id': orgId
      }
    },

    webappConnectors: generateIngestionConfig(userId, orgId),
    descriptorUrl,
    simpleUrl
  };
}

// ==========================================
// Authentication & Security
// ==========================================

/**
 * Generate connection token for hosted MCP server
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {string} serverId - Server ID
 * @param {string} apiKey - API key
 * @returns {string} Connection token
 */
export async function validateConnectionToken(token, userId) {
  const signedPayload = parseSignedConnectionToken(token);
  if (signedPayload) {
    return signedPayload.sub === userId && !(await isTokenRevoked(token, userId));
  }

  const connections = userConnections.get(userId);
  if (!connections?.length) {
    const persisted = await loadPersistedConnection(userId, token);
    return !!(persisted && !persisted.revoked && new Date(persisted.expiresAt) >= new Date());
  }

  const connection = connections.find(c => c.token === token && !c.revoked);
  if (!connection) return false;

  // Check expiration
  if (new Date(connection.expiresAt) < new Date()) {
    return false;
  }

  return true;
}

/**
 * Track user connection
 * @param {string} userId - User ID
 * @param {Object} serverConfig - Server configuration
 */
async function trackConnection(userId, serverConfig) {
  const connections = userConnections.get(userId) || [];

  // Remove expired connections
  const now = new Date();
  const validConnections = connections.filter(c =>
    new Date(c.expiresAt) > now && !c.revoked
  );

  // Add new connection
  const connection = {
    serverId: serverConfig.connection.serverId,
    token: serverConfig.connection.token,
    userId: serverConfig.connection.userId,
    orgId: serverConfig.connection.orgId,
    createdAt: new Date().toISOString(),
    expiresAt: serverConfig.connection.expiresAt,
    revoked: false,
    endpoints: serverConfig.connection.endpoints
  };
  validConnections.push(connection);

  userConnections.set(userId, validConnections);
  await persistConnectionState(connection);
}

/**
 * Revoke all connections for a user
 * @param {string} userId - User ID
 */
export async function revokeAllConnections(userId) {
  const revokedAt = Date.now();
  await setRevokedAfter(userId, revokedAt);
  const connections = userConnections.get(userId);
  if (connections) {
    await Promise.all(connections.map(async connection => {
      connection.revoked = true;
      await persistConnectionState(connection);
      await markConnectionRevoked(userId, connection.token, connection.expiresAt);
    }));
  }
}

export async function getConnectionContext(token, userId) {
  const signedPayload = parseSignedConnectionToken(token);
  if (signedPayload && signedPayload.sub === userId && !(await isTokenRevoked(token, userId))) {
    return {
      serverId: signedPayload.sid,
      token,
      userId: signedPayload.sub,
      orgId: signedPayload.org,
      createdAt: new Date(signedPayload.iat).toISOString(),
      expiresAt: new Date(signedPayload.exp).toISOString(),
      revoked: false,
      endpoints: {
        sse: getSseUrl(userId, token),
        message: getMessageUrl(userId, token),
        jsonrpc: getRpcUrl(userId, token)
      }
    };
  }

  const connections = userConnections.get(userId) || [];
  const inMemory = connections.find(connection =>
    connection.token === token
    && !connection.revoked
    && new Date(connection.expiresAt) >= new Date()
  ) || null;
  if (inMemory) {
    return inMemory;
  }

  const persisted = await loadPersistedConnection(userId, token);
  if (!persisted || persisted.revoked || new Date(persisted.expiresAt) < new Date()) {
    return null;
  }

  return persisted;
}

export async function getHostedServerByToken(token, userId) {
  const connection = await getConnectionContext(token, userId);
  if (!connection) {
    return null;
  }

  return {
    mcp: {
      protocolVersion: CONFIG.protocolVersion,
      serverInfo: {
        name: CONFIG.serverName,
        version: CONFIG.serverVersion,
        vendor: 'hivemind',
        features: {
          tools: true,
          resources: true,
          prompts: true,
          logging: true,
          completions: false
        }
      },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true }
      }
    },
    connection: {
      serverId: connection.serverId,
      userId,
      orgId: connection.orgId,
      baseUrl: CONFIG.publicBaseUrl,
      internalBaseUrl: CONFIG.internalBaseUrl,
      endpoints: connection.endpoints,
      token: connection.token,
      expiresAt: connection.expiresAt
    },
    tools: generateToolsManifest(userId, connection.orgId, { scopes: connection.scopes || ['*'], platform: connection.platform }),
    resources: generateResourcesManifest(userId, connection.orgId),
    prompts: generatePromptsManifest(userId, connection.orgId),
    clientConfig: generateClientConfig(userId, connection.orgId, connection.token),
    ingestion: generateIngestionConfig(userId, connection.orgId)
  };
}

// ==========================================
// MCP Protocol Handlers
// ==========================================

/**
 * Handle MCP initialize request
 * @param {Object} params - Initialize parameters
 * @param {string} userId - User ID
 * @returns {Object} Initialize result
 */
export function handleInitialize(params, userId, orgId) {
  return {
    protocolVersion: CONFIG.protocolVersion,
    serverInfo: {
      name: CONFIG.serverName,
      version: CONFIG.serverVersion
    },
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true }
    },
    instructions: generateSystemPrompt(userId, orgId || 'default')
  };
}

/**
 * Handle tools/list request
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {object} [options={}]
 * @param {string[]} [options.scopes] - User entitlement scopes for tool visibility gating
 * @returns {Object} Tools list result
 */
export function handleToolsList(userId, orgId, options = {}) {
  return {
    tools: generateToolsManifest(userId, orgId, { scopes: options.scopes, platform: options.platform })
  };
}

export function handleResourcesList(userId, orgId) {
  return {
    resources: generateResourcesManifest(userId, orgId)
  };
}

export function handlePromptsList(userId, orgId) {
  return {
    prompts: generatePromptsManifest(userId, orgId)
  };
}

export function handleReadResource(params, userId, orgId) {
  return {
    contents: [{
      uri: params?.uri || 'hivemind://unsupported',
      mimeType: 'application/json',
      text: JSON.stringify({
        message: 'Direct resource reads are not implemented yet.',
        user_id: userId,
        org_id: orgId
      }, null, 2)
    }]
  };
}

export function handleGetPrompt(params, userId, orgId) {
  const name = params?.name || 'unknown';

  // Return the HIVEMIND system prompt for context_injection
  if (name === 'context_injection' || name === 'hivemind_system_prompt') {
    return {
      description: 'HIVEMIND system prompt — teaches AI platforms when and how to use each tool',
      messages: [{
        role: 'assistant',
        content: {
          type: 'text',
          text: generateSystemPrompt(userId, orgId)
        }
      }]
    };
  }

  if (name === 'memory_summary') {
    const topic = params?.arguments?.topic || 'general';
    return {
      description: `Summarise memories about "${topic}"`,
      messages: [{
        role: 'assistant',
        content: {
          type: 'text',
          text: `Use hivemind_recall with mode "insight" and query "${topic}" to retrieve relevant memories, then summarise them for the user.`
        }
      }]
    };
  }

  if (name === 'knowledge_graph_explorer') {
    const startTopic = params?.arguments?.start_topic || '';
    return {
      description: `Explore knowledge graph from "${startTopic}"`,
      messages: [{
        role: 'assistant',
        content: {
          type: 'text',
          text: `Use hivemind_recall to find memories about "${startTopic}", then use hivemind_traverse_graph on the top result to explore connections. Present the relationship map to the user.`
        }
      }]
    };
  }

  return {
    description: `Prompt '${name}' from HIVE-MIND`,
    messages: [{
      role: 'assistant',
      content: {
        type: 'text',
        text: generateSystemPrompt(userId, orgId)
      }
    }]
  };
}

export function createHostedApiClient({ baseUrl, apiKey, userId, orgId }) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  // Retained so handleToolCall can rebuild the client against a different org
  // when a tool call passes a validated org_id override (multi-org users).
  const __config = { baseUrl: normalizedBaseUrl, apiKey, userId, orgId };

  async function request(method, endpoint, { params, body } = {}) {
    const url = new URL(`${normalizedBaseUrl}${endpoint}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          url.searchParams.set(key, value.join(','));
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        // authenticateApiKey() reads X-HM-User-Id / X-HM-Org-Id when the
        // master key is presented — those are the canonical proxy headers.
        // The previous X-User-Id / X-Org-Id names were ignored, so every
        // hosted-service tool call collapsed to DEFAULT_USER and a hosted
        // user's MCP saves ended up under the wrong principal.
        'X-HM-User-Id': userId,
        'X-HM-Org-Id': orgId,
        // Keep legacy names too for any downstream code still reading them.
        'X-User-Id': userId,
        'X-Org-Id': orgId
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const rawText = await response.text();
    let payload = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText;
      }
    }

    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed with ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  }

  return {
    __config,
    get(endpoint, options = {}) {
      return request('GET', endpoint, options);
    },
    post(endpoint, body) {
      return request('POST', endpoint, { body });
    },
    put(endpoint, body) {
      return request('PUT', endpoint, { body });
    },
    delete(endpoint, options = {}) {
      return request('DELETE', endpoint, options);
    }
  };
}

function normalizeMemoryText(value, fallback = '') {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value == null) {
    return fallback;
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value).trim();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags.map(tag => normalizeMemoryText(tag)).filter(Boolean);
}

function buildRelationship(relationship, relatedTo) {
  if (!relationship || !relatedTo) {
    return null;
  }

  const relationshipMap = {
    update: 'Updates',
    extend: 'Extends',
    derive: 'Derives'
  };

  const type = relationshipMap[relationship];
  if (!type) {
    return null;
  }

  return {
    type,
    target_id: relatedTo
  };
}

/**
 * Handle tools/call request
 * @param {Object} params - Tool call parameters
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {Object} apiClient - API client for making requests
 * @returns {Promise<Object>} Tool call result
 */
export async function handleToolCall(params, userId, orgId, apiClient, options = {}) {
  const { name, arguments: args } = params;
  const isMaster = options.isMaster === true;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Cross-org targeting: a tool call may pass `org_id` to operate on ANOTHER
  // org the user actively belongs to — membership-validated here, and the
  // user's role IN THAT ORG governs everything downstream (guests stay
  // project-scoped via buildAccessContext / role-aware listings). This removes
  // the "switch org in the dashboard + reconnect the MCP" dance for multi-org
  // users: one token, every org they're a member of.
  const requestedOrgId = typeof args?.org_id === 'string' && UUID_RE.test(args.org_id.trim())
    ? args.org_id.trim()
    : null;
  if (requestedOrgId && requestedOrgId !== orgId && userId) {
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const m = await prisma.userOrganization.findUnique({
        where: { userId_orgId: { userId, orgId: requestedOrgId } },
        select: { isActive: true, role: true },
      });
      if (!m || m.isActive === false) {
        return formatToolContent({
          error: `You are not an active member of org ${requestedOrgId} — org_id override rejected. Call hivemind_list_projects to see which orgs this account belongs to.`,
        });
      }
      orgId = requestedOrgId;
      if (apiClient?.__config) {
        apiClient = createHostedApiClient({ ...apiClient.__config, orgId });
      }
    } catch (orgErr) {
      return formatToolContent({ error: `org_id validation failed: ${orgErr.message}` });
    }
  }

  // Resolve optional project scope. Two modes:
  //   1. project_id (UUID) → validate membership
  //   2. project (name/slug) → look up by name in org, then validate
  // Either path → server-side mapping to validated scope fields. Falls back
  // to org-wide when neither is set or both fail.
  let requestedProjectId = typeof args.project_id === 'string' && args.project_id.trim()
    ? args.project_id.trim()
    : null;
  const requestedProjectName = typeof args.project === 'string' && args.project.trim()
    ? args.project.trim()
    : null;

  // Name → ID resolution. Look up project by case-insensitive name match
  // within the caller's org. If multiple matches, pick the most recently
  // updated (admins typically use the latest naming).
  if (!requestedProjectId && requestedProjectName && userId && orgId) {
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      if (prisma) {
        const proj = await prisma.project.findFirst({
          where: {
            orgId,
            OR: [
              { name: { equals: requestedProjectName, mode: 'insensitive' } },
              { slug: { equals: requestedProjectName.toLowerCase().replace(/\s+/g, '-') } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        if (proj?.id) requestedProjectId = proj.id;
      }
    } catch (lookupErr) {
      // Fall through — project name lookup is best-effort.
    }
  }

  let resolvedProjectId = null;
  let resolvedProjectIds = [];
  let resolvedTeamId = null;
  let projectAccessError = null;
  if (requestedProjectId && UUID_RE.test(requestedProjectId) && userId && orgId) {
    try {
      const { resolveScopedIngestPayload } = await import('../server.js');
      const scoped = await resolveScopedIngestPayload({
        user_id: userId,
        org_id: orgId,
        project_ids: [requestedProjectId],
      }, { bypassMembership: isMaster });
      resolvedProjectId = requestedProjectId;
      resolvedProjectIds = scoped.project_ids || [];
      resolvedTeamId = scoped.primary_team_id || null;
    } catch (membershipErr) {
      // Membership validation failed — most often a STALE access-context cache
      // right after the project was just created (the owner ProjectMember row
      // exists, but the cached context predates it). Do a direct DB check so an
      // EXPLICIT project_id never silently degrades into the project-picker loop
      // that blocked bootstrapping a freshly-created project.
      try {
        const { getPrismaClient } = await import('../db/prisma.js');
        const prisma = getPrismaClient();
        const proj = await prisma.project.findFirst({
          where: { id: requestedProjectId, orgId, status: 'active' },
          select: { id: true, teamId: true, members: { where: { userId }, select: { userId: true } } },
        });
        if (proj && (isMaster || proj.members.length > 0)) {
          resolvedProjectId = requestedProjectId;
          resolvedProjectIds = [requestedProjectId];
          resolvedTeamId = proj.teamId || null;
        } else if (proj) {
          projectAccessError = `You are not a member of project ${requestedProjectId}. Ask an admin to add you, or omit project_id to save org-wide.`;
        } else {
          projectAccessError = `Project ${requestedProjectId} was not found (or is archived) in this org.`;
        }
      } catch { /* leave unresolved → falls through to org-wide save */ }
    }
  }
  const SCOPE_FIELDS = resolvedProjectId ? {
    project_id: resolvedProjectId,
    project_ids: resolvedProjectIds,
    primary_team_id: resolvedTeamId || undefined,
  } : {};

  try {
    switch (name) {
      case 'hivemind_save_memory': {
        const title = normalizeMemoryText(args.title);
        const content = normalizeMemoryText(args.content);
        const relationship = buildRelationship(args.relationship, args.related_to);

        if (!title) {
          throw new Error('hivemind_save_memory requires a non-empty title');
        }

        if (!content) {
          throw new Error('hivemind_save_memory requires non-empty content');
        }

        // Explicit project_id that the caller cannot access → clear error, NOT
        // a picker. Prevents the re-ask loop when an id was deliberately passed.
        if (projectAccessError) {
          return formatToolContent({ saved: false, error: projectAccessError });
        }

        // Project-membership routing: if the user belongs to >=2 projects
        // and didn't specify one, return a structured clarification (does
        // NOT save) so the agent surfaces a picker to the user. Single
        // project → auto-attach. Zero → fall through to org-wide policy.
        let projectPolicyHint = null;
        let autoAttachedProjectId = null;
        // Only prompt for a project when the caller named NONE. An explicit
        // project_id (resolved above, or rejected via projectAccessError) must
        // never trigger the picker — that was the re-ask loop.
        if (!requestedProjectId && !resolvedProjectId && userId && orgId) {
          try {
            const { getPrismaClient } = await import('../db/prisma.js');
            const prisma = getPrismaClient();
            // Projects the user can save to = explicit ProjectMember rows
            // UNION all projects of the user's teams (implicit access).
            const [explicit, teamRows] = await Promise.all([
              prisma.projectMember.findMany({
                where: { userId, project: { orgId, status: 'active' } },
                select: { project: { select: { id: true, name: true, slug: true, description: true } } },
              }),
              prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
            ]);
            const teamIds = teamRows.map(t => t.teamId);
            const viaTeam = teamIds.length
              ? await prisma.project.findMany({
                  where: { orgId, status: 'active', teamId: { in: teamIds } },
                  select: { id: true, name: true, slug: true, description: true },
                })
              : [];
            const byId = new Map();
            for (const e of explicit) if (e.project) byId.set(e.project.id, e.project);
            for (const p of viaTeam) byId.set(p.id, p);
            const accessible = [...byId.values()];

            // Rule: exactly ONE accessible project → auto-attach (the tools
            // "recognize the project" without asking — single-project members
            // never see a picker). Two or more → ASK which project (or
            // org-wide). Zero → fall through: save org-wide.
            if (accessible.length === 1) {
              autoAttachedProjectId = accessible[0].id;
              projectPolicyHint = `Auto-scoped to your project "${accessible[0].name}" (your only project). Pass project_id explicitly to override, or project_id omitted with scope:"organization" for an org-wide save.`;
            } else if (accessible.length >= 2) {
              return formatToolContent({
                needs_project_choice: true,
                message: `This memory can be scoped to a project. Ask the user which of these ${accessible.length} project(s) to save it to — or org-wide. Then re-call hivemind_save_memory with project_id="<chosen id>" (omit project entirely for org-wide).`,
                projects: accessible.map(p => ({ id: p.id, name: p.name, slug: p.slug, description: p.description })),
                org_wide_option: true,
                saved: false,
              });
            }
          } catch { /* best-effort: fall through to org-wide save */ }
        }

        // Smart save (sync): the MCP caller expects an actual memory id +
        // success in the tool response — returning a 202/job_id breaks
        // chained tool calls that read the memory back. Use sync=true so
        // smart-ingest + entity_co_mention + relationship edges fire
        // before we return. Wall time ~3-8s on the canonical pipeline,
        // acceptable for an interactive save.
        const saveResp = await apiClient.post('/api/memories?sync=true', {
          title,
          content,
          memory_type: args.source_type === 'decision' ? 'decision' : 'fact',
          source_platform: 'mcp',
          tags: normalizeTags(args.tags),
          project: normalizeMemoryText(args.project, null) || null,
          relationship,
          metadata: {
            source_type: args.source_type || 'text'
          },
          user_id: userId,
          org_id: orgId,
          smartIngest: true,
          sync: true,
          ...SCOPE_FIELDS,
          // Auto-attach needs the same shape as explicit scoping: project_ids[]
          // drives resolveScopedIngestPayload; bare project_id alone is ignored
          // by the scope resolver and the save lands org-wide/personal.
          ...(autoAttachedProjectId && !resolvedProjectId
            ? { project_id: autoAttachedProjectId, project_ids: [autoAttachedProjectId], scope: 'project' }
            : {}),
          __bypass_membership: isMaster && resolvedProjectId ? true : undefined,
        });
        return formatToolContent({
          ...saveResp,
          scope: resolvedProjectId ? { project_id: resolvedProjectId } : { scope: 'org-wide' },
          ...(projectPolicyHint ? { policy_hint: projectPolicyHint } : {}),
        });
      }

      case 'hivemind_list_projects': {
        try {
          const { getPrismaClient } = await import('../db/prisma.js');
          const prisma = getPrismaClient();
          // Role-aware: this previously listed EVERY org project to ANY caller,
          // leaking project names/descriptions to guests. Guests see only their
          // own projects; members see accessible (member/team/org-level);
          // owners/admins see all.
          const membership = await prisma.userOrganization.findUnique({
            where: { userId_orgId: { userId, orgId } },
            select: { role: true },
          }).catch(() => null);
          // Real membership wins — master-key service calls only default to
          // 'owner' when the emulated user has no membership row at all.
          const callerRole = membership?.role || (isMaster ? 'owner' : 'member');
          // Same policy-aware visibility engine as the dashboard (raw SQL —
          // the policy column postdates the deployed Prisma client):
          // guests → explicit memberships only; members → member ∪ org_visible
          // ∪ (team_inherited ∧ own team); admins → all.
          const { TeamStore } = await import('../teams/team-store.js');
          const tstore = new TeamStore(prisma);
          const visible = await tstore.listProjectsForUser({ userId, orgId, orgRole: callerRole });
          const visibleIds = visible.slice(0, 50).map(p => p.id);
          const memberRows = visibleIds.length
            ? await prisma.projectMember.findMany({
                where: { projectId: { in: visibleIds } },
                select: { projectId: true, role: true, user: { select: { displayName: true, email: true } } },
              }).catch(() => [])
            : [];
          const peopleByProject = {};
          for (const m of memberRows) {
            (peopleByProject[m.projectId] = peopleByProject[m.projectId] || []).push(m);
          }
          const projects = visible.slice(0, 50).map(p => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            description: p.description,
            status: p.status,
            policy: p.policy,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            _count: p._count,
            members: (peopleByProject[p.id] || []).slice(0, 8),
          }));
          // Multi-org awareness: the MCP token is bound to ONE org. When the
          // user belongs to several, say so — "0 projects" usually means the
          // token is bound to the wrong org, not that projects were deleted.
          const otherOrgs = await prisma.userOrganization.findMany({
            where: { userId, isActive: true, NOT: { orgId } },
            select: { role: true, org: { select: { id: true, name: true } } },
            take: 10,
          }).catch(() => []);
          const orgsNote = otherOrgs.length
            ? ` NOTE: this connection defaults to org ${orgId}. The user ALSO belongs to: ${otherOrgs.map(o => `"${o.org?.name}" (${o.org?.id}, role ${o.role})`).join(', ')}. To work in one of those orgs, pass org_id:"<that org's id>" on any HIVEMIND tool call (hivemind_list_projects, hivemind_recall, hivemind_save_memory, …) — same connection, membership-validated, the user's role in that org applies.`
            : '';
          return formatToolContent({
            org_id: orgId,
            caller_role: callerRole,
            count: projects.length,
            projects: projects.map(p => ({
              id: p.id,
              name: p.name,
              slug: p.slug,
              description: p.description || null,
              status: p.status,
              policy: p.policy || null,
              created_at: p.createdAt,
              last_updated: p.updatedAt,
              member_count: p._count?.members ?? 0,
              memory_count: p._count?.memories ?? 0,
              people: (p.members || []).map(m => ({
                name: m.user?.displayName || m.user?.email || 'member',
                role: m.role,
              })),
            })),
            ...(otherOrgs.length ? { other_orgs: otherOrgs.map(o => ({ id: o.org?.id, name: o.org?.name, role: o.role })) } : {}),
            hint: (projects.length === 0
              ? 'No projects visible in this org for this user — memories save org-wide. Admin can create a project in the HIVEMIND web UI.'
              : 'Each project is a sub-HIVEMIND. If the user task clearly belongs to one (match by name/description), pass its `project_id` to hivemind_recall (scopes recall to that project + org-wide) and hivemind_save_memory. If unclear, omit project for org-wide.') + orgsNote,
          });
        } catch (err) {
          return formatToolContent({ error: err.message, projects: [] });
        }
      }

      case 'hivemind_create_project': {
        try {
          const name = (args.name || '').trim();
          const description = (args.description || '').trim();
          if (!name) {
            return formatToolContent({ error: 'name is required to create a project.' });
          }
          if (!description) {
            return formatToolContent({
              error: 'description is required — provide a 1–2 sentence summary of the project purpose so it can be matched in future recall/save calls.',
            });
          }
          const { getPrismaClient } = await import('../db/prisma.js');
          const prisma = getPrismaClient();
          const { TeamStore } = await import('../teams/team-store.js');
          const store = new TeamStore(prisma);

          // Guard against duplicate-by-name within the org (case-insensitive).
          const existing = await prisma.project.findFirst({
            where: { orgId, name: { equals: name, mode: 'insensitive' } },
            select: { id: true, name: true, slug: true, description: true, status: true, createdAt: true },
          });
          if (existing) {
            return formatToolContent({
              created: false,
              reason: 'project_already_exists',
              project: {
                id: existing.id,
                name: existing.name,
                slug: existing.slug,
                description: existing.description || null,
                status: existing.status,
                created_at: existing.createdAt,
              },
              hint: 'A project with this name already exists — reuse its project_id with hivemind_save_memory / hivemind_recall instead of creating a duplicate.',
            });
          }

          // Attach to a team so the project appears in the dashboard's
          // team-scoped Projects tab (org-level teamId=null projects only show
          // in the team view after the team-store visibility fix; defaulting to
          // the org's Default Team keeps MCP-created projects alongside the rest).
          let teamId = args.team_id || null;
          if (!teamId) {
            try {
              const teams = await prisma.team.findMany({
                where: { orgId },
                select: { id: true, slug: true },
                orderBy: { createdAt: 'asc' },
              });
              const def = teams.find(t => t.slug === 'default-team') || (teams.length === 1 ? teams[0] : null);
              if (def) teamId = def.id;
            } catch { /* leave org-level */ }
          }
          const project = await store.createProject({
            orgId,
            teamId,
            name,
            description,
            createdBy: userId,
          });
          return formatToolContent({
            created: true,
            project: {
              id: project.id,
              name: project.name,
              slug: project.slug,
              description: project.description || null,
              status: project.status,
              created_at: project.createdAt,
            },
            hint: 'Project created. Use its `id` as project_id in hivemind_save_memory to file memories here, and in hivemind_recall to scope retrieval to this project + org-wide facts.',
          });
        } catch (err) {
          return formatToolContent({ created: false, error: err.message });
        }
      }

      case 'hivemind_recall':
        {
          // Base: all modes use /api/recall for profile + injection + quality fixes
          const recallLimit = args.mode === 'panorama' ? 15
            : args.mode === 'insight' ? 10
            : args.limit || 5;

          const recallResult = await apiClient.post('/api/recall', {
            query_context: args.query,
            tags: args.tags || [],
            project: args.project || null,
            source_platforms: args.source_type ? [args.source_type] : [],
            max_memories: recallLimit,
            // Recall v2 orchestrator: attach evidence + fallback when sparse/citation intent
            mode: args.evidence_mode || 'auto',
            // Bi-temporal: "what did we know on date X / what was valid then"
            ...(args.valid_at ? { valid_at: args.valid_at } : {}),
            ...(args.transaction_at ? { transaction_at: args.transaction_at } : {}),
            ...(resolvedProjectId ? { project_id: resolvedProjectId, project_ids: resolvedProjectIds } : {}),
            // Person filter ("what did X update today"): server resolves name/email→userId.
            ...(args.author ? { author: args.author } : {}),
            ...(args.date_range ? { date_range: args.date_range } : {}),
          });

          // Polished memory shape only — drops semantic_*, vector_score, user_profile,
          // and injection_text noise. Caller asked for memories, not a JSON dump.
          const base = {
            memories: polishMemories(recallResult.memories || []),
            search_method: recallResult.search_method || 'persisted-recall',
            mode: args.mode || 'quick',
            count: (recallResult.memories || []).length,
            // Surface evidence inline + fallback bucket for transparency
            evidence_count: (recallResult.evidence || []).length,
            evidence: (recallResult.evidence || []).slice(0, 10),
            mode_used: recallResult.mode_used || 'auto',
          };

          // Quick: return base as-is
          if (!args.mode || args.mode === 'quick') {
            return formatToolContent(base);
          }

          // Insight: add entity extraction + relationship chains (deterministic, no LLM)
          if (args.mode === 'insight') {
            const memories = base.memories;

            const entityMap = new Map();
            const entityPatterns = {
              person: /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/g,
              organization: /\b([A-Z][A-Z0-9]{2,}(?:\s[A-Z][a-z]+)*)\b/g,
              technology: /\b(Python|JavaScript|TypeScript|Rust|Go|Java|Kotlin|Swift|React|Vue|Angular|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|AWS|Azure|GCP|Qdrant|Prisma|Node\.js)\b/gi,
            };

            for (const mem of memories) {
              const content = mem.content || '';
              for (const [type, pattern] of Object.entries(entityPatterns)) {
                const cloned = new RegExp(pattern.source, pattern.flags);
                let match;
                while ((match = cloned.exec(content)) !== null) {
                  const name = match[1] || match[0];
                  if (name.length < 3) continue;
                  const key = name.toLowerCase();
                  if (!entityMap.has(key)) {
                    entityMap.set(key, { name, type, mentions: 0, sources: [] });
                  }
                  const entity = entityMap.get(key);
                  entity.mentions++;
                  if (!entity.sources.includes(mem.id)) entity.sources.push(mem.id);
                }
              }
            }

            const entities = [...entityMap.values()]
              .filter(e => e.mentions >= 1 && e.name.length >= 3)
              .sort((a, b) => b.mentions - a.mentions)
              .slice(0, 20);

            // Build relationship chains from shared entities between memory pairs
            const chains = [];
            for (let i = 0; i < memories.length; i++) {
              for (let j = i + 1; j < memories.length; j++) {
                const iContent = (memories[i].content || '').toLowerCase();
                const jContent = (memories[j].content || '').toLowerCase();
                const sharedEntities = entities.filter(e =>
                  iContent.includes(e.name.toLowerCase()) && jContent.includes(e.name.toLowerCase())
                );
                if (sharedEntities.length > 0) {
                  chains.push({
                    from: memories[i].id,
                    to: memories[j].id,
                    shared_entities: sharedEntities.map(e => e.name),
                    strength: sharedEntities.length,
                  });
                }
              }
            }

            // Cognition-layer expansion: every synthesis row in the result
            // gets its top-4 evidence memories pulled so the caller sees the
            // curated claim AND its source rows. Bypasses additional LLM
            // calls — pure DB lookup against synthesis_evidence_ids.
            let synthesisChains = [];
            try {
              const { getPrismaClient } = await import('../db/prisma.js');
              const prismaClient = getPrismaClient();
              if (prismaClient) {
                const synthRows = memories.filter(m => {
                  const tags = m.tags || [];
                  return m.source_type === 'canonical-fact'
                      || m.source_type === 'synthesis-bridge'
                      || tags.includes('synthesis:canonical')
                      || tags.includes('synthesis:bridge');
                });
                for (const synth of synthRows.slice(0, 5)) {
                  const evIds = synth.synthesis_evidence_ids || [];
                  if (!evIds.length) continue;
                  const rows = await prismaClient.memory.findMany({
                    where: { id: { in: evIds.slice(0, 4) }, deletedAt: null },
                    select: { id: true, title: true, content: true, tags: true, createdAt: true },
                  });
                  synthesisChains.push({
                    synthesis_id: synth.id,
                    synthesis_title: synth.title,
                    synthesis_confidence: synth.synthesis_confidence,
                    synthesis_revision: synth.synthesis_revision,
                    evidence: rows.map(r => ({
                      id: r.id,
                      title: r.title,
                      content: (r.content || '').slice(0, 240),
                      tags: r.tags || [],
                      created_at: r.createdAt,
                    })),
                  });
                }
              }
            } catch (chainErr) {
              console.warn('[hivemind_recall/insight] synthesis chain expansion failed:', chainErr.message);
            }

            return formatToolContent({
              ...base,
              entities,
              relationship_chains: chains.slice(0, 10),
              synthesis_evidence_chains: synthesisChains,
              insight_metadata: {
                entity_count: entities.length,
                chain_count: chains.length,
                synthesis_chain_count: synthesisChains.length,
                memory_count: memories.length,
              },
            });
          }

          // Panorama: add temporal categorization + timeline
          if (args.mode === 'panorama') {
            const memories = base.memories;

            const now = Date.now();
            const DAY = 86400000;

            const categorized = {
              recent: [],     // 0-30 days
              medium: [],     // 30-90 days
              old: [],        // 90-365 days
              historical: [], // 365+ days
            };

            const timeline = {};

            for (const mem of memories) {
              const date = new Date(mem.document_date || mem.created_at || 0);
              const age = now - date.getTime();

              if (age < 30 * DAY) categorized.recent.push(mem);
              else if (age < 90 * DAY) categorized.medium.push(mem);
              else if (age < 365 * DAY) categorized.old.push(mem);
              else categorized.historical.push(mem);

              // Group by month for timeline
              const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
              if (!timeline[monthKey]) timeline[monthKey] = [];
              timeline[monthKey].push({
                id: mem.id,
                title: mem.title || (mem.content || '').slice(0, 60),
                date: date.toISOString(),
                memory_type: mem.memory_type,
              });
            }

            return formatToolContent({
              ...base,
              categories: {
                recent: categorized.recent.length,
                medium: categorized.medium.length,
                old: categorized.old.length,
                historical: categorized.historical.length,
              },
              timeline,
              panorama_metadata: {
                date_range: {
                  oldest: memories.length > 0 ? new Date(Math.min(...memories.map(m => new Date(m.document_date || m.created_at || 0)))).toISOString() : null,
                  newest: memories.length > 0 ? new Date(Math.max(...memories.map(m => new Date(m.document_date || m.created_at || 0)))).toISOString() : null,
                },
                memory_count: memories.length,
              },
            });
          }

          // Fallback
          return formatToolContent(base);
        }

      case 'hivemind_get_memory': {
        const raw = await apiClient.get(`/api/memories/${args.memory_id}`);
        return formatToolContent(polishMemory(raw));
      }

      case 'hivemind_list_memories': {
        // Build params object with only defined values
        const listParams = {
          limit: args.limit || 10,
          offset: Math.max(((args.page || 1) - 1) * (args.limit || 10), 0)
        };
        if (args.project) listParams.project = args.project;
        if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) listParams.tags = args.tags.join(',');
        if (args.source_type === 'decision') listParams.memory_type = 'decision';

        const listRes = await apiClient.get('/api/memories', { params: listParams });
        return formatToolContent({
          memories: polishMemories(listRes?.memories || []),
          pagination: listRes?.pagination || undefined
        });
      }

      case 'hivemind_update_memory': {
        const updRes = await apiClient.put(`/api/memories/${args.memory_id}`, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          user_id: userId,
          org_id: orgId
        });
        return formatToolContent({
          success: updRes?.success !== false,
          memory: updRes?.memory ? polishMemory(updRes.memory) : undefined
        });
      }

      case 'hivemind_delete_memory':
        return formatToolContent(await apiClient.delete(`/api/memories/${args.memory_id}`));

      case 'hivemind_save_conversation':
        return formatToolContent(await apiClient.post('/api/memories', {
          title: args.title,
          content: JSON.stringify(args.messages),
          memory_type: 'event',
          source_platform: args.platform || 'mcp',
          tags: [...(args.tags || []), 'conversation', args.platform || 'unknown'],
          project: args.project || null,
          user_id: userId,
          org_id: orgId,
          ...SCOPE_FIELDS,
        }));

      case 'hivemind_traverse_graph': {
        const trav = await apiClient.post('/api/memories/traverse', {
          start_id: args.memory_id,
          depth: args.depth || 2,
          relationship_types: relationshipTypeToGraphTypes(args.relationship || 'all')
        });
        // Backend now returns already-polished node shape, but pass through
        // polishMemory() defensively in case of legacy/non-polished responses.
        return formatToolContent({
          start_id: trav?.start_id || args.memory_id,
          depth: trav?.depth || args.depth || 2,
          nodes: Array.isArray(trav?.nodes) ? trav.nodes.map(n => polishMemory(n)) : [],
          edges: Array.isArray(trav?.edges) ? trav.edges : [],
          relationship_types: trav?.relationship_types || undefined
        });
      }

      case 'hivemind_query_with_ai': {
        const qres = await apiClient.post('/api/search/insight', {
          query: args.question,
          limit: args.context_limit || 5
        });
        // Cap response size: polish memories AND truncate content to 800 chars
        // each. Without this the raw insight payload routinely overflows the
        // MCP response limit (saw 130k chars on a 5-memory query).
        return formatToolContent({
          query: args.question,
          memories: polishMemories(qres?.memories || qres?.results || [], { contentLimit: 800 }),
          answer: qres?.answer || qres?.synthesis || null,
          context_limit: args.context_limit || 5
        });
      }

      // ── Web Intelligence handlers ─────────────────────────
      case 'hivemind_web_search': {
        const res = await apiClient.post('/api/web/search/jobs', {
          query: args.query,
          domains: args.domains,
          limit: args.limit || 10
        });
        return formatToolContent(res);
      }

      case 'hivemind_web_crawl': {
        const res = await apiClient.post('/api/web/crawl/jobs', {
          urls: args.urls,
          depth: Math.min(args.depth || 1, 3),
          page_limit: Math.min(args.page_limit || 10, 50)
        });
        return formatToolContent(res);
      }

      case 'hivemind_web_job_status': {
        const res = await apiClient.get(`/api/web/jobs/${args.job_id}`);
        return formatToolContent(res);
      }

      case 'hivemind_web_usage': {
        const res = await apiClient.get('/api/web/usage');
        return formatToolContent(res);
      }

      // ── Slack action handlers (Digital Employees) ─────────
      // All four route to core's /api/employees/slack-action endpoint which
      // resolves the caller's employee (via API key), runs policy gate,
      // executes via SlackBridge, persists ActionIntent + audit row, and
      // auto-ingests posted messages into HIVEMIND memory.
      case 'hivemind_slack_post': {
        if (!args.channel || !args.text) {
          throw new Error('hivemind_slack_post requires {channel, text}');
        }
        const res = await apiClient.post('/api/employees/slack-action', {
          action_type: 'slack_post',
          payload: { channel: args.channel, text: args.text, thread_ts: args.thread_ts || null },
        });
        return formatToolContent(res);
      }
      case 'hivemind_slack_react': {
        if (!args.channel || !args.ts || !args.emoji) {
          throw new Error('hivemind_slack_react requires {channel, ts, emoji}');
        }
        const res = await apiClient.post('/api/employees/slack-action', {
          action_type: 'slack_react',
          payload: { channel: args.channel, ts: args.ts, emoji: args.emoji },
        });
        return formatToolContent(res);
      }
      case 'hivemind_slack_search': {
        if (!args.query) throw new Error('hivemind_slack_search requires {query}');
        const res = await apiClient.post('/api/employees/slack-action', {
          action_type: 'slack_search',
          payload: { query: args.query, count: Math.min(args.count || 10, 50) },
        });
        return formatToolContent(res);
      }
      case 'hivemind_slack_history': {
        if (!args.channel) throw new Error('hivemind_slack_history requires {channel}');
        const res = await apiClient.post('/api/employees/slack-action', {
          action_type: 'slack_history',
          payload: { channel: args.channel, limit: Math.min(args.limit || 50, 200), since: args.since || null },
        });
        return formatToolContent(res);
      }

      // ── Coding Intelligence handlers ──────────────────────
      case 'hivemind_ingest_code': {
        const filePath = normalizeMemoryText(args.file_path);
        const content = normalizeMemoryText(args.content);
        if (!filePath) throw new Error('hivemind_ingest_code requires file_path');
        if (!content) throw new Error('hivemind_ingest_code requires content');

        const ext = (filePath.match(/\.([a-z0-9]+)$/i) || [])[1] || 'unknown';
        const langMap = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c', sql: 'sql', sh: 'bash' };
        const language = langMap[ext.toLowerCase()] || ext.toLowerCase();

        const lineCount = content.split('\n').length;
        const summary = normalizeMemoryText(args.summary, '') || `${language} file: ${filePath} (${lineCount} lines)`;

        // Auto-dedup: if caller didn't provide related_to, look up latest memory tagged file:<path>.
        // Found → emit UPDATE relationship so re-ingest builds version chain instead of duplicates.
        let relatedToId = args.related_to || null;
        if (!relatedToId) {
          try {
            const existing = await apiClient.get('/api/memories', {
              params: { tags: `file:${filePath}`, limit: 1 }
            });
            const list = Array.isArray(existing) ? existing : (existing?.memories || existing?.data || []);
            const latest = list.find(m => (m.tags || []).includes('code') && m.is_latest !== false) || list[0];
            if (latest && latest.id) relatedToId = latest.id;
          } catch (_e) {
            // Lookup failure must not block ingest — fall through to fresh insert.
          }
        }

        return formatToolContent(await apiClient.post('/api/memories', {
          title: `code: ${filePath}`,
          content: `${summary}\n\n--- ${filePath} ---\n${content}`,
          memory_type: 'fact',
          source_platform: 'mcp',
          tags: [...normalizeTags(args.tags), 'code', language, `file:${filePath}`],
          project: normalizeMemoryText(args.project, null) || null,
          relationship: relatedToId ? buildRelationship('update', relatedToId) : undefined,
          metadata: {
            source_type: 'code',
            file_path: filePath,
            language,
            line_count: lineCount,
            auto_linked_to: relatedToId && !args.related_to ? relatedToId : undefined
          },
          user_id: userId,
          org_id: orgId,
          ...SCOPE_FIELDS,
        }));
      }

      case 'hivemind_recall_bugs': {
        const ctx = normalizeMemoryText(args.context);
        if (!ctx) throw new Error('hivemind_recall_bugs requires context');
        const limit = Math.min(args.limit || 5, 20);
        const fileTag = args.file_path ? `file:${args.file_path}` : null;

        // Two-pronged retrieval — semantic recall captures paraphrased bug
        // descriptions even with weak tags; tag-exact list ensures we never
        // miss a memory that's been superseded (is_latest=false) but still
        // tagged bug/fix/gotcha. Merge unique by id.
        const semanticRecall = apiClient.post('/api/recall', {
          query_context: `bug fix gotcha: ${ctx}`,
          tags: fileTag ? [fileTag] : [], // narrow by file only — tag OR is too restrictive on /api/recall
          project: args.project || null,
          max_memories: limit * 2,
          ...(resolvedProjectId ? { project_id: resolvedProjectId, project_ids: resolvedProjectIds } : {}),
        }).catch(() => ({ memories: [] }));

        const fetchByTag = (tag) => apiClient.get('/api/memories', {
          params: {
            tags: fileTag ? `${tag},${fileTag}` : tag,
            limit: limit * 2,
            ...(args.project ? { project: args.project } : {})
          }
        }).catch(() => ({ memories: [] }));

        const [semantic, bugList, fixList, gotchaList] = await Promise.all([
          semanticRecall,
          fetchByTag('bug'),
          fetchByTag('fix'),
          fetchByTag('gotcha')
        ]);

        const seen = new Set();
        const merged = [];
        for (const src of [semantic.memories, bugList.memories, fixList.memories, gotchaList.memories]) {
          for (const m of (src || [])) {
            if (!m || seen.has(m.id)) continue;
            // Filter to memories that actually carry a bug-class tag (semantic recall
            // can return non-bug content matching the keywords).
            const tags = m.tags || [];
            const hasBugTag = tags.includes('bug') || tags.includes('fix') || tags.includes('gotcha');
            if (!hasBugTag && src !== semantic.memories) {
              // tag-list path is already filtered by tag — keep
            } else if (!hasBugTag) {
              continue;
            }
            seen.add(m.id);
            merged.push(m);
          }
        }
        // Rank: prefer is_latest, then by score (semantic) or recency
        merged.sort((a, b) => {
          if (a.is_latest !== b.is_latest) return a.is_latest ? -1 : 1;
          const sa = typeof a.score === 'number' ? a.score : 0;
          const sb = typeof b.score === 'number' ? b.score : 0;
          if (sa !== sb) return sb - sa;
          return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
        });

        return formatToolContent({
          query_context: ctx,
          filter_tags: ['bug | fix | gotcha', ...(fileTag ? [fileTag] : [])],
          count: merged.length,
          memories: polishMemories(merged.slice(0, limit))
        });
      }

      case 'hivemind_set_assistant_name': {
        const requested = normalizeMemoryText(args.name, '');
        const { extractNameFromReply, ASSISTANT_IDENTITY } = await import('../services/assistant-identity.js');
        // Treat "skip" / "default" / empty as fall-back to default name.
        const finalName = (!requested || /^(skip|default|reset|none)$/i.test(requested))
          ? ASSISTANT_IDENTITY.DEFAULT_NAME
          : (extractNameFromReply(requested) || ASSISTANT_IDENTITY.DEFAULT_NAME);

        // Look up prior name memory id so Smart Ingest UPDATE chains.
        let prevId = null;
        try {
          const list = await apiClient.get('/api/memories', {
            params: { tags: ASSISTANT_IDENTITY.TAG, limit: 1 },
          });
          const memories = list?.memories || list?.data || [];
          prevId = memories[0]?.id || null;
        } catch {}

        return formatToolContent(await apiClient.post('/api/memories', {
          title: `Assistant name: ${finalName}`,
          content: `User chose to name their HIVEMIND assistant "${finalName}".`,
          memory_type: 'fact',
          source_platform: 'assistant-identity',
          tags: [ASSISTANT_IDENTITY.TAG, 'voice-profile'],
          visibility: 'private',
          metadata: {
            source_type: 'assistant-identity',
            assistant_name: finalName,
          },
          relationship: prevId ? buildRelationship('update', prevId) : undefined,
          user_id: userId,
          org_id: orgId,
        }));
      }

      case 'hivemind_set_voice': {
        const scope = args.scope === 'organization' || args.scope === 'org' ? 'organization' : 'personal';
        const content = normalizeMemoryText(args.content);
        if (!content) throw new Error('hivemind_set_voice requires content');
        const isOrg = scope === 'organization';
        return formatToolContent(await apiClient.post('/api/memories', {
          title: normalizeMemoryText(args.title, '') || (isOrg ? 'Organisation voice profile' : 'Personal voice profile'),
          content,
          memory_type: 'fact',
          source_platform: 'voice-profile',
          tags: [isOrg ? 'org-voice' : 'user-voice', 'voice-profile'],
          visibility: isOrg ? 'organization' : 'private',
          metadata: {
            source_type: 'voice-profile',
            voice_scope: isOrg ? 'organization' : 'personal',
          },
          user_id: userId,
          org_id: orgId,
        }));
      }

      case 'hivemind_log_decision': {
        const title = normalizeMemoryText(args.title);
        const decision = normalizeMemoryText(args.decision);
        const rationale = normalizeMemoryText(args.rationale);
        if (!title) throw new Error('hivemind_log_decision requires title');
        if (!decision) throw new Error('hivemind_log_decision requires decision');
        if (!rationale) throw new Error('hivemind_log_decision requires rationale');

        const alts = Array.isArray(args.alternatives) ? args.alternatives : [];
        const files = Array.isArray(args.affected_files) ? args.affected_files : [];

        const body = [
          `Decision: ${decision}`,
          `Rationale: ${rationale}`,
          alts.length ? `Alternatives considered:\n- ${alts.join('\n- ')}` : null,
          files.length ? `Affected files:\n- ${files.join('\n- ')}` : null
        ].filter(Boolean).join('\n\n');

        return formatToolContent(await apiClient.post('/api/memories', {
          title,
          content: body,
          memory_type: 'decision',
          source_platform: 'mcp',
          tags: [...normalizeTags(args.tags), 'decision', ...files.map(f => `file:${f}`)],
          project: normalizeMemoryText(args.project, null) || null,
          relationship: args.related_to ? buildRelationship('extend', args.related_to) : undefined,
          metadata: {
            source_type: 'decision',
            alternatives: alts,
            affected_files: files
          },
          user_id: userId,
          org_id: orgId,
          ...SCOPE_FIELDS,
        }));
      }

      case 'hivemind_track_refactor': {
        const refactorType = normalizeMemoryText(args.refactor_type);
        const oldName = normalizeMemoryText(args.old_name);
        const newName = normalizeMemoryText(args.new_name);
        const reason = normalizeMemoryText(args.reason);
        if (!refactorType || !oldName || !newName || !reason) {
          throw new Error('hivemind_track_refactor requires refactor_type, old_name, new_name, reason');
        }
        const files = Array.isArray(args.affected_files) ? args.affected_files : [];

        return formatToolContent(await apiClient.post('/api/memories', {
          title: `refactor (${refactorType}): ${oldName} → ${newName}`,
          content: `Refactor type: ${refactorType}\nFrom: ${oldName}\nTo: ${newName}\nReason: ${reason}${files.length ? `\nAffected files:\n- ${files.join('\n- ')}` : ''}`,
          memory_type: 'event',
          source_platform: 'mcp',
          tags: ['refactor', refactorType, ...files.map(f => `file:${f}`)],
          project: normalizeMemoryText(args.project, null) || null,
          relationship: args.related_to ? buildRelationship('derive', args.related_to) : undefined,
          metadata: {
            source_type: 'code',
            refactor_type: refactorType,
            old_name: oldName,
            new_name: newName,
            affected_files: files
          },
          user_id: userId,
          org_id: orgId,
          ...SCOPE_FIELDS,
        }));
      }

      case 'hivemind_test_coverage': {
        const action = args.action;
        const fnName = normalizeMemoryText(args.function_name);
        if (!fnName) throw new Error('hivemind_test_coverage requires function_name');

        if (action === 'save') {
          const cases = Array.isArray(args.test_cases) ? args.test_cases : [];
          const tags = ['test-coverage', `fn:${fnName}`];
          if (args.file_path) tags.push(`file:${args.file_path}`);
          if (args.test_file) tags.push(`testfile:${args.test_file}`);

          return formatToolContent(await apiClient.post('/api/memories', {
            title: `test coverage: ${fnName}`,
            content: `Function: ${fnName}\nFile: ${args.file_path || 'unknown'}\nTest file: ${args.test_file || 'unknown'}\nCoverage: ${args.coverage_pct ?? 'unknown'}%\nTest cases:\n- ${cases.join('\n- ') || 'none specified'}`,
            memory_type: 'fact',
            source_platform: 'mcp',
            tags,
            project: normalizeMemoryText(args.project, null) || null,
            metadata: {
              source_type: 'code',
              function_name: fnName,
              file_path: args.file_path || null,
              test_file: args.test_file || null,
              test_cases: cases,
              coverage_pct: typeof args.coverage_pct === 'number' ? args.coverage_pct : null
            },
            user_id: userId,
            org_id: orgId,
            ...SCOPE_FIELDS,
          }));
        }

        // recall
        const tagFilter = ['test-coverage', `fn:${fnName}`];
        if (args.file_path) tagFilter.push(`file:${args.file_path}`);
        const recallResult = await apiClient.post('/api/recall', {
          query_context: `test coverage for ${fnName}`,
          tags: tagFilter,
          project: args.project || null,
          max_memories: 10,
          ...(resolvedProjectId ? { project_id: resolvedProjectId, project_ids: resolvedProjectIds } : {}),
        });
        return formatToolContent({
          memories: recallResult.memories || [],
          function_name: fnName,
          filter_tags: tagFilter
        });
      }

      case 'hivemind_why_code': {
        const query = normalizeMemoryText(args.query);
        if (!query) throw new Error('hivemind_why_code requires query');

        const tags = [];
        if (args.file_path) tags.push(`file:${args.file_path}`);
        if (args.function_name) tags.push(`fn:${args.function_name}`);

        // Pull decisions, code, refactor history, and bug fixes for this code path.
        const recallResult = await apiClient.post('/api/recall', {
          query_context: `why: ${query}`,
          tags,
          project: args.project || null,
          max_memories: Math.min(args.limit || 8, 20),
          ...(resolvedProjectId ? { project_id: resolvedProjectId, project_ids: resolvedProjectIds } : {}),
        });

        const rawMemories = recallResult.memories || [];
        const decisions = polishMemories(rawMemories.filter(m => m.memory_type === 'decision' || (m.tags || []).includes('decision')));
        const refactors = polishMemories(rawMemories.filter(m => (m.tags || []).includes('refactor')));
        const bugs = polishMemories(rawMemories.filter(m => (m.tags || []).includes('bug') || (m.tags || []).includes('fix')));
        const codeRefs = polishMemories(rawMemories.filter(m => (m.tags || []).includes('code')));
        const memories = polishMemories(rawMemories);

        return formatToolContent({
          query,
          summary: {
            decisions: decisions.length,
            refactors: refactors.length,
            bugs: bugs.length,
            code_refs: codeRefs.length,
            total: memories.length
          },
          memories,
          decisions,
          refactors,
          bugs,
          code_refs: codeRefs
        });
      }

      // ── Bi-temporal aliases (work on ANY memory — docs, contracts, SOPs,
      // catalogs, code). Coding-prefixed names below kept for back-compat.
      case 'hivemind_at':
      case 'hivemind_code_at': {
        if (!args.transaction_time && !args.valid_time) {
          throw new Error('hivemind_code_at requires transaction_time and/or valid_time');
        }
        // Default transaction_time to "now" when only valid_time is given —
        // and warn callers passing a TX-time earlier than any memory's
        // creation: empty result is correct, not a bug.
        const txTime = args.transaction_time || null;
        const validTime = args.valid_time || null;
        const res = await apiClient.post('/api/temporal/as-of', {
          transaction_time: txTime,
          valid_time: validTime
        });
        let memories = res.memories || [];
        if (args.file_path) {
          memories = memories.filter(m => (m.tags || []).includes(`file:${args.file_path}`));
        }
        if (args.project) {
          memories = memories.filter(m => m.project === args.project);
        }
        // Enterprise semantic filter (post-filter on title+content tokens)
        if (args.memory_query && typeof args.memory_query === 'string') {
          const q = args.memory_query.toLowerCase();
          const tokens = q.split(/\s+/).filter(t => t.length >= 3);
          if (tokens.length > 0) {
            memories = memories.filter(m => {
              const haystack = `${m.title || ''} ${m.content || ''}`.toLowerCase();
              return tokens.some(t => haystack.includes(t));
            });
          }
        }
        const polished = polishMemories(memories);
        const hint = (polished.length === 0 && txTime)
          ? `No memories exist at transaction_time=${txTime}${args.file_path ? ` for file ${args.file_path}` : ''}. The system may not have learned anything by that time, or the file did not yet exist. Try a later timestamp or omit the filter.`
          : null;
        return formatToolContent({
          query: res.query || { transaction_time: txTime, valid_time: validTime },
          count: polished.length,
          memories: polished,
          ...(hint ? { hint } : {})
        });
      }

      case 'hivemind_diff':
      case 'hivemind_code_diff': {
        if (!args.time_a || !args.time_b) {
          throw new Error('hivemind_code_diff requires time_a and time_b');
        }
        const tagsFilter = [];
        if (args.file_path) tagsFilter.push(`file:${args.file_path}`);
        if (Array.isArray(args.tags) && args.tags.length) tagsFilter.push(...args.tags);

        const diff = await apiClient.post('/api/temporal/diff', {
          time_a: args.time_a,
          time_b: args.time_b,
          tags_filter: tagsFilter.length ? tagsFilter : undefined
        });
        return formatToolContent({ ...diff, file_path: args.file_path || null });
      }

      case 'hivemind_timeline':
      case 'hivemind_code_timeline': {
        let memoryId = args.memory_id;
        if (!memoryId && args.file_path) {
          // Resolve latest memory tagged file:<path>
          const list = await apiClient.get('/api/memories', {
            params: { tags: `file:${args.file_path}`, limit: 1 }
          });
          const memories = Array.isArray(list) ? list : (list?.memories || list?.data || []);
          memoryId = memories[0]?.id || null;
        }
        if (!memoryId) {
          throw new Error('hivemind_code_timeline requires memory_id or a resolvable file_path');
        }
        const res = await apiClient.post('/api/temporal/timeline', { memory_id: memoryId });
        return formatToolContent(res);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return formatToolError(name, error);
  }
}

// ==========================================
// API Route Setup
// ==========================================

/**
 * Setup hosted MCP API routes
 * @param {Object} app - Express/Fastify app instance
 * @param {Function} authMiddleware - Authentication middleware
 */
export function setupHostedMcpRoutes(app, authMiddleware) {
  // GET /api/mcp/servers/:userId - Get hosted MCP server configuration
  app.get('/api/mcp/servers/:userId', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const orgId = req.user?.orgId || req.headers['x-org-id'];
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    // Verify user matches authenticated user
    const authenticatedUserId = req.user?.id || req.headers['x-user-id'];
    if (authenticatedUserId !== userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'User ID does not match authenticated user'
      });
    }

    try {
      const serverConfig = generateHostedServer(userId, orgId, apiKey);
      res.json(serverConfig);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to generate MCP server configuration',
        message: error.message
      });
    }
  });

  // POST /api/mcp/servers/:userId/rpc - JSON-RPC endpoint for MCP protocol
  app.post('/api/mcp/servers/:userId/rpc', async (req, res) => {
    const { userId } = req.params;
    const token = req.query.token || req.headers['authorization']?.replace('Bearer ', '');

    // Validate connection token
    if (!(await validateConnectionToken(token, userId))) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired connection token'
      });
    }

    const { method, params, id } = req.body;

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = handleInitialize(params, userId);
          break;

        case 'tools/list':
          result = handleToolsList(userId, req.headers['x-org-id'], {
            platform: req.headers['x-mcp-platform'] || req.headers['x-client-platform'] || (req.headers['user-agent'] || '').toLowerCase()
          });
          break;

        case 'tools/call':
          // Note: apiClient would need to be injected or created here
          result = await handleToolCall(params, userId, req.headers['x-org-id'], null);
          break;

        case 'resources/list':
          result = { resources: generateResourcesManifest(userId, req.headers['x-org-id']) };
          break;

        case 'prompts/list':
          result = { prompts: generatePromptsManifest(userId, req.headers['x-org-id']) };
          break;

        default:
          return res.status(400).json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          });
      }

      res.json({
        jsonrpc: '2.0',
        id,
        result
      });
    } catch (error) {
      res.status(500).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error.message }
      });
    }
  });

  // GET /api/mcp/servers/:userId/sse - Server-Sent Events for real-time updates
  app.get('/api/mcp/servers/:userId/sse', async (req, res) => {
    const { userId } = req.params;
    const token = req.query.token;

    if (!(await validateConnectionToken(token, userId))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
    }, 30000);

    // Clean up on close
    req.on('close', () => {
      clearInterval(keepAlive);
    });
  });

  // POST /api/mcp/servers/:userId/revoke - Revoke all connections
  app.post('/api/mcp/servers/:userId/revoke', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    const authenticatedUserId = req.user?.id || req.headers['x-user-id'];

    if (authenticatedUserId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await revokeAllConnections(userId);
    res.json({ success: true, message: 'All MCP connections revoked' });
  });
}

// ==========================================
// Export
// ==========================================

export default {
  createHostedApiClient,
  generateHostedServer,
  getConnectionContext,
  validateConnectionToken,
  revokeAllConnections,
  handleInitialize,
  handleToolsList,
  handleResourcesList,
  handlePromptsList,
  handleReadResource,
  handleGetPrompt,
  handleToolCall,
  setupHostedMcpRoutes
};
