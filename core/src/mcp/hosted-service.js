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

function hostedRetrievalFilters(args = {}) {
  return {
    ...(Array.isArray(args.entities) ? { entities: args.entities } : {}),
    ...(Array.isArray(args.memory_types) ? { memory_types: args.memory_types } : {}),
    ...(args.source_document_id ? { source_document_id: args.source_document_id } : {}),
    ...(args.source_title ? { source_title: args.source_title } : {}),
    ...(args.source_kind ? { source_kind: args.source_kind } : {}),
    ...(args.scope_filter ? { scope_filter: args.scope_filter } : {}),
    ...(Array.isArray(args.relationship_types) ? { relationship_types: args.relationship_types } : {}),
    ...(args.relationship_direction ? { relationship_direction: args.relationship_direction } : {}),
    ...(args.time_axis ? { temporal_axis: args.time_axis } : {}),
    ...(args.memory_id ? { target_memory_id: args.memory_id } : {}),
  };
}

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
  // Loud server-side log so MCP tool failures are diagnosable from container logs.
  // Previously a thrown tool error surfaced ONLY to the MCP client as a generic
  // "operation_failed", leaving nothing in `docker logs hm-core` to root-cause from.
  try { console.warn(`[mcp] tool ${name} failed: ${error?.message || error}`); } catch { /* noop */ }
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
  // Web capabilities are explicit allow-list scopes. They spend platform
  // provider credits and can persist public findings, so an absent or empty
  // scope set must never be interpreted as blanket access.
  const hasAll = scopeSet.has('*');
  const hasCoding = hasAll || !scopeSet.has('!coding');
  const hasWebSearch = hasAll || scopeSet.has('web_search');
  const hasWebResearch = hasAll || scopeSet.has('web_research');
  const hasWebCrawl = hasAll || scopeSet.has('web_crawl');
  const hasAnyWeb = hasWebSearch || hasWebResearch || hasWebCrawl;
  // Write gate for the "Default Access" (read-only) OAuth tier. The token's
  // stored scopes are the INTERNAL scopes (server.js createOAuthAccessToken
  // persists internalScopes): Full Access carries 'memory:write', the read-only
  // tier does not. When write is not granted, mutating tools are filtered out of
  // the manifest so a read-only consent is actually enforced, not just cosmetic.
  // Core HIVEMIND memory tools retain their established default-access
  // behavior. Only provider-spending Web capabilities require explicit scope.
  const canWrite = scopes.length === 0 || hasAll || scopeSet.has('memory:write') || scopeSet.has('memory.write');

  const tools = [
    {
      name: 'hivemind_save_memory',
      description: `Persist a durable fact, preference, decision, or synthesis to HIVE-MIND memory.
Use whenever the user shares something that will matter in a future session: names, plans, decisions, opinions, facts, or anything you'd wish you remembered. NOT for ephemeral chat or greetings — use hivemind_save_conversation for full dialogue transcripts; use hivemind_log_decision for formal technical decisions; use hivemind_ingest_code for source files.
Every save is a versioned snapshot; old versions stay queryable via hivemind_at / hivemind_diff / hivemind_timeline. Pass relationship="update" + related_to=<id> when correcting a prior fact — the server marks the old version superseded.
PROJECT SCOPING: pass project_id ONLY when the user explicitly names a project. Otherwise omit it — the server auto-classifies the best-fitting project from each project's name+description and files it there when confident; it falls back to personal/org-wide when ambiguous. You do NOT need to call hivemind_list_projects before every save. Pair with hivemind_traverse_graph to explore connected context after saving.`,
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
      description: `List all projects (sub-HIVEMINDs) in the current org with metadata: name, description, status, member_count, memory_count, and member names+roles.
Use when the user names a project you don't recognise, when you need the project_id to pass to hivemind_recall or hivemind_save_memory, or when exploring what focused knowledge buckets exist. NOT required before every save — the server auto-classifies saves by project; call this only when you need an explicit project_id or want to inspect membership/metadata.
Returns org projects plus other_orgs the user belongs to. Pass org_id to switch org context.`,
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
      description: `Create a new project (sub-HIVEMIND) inside the current org — a focused knowledge bucket that scopes saves and recall to a specific initiative (e.g. "SOLVIS", "Q3-Launch", "ACME-Account").
Use ONLY when the user explicitly asks to start a project, or when you are saving memories that clearly belong to a brand-new initiative not yet in hivemind_list_projects. NOT for saving memories into an existing project — use hivemind_save_memory with project_id instead.
DUPLICATE GUARD: call hivemind_list_projects first; reuse an existing project_id rather than creating a duplicate. description is required (1–2 sentences, specific) — it drives auto-classification in future saves.
Returns { id, name, slug, description, status, created_at }; pass the returned id to hivemind_save_memory and hivemind_recall.`,
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
      description: `Semantic search across all stored memories — your primary retrieval reflex. Use on every non-trivial user turn to surface relevant past facts, decisions, or context before composing a response.
NOT for fetching a single known memory by ID (use hivemind_get_memory); NOT for browsing/listing without a query (use hivemind_list_memories); NOT for AI-synthesized answers (use hivemind_query_with_ai); NOT for code-history reasons (use hivemind_why_code); NOT for bug patterns (use hivemind_recall_bugs).
Mode guide: quick = fast semantic (default); panorama = temporal/historical sweep; insight = AI sub-queries for complex questions. Pass project_id to scope to one project + org-wide facts; omit for whole-org. Combine author + date_range to answer "what did <person> do this week". Pair top results with hivemind_traverse_graph to pull connected context. HARD RULE: never use hivemind_web_search for facts about the user / their org / their people — recall here first; only go to web if this returns nothing on external topics.`,
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
      description: `Fetch a single memory by its exact UUID and return full details including content, tags, timestamps, and version metadata.
Use when you already have a memory_id (e.g. from a recall result or traverse_graph) and need the complete record. NOT for searching — use hivemind_recall; NOT for version history — use hivemind_timeline; NOT for graph neighbours — use hivemind_traverse_graph. Requires the exact memory_id; no fuzzy matching.`,
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
      description: `Browse and paginate stored memories with tag/type/project filters. Returns a flat list with titles and short previews.
Use when the user wants to see what is stored ("show me all decisions", "list code memories for SOLVIS"), or when you need to scan a category without a specific query. NOT for semantic search — use hivemind_recall with a query; NOT for a single record — use hivemind_get_memory; NOT for AI synthesis — use hivemind_query_with_ai. Combine tags + source_type + project_id to narrow results; use page/limit for pagination.`,
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
      description: `Overwrite specific fields (title, content, tags) of an existing memory by its ID. Use when the user explicitly edits or corrects a stored record you already have the ID for.
NOT for versioned supersession of a fact — use hivemind_save_memory with relationship="update" + related_to instead (preserves version history); NOT for bulk changes — update each memory individually. Requires the exact memory_id; fetch it first via hivemind_recall or hivemind_get_memory if you don't have it. Only the fields you pass are changed; omitted fields are left as-is.`,
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
      description: `Permanently delete a memory by ID. Use only when the user explicitly requests removal of a stored record, or when the record is confidential/erroneous and must not remain.
Deletion is irreversible — version history is also removed. NOT for outdating a fact — use hivemind_save_memory with relationship="update" to supersede while keeping the ledger intact. Always pass a reason for the audit log. Fetch the memory_id via hivemind_recall first if you don't have it.`,
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
      description: `Store a full conversation transcript as a single durable memory (REFLEX 7). Use at the end of sessions that produced meaningful exchanges — decisions made, facts shared, plans agreed — so future sessions can recall the whole dialogue.
NOT for individual facts from a conversation — use hivemind_save_memory for those; NOT for code edits — use hivemind_ingest_code; NOT for architectural decisions — use hivemind_log_decision. Pass a compact messages array (summarise long turns rather than copy verbatim). Tag with platform and any project or entity tags so future recall can find it. Pair with project_id when the conversation was scoped to a project.`,
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
      description: `Walk the knowledge graph from a known memory node and return connected memories up to N hops away, following typed edges (Updates / Extends / Derives / Contradicts / PartOf / Mentions).
Use AFTER hivemind_recall returns a relevant memory and you need richer connected context — e.g. to find the chain of decisions that led to a choice, or memories that were extended by later facts. NOT for searching without a starting ID — use hivemind_recall; NOT for a single memory's version history — use hivemind_timeline. Start from the memory_id of your most relevant recall result; set depth=2 for broad context, depth=1 for immediate neighbours only.`,
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
      description: `Ask a natural-language question and receive an AI-synthesized answer grounded in stored memories — HIVEMIND retrieves relevant context and composes a direct response.
Use for complex multi-part questions that require synthesizing across several memories, or when you want a narrative answer rather than a list of raw memories. NOT for simple lookups — use hivemind_recall for those (faster, cheaper); NOT for a single known record — use hivemind_get_memory. Increase context_limit for questions spanning many facts. Results are grounded in memory; not suitable for live external data (use hivemind_web_search for that).`,
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
      description: `Store a source file or code snippet as a versioned memory, with auto-detected language and structural metadata. Triggers AFTER every Edit/Write to a real file so future sessions can recall codebase context without re-reading the file.
NOT for architectural decisions — use hivemind_log_decision; NOT for test coverage records — use hivemind_test_coverage; NOT for renames/moves — use hivemind_track_refactor; NOT for generic text — use hivemind_save_memory. Pass the full content so Smart Ingest can detect changes and auto-deduplicate against prior versions. Pair with related_to=<prior_memory_id> to chain versions explicitly. Include a concise summary (1-3 sentences) so recall surfaces it without reading full content.`,
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
      description: `Surface stored bug patterns, past fixes, and known gotchas relevant to what you are about to write. Fire BEFORE touching any known-buggy area to avoid repeating history.
NOT for general code context — use hivemind_why_code; NOT for test coverage — use hivemind_test_coverage; NOT for architectural reasons — use hivemind_log_decision recall. Describe what you are implementing (context) as specifically as possible, and pass the file_path being edited to narrow the search. Returns memories tagged bug | fix | gotcha with fix context. Combine with hivemind_why_code for a full picture before modifying unfamiliar code.`,
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
      description: `Personalization: set the display name HIVEMIND uses for itself in Talk-to-HIVE chats (e.g. "Sage", "Brain", "Iris"). Stored as a personal memory; re-running with a different name updates it automatically.
Use only when the user explicitly asks to rename the assistant. NOT for setting voice/tone — use hivemind_set_voice. Pass empty string or "default" to reset to "HIVE". One name per user; there is no project scope for this setting.`,
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
      name: 'hivemind_chat_context',
      description: `Build the same event-driven, source-grounded context used by /api/chat without generating the final answer. Returns facts, source sections, citations, coverage, and cutoff state for another LLM. A document-backed fact result receives one bounded evidence expansion; full raw-document hydration remains explicit-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The user question verbatim.' },
          mode: { type: 'string', enum: ['fact', 'explain', 'full'], default: 'fact' },
          project_id: { type: 'string', description: 'Optional accessible project UUID.' },
          source_document_id: { type: 'string', description: 'Known document UUID; use with full.' },
          source_title: { type: 'string', description: 'Known source title; use with full.' },
          include_live: { type: 'boolean', default: false, description: 'Allow eligible live connector evidence.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'hivemind_set_voice',
      description: `Define how HIVEMIND speaks — tone, terminology, do/don't rules, signature phrases. Loaded into every Talk-to-HIVE system prompt. Re-calling with the same scope updates the profile.
Use when the user wants to calibrate HIVEMIND's communication style for themselves (scope="personal") or for the whole org (scope="organization"). NOT for renaming the assistant — use hivemind_set_assistant_name. Organization scope overrides personal scope for shared members; personal scope applies only to the calling user. Content should be in freeform markdown (see parameter description for examples).`,
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
      description: `Record a formal architectural or technical decision with rationale and alternatives considered — the permanent "why" ledger that future sessions recall via hivemind_why_code.
Use whenever a meaningful engineering choice is made: library selection, algorithm pick, API design tradeoff, infrastructure decision. NOT for general facts — use hivemind_save_memory; NOT for code file snapshots — use hivemind_ingest_code; NOT for rename/move history — use hivemind_track_refactor. Always include rationale and alternatives so the decision is auditable. Pair with affected_files and tags so hivemind_why_code can surface it when the relevant file is later modified.`,
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
      description: `Record a rename, move, split, merge, or structural restructure so future sessions know how code evolved. Creates a DERIVE edge from old identity to new.
Fire after any rename/move/extract of a function, file, module, or schema. NOT for saving code content — use hivemind_ingest_code; NOT for why a design was chosen — use hivemind_log_decision; NOT for bug fixes — use hivemind_save_memory tagged "fix". Pass related_to=<old memory_id> if you have it — the server links old and new. The reason field is required and should explain the motivation, not just describe the change.`,
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
      description: `Save or recall which tests cover a function or module, including test case descriptions and coverage percentage.
action="save": fire after writing/updating tests to record coverage — NOT for code content (use hivemind_ingest_code); action="recall": fire BEFORE modifying a function to see what tests exist — NOT for general code history (use hivemind_why_code) or bug history (use hivemind_recall_bugs). Requires function_name; add file_path to narrow to one module. Coverage data is per-function/class granularity, not line-level.`,
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
      description: `Answer "why does this code exist / work this way?" by retrieving decisions, bug-fix rationale, and historical context associated with a file or function.
Fire BEFORE modifying unfamiliar code or when you need the rationale behind a design choice. NOT for active bug patterns (use hivemind_recall_bugs); NOT for test coverage (use hivemind_test_coverage action="recall"); NOT for file content snapshots (use hivemind_ingest_code recall or hivemind_at). Pass file_path and/or function_name to narrow retrieval; combine with hivemind_recall_bugs for full pre-change context. Returns decisions + fix memories ranked by relevance to the query.`,
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
      description: `Bi-temporal point-in-time snapshot: return memories exactly as HIVEMIND knew them at a given timestamp (contracts, prices, SOPs, code, decisions).
Use on temporal questions: "what did the contract say on Nov 1?", "what was the policy before the March update?". NOT for a delta between two dates — use hivemind_diff; NOT for one memory's full revision chain — use hivemind_timeline; NOT for a live semantic search — use hivemind_recall.
transaction_time = when the system LEARNED the fact (system clock); valid_time = when it was TRUE in the world (business date). Pass memory_query to filter the time-traveled set semantically.`,
      inputSchema: {
        type: 'object',
        properties: {
          transaction_time: { type: 'string', description: 'ISO timestamp — when the system learned the fact.' },
          valid_time: { type: 'string', description: 'ISO timestamp — when the fact was true in the world.' },
          memory_query: { type: 'string', description: 'Optional semantic filter on the time-traveled set (e.g. "supplier contract").' },
          file_path: { type: 'string', description: 'Optional file:<path> tag filter (code use).' },
          limit: { type: 'integer', description: 'Max memories to return (default 20, max 200).' },
          project: { type: 'string' },
          project_id: { type: 'string' },
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
          time_axis: { type: 'string', enum: ['event_time', 'valid_time', 'known_time'] },
        }
      }
    },
    {
      name: 'hivemind_diff',
      description: `Bi-temporal diff: return what changed between time_a and time_b across any set of memories (contracts, catalogs, SOPs, code decisions).
Use on "what changed between X and Y?" questions: vendor agreement evolution, policy additions, price deltas across catalog cycles. NOT for a single point-in-time snapshot — use hivemind_at; NOT for one memory's full version chain — use hivemind_timeline; NOT for a current search — use hivemind_recall. Narrow with tags (tag intersection) or file_path. Both time_a and time_b are required; use ISO timestamps.`,
      inputSchema: {
        type: 'object',
        properties: {
          time_a: { type: 'string', description: 'Earlier ISO timestamp' },
          time_b: { type: 'string', description: 'Later ISO timestamp' },
          file_path: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag intersection filter, e.g. ["contract","vendor"]' },
          memory_query: { type: 'string' }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
        },
        required: ['time_a', 'time_b']
      }
    },
    {
      name: 'hivemind_timeline',
      description: `Return the full version chain for a single memory — every revision with valid_from, valid_to, superseded_by, and reason. Use when the user wants the complete amendment/edit history of one specific item.
NOT for a point-in-time snapshot across many memories — use hivemind_at; NOT for a delta between two dates — use hivemind_diff; NOT for graph neighbours — use hivemind_traverse_graph. Identify the memory via memory_id (from recall) or via file_path tag (code use). Examples: "show every revision of the SolvisLea Pro datasheet", "contract amendment chain for vendor X".`,
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'Memory UUID — direct.' },
          file_path: { type: 'string', description: 'Or resolve via file:<path> tag (code use).' },
          memory_query: { type: 'string' }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
          time_axis: { type: 'string', enum: ['event_time', 'valid_time', 'known_time'], default: 'valid_time' },
        }
      }
    },
    {
      name: 'hivemind_code_at',
      description: 'ALIAS of hivemind_at — kept for back-compat. Prefer hivemind_at for new calls. Returns memories as HIVEMIND knew them at a given transaction_time or valid_time. Use hivemind_diff for deltas; hivemind_timeline for one memory\'s version chain.',
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
      description: 'ALIAS of hivemind_diff — kept for back-compat. Prefer hivemind_diff for new calls. Returns what changed between time_a and time_b. Use hivemind_at for point-in-time snapshots; hivemind_timeline for one memory\'s full revision chain.',
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
      description: 'ALIAS of hivemind_timeline — kept for back-compat. Prefer hivemind_timeline for new calls. Returns every revision of one memory. Use hivemind_at for point-in-time across many memories; hivemind_diff for cross-memory deltas.',
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

  // ── Web Intelligence tools (explicit scope-gated) ─────────
  if (hasWebSearch) tools.push({
    name: 'hivemind_web_search', description: 'Search the live public web asynchronously. Returns a job_id; poll hivemind_web_job_status.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, domains: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, required: ['query'] },
  });
  if (hasWebResearch) tools.push({
    name: 'hivemind_web_research', description: 'Run bounded, cited public-web research asynchronously. Returns a job_id; poll hivemind_web_job_status.',
    inputSchema: { type: 'object', properties: { input: { type: 'string' }, model: { type: 'string' }, citation_format: { type: 'string', enum: ['numbered', 'markdown'] } }, required: ['input'] },
  });
  if (hasWebCrawl) tools.push({
    name: 'hivemind_web_crawl', description: 'Crawl public URLs and extract page content asynchronously. Returns a job_id; poll hivemind_web_job_status.',
    inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, depth: { type: 'number' }, page_limit: { type: 'number' } }, required: ['urls'] },
  });
  if (hasAnyWeb) {
    tools.push({
      name: 'hivemind_web_job_status',
      description: `Poll the status and results of an async web search or crawl job started by hivemind_web_search or hivemind_web_crawl.
Use after submitting a web job — call every 3-5 seconds until status is "done" or "error". NOT for HIVEMIND memory operations — use hivemind_recall for those. Requires the job_id returned by the originating search/crawl call.`,
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job ID from search/crawl submission' }
        },
        required: ['job_id']
      }
    });
    tools.push({ name: 'hivemind_web_retry_job', description: 'Retry one failed tenant-scoped Web Intelligence job.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } });
    tools.push({ name: 'hivemind_web_save_result', description: 'Save a completed Web Intelligence result into HIVEMIND.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, result_index: { type: 'number' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['job_id'] } });
    tools.push({
      name: 'hivemind_web_usage',
      description: `Return current web intelligence quota and usage (searches used, crawl pages consumed, limits remaining). Use before submitting large web jobs to avoid hitting quota mid-task, or when a web job is rejected with a quota error. No parameters required.`,
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
      description: `Post a message to a Slack channel or reply in a thread, routed through HIVEMIND's policy gate (channel allowlist, rate limits, work-hours check). Use when a Digital Employee must broadcast or reply in Slack.
NOT for reading messages — use hivemind_slack_history or hivemind_slack_search; NOT for emoji reactions — use hivemind_slack_react. Requires channel (Slack channel ID, e.g. C01ABCDEF) and text (mrkdwn supported). Pass thread_ts to reply in-thread rather than posting to channel root.`,
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
      description: `Add an emoji reaction to a specific Slack message. Policy-gated like hivemind_slack_post. Use for lightweight acknowledgment or status signals without posting a full message.
NOT for posting text — use hivemind_slack_post. Requires channel ID, message timestamp (ts), and emoji name without colons (e.g. "thumbsup"). The ts comes from a Slack event or hivemind_slack_history result.`,
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
      description: `Full-text search across the connected Slack workspace and return matching messages with metadata. Read-only.
Use when you need to find specific past messages by keyword or topic. NOT for reading recent channel history — use hivemind_slack_history for that; NOT for posting — use hivemind_slack_post. Supports Slack search syntax (e.g. "from:user", "in:#channel"). Returns up to count results (default 10, max 50).`,
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
      description: `Fetch the most recent messages from a specific Slack channel in chronological order. Read-only.
Use when you need what was posted in a known channel recently (e.g. monitoring a support channel, checking standup posts). NOT for keyword search across workspace — use hivemind_slack_search; NOT for posting — use hivemind_slack_post. Requires channel ID; pass since (ISO timestamp) to bound the look-back window. Limit defaults to 50, max 200.`,
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
           - project_id: pass ONLY when the user explicitly names a
                         project. Otherwise OMIT — the server now
                         AUTO-CLASSIFIES the best-fitting project from
                         each project's name+description and files it
                         there when confident; it falls back to personal/
                         org-wide when ambiguous. You do NOT need to call
                         hivemind_list_projects before every save.
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
hivemind_list_projects   { query? }   ← call when user names a project you don't recognise; NOT required before every save (server auto-classifies)

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
        // Canonical front door: MCP save_memory (and chat autosave, which calls
        // this same tool) routes through POST /api/ingest/source as an ATOMIC
        // ingest. Provenance is normalized to source:mcp; the engine still owns
        // supersession (relationship carries {type,target_id}) + entity/edge
        // creation via the smart router — ingestSource atomic does NOT skip it,
        // so behaviour matches the old sync /api/memories path. Identity flows
        // through the X-HM-User-Id/Org-Id headers apiClient already sets, so the
        // endpoint resolves the correct principal (no body user_id/org_id).
        const _proj = SCOPE_FIELDS.project_id
          || (autoAttachedProjectId && !resolvedProjectId ? autoAttachedProjectId : null);
        const _projIds = SCOPE_FIELDS.project_ids
          || (autoAttachedProjectId && !resolvedProjectId ? [autoAttachedProjectId] : undefined);
        const ingestResp = await apiClient.post('/api/ingest/source', {
          mode: 'atomic',
          title,
          content,
          source: { type: 'mcp', source_id: 'mcp' },
          tags: normalizeTags(args.tags),
          ...(_proj ? { scope: 'project', project_id: _proj } : {}),
          ...(SCOPE_FIELDS.primary_team_id ? { primary_team_id: SCOPE_FIELDS.primary_team_id } : {}),
          relationship,
          metadata: {
            memory_type: args.source_type === 'decision' ? 'decision' : 'fact',
            source_type: args.source_type || 'text',
            project: normalizeMemoryText(args.project, null) || null,
            ...(_projIds ? { project_ids: _projIds } : {}),
          },
        });
        const newId = ingestResp.memoryId || (Array.isArray(ingestResp.memoryIds) ? ingestResp.memoryIds[0] : null);
        const saveResp = {
          saved: ingestResp.ok === true && !!newId,
          id: newId,
          memory_id: newId,
          operation: ingestResp.operation || 'created',
          skipped: ingestResp.skipped || false,
        };
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

      case 'hivemind_chat_context':
        {
          const requestedMode = ['fact', 'explain', 'full'].includes(args.mode) ? args.mode : 'fact';
          const recallArgs = {
            query_context: args.query,
            mode: requestedMode,
            explicit_mode: true,
            include_live: args.include_live === true,
            ...(resolvedProjectId ? { project_id: resolvedProjectId, project_ids: resolvedProjectIds } : {}),
            ...(args.source_document_id ? { source_document_id: args.source_document_id } : {}),
            ...(args.source_title ? { source_title: args.source_title } : {}),
          };
          let result = await apiClient.post('/api/recall', recallArgs);

          // Use returned provenance, not query wording, to decide whether the
          // fact-only packet needs bounded source evidence. Never infer full.
          const hasDocumentAnchor = (result.memories || []).some((memory) => {
            const tags = memory?.tags || [];
            return tags.some((tag) => typeof tag === 'string' && (
              tag.startsWith('filename:') || tag.startsWith('doc-id:') || tag.startsWith('doc-hash:')
            )) || !!memory?.source_metadata?.document_id;
          });
          if (requestedMode === 'fact' && !(result.evidence || []).length && hasDocumentAnchor) {
            result = await apiClient.post('/api/recall', { ...recallArgs, mode: 'explain' });
          }

          return formatToolContent({
            mode_used: result.mode_used || requestedMode,
            context: result.evidence_packet || {
              facts: result.memories || [],
              sourceSections: result.evidence || [],
              liveEvidence: result.live || [],
              citations: [],
              coverage: {},
              cutoff_reason: result.cutoff_reason || null,
            },
            latency_ms: result.latency_ms || null,
          });
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
        // Only send fields the caller actually provided (an undefined field must
        // not overwrite the stored value with null on the partial-update schema).
        const patchFields = {};
        if (args.title !== undefined) patchFields.title = args.title;
        if (args.content !== undefined) patchFields.content = args.content;
        if (args.tags !== undefined) patchFields.tags = args.tags;

        const putTo = (id) => apiClient.put(`/api/memories/${id}`, {
          ...patchFields, user_id: userId, org_id: orgId,
        });

        // A natural-language edit ("change the launch day to next year") frequently
        // reaches us with a missing or stale memory_id — the model never had it, or
        // recall handed back an id the caller can SEE but does not OWN (PUT is
        // owner-scoped, recall is org/shared-scoped). Instead of throwing a bare
        // operation_failed, resolve the target by recalling the caller's own
        // memories with the edit text as the query, then update that.
        const resolveTargetId = async () => {
          const q = args.match || args.query || args.content || args.title;
          if (!q) return null;
          try {
            const r = await apiClient.post('/api/recall', {
              query_context: String(q), max_memories: 5, mode: 'quick',
            });
            return (r?.memories || []).find((m) => m && m.id)?.id || null;
          } catch { return null; }
        };

        let targetId = args.memory_id || null;
        let resolvedBy = targetId ? 'id' : null;
        let updRes = null;
        if (targetId) {
          try {
            updRes = await putTo(targetId);
          } catch (e) {
            // 403/404 on the supplied id → not found or not owned; fall through to
            // resolve-by-search. Any other error is genuine → let it surface + log.
            if (!/failed with 40[34]/.test(e?.message || '')) throw e;
            targetId = null;
          }
        }
        if (!updRes) {
          const resolved = await resolveTargetId();
          if (!resolved) {
            return formatToolContent({
              success: false,
              error: 'Could not determine which memory to update. Pass memory_id, or describe the memory (its subject) so it can be found among your memories.',
            });
          }
          targetId = resolved;
          resolvedBy = 'search';
          updRes = await putTo(targetId); // genuine failure here logs + surfaces
        }
        return formatToolContent({
          success: updRes?.success !== false,
          resolved_by: resolvedBy,
          memory_id: targetId,
          memory: updRes?.memory ? polishMemory(updRes.memory) : undefined,
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

      case 'hivemind_web_research': {
        const res = await apiClient.post('/api/web/research/jobs', {
          input: args.input,
          model: args.model || 'auto',
          citation_format: args.citation_format || 'numbered',
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

      case 'hivemind_web_retry_job': {
        const res = await apiClient.post(`/api/web/jobs/${args.job_id}/retry`, {});
        return formatToolContent(res);
      }

      case 'hivemind_web_save_result': {
        const res = await apiClient.post(`/api/web/jobs/${args.job_id}/save-to-memory`, {
          resultIndex: args.result_index,
          title: args.title,
          tags: args.tags,
        });
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
        const txTime = args.transaction_time || null;
        const validTime = args.valid_time || null;
        const query = args.memory_query || args.file_path || 'workspace memory';
        const atLimit = Math.max(1, Math.min(200, Number(args.limit) || 20));
        const res = await apiClient.post('/api/recall', {
          query_context: query,
          mode: 'explain',
          ...hostedRetrievalFilters(args),
          time: {
            ...(txTime ? { known_at: txTime } : {}),
            ...(validTime ? { valid_at: validTime } : {}),
          },
          ...(args.file_path ? { tags: [`file:${args.file_path}`] } : {}),
          limit: atLimit,
          project_id: args.project_id || null,
        });
        // Cap the response. An as-of query legitimately matches everything whose
        // validity window covers that instant, which on a real corpus is hundreds
        // of full memory rows — measured 443 memories / 3.1MB, enough to blow up
        // the calling agent's context and make the tool unusable in practice. The
        // documented contract is a default of 20.
        const polished = polishMemories(res.memories || []).slice(0, atLimit);
        const hint = (polished.length === 0 && txTime)
          ? `No memories exist at transaction_time=${txTime}${args.file_path ? ` for file ${args.file_path}` : ''}. The system may not have learned anything by that time, or the file did not yet exist. Try a later timestamp or omit the filter.`
          : null;
        return formatToolContent({
          query: { text: query, transaction_time: txTime, valid_time: validTime },
          count: polished.length,
          memories: polished,
          evidence: res.evidence || [],
          evidence_packet: res.evidence_packet || null,
          cutoff_reason: res.cutoff_reason || null,
          ...(hint ? { hint } : {})
        });
      }

      case 'hivemind_diff':
      case 'hivemind_code_diff': {
        if (!args.time_a || !args.time_b) {
          throw new Error('hivemind_code_diff requires time_a and time_b');
        }
        const from = new Date(args.time_a);
        const to = new Date(args.time_b);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
          throw new Error('hivemind_diff requires valid time_a/time_b with time_a before time_b');
        }
        const tags = [...(Array.isArray(args.tags) ? args.tags : []), ...(args.file_path ? [`file:${args.file_path}`] : [])];
        const query = args.memory_query || args.file_path || tags.join(' ') || 'workspace changes';
        const recallAt = (value) => apiClient.post('/api/recall', {
          query_context: query,
          mode: 'explain',
          ...hostedRetrievalFilters(args),
          time: { valid_at: value.toISOString() },
          ...(tags.length ? { tags } : {}),
        });
        const [a, b] = await Promise.all([recallAt(from), recallAt(to)]);
        const fromIds = new Set((a.memories || []).map((memory) => memory.id));
        const toIds = new Set((b.memories || []).map((memory) => memory.id));
        const added = (b.memories || []).filter((memory) => !fromIds.has(memory.id));
        const removed = (a.memories || []).filter((memory) => !toIds.has(memory.id));
        const persisted = (b.memories || []).filter((memory) => fromIds.has(memory.id));
        const changedIds = new Set([...added, ...removed].map((memory) => memory.id));
        const edges = [...(a.evidence_packet?.graphEvidence || []), ...(b.evidence_packet?.graphEvidence || [])];
        const seenEdges = new Set();
        const changes = edges.filter((edge) => {
          const type = String(edge.type || '').toLowerCase();
          const key = `${edge.from_id}|${edge.to_id}|${type}`;
          if (!['updates', 'contradicts'].includes(type) || seenEdges.has(key)) return false;
          if (!changedIds.has(edge.from_id) && !changedIds.has(edge.to_id)) return false;
          seenEdges.add(key);
          return true;
        });
        return formatToolContent({ query, from_date: args.time_a, to_date: args.time_b, added, removed, persisted, changes, from: a, to: b });
      }

      case 'hivemind_timeline':
      case 'hivemind_code_timeline': {
        if (!args.memory_id && !args.file_path) {
          throw new Error('hivemind_code_timeline requires memory_id or a resolvable file_path');
        }
        const query = args.memory_query || args.file_path || args.memory_id;
        const res = await apiClient.post('/api/recall', {
          query_context: query,
          mode: 'explain',
          ...hostedRetrievalFilters(args),
          operation: 'timeline',
          include_superseded: true,
          ...(args.file_path ? { tags: [`file:${args.file_path}`] } : {}),
        });
        return formatToolContent({ query, timeline: res.memories || [], evidence_packet: res.evidence_packet || null, cutoff_reason: res.cutoff_reason || null });
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
