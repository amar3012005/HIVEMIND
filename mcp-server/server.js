/**
 * HIVE-MIND MCP Server
 *
 * Model Context Protocol server for cross-platform memory access
 * Provides tools and resources for Claude Desktop, Cursor IDE, and other MCP clients
 * 
 * Features:
 * - 8 Memory Tools: save_memory, recall, list_memories, get_memory, delete_memory, get_context, search_memories, traverse_graph
 * - 5 Resource URIs: memories://recent, memories://favorites, memories://all, context://current, context://summary
 * - 2 Prompt Templates: memory-summary, context-injection
 * - Meta-MCP Bridge Integration: Cross-app context synchronization
 * - Real-time Sync: WebSocket/SSE for Cursor ↔ Claude ↔ ChatGPT synchronization
 *
 * @module mcp-server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { createSafeLogger } from './safe-logger.js';

// Meta-MCP Bridge Integration
import { getBridge, getEndpoint } from '../core/src/mcp/bridge.js';
import { getSyncServer, getSyncQueue, getProtocol } from '../core/src/mcp/sync.js';

// Session Management Tools
import { saveSessionTool, handleSaveSession } from './tools/save-session.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  serverName: 'hivemind-mcp',
  serverVersion: '1.0.0',
  defaultUserId: process.env.CURRENT_USER_ID || 'anonymous',
  apiBaseUrl: process.env.HIVEMIND_API_URL || 'http://localhost:3000',
  apiKey: process.env.HIVEMIND_API_KEY || process.env.QDRANT_API_KEY || 'dev_api_key_hivemind_2026',
  defaultRecallProject: process.env.HIVEMIND_DEFAULT_RECALL_PROJECT || null,
  defaultRecallSources: (process.env.HIVEMIND_DEFAULT_RECALL_SOURCES || 'session,mcp').split(',').map(item => item.trim()).filter(Boolean),
  defaultRecallTags: (process.env.HIVEMIND_DEFAULT_RECALL_TAGS || '').split(',').map(item => item.trim()).filter(Boolean)
};

// Logger
const logger = createSafeLogger('MCP');

// ==========================================
// Meta-MCP Bridge Integration
// ==========================================

// Initialize bridge for endpoint management
const bridge = getBridge();

// Initialize sync server for cross-app synchronization
const syncServer = getSyncServer();
const syncQueue = getSyncQueue();
const protocol = getProtocol();

// Register this server as a client for sync
const serverClientId = `mcp-server-${uuidv4()}`;
syncServer.registerClient(serverClientId, CONFIG.defaultUserId, 'mcp-server', {
  send: (data) => {
    // In production, this would send to WebSocket/SSE
    logger.debug('Sync payload queued for MCP server', data);
  }
});

// ==========================================
// Tool Definitions
// ==========================================

const TOOLS = {
  save_memory: {
    name: 'save_memory',
    description: 'Save information to persistent cross-platform memory. Use this when the user shares important facts, preferences, decisions, or context they want remembered.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to remember (required, 1-10000 characters)'
        },
        memoryType: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'],
          description: 'Type of memory (default: fact)'
        },
        title: {
          type: 'string',
          description: 'Short descriptive title for the memory'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization'
        },
        importanceScore: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance score 0-1 (default: 0.5)'
        }
      },
      required: ['content']
    }
  },

  recall: {
    name: 'recall',
    description: 'Search and retrieve relevant memories using natural language queries. Returns memories ranked by semantic similarity, recency, and importance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query (required)'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum results to return'
        },
        memoryTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by memory types'
        },
        recencyBias: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description: 'Weight for recency in scoring (0=ignore, 1=only recency)'
        }
      },
      required: ['query']
    }
  },

  list_memories: {
    name: 'list_memories',
    description: 'List all memories with optional filtering by type, tags, or source platform.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Number of memories to return'
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Pagination offset'
        },
        memoryType: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'],
          description: 'Filter by memory type'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags'
        },
        sourcePlatform: {
          type: 'string',
          description: 'Filter by source platform (chatgpt, claude, etc.)'
        }
      }
    }
  },

  get_memory: {
    name: 'get_memory',
    description: 'Get a specific memory by ID with its relationships and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the memory to retrieve'
        },
        includeRelationships: {
          type: 'boolean',
          default: true,
          description: 'Include related memories'
        }
      },
      required: ['memoryId']
    }
  },

  delete_memory: {
    name: 'delete_memory',
    description: 'Delete a memory by ID (soft delete for GDPR compliance).',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          format: 'uuid',
          description: 'ID of memory to delete'
        }
      },
      required: ['memoryId']
    }
  },

  get_context: {
    name: 'get_context',
    description: 'Get all relevant context for the current conversation. Automatically retrieves memories based on conversation topic and user history.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic to filter context'
        },
        format: {
          type: 'string',
          enum: ['xml', 'json', 'markdown'],
          default: 'xml',
          description: 'Output format for context'
        }
      }
    }
  },

  search_memories: {
    name: 'search_memories',
    description: 'Advanced hybrid search combining vector similarity, keyword matching, and graph traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        filters: {
          type: 'object',
          properties: {
            memoryTypes: { type: 'array', items: { type: 'string' } },
            sourcePlatform: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            dateFrom: { type: 'string', format: 'date-time' },
            dateTo: { type: 'string', format: 'date-time' }
          }
        },
        weights: {
          type: 'object',
          properties: {
            similarity: { type: 'number', default: 0.5 },
            recency: { type: 'number', default: 0.3 },
            importance: { type: 'number', default: 0.2 }
          }
        },
        nResults: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 50
        }
      },
      required: ['query']
    }
  },

  traverse_graph: {
    name: 'traverse_graph',
    description: 'Traverse the memory graph from a starting memory to find related memories through Updates, Extends, or Derives relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        startId: {
          type: 'string',
          format: 'uuid',
          description: 'Starting memory ID'
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          default: 3,
          description: 'Traversal depth'
        },
        relationshipTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['Updates', 'Extends', 'Derives']
          },
          description: 'Relationship types to follow'
        }
      },
      required: ['startId']
    }
  },

  save_session: {
    name: 'save_session',
    description: 'Save a complete chat session as a memory with automatic summarization. Captures decisions, action items, and key context from conversations across AI platforms.',
    inputSchema: saveSessionTool.inputSchema
  },

  register_connector: {
    name: 'register_connector',
    description: 'Register an external MCP connector endpoint in HIVE-MIND so it can ingest data from systems like Linear, Gmail, or repo/code MCP servers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        adapterType: { type: 'string', enum: ['gmail', 'repository_code', 'chat_session', 'linear'] },
        transport: { type: 'string', enum: ['stdio', 'streamable-http', 'http', 'sse'] },
        url: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        defaultProject: { type: 'string' },
        defaultTags: { type: 'array', items: { type: 'string' } }
      },
      required: ['name', 'adapterType']
    }
  },

  inspect_connector: {
    name: 'inspect_connector',
    description: 'Inspect a registered external MCP connector and list its available tools, resources, and prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    }
  },

  ingest_connector: {
    name: 'ingest_connector',
    description: 'Invoke a registered external MCP connector and ingest its output into HIVE-MIND through the async pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointName: { type: 'string' },
        operationType: { type: 'string', enum: ['tool', 'resource'] },
        operationName: { type: 'string' },
        uri: { type: 'string' },
        operationArguments: { type: 'object' },
        project: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['endpointName', 'operationType']
    }
  }
};

// ==========================================
// Resource Definitions
// ==========================================

const RESOURCES = {
  'memories://recent': {
    uri: 'memories://recent',
    name: 'Recent Memories',
    description: 'Most recently accessed or updated memories',
    mimeType: 'application/json'
  },
  'memories://favorites': {
    uri: 'memories://favorites',
    name: 'Favorite Memories',
    description: 'High-importance memories (score >= 0.8)',
    mimeType: 'application/json'
  },
  'memories://all': {
    uri: 'memories://all',
    name: 'All Memories',
    description: 'Complete memory collection',
    mimeType: 'application/json'
  },
  'context://current': {
    uri: 'context://current',
    name: 'Current Context',
    description: 'Active conversation context in XML format',
    mimeType: 'application/xml'
  },
  'context://summary': {
    uri: 'context://summary',
    name: 'Context Summary',
    description: 'Summary of user context and preferences',
    mimeType: 'text/markdown'
  }
};

// ==========================================
// Prompt Templates
// ==========================================

const PROMPTS = {
  'memory-summary': {
    name: 'memory-summary',
    description: 'Generate a summary of all memories for a topic',
    arguments: [
      {
        name: 'topic',
        description: 'Topic to summarize',
        required: true
      }
    ]
  },
  'context-injection': {
    name: 'context-injection',
    description: 'Inject relevant context into a conversation',
    arguments: [
      {
        name: 'conversationId',
        description: 'Conversation identifier',
        required: false
      }
    ]
  }
};

// ==========================================
// MCP Server Initialization
// ==========================================

const server = new Server(
  {
    name: CONFIG.serverName,
    version: CONFIG.serverVersion
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  }
);

// ==========================================
// Request Handlers
// ==========================================

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.info('Listing tools');
  return {
    tools: Object.values(TOOLS)
  };
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  logger.info('Listing resources');
  return {
    resources: Object.values(RESOURCES)
  };
});

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  logger.info('Listing prompts');
  return {
    prompts: Object.values(PROMPTS)
  };
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  logger.info('Reading resource', { uri });

  try {
    switch (uri) {
      case 'memories://recent': {
        const memories = await apiCall('GET', '/api/memories', { limit: 10 });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(memories, null, 2)
            }
          ]
        };
      }

      case 'memories://favorites': {
        const memories = await apiCall('GET', '/api/memories', { 
          limit: 20,
          minImportance: 0.8
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(memories, null, 2)
            }
          ]
        };
      }

      case 'memories://all': {
        const memories = await apiCall('GET', '/api/memories', { limit: 100 });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(memories, null, 2)
            }
          ]
        };
      }

      case 'context://current': {
        const context = await injectContext({ format: 'xml' });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/xml',
              text: context.formatted
            }
          ]
        };
      }

      case 'context://summary': {
        const context = await injectContext({ format: 'markdown' });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: context.formatted
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  } catch (error) {
    logger.error('Resource read failed', { uri, error: error.message });
    throw error;
  }
});

// Get prompt template
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  logger.info('Getting prompt', { name });

  switch (name) {
    case 'memory-summary':
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please provide a comprehensive summary of all memories related to: ${args?.topic || 'general'}`
            }
          }
        ]
      };

    case 'context-injection':
      const context = await injectContext({ format: 'xml' });
      return {
        messages: [
          {
            role: 'system',
            content: {
              type: 'text',
              text: `Here is the relevant context for this conversation:\n\n${context.formatted}`
            }
          }
        ]
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = uuidv4();

  logger.info('Tool called', { name, requestId });

  try {
    switch (name) {
      case 'save_memory':
        return await handleSaveMemory(args, requestId);

      case 'recall':
        return await handleRecall(args, requestId);

      case 'list_memories':
        return await handleListMemories(args, requestId);

      case 'get_memory':
        return await handleGetMemory(args, requestId);

      case 'delete_memory':
        return await handleDeleteMemory(args, requestId);

      case 'get_context':
        return await handleGetContext(args, requestId);

      case 'search_memories':
        return await handleSearchMemories(args, requestId);

      case 'traverse_graph':
        return await handleTraverseGraph(args, requestId);

      case 'save_session':
        return await handleSaveSession(args, requestId, apiCall, logger);

      case 'register_connector':
        return await handleRegisterConnector(args, requestId);

      case 'inspect_connector':
        return await handleInspectConnector(args, requestId);

      case 'ingest_connector':
        return await handleIngestConnector(args, requestId);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error('Tool execution failed', { name, requestId, error: error.message });
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

// ==========================================
// Tool Implementations
// ==========================================

async function handleSaveMemory(args, requestId) {
  const { content, memoryType = 'fact', title, tags = [], importanceScore = 0.5, project } = args;

  // Validate content length
  if (!content || content.length < 1 || content.length > 10000) {
    throw new Error('Content must be between 1 and 10000 characters');
  }

  // Build minimal payload - only send what API expects
  const payload = {
    content,
    tags,
    project: project || 'mcp-sessions'
  };

  // Only add optional fields if they have values
  if (importanceScore && typeof importanceScore === 'number') {
    payload.importance_score = importanceScore;
  }

  const response = await apiCall('POST', '/api/memories', payload);
  const memory = response.memory || response;

  logger.info('Memory saved', { requestId, memoryId: memory?.id });

  return {
    content: [
      {
        type: 'text',
        text: `✅ Memory saved successfully!\n\nID: \`${memory?.id || 'unknown'}\`\nType: ${memoryType}\n${title ? `Title: ${title}\n` : ''}`
      }
    ]
  };
}

async function handleRecall(args, requestId) {
  const { query, limit = 10, memoryTypes, recencyBias = 0.5 } = args;

  if (!query || query.length < 1) {
    throw new Error('Query is required');
  }

  const results = await apiCall('POST', '/api/recall', {
    query_context: query,
    max_memories: limit,
    memory_types: memoryTypes,
    recency_bias: recencyBias,
    project: CONFIG.defaultRecallProject,
    preferred_project: CONFIG.defaultRecallProject,
    preferred_source_platforms: CONFIG.defaultRecallSources,
    preferred_tags: CONFIG.defaultRecallTags
  });

  const formattedResults = formatRecallResults(results.memories || results.results || []);

  logger.info('Memories recalled', { requestId, count: results.results?.length || 0 });

  // Sync context update (user is viewing memories)
  try {
    const context = {
      userId: CONFIG.defaultUserId,
      type: 'context_view',
      timestamp: new Date().toISOString(),
      query: query.substring(0, 100), // Truncate for sync
      resultsCount: results.results?.length || 0
    };
    syncQueue.queue(context);
  } catch (syncError) {
    logger.warn('Sync queue failed', { error: syncError.message });
  }

  return {
    content: [
      {
        type: 'text',
        text: formattedResults
      }
    ]
  };
}

async function handleListMemories(args, requestId) {
  const { limit = 20, offset = 0, memoryType, tags, sourcePlatform } = args;

  const queryParams = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString()
  });

  if (memoryType) queryParams.append('memory_type', memoryType);
  if (tags) queryParams.append('tags', tags.join(','));
  if (sourcePlatform) queryParams.append('source_platform', sourcePlatform);

  const response = await apiCall('GET', `/api/memories?${queryParams}`);

  const formatted = response.memories?.map(m =>
    `- [\`${m.id}\`] **${m.title || m.content.substring(0, 50)}...**\n  Type: ${m.memory_type || m.memoryType} | Created: ${new Date(m.created_at || m.createdAt).toLocaleDateString()}`
  ).join('\n') || 'No memories found.';

  return {
    content: [
      {
        type: 'text',
        text: `## Memories (${response.pagination?.total || 0} total)\n\n${formatted}`
      }
    ]
  };
}

async function handleGetMemory(args, requestId) {
  const { memoryId, includeRelationships = true } = args;

  const memory = await apiCall('GET', `/api/memories/${memoryId}?include_relationships=${includeRelationships}`);

  const formatted = formatMemoryDetail(memory);

  return {
    content: [
      {
        type: 'text',
        text: formatted
      }
    ]
  };
}

async function handleDeleteMemory(args, requestId) {
  const { memoryId } = args;

  await apiCall('DELETE', `/api/memories/${memoryId}`);

  logger.info('Memory deleted', { requestId, memoryId });

  return {
    content: [
      {
        type: 'text',
        text: `✅ Memory \`${memoryId}\` deleted successfully.`
      }
    ]
  };
}

async function handleGetContext(args, requestId) {
  const { topic, format = 'xml' } = args;

  const context = await injectContext({ topic, format });

  return {
    content: [
      {
        type: 'text',
        text: context.formatted
      }
    ],
    metadata: context.metadata
  };
}

async function handleSearchMemories(args, requestId) {
  const { query, filters, weights, nResults = 10 } = args;

  const results = await apiCall('POST', '/api/memories/search', {
    query,
    project: filters?.project,
    memory_type: filters?.memoryType || filters?.memory_type,
    tags: filters?.tags,
    weights,
    n_results: nResults
  });

  const formatted = formatRecallResults(results.results, true);

  return {
    content: [
      {
        type: 'text',
        text: formatted
      }
    ]
  };
}

async function handleTraverseGraph(args, requestId) {
  const { startId, depth = 3, relationshipTypes } = args;

  const result = await apiCall('POST', '/api/memories/traverse', {
    start_id: startId,
    depth,
    relationship_types: relationshipTypes
  });

  const formatted = formatGraphTraversal(result);

  return {
    content: [
      {
        type: 'text',
        text: formatted
      }
    ]
  };
}

async function handleRegisterConnector(args, requestId) {
  const response = await apiCall('POST', '/api/connectors/mcp/endpoints', {
    name: args.name,
    adapter_type: args.adapterType,
    transport: args.transport,
    url: args.url,
    command: args.command,
    args: args.args || [],
    cwd: args.cwd,
    headers: args.headers || {},
    default_project: args.defaultProject || null,
    default_tags: args.defaultTags || []
  });

  const endpoint = response.endpoint;
  return {
    content: [
      {
        type: 'text',
        text: `Connector registered.\n\nName: ${endpoint.name}\nAdapter: ${endpoint.adapter_type}\nTransport: ${endpoint.transport}\n${endpoint.url ? `URL: ${endpoint.url}\n` : ''}${endpoint.default_project ? `Default project: ${endpoint.default_project}\n` : ''}`
      }
    ]
  };
}

async function handleInspectConnector(args, requestId) {
  const response = await apiCall('POST', '/api/connectors/mcp/inspect', {
    name: args.name
  });

  const inspection = response.inspection;
  const tools = (inspection.tools || []).map(tool => `- ${tool.name}`).join('\n') || '- none';
  const resources = (inspection.resources || []).map(resource => `- ${resource.name || resource.uri}`).join('\n') || '- none';
  const prompts = (inspection.prompts || []).map(prompt => `- ${prompt.name}`).join('\n') || '- none';

  return {
    content: [
      {
        type: 'text',
        text: `Connector inspection for ${inspection.endpoint.name}\n\nTools:\n${tools}\n\nResources:\n${resources}\n\nPrompts:\n${prompts}`
      }
    ]
  };
}

async function handleIngestConnector(args, requestId) {
  const response = await apiCall('POST', '/api/connectors/mcp/ingest', {
    endpoint_name: args.endpointName,
    project: args.project || null,
    tags: args.tags || [],
    operation: args.operationType === 'resource'
      ? {
          type: 'resource',
          uri: args.uri
        }
      : {
          type: 'tool',
          name: args.operationName,
          arguments: args.operationArguments || {}
        }
  });

  const jobs = response.accepted_jobs || [];
  const lines = jobs.map(job => `- job ${job.jobId} | source_type=${job.source_type} | project=${job.project || 'none'}`);

  return {
    content: [
      {
        type: 'text',
        text: `Connector ingest started for ${args.endpointName}\n\n${lines.join('\n') || 'No jobs accepted.'}`
      }
    ]
  };
}

// ==========================================
// Helper Functions
// ==========================================

/**
 * Format recall results for display
 */
function formatRecallResults(results, includeScore = false) {
  if (!results || results.length === 0) {
    return '_No relevant memories found._';
  }

  const items = results.map((r, i) => {
    const scoreStr = includeScore ? ` | Score: ${r.score?.toFixed(3)}` : '';
    const memoryType = r.memory_type || r.memoryType || 'fact';
    return `${i + 1}. **[${memoryType}]** ${r.title || r.content.substring(0, 100)}${r.content.length > 100 ? '...' : ''}${scoreStr}`;
  });

  return items.join('\n');
}

/**
 * Format detailed memory view
 */
function formatMemoryDetail(memory) {
  const lines = [
    `## ${memory.title || 'Memory Details'}`,
    '',
    `**ID:** \`${memory.id}\``,
    `**Type:** ${memory.memoryType}`,
    `**Importance:** ${memory.importanceScore?.toFixed(2)}`,
    `**Source:** ${memory.sourcePlatform || 'unknown'}`,
    `**Created:** ${new Date(memory.createdAt).toLocaleString()}`,
    '',
    '### Content',
    memory.content
  ];

  if (memory.tags?.length > 0) {
    lines.push('', '**Tags:** ' + memory.tags.join(', '));
  }

  if (memory.relationships?.length > 0) {
    lines.push('', '### Relationships');
    memory.relationships.forEach(rel => {
      lines.push(`- ${rel.type} → \`${rel.related_memory_id}\``);
    });
  }

  return lines.join('\n');
}

/**
 * Format graph traversal result
 */
function formatGraphTraversal(result) {
  if (!result.nodes || result.nodes.length === 0) {
    return '_No related memories found._';
  }

  const lines = ['## Graph Traversal Result', ''];
  
  result.nodes.forEach((node, i) => {
    lines.push(`### ${i + 1}. ${node.memory?.title || 'Untitled'}`);
    lines.push(`- **ID:** \`${node.memory?.id}\``);
    lines.push(`- **Type:** ${node.memory?.memoryType}`);
    lines.push(`- **Relationship:** ${node.relationship?.type}`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Make API call to HIVE-MIND backend
 */
async function apiCall(method, path, body = null) {
  const url = new URL(path, CONFIG.apiBaseUrl);
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `${CONFIG.serverName}/${CONFIG.serverVersion}`
    }
  };

  if (CONFIG.apiKey) {
    options.headers['X-API-Key'] = CONFIG.apiKey;
  }

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let error = null;
    try {
      error = raw ? JSON.parse(raw) : null;
    } catch {
      error = null;
    }
    throw new Error(
      error?.message
      || error?.error
      || raw
      || `HTTP ${response.status}`
    );
  }

  return response.json();
}

/**
 * Inject context for conversation
 */
async function injectContext(options = {}) {
  const { topic, format = 'xml' } = options;

  try {
    const response = await apiCall('POST', '/recall/context', {
      topic,
      format,
      maxMemories: 20,
      maxTokens: 2000
    });

    return response;
  } catch (error) {
    logger.error('Context injection failed', { error: error.message });
    
    // Return empty but valid context
    const emptyContext = format === 'json'
      ? { memories: [] }
      : format === 'markdown'
        ? '## Relevant Context\n\n_No memories found._'
        : '<relevant-memories>\n  <!-- No memories -->\n</relevant-memories>';

    return {
      formatted: typeof emptyContext === 'string' ? emptyContext : JSON.stringify(emptyContext),
      memoryIds: [],
      tokenCount: 0,
      error: error.message
    };
  }
}

/**
 * Get current user ID from environment or session
 */
function getCurrentUserId() {
  return CONFIG.defaultUserId;
}

// ==========================================
// Server Startup
// ==========================================

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('HIVE-MIND MCP Server started', {
      name: CONFIG.serverName,
      version: CONFIG.serverVersion,
      transport: 'stdio'
    });

    logger.info('MCP server startup complete', {
      name: CONFIG.serverName,
      version: CONFIG.serverVersion,
      tools: Object.keys(TOOLS),
      resources: Object.keys(RESOURCES),
      prompts: Object.keys(PROMPTS)
    });

    // Start sync server for cross-app synchronization
    syncServer.startSync();
    logger.info('Sync server started', { stats: syncServer.getStats() });

  } catch (error) {
    logger.error('Fatal server error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Start server
main();

// Export for testing
export { server, TOOLS, RESOURCES, PROMPTS, syncServer, syncQueue, bridge };
