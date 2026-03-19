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
    || 'https://hivemind.davinciai.eu:8050',
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
    tools: generateToolsManifest(userId, orgId),

    // Available Resources
    resources: generateResourcesManifest(userId, orgId),

    // Available Prompts
    prompts: generatePromptsManifest(userId, orgId),

    // Client Configuration for Claude Desktop/Cursor/Antigravity/VS Code
    clientConfig: generateClientConfig(userId, orgId, connectionToken),
    ingestion: generateIngestionConfig(userId, orgId)
  };

  // Track connection
  void trackConnection(userId, serverConfig);

  return serverConfig;
}

/**
 * Generate MCP tools manifest for HIVE-MIND capabilities
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @returns {Array} MCP tools manifest
 */
function generateToolsManifest(userId, orgId) {
  return [
    {
      name: 'hivemind_save_memory',
      description: 'Save information to HIVE-MIND persistent memory. Use this to store important facts, code snippets, decisions, or context that should be remembered across conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short, descriptive title for the memory'
          },
          content: {
            type: 'string',
            description: 'The content to remember - can be text, code, conversation summary, etc.'
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
            description: 'Tags for categorizing the memory (e.g., ["react", "api-design", "bug-fix"])'
          },
          project: {
            type: 'string',
            description: 'Project or domain this memory belongs to'
          },
          relationship: {
            type: 'string',
            enum: ['update', 'extend', 'derive'],
            description: 'How this relates to existing memories: update (replaces old), extend (adds to), derive (infers from)'
          },
          related_to: {
            type: 'string',
            description: 'Memory ID this relates to (for update/extend/derive relationships)'
          }
        },
        required: ['title', 'content']
      }
    },
    {
      name: 'hivemind_recall',
      description: 'Search and retrieve relevant memories from HIVE-MIND. Use this to find previously stored information, code patterns, or context from past conversations.',
      inputSchema: {
        type: 'object',
        properties: {
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
          source_type: {
            type: 'string',
            enum: ['text', 'code', 'conversation', 'documentation', 'decision'],
            description: 'Filter by content type'
          },
          mode: {
            type: 'string',
            enum: ['quick', 'panorama', 'insight'],
            description: 'Search mode: quick (fast semantic), panorama (temporal/historical), insight (AI-powered sub-queries)'
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
          project: {
            type: 'string',
            description: 'Filter by project'
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
    }
  ];
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
      description: 'Inject relevant memories into the conversation context',
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
    tools: generateToolsManifest(userId, connection.orgId),
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
export function handleInitialize(params, userId) {
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
    }
  };
}

/**
 * Handle tools/list request
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @returns {Object} Tools list result
 */
export function handleToolsList(userId, orgId) {
  return {
    tools: generateToolsManifest(userId, orgId)
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
  return {
    description: `Prompt '${params?.name || 'unknown'}' from HIVE-MIND`,
    messages: [{
      role: 'assistant',
      content: {
        type: 'text',
        text: JSON.stringify({
          message: 'Direct prompt generation is not implemented yet.',
          user_id: userId,
          org_id: orgId,
          args: params?.arguments || {}
        }, null, 2)
      }
    }]
  };
}

export function createHostedApiClient({ baseUrl, apiKey, userId, orgId }) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

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
        'X-User-Id': userId,
        'X-Org-Id': orgId
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed with ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  }

  return {
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

/**
 * Handle tools/call request
 * @param {Object} params - Tool call parameters
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {Object} apiClient - API client for making requests
 * @returns {Promise<Object>} Tool call result
 */
export async function handleToolCall(params, userId, orgId, apiClient) {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case 'hivemind_save_memory':
        return formatToolContent(await apiClient.post('/api/memories', {
          title: args.title,
          content: args.content,
          memory_type: args.source_type === 'decision' ? 'decision' : 'fact',
          source_platform: 'mcp',
          tags: args.tags || [],
          project: args.project || null,
          metadata: {
            relationship: args.relationship || null,
            related_to: args.related_to || null,
            source_type: args.source_type || 'text'
          },
          user_id: userId,
          org_id: orgId
        }));

      case 'hivemind_recall':
        if (args.mode === 'panorama') {
          return formatToolContent(await apiClient.post('/api/search/panorama', {
            query: args.query,
            limit: args.limit || 5
          }));
        }
        if (args.mode === 'insight') {
          return formatToolContent(await apiClient.post('/api/search/insight', {
            query: args.query,
            limit: args.limit || 5
          }));
        }
        return formatToolContent(await apiClient.post('/api/search/quick', {
          query: args.query,
          tags: args.tags,
          project: args.project,
          source_platform: args.source_type,
          limit: args.limit || 5
        }));

      case 'hivemind_get_memory':
        return formatToolContent(await apiClient.get(`/api/memories/${args.memory_id}`));

      case 'hivemind_list_memories': {
        // Build params object with only defined values
        const listParams = {
          limit: args.limit || 10,
          offset: Math.max(((args.page || 1) - 1) * (args.limit || 10), 0)
        };
        if (args.project) listParams.project = args.project;
        if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) listParams.tags = args.tags.join(',');
        if (args.source_type === 'decision') listParams.memory_type = 'decision';

        return formatToolContent(await apiClient.get('/api/memories', { params: listParams }));
      }

      case 'hivemind_update_memory':
        return formatToolContent(await apiClient.put(`/api/memories/${args.memory_id}`, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          user_id: userId,
          org_id: orgId
        }));

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
          org_id: orgId
        }));

      case 'hivemind_traverse_graph':
        return formatToolContent(await apiClient.post('/api/memories/traverse', {
          start_id: args.memory_id,
          depth: args.depth || 2,
          relationship_types: relationshipTypeToGraphTypes(args.relationship || 'all')
        }));

      case 'hivemind_query_with_ai':
        return formatToolContent(await apiClient.post('/api/search/insight', {
          query: args.question,
          limit: args.context_limit || 5
        }));

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
          result = handleToolsList(userId, req.headers['x-org-id']);
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
