# Phase 1 Implementation Specification: Integration Engineer

**Document Version:** 1.0.0  
**Role:** Integration Engineer  
**Estimated Duration:** 10-14 days  
**Priority:** Critical (Platform Connectivity)  
**Compliance Reference:** CROSS_PLATFORM_SYNC_SPEC.md §1.3  

---

## Executive Summary

This specification defines the integration layer implementation for HIVE-MIND's cross-platform context sync. You will build **ChatGPT Custom GPT Actions**, **Claude Actions API** integrations, implement the **Model Context Protocol (MCP)** server, create a **universal webhook handler**, and establish **pre-inference recall injection** logic.

### Key Deliverables

1. ✅ ChatGPT Custom GPT Actions configuration (openapi.yaml + OAuth)
2. ✅ Claude Actions API integration (system prompts, webhook handlers)
3. ✅ Model Context Protocol (MCP) server implementation (mcp-server.js)
4. ✅ Universal webhook handler with HMAC signing
5. ✅ Pre-inference recall injection logic (`<relevant-memories>` XML tags)
6. ✅ Test scripts for cross-platform handoff verification

---

## 1. ChatGPT Custom GPT Actions

### 1.1 OpenAPI Specification

```yaml
# File: integrations/chatgpt/openapi.yaml
openapi: 3.1.0
info:
  title: HIVE-MIND Memory API
  description: |
    Cross-platform context preservation API for ChatGPT integration.
    Enables memory storage and retrieval across AI platforms.
  version: 1.0.0
  contact:
    email: api@hivemind.io
  license:
    name: Proprietary
    url: https://hivemind.io/terms

servers:
  - url: https://api.hivemind.io/v1
    description: Production (EU)
  - url: https://api-staging.hivemind.io/v1
    description: Staging

security:
  - bearerAuth: []

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: JWT token from ZITADEL OIDC

  schemas:
    Memory:
      type: object
      required:
        - content
      properties:
        id:
          type: string
          format: uuid
          description: Unique memory identifier
        content:
          type: string
          minLength: 1
          maxLength: 10000
          description: Memory content
        memoryType:
          type: string
          enum: [fact, preference, decision, lesson, goal, event, relationship]
          default: fact
        title:
          type: string
          maxLength: 500
        tags:
          type: array
          items:
            type: string
        sourcePlatform:
          type: string
          default: chatgpt
        importanceScore:
          type: number
          minimum: 0
          maximum: 1
          default: 0.5
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time

    MemoryCreate:
      type: object
      required:
        - content
      properties:
        content:
          type: string
          minLength: 1
          maxLength: 10000
        memoryType:
          type: string
          enum: [fact, preference, decision, lesson, goal, event, relationship]
          default: fact
        title:
          type: string
          maxLength: 500
        tags:
          type: array
          items:
            type: string
        importanceScore:
          type: number
          minimum: 0
          maximum: 1

    RecallQuery:
      type: object
      required:
        - query
      properties:
        query:
          type: string
          minLength: 1
          maxLength: 2000
        limit:
          type: integer
          minimum: 1
          maximum: 50
          default: 10
        memoryTypes:
          type: string
          description: Comma-separated memory types
        recencyBias:
          type: number
          minimum: 0
          maximum: 1
          default: 0.5

    RecallResponse:
      type: object
      properties:
        results:
          type: array
          items:
            $ref: '#/components/schemas/Memory'
        metadata:
          type: object
          properties:
            total:
              type: integer
            latencyMs:
              type: integer

    Error:
      type: object
      properties:
        error:
          type: string
        message:
          type: string
        requestId:
          type: string

paths:
  /memories:
    post:
      operationId: createMemory
      summary: Create a new memory
      description: |
        Store a new memory that will be available across all AI platforms.
        The memory is automatically embedded for semantic search.
      tags:
        - Memories
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/MemoryCreate'
      responses:
        '201':
          description: Memory created successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Memory'
        '400':
          description: Invalid request
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Unauthorized
        '500':
          description: Server error

    get:
      operationId: listMemories
      summary: List memories
      description: Retrieve memories with filtering and pagination
      tags:
        - Memories
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - name: offset
          in: query
          schema:
            type: integer
            minimum: 0
            default: 0
        - name: memoryType
          in: query
          schema:
            type: string
            enum: [fact, preference, decision, lesson, goal, event, relationship]
        - name: tags
          in: query
          schema:
            type: string
          description: Comma-separated tags
      responses:
        '200':
          description: List of memories
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/Memory'
                  pagination:
                    type: object
                    properties:
                      limit:
                        type: integer
                      offset:
                        type: integer
                      total:
                        type: integer
                      hasMore:
                        type: boolean
        '401':
          description: Unauthorized

  /memories/{memoryId}:
    get:
      operationId: getMemory
      summary: Get a specific memory
      tags:
        - Memories
      parameters:
        - name: memoryId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Memory details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Memory'
        '404':
          description: Memory not found

    patch:
      operationId: updateMemory
      summary: Update a memory
      description: Creates a new version with Updates relationship
      tags:
        - Memories
      parameters:
        - name: memoryId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/MemoryCreate'
      responses:
        '200':
          description: Memory updated
        '404':
          description: Memory not found

    delete:
      operationId: deleteMemory
      summary: Delete a memory
      tags:
        - Memories
      parameters:
        - name: memoryId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '204':
          description: Memory deleted
        '404':
          description: Memory not found

  /recall:
    post:
      operationId: recallMemories
      summary: Semantic memory search
      description: |
        Search memories using natural language queries.
        Returns results ranked by semantic similarity, recency, and importance.
      tags:
        - Recall
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RecallQuery'
      responses:
        '200':
          description: Search results
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RecallResponse'
        '400':
          description: Invalid query
        '401':
          description: Unauthorized

  /sync/status:
    get:
      operationId: getSyncStatus
      summary: Get sync status
      description: Check sync status across all connected platforms
      tags:
        - Sync
      responses:
        '200':
          description: Sync status
          content:
            application/json:
              schema:
                type: object
                properties:
                  platforms:
                    type: array
                    items:
                      type: object
                      properties:
                        platform:
                          type: string
                        status:
                          type: string
                        lastSyncedAt:
                          type: string
                          format: date-time
                        health:
                          type: string
                          enum: [healthy, warning, critical]

x-chatgpt-actions:
  - actionId: save_memory
    summary: "Save to Memory"
    description: "Remember this information for future conversations"
    operationId: createMemory
    prompt: |
      When the user wants to remember something important, use this action.
      Examples:
      - "Remember that I prefer TypeScript"
      - "Save this: I'm working on a healthcare project"
      - "Don't forget that my timezone is CET"

  - actionId: recall_memory
    summary: "Recall from Memory"
    description: "Search your saved memories"
    operationId: recallMemories
    prompt: |
      When you need to recall previously saved information, use this action.
      Examples:
      - "What do I know about the user's tech stack?"
      - "Find memories about their project preferences"
      - "What has the user told me about their goals?"
```

### 1.2 Custom GPT Configuration

```json
{
  "name": "HIVE-MIND Assistant",
  "description": "Your cross-platform memory assistant. Remembers context across conversations and platforms.",
  "instructions": "You are HIVE-MIND, a memory-aware AI assistant. You have access to a persistent memory system that stores user preferences, facts, and context across all AI platforms.\n\nWhen interacting:\n1. Always check relevant memories before responding to questions about the user\n2. Proactively save important information the user shares\n3. Reference memories naturally in conversation\n4. Ask for confirmation before saving sensitive information\n\nUse the available actions to save and recall memories seamlessly.",
  "conversation_starters": [
    "What do you remember about me?",
    "Save this preference for future conversations",
    "What was I working on last time?",
    "Help me remember important context"
  ],
  "capabilities": {
    "code_interpreter": false,
    "dalle": false,
    "actions": true
  },
  "metadata": {
    "privacy_policy_url": "https://hivemind.io/privacy",
    "contact_email": "support@hivemind.io"
  }
}
```

### 1.3 OAuth Flow Implementation

```typescript
// File: integrations/chatgpt/oauth-handler.ts

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../core/src/utils/logger';

const router = Router();

// OAuth state schema
const OAuthStateSchema = z.object({
  state: z.string(),
  redirectUri: z.string().url(),
  platformUserId: z.string(),
  platformSessionId: z.string().optional(),
});

/**
 * GET /integrations/chatgpt/oauth/authorize
 * Initiate OAuth flow from ChatGPT
 */
router.get('/oauth/authorize', async (req: Request, res: Response): Promise<void> => {
  const {
    state,
    redirect_uri,
    platform_user_id,
    platform_session_id,
  } = req.query;

  try {
    // Validate state
    const validatedState = OAuthStateSchema.parse({
      state,
      redirectUri: redirect_uri,
      platformUserId: platform_user_id,
      platformSessionId: platform_session_id,
    });

    // Store state in Redis for later verification
    await redis.setex(
      `oauth:chatgpt:${validatedState.state}`,
      600, // 10 minute expiry
      JSON.stringify(validatedState)
    );

    // Redirect to ZITADEL for authentication
    const authUrl = getZitadelClient().generateAuthUrl(
      validatedState.state,
      undefined // Optional organization ID
    );

    logger.info('ChatGPT OAuth initiated', {
      platformUserId: validatedState.platformUserId,
      state: validatedState.state,
    });

    res.redirect(authUrl);
  } catch (error) {
    logger.error('ChatGPT OAuth authorization failed', { error });
    res.status(400).send('Authorization failed');
  }
});

/**
 * GET /integrations/chatgpt/oauth/callback
 * OAuth callback from ZITADEL
 */
router.get('/oauth/callback', async (req: Request, res: Response): Promise<void> => {
  const { code, state, error } = req.query;

  try {
    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    // Retrieve stored state
    const storedStateJson = await redis.get(`oauth:chatgpt:${state}`);
    if (!storedStateJson) {
      throw new Error('Invalid or expired state');
    }

    const storedState = OAuthStateSchema.parse(JSON.parse(storedStateJson));

    // Exchange code for tokens
    const tokenSet = await getZitadelClient().exchangeCode(
      code as string,
      state as string
    );

    // Get user info
    const userInfo = await getZitadelClient().getUserInfo(
      tokenSet.access_token!
    );

    // Create or update platform integration
    const integration = await prisma.platformIntegration.upsert({
      where: {
        userId_platformType: {
          userId: userInfo.sub, // Map ZITADEL sub to our user ID
          platformType: 'chatgpt',
        },
      },
      update: {
        accessTokenEncrypted: encrypt(tokenSet.access_token!),
        refreshTokenEncrypted: tokenSet.refresh_token ? encrypt(tokenSet.refresh_token) : null,
        tokenExpiresAt: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
        platformUserId: storedState.platformUserId,
        lastSyncedAt: new Date(),
        syncStatus: 'idle',
      },
      create: {
        userId: userInfo.sub,
        platformType: 'chatgpt',
        platformUserId: storedState.platformUserId,
        platformDisplayName: userInfo.name,
        authType: 'oauth2',
        accessTokenEncrypted: encrypt(tokenSet.access_token!),
        refreshTokenEncrypted: tokenSet.refresh_token ? encrypt(tokenSet.refresh_token) : null,
        tokenExpiresAt: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
        oauthScopes: tokenSet.scope?.split(' ') ?? [],
        oauthGrantedAt: new Date(),
        isActive: true,
        syncStatus: 'idle',
      },
    });

    // Clean up state
    await redis.del(`oauth:chatgpt:${state}`);

    logger.info('ChatGPT OAuth completed', {
      userId: userInfo.sub,
      integrationId: integration.id,
    });

    // Redirect back to ChatGPT with success
    const redirectUrl = new URL(storedState.redirectUri);
    redirectUrl.searchParams.set('status', 'success');
    redirectUrl.searchParams.set('user_id', userInfo.sub);

    res.redirect(redirectUrl.toString());
  } catch (error) {
    logger.error('ChatGPT OAuth callback failed', { error });

    const redirectUrl = new URL(req.query.redirect_uri as string);
    redirectUrl.searchParams.set('status', 'error');
    redirectUrl.searchParams.set('error', String(error));

    res.redirect(redirectUrl.toString());
  }
});

/**
 * POST /integrations/chatgpt/oauth/refresh
 * Refresh OAuth tokens
 */
router.post('/oauth/refresh', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.body;

  try {
    // Get integration
    const integration = await prisma.platformIntegration.findFirst({
      where: {
        userId,
        platformType: 'chatgpt',
      },
    });

    if (!integration?.refreshTokenEncrypted) {
      throw new Error('No refresh token available');
    }

    // Refresh tokens
    const tokenSet = await getZitadelClient().refreshTokens(
      decrypt(integration.refreshTokenEncrypted)
    );

    // Update integration
    await prisma.platformIntegration.update({
      where: { id: integration.id },
      data: {
        accessTokenEncrypted: encrypt(tokenSet.access_token!),
        refreshTokenEncrypted: tokenSet.refresh_token ? encrypt(tokenSet.refresh_token) : null,
        tokenExpiresAt: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
        oauthLastRefreshed: new Date(),
      },
    });

    logger.info('ChatGPT tokens refreshed', { userId });

    res.json({ success: true });
  } catch (error) {
    logger.error('Token refresh failed', { userId, error });
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

export default router;
```

---

## 2. Claude Actions API Integration

### 2.1 System Prompt Configuration

```typescript
// File: integrations/claude/system-prompt.ts

export const CLAUDE_SYSTEM_PROMPT = `
You are an AI assistant with access to HIVE-MIND, a cross-platform memory system.

## Memory Integration

You have access to the user's saved memories, preferences, and context from previous conversations across all AI platforms (ChatGPT, Claude, etc.).

### When to Use Memory Tools:

1. **Before responding to personal questions**: Check if relevant memories exist
2. **When user shares important information**: Save it to memory
3. **When context seems familiar**: Search for related memories
4. **At conversation start**: Load relevant context automatically

### Memory Types:

- **fact**: Objective information (e.g., "User lives in Berlin")
- **preference**: User preferences (e.g., "Prefers TypeScript over JavaScript")
- **decision**: Decisions made (e.g., "Chose PostgreSQL for the database")
- **lesson**: Learned lessons (e.g., "Microservices added unnecessary complexity")
- **goal**: User goals (e.g., "Launch MVP by Q2 2024")
- **event**: Events (e.g., "Meeting with investor on March 15")
- **relationship**: Relationships (e.g., "Works with team of 5 developers")

### Response Format:

When referencing memories, do so naturally:
- "Based on what you've told me before about TypeScript..."
- "I recall you mentioned working on a healthcare project..."
- "You previously decided to use PostgreSQL, would you like to stick with that?"

### Privacy:

- Never reveal memory system internals
- Don't mention "HIVE-MIND" or "memory system" to users
- Treat memories as natural conversation context
- Ask before saving sensitive information
`;

export const CLAUDE_TOOL_DEFINITIONS = [
  {
    name: 'save_memory',
    description: 'Save important information to persistent memory',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember',
        },
        memoryType: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'],
          description: 'Type of memory',
        },
        title: {
          type: 'string',
          description: 'Short title for the memory',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall_memories',
    description: 'Search for relevant memories',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return',
          default: 10,
        },
        memoryTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by memory types',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context',
    description: 'Get all relevant context for current conversation',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic to filter context',
        },
      },
    },
  },
];
```

### 2.2 Claude Webhook Handler

```typescript
// File: integrations/claude/webhook-handler.ts

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { logger } from '../../core/src/utils/logger';
import { getMemoryService } from '../../core/src/services/memory.service';
import { getRecallService } from '../../core/src/services/recall.service';

const router = Router();

// Webhook payload schema
const ClaudeWebhookSchema = z.object({
  type: z.enum(['conversation.start', 'conversation.message', 'tool_call']),
  conversation_id: z.string(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    message: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.any()).optional(),
  }),
  signature: z.string(),
});

/**
 * POST /integrations/claude/webhook
 * Handle Claude webhook events
 */
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();

  try {
    // Verify webhook signature
    const signature = req.headers['x-claude-signature'] as string;
    const body = JSON.stringify(req.body);

    if (!verifyWebhookSignature(body, signature)) {
      logger.warning('Invalid webhook signature', { requestId });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse and validate payload
    const payload = ClaudeWebhookSchema.parse({
      ...req.body,
      signature,
    });

    logger.info('Claude webhook received', {
      requestId,
      type: payload.type,
      conversationId: payload.conversation_id,
      userId: payload.user_id,
    });

    // Handle different event types
    switch (payload.type) {
      case 'conversation.start':
        await handleConversationStart(payload, requestId);
        break;

      case 'conversation.message':
        await handleConversationMessage(payload, requestId);
        break;

      case 'tool_call':
        await handleToolCall(payload, requestId);
        break;
    }

    res.json({ status: 'processed', requestId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warning('Invalid webhook payload', { requestId, errors: error.errors });
      res.status(400).json({ error: 'Invalid payload', details: error.errors });
      return;
    }

    logger.error('Webhook processing failed', { requestId, error });
    res.status(500).json({ error: 'Processing failed', requestId });
  }
});

/**
 * Handle conversation start - inject context
 */
async function handleConversationStart(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  requestId: string
): Promise<void> {
  const memoryService = getMemoryService();
  const recallService = getRecallService();

  // Get relevant context for user
  const context = await recallService.getConversationContext({
    userId: payload.user_id,
    limit: 20,
  });

  // Store session context
  await prisma.session.create({
    data: {
      userId: payload.user_id,
      platformType: 'claude',
      platformSessionId: payload.conversation_id,
      memoriesInjected: context.memories.map(m => m.id),
      startedAt: new Date(payload.timestamp),
    },
  });

  logger.info('Conversation context injected', {
    requestId,
    memoryCount: context.memories.length,
  });
}

/**
 * Handle incoming message - check for memory-worthy content
 */
async function handleConversationMessage(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  requestId: string
): Promise<void> {
  const message = payload.payload.message;
  if (!message) return;

  // Analyze message for memory-worthy content
  const memoryService = getMemoryService();
  const suggestions = await memoryService.analyzeForMemories({
    userId: payload.user_id,
    message,
    conversationId: payload.conversation_id,
  });

  if (suggestions.length > 0) {
    // Store suggestions for model to use
    await redis.setex(
      `claude:memory-suggestions:${payload.conversation_id}`,
      300, // 5 minutes
      JSON.stringify(suggestions)
    );

    logger.info('Memory suggestions generated', {
      requestId,
      count: suggestions.length,
    });
  }
}

/**
 * Handle tool calls from Claude
 */
async function handleToolCall(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  requestId: string
): Promise<void> {
  const { tool_name, tool_input } = payload.payload;

  switch (tool_name) {
    case 'save_memory':
      await handleSaveMemory(payload, tool_input!, requestId);
      break;

    case 'recall_memories':
      await handleRecallMemories(payload, tool_input!, requestId);
      break;

    case 'get_context':
      await handleGetContext(payload, tool_input!, requestId);
      break;
  }
}

async function handleSaveMemory(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  input: Record<string, any>,
  requestId: string
): Promise<void> {
  const memoryService = getMemoryService();

  const memory = await memoryService.createMemory({
    userId: payload.user_id,
    content: input.content,
    memoryType: input.memoryType ?? 'fact',
    title: input.title,
    tags: input.tags,
    sourcePlatform: 'claude',
    sourceSessionId: payload.conversation_id,
  });

  logger.info('Memory saved via Claude', {
    requestId,
    memoryId: memory.id,
  });
}

async function handleRecallMemories(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  input: Record<string, any>,
  requestId: string
): Promise<void> {
  const recallService = getRecallService();

  const results = await recallService.search({
    userId: payload.user_id,
    query: input.query,
    limit: input.limit ?? 10,
    memoryTypes: input.memoryTypes,
  });

  // Store results for model
  await redis.setex(
    `claude:recall-results:${payload.conversation_id}:${requestId}`,
    300,
    JSON.stringify(results)
  );
}

async function handleGetContext(
  payload: z.infer<typeof ClaudeWebhookSchema>,
  input: Record<string, any>,
  requestId: string
): Promise<void> {
  const recallService = getRecallService();

  const context = await recallService.getConversationContext({
    userId: payload.user_id,
    topic: input.topic,
    limit: 20,
  });

  await redis.setex(
    `claude:context:${payload.conversation_id}`,
    600,
    JSON.stringify(context)
  );
}

/**
 * Verify HMAC webhook signature
 */
function verifyWebhookSignature(body: string, signature: string): boolean {
  const secret = process.env.CLAUDE_WEBHOOK_SECRET!;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

export default router;
```

---

## 3. Model Context Protocol (MCP) Server

### 3.1 MCP Server Implementation

```javascript
// File: mcp-server/mcp-server.js

const { Server } = require('@modelcontextprotocol/sdk/server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types');
const { z } = require('zod');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ==========================================
// MCP SERVER CONFIGURATION
// ==========================================

const server = new Server(
  {
    name: 'hivemind-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ==========================================
// TOOL DEFINITIONS
// ==========================================

const TOOLS = {
  save_memory: {
    name: 'save_memory',
    description: 'Save information to persistent cross-platform memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to remember',
        },
        memoryType: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'],
          description: 'Type of memory',
        },
        title: {
          type: 'string',
          description: 'Short descriptive title',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Categorization tags',
        },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance score (0-1)',
        },
      },
      required: ['content'],
    },
  },

  recall: {
    name: 'recall',
    description: 'Search and retrieve relevant memories',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum results',
        },
        memoryTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by memory types',
        },
        recencyBias: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description: 'Weight for recency in scoring',
        },
      },
      required: ['query'],
    },
  },

  list_memories: {
    name: 'list_memories',
    description: 'List all memories with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
        },
        memoryType: {
          type: 'string',
          enum: ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'],
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  },

  delete_memory: {
    name: 'delete_memory',
    description: 'Delete a memory by ID',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          format: 'uuid',
          description: 'ID of memory to delete',
        },
      },
      required: ['memoryId'],
    },
  },

  get_context: {
    name: 'get_context',
    description: 'Get all relevant context for current conversation',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic filter',
        },
      },
    },
  },
};

// ==========================================
// RESOURCE DEFINITIONS
// ==========================================

const RESOURCES = {
  'memories://recent': {
    uri: 'memories://recent',
    name: 'Recent Memories',
    description: 'Most recently accessed memories',
    mimeType: 'application/json',
  },
  'memories://favorites': {
    uri: 'memories://favorites',
    name: 'Favorite Memories',
    description: 'High-importance memories',
    mimeType: 'application/json',
  },
  'context://current': {
    uri: 'context://current',
    name: 'Current Context',
    description: 'Active conversation context',
    mimeType: 'application/xml',
  },
};

// ==========================================
// REQUEST HANDLERS
// ==========================================

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(TOOLS),
  };
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: Object.values(RESOURCES),
  };
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case 'memories://recent':
      const recent = await prisma.memory.findMany({
        where: { deletedAt: null },
        orderBy: { lastConfirmedAt: 'desc' },
        take: 10,
      });
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(recent, null, 2),
          },
        ],
      };

    case 'memories://favorites':
      const favorites = await prisma.memory.findMany({
        where: {
          importanceScore: { gte: 0.8 },
          deletedAt: null,
        },
        orderBy: { importanceScore: 'desc' },
        take: 10,
      });
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(favorites, null, 2),
          },
        ],
      };

    case 'context://current':
      // Return XML-formatted context
      return {
        contents: [
          {
            uri,
            mimeType: 'application/xml',
            text: getCurrentContextXml(),
          },
        ],
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`[MCP] Tool called: ${name}`, args);

  switch (name) {
    case 'save_memory':
      return await handleSaveMemory(args);

    case 'recall':
      return await handleRecall(args);

    case 'list_memories':
      return await handleListMemories(args);

    case 'delete_memory':
      return await handleDeleteMemory(args);

    case 'get_context':
      return await handleGetContext(args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ==========================================
// TOOL IMPLEMENTATIONS
// ==========================================

async function handleSaveMemory(args) {
  const { content, memoryType = 'fact', title, tags, importance = 0.5 } = args;

  const memory = await prisma.memory.create({
    data: {
      userId: getCurrentUserId(),
      content,
      memoryType,
      title,
      tags: tags || [],
      importanceScore: importance,
      sourcePlatform: 'mcp',
      documentDate: new Date(),
    },
  });

  // Generate and store embedding (async)
  generateAndStoreEmbedding(memory.id, content);

  return {
    content: [
      {
        type: 'text',
        text: `Memory saved successfully.\nID: ${memory.id}\nType: ${memoryType}`,
      },
    ],
  };
}

async function handleRecall(args) {
  const { query, limit = 10, memoryTypes, recencyBias = 0.5 } = args;

  // Vector search would go here
  const memories = await prisma.memory.findMany({
    where: {
      userId: getCurrentUserId(),
      memoryType: memoryTypes ? { in: memoryTypes } : undefined,
      deletedAt: null,
    },
    orderBy: { documentDate: 'desc' },
    take: limit,
  });

  return {
    content: [
      {
        type: 'text',
        text: `Found ${memories.length} memories:\n\n` +
          memories.map(m => `- [${m.memoryType}] ${m.title || m.content.substring(0, 100)}...`).join('\n'),
      },
    ],
  };
}

async function handleListMemories(args) {
  const { limit = 20, offset = 0, memoryType, tags } = args;

  const where = {
    userId: getCurrentUserId(),
    deletedAt: null,
    ...(memoryType && { memoryType }),
    ...(tags && { tags: { hasSome: tags } }),
  };

  const [memories, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.memory.count({ where }),
  ]);

  return {
    content: [
      {
        type: 'text',
        text: `Memories (${memories.length}/${total}):\n\n` +
          memories.map(m => `- ${m.id}: ${m.content.substring(0, 80)}...`).join('\n'),
      },
    ],
  };
}

async function handleDeleteMemory(args) {
  const { memoryId } = args;

  await prisma.memory.update({
    where: { id: memoryId },
    data: { deletedAt: new Date() },
  });

  return {
    content: [
      {
        type: 'text',
        text: `Memory ${memoryId} deleted successfully.`,
      },
    ],
  };
}

async function handleGetContext(args) {
  const { topic } = args;

  const contextXml = getCurrentContextXml(topic);

  return {
    content: [
      {
        type: 'text',
        text: contextXml,
      },
    ],
  };
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getCurrentUserId() {
  // In production, extract from authenticated session
  return process.env.CURRENT_USER_ID || 'anonymous';
}

async function generateAndStoreEmbedding(memoryId, content) {
  // Async embedding generation
  try {
    const response = await fetch('http://localhost:3000/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content }),
    });
    const { embedding } = await response.json();

    await prisma.vectorEmbedding.create({
      data: {
        memoryId,
        qdrantCollection: 'hivemind_memories',
        qdrantPointId: memoryId,
      },
    });

    // Upsert to Qdrant
    await fetch('http://localhost:6333/collections/hivemind_memories/points', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id: memoryId,
            vector: embedding,
            payload: {
              user_id: getCurrentUserId(),
              memory_id: memoryId,
              content,
            },
          },
        ],
      }),
    });
  } catch (error) {
    console.error('Failed to generate embedding:', error);
  }
}

function getCurrentContextXml(topic) {
  return `
<relevant-memories>
  <memory type="fact">
    <title>User Preferences</title>
    <content>Uses TypeScript for backend development</content>
    <date>2024-01-15</date>
  </memory>
  <memory type="preference">
    <title>Database Choice</title>
    <content>Prefers PostgreSQL over NoSQL solutions</content>
    <date>2024-01-10</date>
  </memory>
  ${topic ? `<topic-filter>${topic}</topic-filter>` : ''}
</relevant-memories>
`.trim();
}

// ==========================================
// SERVER STARTUP
// ==========================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP] HIVE-MIND MCP Server running on stdio');
}

main().catch((error) => {
  console.error('[MCP] Fatal error:', error);
  process.exit(1);
});

module.exports = { server, TOOLS, RESOURCES };
```

### 3.2 MCP Configuration File

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/path/to/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/hivemind",
        "QDRANT_URL": "http://localhost:6333",
        "CURRENT_USER_ID": "${USER_ID}"
      }
    }
  }
}
```

---

## 4. Universal Webhook Handler

### 4.1 HMAC Signing Implementation

```typescript
// File: integrations/webhooks/hmac-handler.ts

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../../core/src/utils/logger';

const router = Router();

// Webhook signature verification middleware
export function verifyWebhookSignature(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    const body = JSON.stringify(req.body);

    if (!signature || !timestamp) {
      logger.warning('Missing webhook signature headers');
      res.status(401).json({ error: 'Missing signature headers' });
      return;
    }

    // Check timestamp freshness (5 minute window)
    const now = Date.now();
    const webhookTime = parseInt(timestamp) * 1000;
    if (Math.abs(now - webhookTime) > 5 * 60 * 1000) {
      logger.warning('Webhook timestamp expired');
      res.status(401).json({ error: 'Expired timestamp' });
      return;
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      logger.warning('Invalid webhook signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  };
}

// Generate signature for outgoing webhooks
export function generateWebhookSignature(payload: any, secret: string): {
  signature: string;
  timestamp: number;
} {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return { signature, timestamp };
}

/**
 * POST /integrations/webhooks/:platform
 * Universal webhook endpoint for all platforms
 */
router.post('/:platform', async (req: Request, res: Response): Promise<void> => {
  const { platform } = req.params;
  const requestId = crypto.randomUUID();

  try {
    // Get platform-specific secret
    const platformSecret = getPlatformWebhookSecret(platform);
    if (!platformSecret) {
      res.status(404).json({ error: 'Platform not configured' });
      return;
    }

    // Verify signature
    verifyWebhookSignature(platformSecret)(req, res, async () => {
      // Process webhook
      const result = await processWebhook(platform, req.body, requestId);

      logger.info('Webhook processed', {
        requestId,
        platform,
        eventType: req.body.type,
      });

      res.json({ status: 'processed', requestId, result });
    });
  } catch (error) {
    logger.error('Webhook processing failed', { requestId, platform, error });
    res.status(500).json({ error: 'Processing failed', requestId });
  }
});

async function processWebhook(
  platform: string,
  payload: any,
  requestId: string
): Promise<any> {
  switch (platform) {
    case 'chatgpt':
      return await processChatGPTWebhook(payload, requestId);

    case 'claude':
      return await processClaudeWebhook(payload, requestId);

    case 'perplexity':
      return await processPerplexityWebhook(payload, requestId);

    case 'gemini':
      return await processGeminiWebhook(payload, requestId);

    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

async function processChatGPTWebhook(payload: any, requestId: string): Promise<any> {
  // Handle ChatGPT-specific webhook events
  const { type, conversation_id, user_id } = payload;

  switch (type) {
    case 'conversation.updated':
      await syncConversationState(user_id, conversation_id);
      break;

    case 'memory.requested':
      await provideMemoryContext(user_id, conversation_id);
      break;
  }

  return { processed: true };
}

async function processClaudeWebhook(payload: any, requestId: string): Promise<any> {
  // Handle Claude-specific webhook events
  const { type, message_id, user_id } = payload;

  switch (type) {
    case 'message.created':
      await analyzeMessageForMemories(user_id, message_id);
      break;
  }

  return { processed: true };
}

async function processPerplexityWebhook(payload: any, requestId: string): Promise<any> {
  // Handle Perplexity-specific events
  return { processed: true };
}

async function processGeminiWebhook(payload: any, requestId: string): Promise<any> {
  // Handle Gemini-specific events
  return { processed: true };
}

function getPlatformWebhookSecret(platform: string): string | null {
  const secrets: Record<string, string> = {
    chatgpt: process.env.CHATGPT_WEBHOOK_SECRET!,
    claude: process.env.CLAUDE_WEBHOOK_SECRET!,
    perplexity: process.env.PERPLEXITY_WEBHOOK_SECRET!,
    gemini: process.env.GEMINI_WEBHOOK_SECRET!,
  };

  return secrets[platform] || null;
}

async function syncConversationState(userId: string, conversationId: string): Promise<void> {
  // Update conversation state in database
  await prisma.session.upsert({
    where: { platformSessionId: conversationId },
    update: { lastActivityAt: new Date() },
    create: {
      userId,
      platformType: 'chatgpt',
      platformSessionId: conversationId,
      lastActivityAt: new Date(),
    },
  });
}

async function provideMemoryContext(userId: string, conversationId: string): Promise<void> {
  // Provide relevant memories for conversation
  const context = await getRecallService().getConversationContext({
    userId,
    limit: 10,
  });

  await redis.setex(
    `context:${conversationId}`,
    600,
    JSON.stringify(context)
  );
}

async function analyzeMessageForMemories(userId: string, messageId: string): Promise<void> {
  // Analyze message for memory-worthy content
  const message = await getMessageContent(messageId);
  const suggestions = await getMemoryService().analyzeForMemories({
    userId,
    message,
  });

  if (suggestions.length > 0) {
    await storeMemorySuggestions(messageId, suggestions);
  }
}

export default router;
```

---

## 5. Pre-Inference Recall Injection

### 5.1 XML Context Injection

```typescript
// File: integrations/context-injector.ts

import { logger } from '../core/src/utils/logger';

interface InjectionOptions {
  userId: string;
  conversationId?: string;
  topic?: string;
  maxMemories?: number;
  format?: 'xml' | 'json' | 'markdown';
  includeMetadata?: boolean;
}

interface InjectedContext {
  formatted: string;
  memoryIds: string[];
  tokenCount: number;
  injectedAt: Date;
}

/**
 * Generate pre-inference context for LLM consumption
 */
export async function injectRecallContext(
  options: InjectionOptions
): Promise<InjectedContext> {
  const {
    userId,
    conversationId,
    topic,
    maxMemories = 20,
    format = 'xml',
    includeMetadata = true,
  } = options;

  const startTime = Date.now();

  // Fetch relevant memories
  const memories = await fetchRelevantMemories({
    userId,
    topic,
    limit: maxMemories,
  });

  // Format based on requested format
  let formatted: string;
  switch (format) {
    case 'xml':
      formatted = formatAsXml(memories, includeMetadata);
      break;
    case 'json':
      formatted = formatAsJson(memories, includeMetadata);
      break;
    case 'markdown':
      formatted = formatAsMarkdown(memories, includeMetadata);
      break;
    default:
      formatted = formatAsXml(memories, includeMetadata);
  }

  // Calculate token count (approximate)
  const tokenCount = Math.ceil(formatted.length / 4);

  const result: InjectedContext = {
    formatted,
    memoryIds: memories.map(m => m.id),
    tokenCount,
    injectedAt: new Date(),
  };

  // Log injection
  logger.info('Context injected', {
    userId,
    conversationId,
    memoryCount: memories.length,
    tokenCount,
    latencyMs: Date.now() - startTime,
  });

  // Track injection for analytics
  if (conversationId) {
    await trackContextInjection(conversationId, result);
  }

  return result;
}

/**
 * Format memories as XML for LLM consumption
 */
function formatAsXml(memories: any[], includeMetadata: boolean): string {
  const xmlParts = memories.map(m => {
    const metadata = includeMetadata
      ? `
    <metadata>
      <type>${m.memoryType}</type>
      <importance>${m.importanceScore}</importance>
      <source>${m.sourcePlatform || 'unknown'}</source>
      <date>${m.documentDate?.toISOString() || m.createdAt.toISOString()}</date>
      ${m.tags?.length ? `<tags>${m.tags.join(', ')}</tags>` : ''}
    </metadata>`
      : '';

    return `  <memory id="${m.id}">
    <content>${escapeXml(m.content)}</content>
    ${m.title ? `    <title>${escapeXml(m.title)}</title>` : ''}
    ${metadata}
  </memory>`;
  });

  return `
<relevant-memories>
${xmlParts.join('\n')}
</relevant-memories>
`.trim();
}

/**
 * Format memories as JSON for LLM consumption
 */
function formatAsJson(memories: any[], includeMetadata: boolean): string {
  const formatted = memories.map(m => ({
    id: m.id,
    content: m.content,
    ...(m.title && { title: m.title }),
    ...(includeMetadata && {
      type: m.memoryType,
      importance: m.importanceScore,
      source: m.sourcePlatform,
      date: m.documentDate || m.createdAt,
      tags: m.tags,
    }),
  }));

  return JSON.stringify({ memories: formatted }, null, 2);
}

/**
 * Format memories as Markdown for LLM consumption
 */
function formatAsMarkdown(memories: any[], includeMetadata: boolean): string {
  const parts = memories.map(m => {
    const header = m.title || `[${m.memoryType}]`;
    const metadata = includeMetadata
      ? `\n> Type: ${m.memoryType} | Importance: ${m.importanceScore} | Date: ${m.documentDate?.toLocaleDateString()}`
      : '';

    return `### ${header}\n\n${m.content}${metadata}`;
  });

  return `## Relevant Context\n\n${parts.join('\n\n---\n\n')}`;
}

/**
 * Fetch relevant memories for context injection
 */
async function fetchRelevantMemories(options: {
  userId: string;
  topic?: string;
  limit: number;
}): Promise<any[]> {
  const { userId, topic, limit } = options;

  if (topic) {
    // Use vector search for topic-based retrieval
    const recallService = getRecallService();
    const results = await recallService.search({
      userId,
      query: topic,
      limit,
    });
    return results.results;
  }

  // Default: get recent high-importance memories
  const memories = await prisma.memory.findMany({
    where: {
      userId,
      isLatest: true,
      deletedAt: null,
    },
    orderBy: [
      { importanceScore: 'desc' },
      { documentDate: 'desc' },
    ],
    take: limit,
  });

  return memories;
}

/**
 * Track context injection for analytics
 */
async function trackContextInjection(
  conversationId: string,
  context: InjectedContext
): Promise<void> {
  await prisma.session.updateMany({
    where: { platformSessionId: conversationId },
    data: {
      memoriesInjected: context.memoryIds,
      contextWindowUsed: context.tokenCount,
      lastActivityAt: context.injectedAt,
    },
  });
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Middleware to inject context into LLM requests
 */
export function contextInjectionMiddleware(options: {
  format?: 'xml' | 'json' | 'markdown';
  maxTokens?: number;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      next();
      return;
    }

    try {
      const context = await injectRecallContext({
        userId,
        conversationId: req.body.conversation_id,
        topic: req.body.topic,
        format: options.format,
      });

      // Attach context to request
      req.injectedContext = context;

      // Check token limit
      if (options.maxTokens && context.tokenCount > options.maxTokens) {
        logger.warning('Context exceeds token limit', {
          tokenCount: context.tokenCount,
          limit: options.maxTokens,
        });
      }

      next();
    } catch (error) {
      logger.error('Context injection failed', { error });
      next(); // Continue without context
    }
  };
}
```

### 5.2 System Prompt Integration

```typescript
// File: integrations/system-prompts.ts

export const SYSTEM_PROMPT_WITH_CONTEXT = `
You are an AI assistant with access to the user's persistent memory context.

<instruction>
The following XML block contains relevant memories and context from previous conversations.
Use this information naturally in your responses without explicitly mentioning the memory system.

{INJECTED_CONTEXT}

When referencing this information:
1. Be natural and conversational
2. Don't say "according to your memories" or "the system shows"
3. Treat it as context you naturally remember from previous conversations
4. If the information seems outdated, gently confirm with the user
5. Never reveal the existence of the memory system itself
</instruction>

Proceed with the conversation using this context.
`;

export const SYSTEM_PROMPT_WITHOUT_CONTEXT = `
You are a helpful AI assistant. Engage naturally with the user.
If they share important information, you may suggest saving it for future reference.
`;

/**
 * Build system prompt with injected context
 */
export function buildSystemPrompt(context?: string): string {
  if (!context) {
    return SYSTEM_PROMPT_WITHOUT_CONTEXT;
  }

  return SYSTEM_PROMPT_WITH_CONTEXT.replace('{INJECTED_CONTEXT}', context);
}
```

---

## 6. Cross-Platform Handoff Tests

### 6.1 Test Script

```typescript
// File: tests/integration/cross-platform-handoff.test.ts

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_BASE = process.env.TEST_API_URL || 'http://localhost:3000';

describe('Cross-Platform Handoff', () => {
  let authToken: string;
  let userId: string;
  let testMemoryId: string;

  beforeAll(async () => {
    // Setup test user
    const user = await prisma.user.create({
      data: {
        zitadelUserId: `test-${Date.now()}`,
        email: `test-${Date.now()}@hivemind.io`,
      },
    });
    userId = user.id;
    authToken = await generateTestToken(userId);
  });

  afterAll(async () => {
    // Cleanup
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('Scenario 1: ChatGPT → Claude Handoff', () => {
    it('should recall memory saved from ChatGPT when querying from Claude', async () => {
      // Step 1: Save memory via ChatGPT action
      const saveResponse = await request(API_BASE)
        .post('/api/memories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          content: 'User prefers TypeScript for backend development',
          memoryType: 'preference',
          title: 'Backend Language Preference',
          tags: ['typescript', 'backend', 'programming'],
          sourcePlatform: 'chatgpt',
          sourceSessionId: 'chatgpt-session-123',
        });

      expect(saveResponse.status).toBe(201);
      testMemoryId = saveResponse.body.id;

      // Step 2: Query from Claude context
      const recallResponse = await request(API_BASE)
        .post('/api/recall')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          query: 'What programming language does the user prefer?',
          limit: 5,
          sourcePlatform: 'chatgpt', // Filter by source
        });

      expect(recallResponse.status).toBe(200);
      expect(recallResponse.body.results.length).toBeGreaterThan(0);
      expect(recallResponse.body.results[0].content).toContain('TypeScript');
    });
  });

  describe('Scenario 2: Claude → ChatGPT Handoff', () => {
    it('should recall memory saved from Claude when querying from ChatGPT', async () => {
      // Step 1: Save memory via Claude action
      const saveResponse = await request(API_BASE)
        .post('/api/memories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          content: 'User is working on a healthcare startup called MedTech',
          memoryType: 'fact',
          title: 'Current Project',
          tags: ['healthcare', 'startup', 'project'],
          sourcePlatform: 'claude',
          sourceSessionId: 'claude-session-456',
        });

      expect(saveResponse.status).toBe(201);

      // Step 2: Query from ChatGPT context
      const recallResponse = await request(API_BASE)
        .post('/api/recall')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          query: 'What is the user working on?',
          limit: 5,
        });

      expect(recallResponse.status).toBe(200);
      const found = recallResponse.body.results.some(
        (r: any) => r.content.includes('MedTech')
      );
      expect(found).toBe(true);
    });
  });

  describe('Scenario 3: Multi-Platform Sync', () => {
    it('should sync memories across all platforms in real-time', async () => {
      const platforms = ['chatgpt', 'claude', 'perplexity'];
      const memoryContents: string[] = [];

      // Save from each platform
      for (const platform of platforms) {
        const response = await request(API_BASE)
          .post('/api/memories')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            content: `Memory from ${platform}`,
            memoryType: 'fact',
            sourcePlatform: platform,
          });

        expect(response.status).toBe(201);
        memoryContents.push(response.body.content);
      }

      // Verify all memories visible from any platform
      const recallResponse = await request(API_BASE)
        .post('/api/recall')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          query: 'Memory from',
          limit: 10,
        });

      expect(recallResponse.status).toBe(200);
      expect(recallResponse.body.results.length).toBeGreaterThanOrEqual(3);

      // Check each platform's memory is present
      for (const content of memoryContents) {
        const found = recallResponse.body.results.some(
          (r: any) => r.content === content
        );
        expect(found).toBe(true);
      }
    });
  });

  describe('Scenario 4: Context Injection', () => {
    it('should inject relevant context in XML format', async () => {
      const contextResponse = await request(API_BASE)
        .get('/api/recall/context')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/xml');

      expect(contextResponse.status).toBe(200);
      expect(contextResponse.text).toContain('<relevant-memories>');
      expect(contextResponse.text).toContain('</relevant-memories>');
      expect(contextResponse.text).toContain(testMemoryId);
    });
  });

  describe('Scenario 5: Memory Updates Across Platforms', () => {
    it('should propagate memory updates to all platforms', async () => {
      // Create initial memory
      const createResponse = await request(API_BASE)
        .post('/api/memories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          content: 'Initial content',
          memoryType: 'fact',
          sourcePlatform: 'chatgpt',
        });

      const memoryId = createResponse.body.id;

      // Update memory
      const updateResponse = await request(API_BASE)
        .patch(`/api/memories/${memoryId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          content: 'Updated content from claude',
        });

      expect(updateResponse.status).toBe(200);

      // Verify update is visible
      const getResponse = await request(API_BASE)
        .get(`/api/memories/${memoryId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(getResponse.body.content).toBe('Updated content from claude');
      expect(getResponse.body.supersedesId).toBe(memoryId);
    });
  });
});

async function generateTestToken(userId: string): Promise<string> {
  // Generate JWT token for test user
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    {
      sub: userId,
      email: 'test@hivemind.io',
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}
```

### 6.2 E2E Test Configuration

```javascript
// File: tests/e2e/jest.config.js

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup.ts'],
  globalSetup: '<rootDir>/tests/e2e/global-setup.ts',
  globalTeardown: '<rootDir>/tests/e2e/global-teardown.ts',
  testTimeout: 30000,
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage-e2e',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/core/src/$1',
  },
};
```

---

## 7. Acceptance Criteria

### 7.1 Functional Requirements

| ID | Requirement | Test Method | Pass Criteria |
|----|-------------|-------------|---------------|
| INT-01 | ChatGPT OAuth flow completes | Manual OAuth test | Token stored in DB |
| INT-02 | Claude webhook receives events | Send test webhook | 200 response |
| INT-03 | MCP server responds to tools | MCP client test | Tool execution works |
| INT-04 | HMAC signature verification | Send invalid signature | 401 response |
| INT-05 | XML context injection works | Check LLM prompt | XML tags present |
| INT-06 | Cross-platform recall works | Handoff test script | Memory found |
| INT-07 | Memory updates propagate | Update test | New version visible |
| INT-08 | Webhook retry on failure | Simulate failure | Retry logged |

### 7.2 Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| OAuth flow time | <5s | Authorization to token |
| Webhook processing | <500ms | P99 latency |
| Context injection | <200ms | P99 latency |
| MCP tool response | <1s | P99 latency |

### 7.3 Security Requirements

| ID | Requirement | Verification |
|----|-------------|--------------|
| SEC-01 | OAuth tokens encrypted | Check DB encryption |
| SEC-02 | Webhook signatures validated | Test invalid signature |
| SEC-03 | Context injection sanitized | XSS test |
| SEC-04 | Platform isolation enforced | Cross-tenant test |

---

## 8. Testing Instructions

### 8.1 Unit Tests

```bash
# Run integration tests
npm run test:integration

# Run specific test file
npm run test:integration -- cross-platform-handoff.test.ts

# With coverage
npm run test:integration -- --coverage
```

### 8.2 Manual Testing

```bash
# Start test environment
docker-compose -f docker-compose.test.yml up -d

# Run OAuth flow test
./scripts/test-oauth-flow.sh

# Test webhook endpoints
curl -X POST http://localhost:3000/integrations/webhooks/claude \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: invalid" \
  -d '{"type": "test"}'

# Test MCP server
npx @modelcontextprotocol/inspector node mcp-server/mcp-server.js
```

### 8.3 Load Testing

```bash
# Test webhook throughput
k6 run tests/load/webhooks.js

# Test context injection
k6 run tests/load/context-injection.js
```

---

## 9. Environment Variables

```bash
# ChatGPT
CHATGPT_CLIENT_ID=your-client-id
CHATGPT_CLIENT_SECRET=your-client-secret
CHATGPT_REDIRECT_URI=https://api.hivemind.io/integrations/chatgpt/oauth/callback
CHATGPT_WEBHOOK_SECRET=your-webhook-secret

# Claude
CLAUDE_API_KEY=your-api-key
CLAUDE_WEBHOOK_SECRET=your-webhook-secret

# MCP
MCP_SERVER_PORT=3001

# General
JWT_SECRET=your-jwt-secret
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://user:pass@localhost:5432/hivemind
```

---

## 10. References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md)
- [ChatGPT Custom GPT Actions](https://platform.openai.com/docs/actions)
- [Claude Actions API](https://docs.anthropic.com/claude/docs/actions)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [HMAC Signing Best Practices](https://tools.ietf.org/html/rfc2104)

---

**Document Approval:**

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Integration Lead | | | |
| Security Engineer | | | |
| Backend Lead | | | |
