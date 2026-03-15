# Phase 2 Implementation Plan: Universal Connectivity (Meta-MCP Bridge)

**Document Version:** 1.0  
**Date:** 2026-03-09  
**Status:** 🚧 IN PROGRESS  
**Priority:** P0 - Critical Path  

---

## Executive Summary

The Universal Connectivity (Meta-MCP Bridge) addresses the fundamental limitation of siloed AI applications: **context isolation**. When users switch between AI clients (Cursor ↔ Claude Desktop ↔ ChatGPT), context is lost. This plan implements a Meta-MCP Bridge that generates unique, persistent endpoints per user, enabling cross-app visibility and automatic context synchronization without manual sync.

**Target:** Match Supermemory.ai's MCP protocol with universal endpoint generation and cross-app synchronization.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    META-MCP BRIDGE ARCHITECTURE                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         META-MCP BRIDGE                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  User-Specific Endpoint Generation                                    │  │
│  │  • UUID-based endpoint per user                                       │  │
│  │  • Persistent connection across sessions                              │  │
│  │  • Cross-app visibility (Cursor ↔ Claude ↔ ChatGPT)                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│   Cursor     │    │  Claude Desktop  │    │  ChatGPT     │
│   MCP Client │    │  MCP Client      │    │  MCP Client  │
└───────┬──────┘    └────────┬─────────┘    └───────┬──────┘
        │                    │                     │
        └────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  HIVE-MIND Core │
                    │  • Memory Store │
                    │  • Search       │
                    │  • Recall       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  MCP Protocol   │
                    │  • Tools        │
                    │  • Resources    │
                    │  • Prompts      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  State Sync     │
                    │  • Session      │
                    │  • Context      │
                    │  • Preferences  │
                    └─────────────────┘
```

---

## Current State Gap Analysis

| Component | Current Implementation | Target (Supermemory) | Gap |
|-----------|----------------------|---------------------|-----|
| User-Specific Endpoints | ❌ None | ✅ UUID-based per user | **HIGH** |
| Cross-App Visibility | ❌ None | ✅ Cursor ↔ Claude ↔ ChatGPT | **HIGH** |
| Meta-MCP Bridge | ❌ None | ✅ Universal endpoint | **HIGH** |
| MCP Server Completion | ⚠️ Partial | ✅ Full protocol | **MEDIUM** |

---

## Implementation Steps

### Step 1: User-Specific Endpoint Generation

**Effort:** 3 days  
**Dependencies:** None  
**Files:** `core/src/mcp/endpoints.js`

```javascript
/**
 * User-Specific MCP Endpoint Generation
 * Creates unique, persistent endpoints per user for cross-app visibility
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export class EndpointGenerator {
  constructor() {
    this.endpoints = new Map();
    this.endpointPrefix = process.env.MCP_ENDPOINT_PREFIX || 'hivemind';
  }

  /**
   * Generate unique endpoint for user
   * @param {string} userId - User ID
   * @param {string} orgId - Organization ID
   * @returns {Object} Endpoint configuration
   */
  generateEndpoint(userId, orgId) {
    const endpointId = uuidv4();
    const secret = this._generateSecret(userId, orgId, endpointId);
    
    const endpoint = {
      id: endpointId,
      userId,
      orgId,
      secret,
      url: this._buildEndpointUrl(endpointId, secret),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      isActive: true
    };

    // Store endpoint
    this.endpoints.set(userId, endpoint);
    
    // Persist to database
    this._persistEndpoint(endpoint);

    return endpoint;
  }

  /**
   * Get existing endpoint for user
   */
  getEndpoint(userId) {
    let endpoint = this.endpoints.get(userId);
    
    if (!endpoint) {
      // Load from database
      endpoint = this._loadEndpoint(userId);
      if (endpoint) {
        this.endpoints.set(userId, endpoint);
      }
    }

    return endpoint;
  }

  /**
   * Revoke endpoint
   */
  revokeEndpoint(userId) {
    const endpoint = this.endpoints.get(userId);
    if (endpoint) {
      endpoint.isActive = false;
      endpoint.revokedAt = new Date().toISOString();
      this._persistEndpoint(endpoint);
      this.endpoints.delete(userId);
    }
    return { success: true };
  }

  /**
   * Regenerate endpoint secret
   */
  regenerateSecret(userId) {
    const endpoint = this.endpoints.get(userId);
    if (!endpoint) {
      throw new Error(`No endpoint found for user: ${userId}`);
    }

    const newSecret = this._generateSecret(endpoint.userId, endpoint.orgId, endpoint.id);
    endpoint.secret = newSecret;
    endpoint.url = this._buildEndpointUrl(endpoint.id, newSecret);
    endpoint.updatedAt = new Date().toISOString();

    this._persistEndpoint(endpoint);
    return endpoint;
  }

  /**
   * Build endpoint URL
   */
  _buildEndpointUrl(endpointId, secret) {
    const baseUrl = process.env.MCP_BASE_URL || 'http://localhost:3000';
    return `${baseUrl}/mcp/${endpointId}?secret=${secret}`;
  }

  /**
   * Generate secret for endpoint
   */
  _generateSecret(userId, orgId, endpointId) {
    const input = `${userId}:${orgId}:${endpointId}:${process.env.MCP_SECRET_KEY || 'default-key'}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
  }

  /**
   * Persist endpoint to database
   */
  _persistEndpoint(endpoint) {
    // In production, this would use Prisma
    // For now, store in memory and provide API for persistence
    console.log(`Persisting endpoint for user ${endpoint.userId}:`, endpoint.id);
  }

  /**
   * Load endpoint from database
   */
  _loadEndpoint(userId) {
    // In production, this would query the database
    return null;
  }

  /**
   * Validate endpoint secret
   */
  validateEndpoint(endpointId, secret) {
    // Find endpoint by ID
    for (const [userId, endpoint] of this.endpoints) {
      if (endpoint.id === endpointId && endpoint.secret === secret && endpoint.isActive) {
        endpoint.lastUsedAt = new Date().toISOString();
        return { valid: true, userId: endpoint.userId, orgId: endpoint.orgId };
      }
    }

    return { valid: false };
  }

  /**
   * Get all active endpoints
   */
  getActiveEndpoints() {
    return Array.from(this.endpoints.values()).filter(e => e.isActive);
  }

  /**
   * Get endpoint statistics
   */
  getStats() {
    const active = this.getActiveEndpoints();
    return {
      totalEndpoints: this.endpoints.size,
      activeEndpoints: active.length,
      avgUsage: active.length > 0 ? active.length / this.endpoints.size : 0
    };
  }
}

// Singleton
let endpointGenerator = null;
export function getEndpointGenerator() {
  if (!endpointGenerator) {
    endpointGenerator = new EndpointGenerator();
  }
  return endpointGenerator;
}
```

---

### Step 2: Cross-App Context Synchronization

**Effort:** 4 days  
**Dependencies:** Step 1  
**Files:** `core/src/mcp/sync.js`

```javascript
/**
 * Cross-App Context Synchronization
 * Syncs context between Cursor, Claude Desktop, ChatGPT, etc.
 */

export class ContextSyncer {
  constructor() {
    this.syncQueue = [];
    this.syncInterval = 1000; // 1 second
    this.maxBatchSize = 10;
    this.syncedContexts = new Map();
  }

  /**
   * Queue context for synchronization
   */
  queueContext(context) {
    this.syncQueue.push({
      ...context,
      queuedAt: new Date().toISOString()
    });

    // Process queue if it reaches threshold
    if (this.syncQueue.length >= this.maxBatchSize) {
      this.processQueue();
    }
  }

  /**
   * Process sync queue
   */
  async processQueue() {
    if (this.syncQueue.length === 0) return;

    const batch = this.syncQueue.splice(0, this.maxBatchSize);
    
    // Group by user
    const byUser = this._groupByUser(batch);

    // Sync each user's context
    for (const [userId, contexts] of byUser) {
      await this._syncUserContext(userId, contexts);
    }
  }

  /**
   * Sync context for a user
   */
  async _syncUserContext(userId, contexts) {
    // Get all active endpoints for user
    const endpoints = this._getUserEndpoints(userId);
    
    if (endpoints.length === 0) {
      console.log(`No active endpoints for user: ${userId}`);
      return;
    }

    // Build unified context
    const unifiedContext = this._buildUnifiedContext(contexts);

    // Push to each endpoint
    for (const endpoint of endpoints) {
      try {
        await this._pushToEndpoint(endpoint, unifiedContext);
        this.syncedContexts.set(userId, {
          ...unifiedContext,
          syncedAt: new Date().toISOString()
        });
      } catch (error) {
        console.error(`Failed to sync to endpoint ${endpoint.id}:`, error);
      }
    }
  }

  /**
   * Build unified context from multiple sources
   */
  _buildUnifiedContext(contexts) {
    // Merge contexts, prioritizing latest
    const merged = {
      memories: [],
      preferences: {},
      activeProject: null,
      recentSessions: []
    };

    for (const context of contexts) {
      // Merge memories
      if (context.memories) {
        merged.memories.push(...context.memories);
      }

      // Merge preferences (later overrides earlier)
      if (context.preferences) {
        merged.preferences = { ...merged.preferences, ...context.preferences };
      }

      // Track active project
      if (context.activeProject) {
        merged.activeProject = context.activeProject;
      }

      // Track recent sessions
      if (context.recentSessions) {
        merged.recentSessions.push(...context.recentSessions);
      }
    }

    // Deduplicate and sort
    merged.memories = [...new Set(merged.memories)];
    merged.recentSessions = merged.recentSessions.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );

    return merged;
  }

  /**
   * Push context to endpoint
   */
  async _pushToEndpoint(endpoint, context) {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Mind-Secret': endpoint.secret
      },
      body: JSON.stringify({
        type: 'context_update',
        context,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to push context: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get user's active endpoints
   */
  _getUserEndpoints(userId) {
    // In production, query database for active endpoints
    return [];
  }

  /**
   * Group contexts by user
   */
  _groupByUser(contexts) {
    const byUser = new Map();
    for (const context of contexts) {
      if (!byUser.has(context.userId)) {
        byUser.set(context.userId, []);
      }
      byUser.get(context.userId).push(context);
    }
    return byUser;
  }

  /**
   * Get synced context for user
   */
  getSyncedContext(userId) {
    return this.syncedContexts.get(userId);
  }

  /**
   * Force sync for user
   */
  async forceSync(userId) {
    const contexts = this.syncQueue.filter(c => c.userId === userId);
    if (contexts.length > 0) {
      await this._syncUserContext(userId, contexts);
    }
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return {
      queueSize: this.syncQueue.length,
      syncedContexts: this.syncedContexts.size,
      avgBatchSize: this.syncQueue.length > 0 ? this.maxBatchSize : 0
    };
  }
}

// Singleton
let contextSyncer = null;
export function getContextSyncer() {
  if (!contextSyncer) {
    contextSyncer = new ContextSyncer();
  }
  return contextSyncer;
}
```

---

### Step 3: MCP Protocol Implementation

**Effort:** 5 days  
**Dependencies:** Steps 1 & 2  
**Files:** `core/src/mcp/server.js`

```javascript
/**
 * MCP Protocol Server
 * Implements Model Context Protocol for HIVE-MIND
 */

import { getEndpointGenerator } from './endpoints.js';
import { getContextSyncer } from './sync.js';

export class MCPServer {
  constructor() {
    this.endpointGenerator = getEndpointGenerator();
    this.contextSyncer = getContextSyncer();
    this.tools = this._initializeTools();
    this.resources = this._initializeResources();
    this.prompts = this._initializePrompts();
  }

  /**
   * Initialize MCP tools
   */
  _initializeTools() {
    return {
      memory_store: {
        name: 'memory_store',
        description: 'Store a new memory in HIVE-MIND',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Memory content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
            project: { type: 'string', description: 'Project name' },
            relationship: { 
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['Updates', 'Extends', 'Derives'] },
                target_id: { type: 'string' }
              }
            }
          },
          required: ['content']
        },
        handler: this._handleMemoryStore.bind(this)
      },
      memory_search: {
        name: 'memory_search',
        description: 'Search memories by keyword',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            max_results: { type: 'number', default: 10 }
          },
          required: ['query']
        },
        handler: this._handleMemorySearch.bind(this)
      },
      memory_recall: {
        name: 'memory_recall',
        description: 'Get relevant memories for context',
        parameters: {
          type: 'object',
          properties: {
            query_context: { type: 'string', description: 'Query context' },
            max_memories: { type: 'number', default: 5 }
          },
          required: ['query_context']
        },
        handler: this._handleMemoryRecall.bind(this)
      },
      memory_traverse: {
        name: 'memory_traverse',
        description: 'Traverse memory graph relationships',
        parameters: {
          type: 'object',
          properties: {
            start_id: { type: 'string', description: 'Starting memory ID' },
            depth: { type: 'number', default: 3 },
            relationship_types: { 
              type: 'array', 
              items: { type: 'string' },
              default: ['Updates', 'Extends', 'Derives']
            }
          },
          required: ['start_id']
        },
        handler: this._handleMemoryTraverse.bind(this)
      },
      session_start: {
        name: 'session_start',
        description: 'Start a new session for context tracking',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', description: 'Platform type' },
            title: { type: 'string', description: 'Session title' }
          }
        },
        handler: this._handleSessionStart.bind(this)
      },
      session_end: {
        name: 'session_end',
        description: 'End current session and auto-capture decisions',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Session content' }
          }
        },
        handler: this._handleSessionEnd.bind(this)
      }
    };
  }

  /**
   * Initialize MCP resources
   */
  _initializeResources() {
    return {
      'memory://memories': {
        name: 'memories',
        description: 'All memories for current user',
        mimeType: 'application/json',
        handler: this._handleMemoriesResource.bind(this)
      },
      'memory://profile': {
        name: 'profile',
        description: 'User profile and preferences',
        mimeType: 'application/json',
        handler: this._handleProfileResource.bind(this)
      },
      'memory://projects': {
        name: 'projects',
        description: 'User projects',
        mimeType: 'application/json',
        handler: this._handleProjectsResource.bind(this)
      }
    };
  }

  /**
   * Initialize MCP prompts
   */
  _initializePrompts() {
    return {
      'summarize_session': {
        name: 'summarize_session',
        description: 'Summarize a session into key memories',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Summarize this session into key memories:\n\n{session_content}'
            }
          }
        ]
      },
      'contextualize_chunk': {
        name: 'contextualize_chunk',
        description: 'Generate context for a text chunk',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Generate context for this chunk:\n\n{chunk}\n\nSource: {source}'
            }
          }
        ]
      }
    };
  }

  /**
   * Handle memory_store tool
   */
  async _handleMemoryStore(params, context) {
    const { content, tags = [], project, relationship } = params;
    
    // Store memory
    const memory = await this._storeMemory({
      content,
      tags,
      project,
      relationship,
      userId: context.userId,
      orgId: context.orgId
    });

    // Sync context to other apps
    this.contextSyncer.queueContext({
      userId: context.userId,
      orgId: context.orgId,
      memories: [memory.id],
      type: 'memory_created'
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(memory) }],
      isError: false
    };
  }

  /**
   * Handle memory_search tool
   */
  async _handleMemorySearch(params, context) {
    const { query, max_results = 10 } = params;

    const results = await this._searchMemories({
      query,
      userId: context.userId,
      orgId: context.orgId,
      nResults: max_results
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(results) }],
      isError: false
    };
  }

  /**
   * Handle memory_recall tool
   */
  async _handleMemoryRecall(params, context) {
    const { query_context, max_memories = 5 } = params;

    const recall = await this._recallMemories({
      queryContext: query_context,
      userId: context.userId,
      maxMemories: max_memories
    });

    return {
      content: [{ type: 'text', text: recall.injectionText }],
      isError: false
    };
  }

  /**
   * Handle memory_traverse tool
   */
  async _handleMemoryTraverse(params, context) {
    const { start_id, depth = 3, relationship_types = ['Updates', 'Extends', 'Derives'] } = params;

    const result = await this._traverseGraph({
      startId: start_id,
      depth,
      relationshipTypes: relationship_types,
      userId: context.userId
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false
    };
  }

  /**
   * Handle session_start tool
   */
  async _handleSessionStart(params, context) {
    const { platform, title } = params;

    const session = await this._startSession({
      platform,
      title,
      userId: context.userId,
      orgId: context.orgId
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(session) }],
      isError: false
    };
  }

  /**
   * Handle session_end tool
   */
  async _handleSessionEnd(params, context) {
    const { content } = params;

    const result = await this._endSession({
      content,
      userId: context.userId,
      orgId: context.orgId
    });

    // Sync context
    this.contextSyncer.queueContext({
      userId: context.userId,
      orgId: context.orgId,
      memories: result.captured.map(c => c.memory.id),
      type: 'session_ended'
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false
    };
  }

  /**
   * Handle memories resource
   */
  async _handleMemoriesResource(context) {
    const memories = await this._getAllMemories({
      userId: context.userId,
      orgId: context.orgId
    });

    return {
      contents: [{
        uri: 'memory://memories',
        mimeType: 'application/json',
        text: JSON.stringify(memories)
      }]
    };
  }

  /**
   * Handle profile resource
   */
  async _handleProfileResource(context) {
    const profile = await this._getUserProfile({
      userId: context.userId,
      orgId: context.orgId
    });

    return {
      contents: [{
        uri: 'memory://profile',
        mimeType: 'application/json',
        text: JSON.stringify(profile)
      }]
    };
  }

  /**
   * Handle projects resource
   */
  async _handleProjectsResource(context) {
    const projects = await this._getUserProjects({
      userId: context.userId,
      orgId: context.orgId
    });

    return {
      contents: [{
        uri: 'memory://projects',
        mimeType: 'application/json',
        text: JSON.stringify(projects)
      }]
    };
  }

  // Helper methods (to be implemented with actual database logic)
  async _storeMemory(params) {
    // Implementation with database
    return { id: 'mock-id', ...params };
  }

  async _searchMemories(params) {
    // Implementation with database
    return { results: [] };
  }

  async _recallMemories(params) {
    // Implementation with database
    return { injectionText: '<relevant-memories></relevant-memories>' };
  }

  async _traverseGraph(params) {
    // Implementation with database
    return { nodes: [], edges: [] };
  }

  async _startSession(params) {
    // Implementation with database
    return { id: 'mock-session-id', ...params };
  }

  async _endSession(params) {
    // Implementation with database
    return { captured: [], count: 0 };
  }

  async _getAllMemories(params) {
    // Implementation with database
    return [];
  }

  async _getUserProfile(params) {
    // Implementation with database
    return {};
  }

  async _getUserProjects(params) {
    // Implementation with database
    return [];
  }

  /**
   * Process MCP request
   */
  async processRequest(request) {
    const { method, params, context } = request;

    switch (method) {
      case 'tools/call':
        const tool = this.tools[params.name];
        if (tool) {
          return await tool.handler(params, context);
        }
        return { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true };

      case 'resources/read':
        const resource = this.resources[params.uri];
        if (resource) {
          return await resource.handler(context);
        }
        return { contents: [], isError: true };

      case 'prompts/render':
        const prompt = this.prompts[params.name];
        if (prompt) {
          return { messages: prompt.messages };
        }
        return { messages: [], isError: true };

      default:
        return { content: [{ type: 'text', text: `Unknown method: ${method}` }], isError: true };
    }
  }

  /**
   * Get MCP server info
   */
  getInfo() {
    return {
      name: 'hivemind',
      version: '2.0.0',
      description: 'HIVE-MIND MCP Server - Universal AI Memory',
      tools: Object.keys(this.tools),
      resources: Object.keys(this.resources),
      prompts: Object.keys(this.prompts)
    };
  }
}

// Singleton
let mcpServer = null;
export function getMCPServer() {
  if (!mcpServer) {
    mcpServer = new MCPServer();
  }
  return mcpServer;
}
```

---

### Step 4: MCP Client Integration

**Effort:** 3 days  
**Dependencies:** Step 3  
**Files:** `integrations/mcp-clients/`

#### Cursor IDE Integration

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "hivemind": {
      "command": "curl",
      "args": [
        "-X",
        "POST",
        "http://localhost:3000/mcp/{endpoint-id}?secret={secret}",
        "-H",
        "Content-Type: application/json",
        "-d",
        "{request}"
      ],
      "env": {
        "MCP_ENDPOINT_ID": "your-endpoint-id",
        "MCP_SECRET": "your-secret"
      }
    }
  }
}
```

#### Claude Desktop Integration

```json
// claude_mcp.json
{
  "mcpServers": {
    "hivemind": {
      "command": "curl",
      "args": [
        "-X",
        "POST",
        "http://localhost:3000/mcp/{endpoint-id}?secret={secret}",
        "-H",
        "Content-Type: application/json",
        "-d",
        "{request}"
      ],
      "env": {
        "MCP_ENDPOINT_ID": "your-endpoint-id",
        "MCP_SECRET": "your-secret"
      }
    }
  }
}
```

#### OpenCode Integration

```json
// .opencode/config.json
{
  "mcpServers": {
    "hivemind": {
      "url": "http://localhost:3000/mcp/{endpoint-id}?secret={secret}",
      "transport": "http"
    }
  }
}
```

---

### Step 5: HTTP Endpoint Handler

**Effort:** 2 days  
**Dependencies:** Steps 1-4  
**Files:** `core/src/server.js` (extensions)

```javascript
// Add to server.js

case '/mcp/{endpointId}':
  if (req.method === 'POST') {
    const endpointGenerator = getEndpointGenerator();
    const secret = url.searchParams.get('secret');
    
    const validation = endpointGenerator.validateEndpoint(endpointId, secret);
    
    if (!validation.valid) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Invalid endpoint' }));
      return;
    }

    const body = await parseBody(req);
    const mcpServer = getMCPServer();
    
    const response = await mcpServer.processRequest({
      ...body,
      context: {
        userId: validation.userId,
        orgId: validation.orgId
      }
    });

    jsonResponse(res, response);
  }
  break;
```

---

## Meta-MCP Bridge Architecture

### Endpoint Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    META-MCP BRIDGE FLOW                                     │
└─────────────────────────────────────────────────────────────────────────────┘

1. User registers with HIVE-MIND
   └─> UUID generated for user

2. User configures MCP client (Cursor, Claude, etc.)
   └─> Client receives endpoint URL: /mcp/{uuid}?secret={hash}

3. Client makes MCP request
   └─> Request: POST /mcp/{uuid}?secret={hash}
       Body: { method: "tools/call", params: { name: "memory_store" } }

4. Bridge validates endpoint
   └─> Validates UUID + secret hash
   └─> Extracts userId, orgId

5. Bridge processes request
   └─> Routes to appropriate MCP handler
   └─> Executes tool/resource/prompt

6. Bridge syncs context
   └─> Queues context update
   └─> Pushes to all user endpoints

7. Response returned
   └─> Client receives result
   └─> Context available in all connected apps
```

---

## MCP Server Completion Requirements

### Tools (Complete)

| Tool | Status | Description |
|------|--------|-------------|
| `memory_store` | ✅ | Store new memory |
| `memory_search` | ✅ | Search by keyword |
| `memory_recall` | ✅ | Get relevant memories |
| `memory_traverse` | ✅ | Traverse graph |
| `session_start` | ✅ | Start session |
| `session_end` | ✅ | End session |
| `memory_delete` | ⚠️ | Delete memory |
| `memory_update` | ⚠️ | Update memory |
| `profile_get` | ⚠️ | Get user profile |
| `profile_update` | ⚠️ | Update profile |

### Resources (Complete)

| Resource | Status | Description |
|----------|--------|-------------|
| `memory://memories` | ✅ | All memories |
| `memory://profile` | ✅ | User profile |
| `memory://projects` | ✅ | User projects |
| `memory://sessions` | ⚠️ | Session history |
| `memory://relationships` | ⚠️ | Graph relationships |

### Prompts (Complete)

| Prompt | Status | Description |
|--------|--------|-------------|
| `summarize_session` | ✅ | Session summarization |
| `contextualize_chunk` | ✅ | Chunk contextualization |
| `resolve_conflict` | ⚠️ | Conflict resolution |
| `generate_tags` | ⚠️ | Auto-tag generation |

---

## Testing Strategy

### Unit Tests

```javascript
// tests/mcp/endpoints.test.js
import { describe, it, expect } from 'node:test';

describe('EndpointGenerator', () => {
  it('generates unique endpoint for user', () => {
    const generator = getEndpointGenerator();
    const endpoint = generator.generateEndpoint('user-123', 'org-456');
    
    expect(endpoint.id).toBeDefined();
    expect(endpoint.userId).toBe('user-123');
    expect(endpoint.orgId).toBe('org-456');
    expect(endpoint.secret).toHaveLength(32);
  });

  it('validates endpoint secret', () => {
    const generator = getEndpointGenerator();
    const endpoint = generator.generateEndpoint('user-123', 'org-456');
    
    const validation = generator.validateEndpoint(endpoint.id, endpoint.secret);
    expect(validation.valid).toBe(true);
    expect(validation.userId).toBe('user-123');
  });

  it('rejects invalid secret', () => {
    const generator = getEndpointGenerator();
    const endpoint = generator.generateEndpoint('user-123', 'org-456');
    
    const validation = generator.validateEndpoint(endpoint.id, 'invalid-secret');
    expect(validation.valid).toBe(false);
  });
});

// tests/mcp/sync.test.js
import { describe, it, expect } from 'node:test';

describe('ContextSyncer', () => {
  it('queues context for synchronization', () => {
    const syncer = getContextSyncer();
    syncer.queueContext({
      userId: 'user-123',
      orgId: 'org-456',
      memories: ['mem-1'],
      type: 'memory_created'
    });
    
    expect(syncer.getStats().queueSize).toBe(1);
  });

  it('builds unified context', () => {
    const syncer = getContextSyncer();
    const unified = syncer._buildUnifiedContext([
      { memories: ['mem-1'], activeProject: 'project-a' },
      { memories: ['mem-2'], activeProject: 'project-b' }
    ]);
    
    expect(unified.memories).toHaveLength(2);
    expect(unified.activeProject).toBe('project-b');
  });
});
```

### Integration Tests

```javascript
// tests/integration/mcp.test.js
import { describe, it, expect } from 'node:test';

describe('MCP Integration', () => {
  it('end-to-end MCP request flow', async () => {
    // Generate endpoint
    const generator = getEndpointGenerator();
    const endpoint = generator.generateEndpoint('test-user', 'test-org');

    // Make MCP request
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'memory_store',
          content: 'Test memory',
          tags: ['test']
        }
      })
    });

    const result = await response.json();
    expect(result.content[0].type).toBe('text');
  });

  it('cross-app context synchronization', async () => {
    // Store memory in app A
    const endpointA = generator.generateEndpoint('user-123', 'org-456');
    await fetch(endpointA.url, {
      method: 'POST',
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: 'memory_store', content: 'New memory' }
      })
    });

    // Retrieve in app B (same user)
    const endpointB = generator.getEndpoint('user-123');
    const recallResponse = await fetch(endpointB.url, {
      method: 'POST',
      body: JSON.stringify({
        method: 'tools/call',
        params: { 
          name: 'memory_recall', 
          query_context: 'New memory' 
        }
      })
    });

    const recallResult = await recallResponse.json();
    expect(recallResult.injectionText).toContain('New memory');
  });
});
```

---

## Dependencies

| Component | Dependency | Priority |
|-----------|-----------|----------|
| UUID Generation | `uuid` | P0 |
| MCP Server | `core/src/mcp/server.js` | P0 |
| Endpoint Generator | `core/src/mcp/endpoints.js` | P0 |
| Context Syncer | `core/src/mcp/sync.js` | P0 |
| HTTP Handler | `core/src/server.js` | P0 |

---

## Estimated Effort

| Task | Hours | Days |
|------|-------|------|
| User-Specific Endpoints | 12 | 1.5 |
| Cross-App Context Sync | 16 | 2 |
| MCP Protocol Implementation | 20 | 2.5 |
| MCP Client Integration | 12 | 1.5 |
| HTTP Endpoint Handler | 8 | 1 |
| Testing | 12 | 1.5 |
| Documentation | 4 | 0.5 |
| **Total** | **84** | **10.5** |

---

## Success Criteria

- [ ] Unique endpoint generated per user (UUID-based)
- [ ] Cross-app visibility working (Cursor ↔ Claude ↔ ChatGPT)
- [ ] Context synchronization latency <1 second
- [ ] MCP protocol fully implemented (tools/resources/prompts)
- [ ] All MCP clients can connect and use HIVE-MIND
- [ ] All tests passing (unit + integration)

---

## Rollout Plan

### Phase 1: Endpoint Generation (Week 1)
- UUID-based endpoint generation
- Secret validation
- Endpoint management API

### Phase 2: Cross-App Sync (Week 2)
- Context synchronization
- Queue processing
- Multi-app push

### Phase 3: MCP Protocol (Week 3)
- Tools implementation
- Resources implementation
- Prompts implementation

### Phase 4: Client Integration (Week 4)
- Cursor integration
- Claude Desktop integration
- ChatGPT integration
- Production deployment

---

## Monitoring & Observability

### Key Metrics

| Metric | Alert Threshold | Target |
|--------|----------------|--------|
| Endpoint Generation Latency | >100ms | <50ms |
| Context Sync Latency | >2s | <1s |
| MCP Request Latency | >500ms | <200ms |
| Cross-App Sync Rate | <80% | >95% |

### Logging

```javascript
logger.info('mcp.endpoint.generated', {
  userId,
  endpointId,
  timestamp: new Date().toISOString()
});

logger.info('mcp.context.synced', {
  userId,
  contextType,
  endpointCount,
  latencyMs: performance.now() - start
});

logger.error('mcp.request.failed', {
  method,
  error: error.message,
  userId: context?.userId
});
```

---

## Future Enhancements

1. **Real-Time Sync**: WebSocket-based real-time context updates
2. **Conflict Detection**: Automatic detection of conflicting contexts
3. **Context Versioning**: Track context evolution over time
4. **Multi-User Support**: Team context sharing
5. **Context Analytics**: Usage patterns and insights

---

## References

- MCP Protocol Specification: https://modelcontextprotocol.io/
- Supermemory MCP: https://supermemory.ai/docs/supermemory-mcp/
- Claude MCP Integration: https://claude.ai/mcp
