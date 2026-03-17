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

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  baseUrl: process.env.HIVEMIND_BASE_URL || 'https://hivemind.davinciai.eu:8050',
  apiVersion: '2024-11-05',
  protocolVersion: '2024-11-05',
  serverName: 'hivemind-hosted-mcp',
  serverVersion: '2.0.0',
  maxToolsPerRequest: 64,
  maxConnectionsPerUser: 10
};

// In-memory connection tracking (production: use Redis)
const userConnections = new Map();

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
  const connectionToken = generateConnectionToken(userId, orgId, serverId, apiKey);

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
      baseUrl: CONFIG.baseUrl,
      endpoints: {
        // SSE endpoint for real-time updates
        sse: `${CONFIG.baseUrl}/api/mcp/servers/${userId}/sse?token=${connectionToken}`,
        // Message endpoint for tool calls
        message: `${CONFIG.baseUrl}/api/mcp/servers/${userId}/message?token=${connectionToken}`,
        // JSON-RPC endpoint for stdio bridge
        jsonrpc: `${CONFIG.baseUrl}/api/mcp/servers/${userId}/rpc?token=${connectionToken}`
      },
      token: connectionToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
    },

    // Available Tools (HIVE-MIND capabilities exposed as MCP tools)
    tools: generateToolsManifest(userId, orgId),

    // Available Resources
    resources: generateResourcesManifest(userId, orgId),

    // Available Prompts
    prompts: generatePromptsManifest(userId, orgId),

    // Client Configuration for Claude Desktop/Cursor
    clientConfig: generateClientConfig(userId, orgId, connectionToken)
  };

  // Track connection
  trackConnection(userId, serverConfig);

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
function generateClientConfig(userId, orgId, token) {
  return {
    // Claude Desktop configuration
    claudeDesktop: {
      command: 'npx',
      args: ['-y', '@hivemind/mcp-bridge', 'hosted'],
      env: {
        HIVEMIND_HOSTED_URL: `${CONFIG.baseUrl}/api/mcp/servers/${userId}`,
        HIVEMIND_CONNECTION_TOKEN: token,
        HIVEMIND_USER_ID: userId,
        HIVEMIND_ORG_ID: orgId
      }
    },

    // Cursor configuration
    cursor: {
      mcpServers: {
        hivemind: {
          command: 'npx',
          args: ['-y', '@hivemind/mcp-bridge', 'hosted'],
          env: {
            HIVEMIND_HOSTED_URL: `${CONFIG.baseUrl}/api/mcp/servers/${userId}`,
            HIVEMIND_CONNECTION_TOKEN: token,
            HIVEMIND_USER_ID: userId,
            HIVEMIND_ORG_ID: orgId
          }
        }
      }
    },

    // Direct HTTP configuration (for advanced users)
    http: {
      endpoint: `${CONFIG.baseUrl}/api/mcp/servers/${userId}/rpc`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-User-Id': userId,
        'X-Org-Id': orgId
      }
    },

    // Simple URL for copy-paste
    simpleUrl: `${CONFIG.baseUrl}/api/mcp/servers/${userId}?token=${token}`
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
function generateConnectionToken(userId, orgId, serverId, apiKey) {
  const timestamp = Date.now();
  const data = `${userId}:${orgId}:${serverId}:${timestamp}:${apiKey}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 48);
}

/**
 * Validate connection token
 * @param {string} token - Token to validate
 * @param {string} userId - Expected user ID
 * @returns {boolean} Validation result
 */
export function validateConnectionToken(token, userId) {
  const connections = userConnections.get(userId);
  if (!connections) return false;

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
function trackConnection(userId, serverConfig) {
  const connections = userConnections.get(userId) || [];

  // Remove expired connections
  const now = new Date();
  const validConnections = connections.filter(c =>
    new Date(c.expiresAt) > now && !c.revoked
  );

  // Add new connection
  validConnections.push({
    serverId: serverConfig.connection.serverId,
    token: serverConfig.connection.token,
    createdAt: new Date().toISOString(),
    expiresAt: serverConfig.connection.expiresAt,
    revoked: false,
    endpoints: serverConfig.connection.endpoints
  });

  userConnections.set(userId, validConnections);
}

/**
 * Revoke all connections for a user
 * @param {string} userId - User ID
 */
export function revokeAllConnections(userId) {
  const connections = userConnections.get(userId);
  if (connections) {
    connections.forEach(c => c.revoked = true);
  }
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
        return await apiClient.post('/api/integrations/webapp/store', {
          title: args.title,
          content: args.content,
          source_type: args.source_type || 'text',
          tags: args.tags || [],
          project: args.project,
          relationship: args.relationship,
          related_to: args.related_to,
          user_id: userId,
          org_id: orgId
        });

      case 'hivemind_recall':
        return await apiClient.post('/api/integrations/webapp/prepare', {
          query: args.query,
          max_memories: args.limit || 5,
          tags: args.tags,
          project: args.project,
          source_platforms: args.source_type ? [args.source_type] : [],
          user_id: userId,
          org_id: orgId
        });

      case 'hivemind_get_memory':
        return await apiClient.get(`/api/memories/${args.memory_id}`, {
          headers: { 'X-User-Id': userId, 'X-Org-Id': orgId }
        });

      case 'hivemind_list_memories':
        return await apiClient.get('/api/memories', {
          params: {
            user_id: userId,
            org_id: orgId,
            project: args.project,
            tags: args.tags?.join(','),
            source_type: args.source_type,
            limit: args.limit || 10,
            page: args.page || 1
          }
        });

      case 'hivemind_update_memory':
        return await apiClient.put(`/api/memories/${args.memory_id}`, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          user_id: userId,
          org_id: orgId
        });

      case 'hivemind_delete_memory':
        return await apiClient.delete(`/api/memories/${args.memory_id}`, {
          data: { reason: args.reason, user_id: userId, org_id: orgId }
        });

      case 'hivemind_save_conversation':
        return await apiClient.post('/api/integrations/webapp/store', {
          title: args.title,
          content: JSON.stringify(args.messages),
          source_type: 'conversation',
          tags: [...(args.tags || []), 'conversation', args.platform || 'unknown'],
          project: args.project,
          user_id: userId,
          org_id: orgId
        });

      case 'hivemind_traverse_graph':
        return await apiClient.post('/api/memories/traverse', {
          memory_id: args.memory_id,
          relationship: args.relationship || 'all',
          depth: args.depth || 2,
          user_id: userId,
          org_id: orgId
        });

      case 'hivemind_query_with_ai':
        return await apiClient.post('/api/query', {
          question: args.question,
          context_limit: args.context_limit || 5,
          user_id: userId,
          org_id: orgId
        });

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Error executing ${name}: ${error.message}`
      }]
    };
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
    if (!validateConnectionToken(token, userId)) {
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

    if (!validateConnectionToken(token, userId)) {
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

    revokeAllConnections(userId);
    res.json({ success: true, message: 'All MCP connections revoked' });
  });
}

// ==========================================
// Export
// ==========================================

export default {
  generateHostedServer,
  validateConnectionToken,
  revokeAllConnections,
  handleInitialize,
  handleToolsList,
  handleToolCall,
  setupHostedMcpRoutes
};
