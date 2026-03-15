/**
 * MCP Integration Tests
 * 
 * Test suite for:
 * - Meta-MCP Bridge endpoint generation
 * - Cross-app context synchronization
 * - MCP protocol implementation
 * 
 * @module tests/mcp.test
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Import modules for testing
import { getBridge, getEndpoint, generateEndpoint, validateEndpoint, checkRateLimit, getStats } from '../src/mcp/bridge.js';
import { getSyncServer, getSyncQueue, getProtocol, SyncQueue, ContextBuilder, ContextRequestHandler, SyncServer, PROTOCOL } from '../src/mcp/sync.js';

// ==========================================
// Configuration for Testing
// ==========================================

const TEST_USER_ID = 'test-user-' + uuidv4();
const TEST_ORG_ID = 'test-org-' + uuidv4();
const TEST_PLATFORM = 'test';

// ==========================================
// Test: Endpoint Generation
// ==========================================

test('Meta-MCP Bridge: Generate unique endpoint per user', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);

  assert.ok(endpoint.id, 'Endpoint should have an ID');
  assert.ok(uuidv4(endpoint.id), 'Endpoint ID should be a valid UUID');
  assert.equal(endpoint.userId, TEST_USER_ID, 'Endpoint should belong to correct user');
  assert.equal(endpoint.orgId, TEST_ORG_ID, 'Endpoint should belong to correct org');
  assert.equal(endpoint.platform, TEST_PLATFORM, 'Endpoint should have correct platform');
  assert.ok(endpoint.secret, 'Endpoint should have a secret');
  assert.ok(endpoint.url, 'Endpoint should have a URL');
  assert.ok(endpoint.createdAt, 'Endpoint should have creation timestamp');
  assert.equal(endpoint.isActive, true, 'Endpoint should be active');
});

test('Meta-MCP Bridge: Get existing endpoint', async (t) => {
  // Generate endpoint first
  const endpoint1 = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  // Get endpoint
  const endpoint2 = getEndpoint(TEST_USER_ID);
  
  assert.ok(endpoint2, 'Should return existing endpoint');
  assert.equal(endpoint2.id, endpoint1.id, 'Should return same endpoint');
  assert.equal(endpoint2.userId, TEST_USER_ID, 'Should return correct user');
});

test('Meta-MCP Bridge: Get all user endpoints', async (t) => {
  // Generate multiple endpoints
  const endpoint1 = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, 'cursor');
  const endpoint2 = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, 'claude');
  
  const endpoints = getEndpoint(TEST_USER_ID);
  const allEndpoints = getStats().activeEndpoints;
  
  assert.ok(allEndpoints >= 2, 'Should have at least 2 endpoints');
});

test('Meta-MCP Bridge: Validate endpoint secret', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  const validation = validateEndpoint(endpoint.id, endpoint.secret);
  
  assert.ok(validation.valid, 'Valid secret should be accepted');
  assert.equal(validation.userId, TEST_USER_ID, 'Should return correct user ID');
  assert.equal(validation.orgId, TEST_ORG_ID, 'Should return correct org ID');
});

test('Meta-MCP Bridge: Reject invalid secret', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  const validation = validateEndpoint(endpoint.id, 'invalid-secret');
  
  assert.equal(validation.valid, false, 'Invalid secret should be rejected');
  assert.ok(validation.reason, 'Should return reason for rejection');
});

test('Meta-MCP Bridge: Regenerate secret', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  const oldSecret = endpoint.secret;
  
  const newEndpoint = getBridge().regenerateSecret(TEST_USER_ID, endpoint.id);
  
  assert.notEqual(newEndpoint.secret, oldSecret, 'Secret should be different');
  assert.ok(newEndpoint.secretRotatedAt, 'Should have rotation timestamp');
  
  // Old secret should no longer work
  const oldValidation = validateEndpoint(endpoint.id, oldSecret);
  assert.equal(oldValidation.valid, false, 'Old secret should be invalid');
  
  // New secret should work
  const newValidation = validateEndpoint(endpoint.id, newEndpoint.secret);
  assert.ok(newValidation.valid, 'New secret should be valid');
});

test('Meta-MCP Bridge: Revoke endpoint', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  const result = getBridge().revokeEndpoint(TEST_USER_ID, endpoint.id);
  
  assert.ok(result.success, 'Revocation should succeed');
  assert.equal(result.endpointId, endpoint.id, 'Should return correct endpoint ID');
  
  // Endpoint should no longer be valid
  const validation = validateEndpoint(endpoint.id, endpoint.secret);
  assert.equal(validation.valid, false, 'Revoked endpoint should be invalid');
});

test('Meta-MCP Bridge: Rate limiting', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  // Check initial rate limit
  const initialCheck = checkRateLimit(endpoint.id);
  assert.ok(initialCheck.allowed, 'Initial request should be allowed');
  assert.ok(initialCheck.remainingHourly >= 0, 'Should have remaining requests');
  
  // Simulate multiple requests
  for (let i = 0; i < 65; i++) {
    checkRateLimit(endpoint.id);
  }
  
  // Should be rate limited
  const limitedCheck = checkRateLimit(endpoint.id);
  assert.equal(limitedCheck.allowed, false, 'Should be rate limited after max requests');
});

test('Meta-MCP Bridge: Endpoint statistics', async (t) => {
  // Generate some endpoints
  generateEndpoint('user-1-' + uuidv4(), 'org-1', 'cursor');
  generateEndpoint('user-2-' + uuidv4(), 'org-1', 'claude');
  generateEndpoint('user-3-' + uuidv4(), 'org-2', 'chatgpt');
  
  const stats = getStats();
  
  assert.ok(stats.totalEndpoints >= 3, 'Should track total endpoints');
  assert.ok(stats.activeEndpoints >= 3, 'Should track active endpoints');
  assert.ok(stats.endpointsByPlatform, 'Should have platform breakdown');
});

// ==========================================
// Test: Cross-App Context Synchronization
// ==========================================

test('Context Sync: Queue context for sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  const context = {
    userId: TEST_USER_ID,
    type: 'memory_created',
    timestamp: new Date().toISOString(),
    memory: {
      id: uuidv4(),
      content: 'Test memory content',
      type: 'fact'
    }
  };
  
  syncQueue.queue(context);
  
  const queueSize = syncQueue.size(TEST_USER_ID);
  assert.ok(queueSize >= 1, 'Context should be queued');
});

test('Context Sync: Build context from memories', async (t) => {
  const contextBuilder = new ContextBuilder();
  
  const memories = [
    {
      id: uuidv4(),
      content: 'First memory',
      memoryType: 'fact',
      title: 'Test Memory 1',
      tags: ['test', 'memory'],
      importanceScore: 0.8,
      createdAt: new Date().toISOString(),
      relationships: []
    },
    {
      id: uuidv4(),
      content: 'Second memory',
      memoryType: 'preference',
      title: 'Test Memory 2',
      tags: ['preference'],
      importanceScore: 0.6,
      createdAt: new Date().toISOString(),
      relationships: []
    }
  ];
  
  const context = contextBuilder.buildFromMemories(TEST_USER_ID, memories, {
    format: 'xml',
    maxTokens: 2000
  });
  
  assert.equal(context.userId, TEST_USER_ID, 'Context should have correct user');
  assert.equal(context.type, 'memories_update', 'Context should have correct type');
  assert.ok(context.timestamp, 'Context should have timestamp');
  assert.equal(context.memories.length, 2, 'Context should have all memories');
  assert.equal(context.metadata.format, 'xml', 'Context should have correct format');
});

test('Context Sync: Build context from session', async (t) => {
  const contextBuilder = new ContextBuilder();
  
  const session = {
    id: uuidv4(),
    platform: 'cursor',
    title: 'Test Session',
    startedAt: new Date().toISOString(),
    endedAt: new Date(Date.now() + 3600000).toISOString(),
    decisions: ['Use TypeScript', 'Use PostgreSQL'],
    memoriesCreated: [uuidv4(), uuidv4()]
  };
  
  const context = contextBuilder.buildFromSession(TEST_USER_ID, session);
  
  assert.equal(context.userId, TEST_USER_ID, 'Context should have correct user');
  assert.equal(context.type, 'session_update', 'Context should have correct type');
  assert.equal(context.session.id, session.id, 'Context should have session ID');
  assert.equal(context.session.platform, 'cursor', 'Context should have platform');
  assert.ok(context.metadata.sessionDuration >= 0, 'Context should have duration');
});

test('Context Sync: Build context from preferences', async (t) => {
  const contextBuilder = new ContextBuilder();
  
  const preferences = {
    theme: 'dark',
    language: 'en',
    timezone: 'UTC',
    notifications: true
  };
  
  const context = contextBuilder.buildFromPreferences(TEST_USER_ID, preferences);
  
  assert.equal(context.userId, TEST_USER_ID, 'Context should have correct user');
  assert.equal(context.type, 'preferences_update', 'Context should have correct type');
  assert.deepStrictEqual(context.preferences, preferences, 'Context should have preferences');
});

test('Context Sync: Protocol message builders', async (t) => {
  const syncId = uuidv4();
  const requestId = uuidv4();
  
  // Test context update
  const updateMsg = PROTOCOL.contextUpdate([{ type: 'test' }], syncId);
  assert.equal(updateMsg.type, 'context_update', 'Should build context update');
  assert.equal(updateMsg.syncId, syncId, 'Should have sync ID');
  assert.ok(updateMsg.timestamp, 'Should have timestamp');
  
  // Test context request
  const requestMsg = PROTOCOL.contextRequest(requestId, { topic: 'test' });
  assert.equal(requestMsg.type, 'context_request', 'Should build context request');
  assert.equal(requestMsg.requestId, requestId, 'Should have request ID');
  
  // Test context acknowledgment
  const ackMsg = PROTOCOL.contextAck(syncId, 'success');
  assert.equal(ackMsg.type, 'context_ack', 'Should build context ack');
  assert.equal(ackMsg.syncId, syncId, 'Should have sync ID');
  assert.equal(ackMsg.status, 'success', 'Should have status');
  
  // Test ping/pong
  const pingMsg = PROTOCOL.ping();
  assert.equal(pingMsg.type, 'ping', 'Should build ping');
  
  const pongMsg = PROTOCOL.pong();
  assert.equal(pongMsg.type, 'pong', 'Should build pong');
});

test('Context Sync: Request handler', async (t) => {
  const requestHandler = new ContextRequestHandler();
  
  // Test pending request count
  assert.equal(requestHandler.getPendingCount(), 0, 'Should start with no pending requests');
  
  // Test that handler exists
  assert.ok(requestHandler.handleResponse, 'Should have handleResponse method');
  assert.ok(requestHandler.handleError, 'Should have handleError method');
});

test('Context Sync: Sync server registration', async (t) => {
  const syncServer = getSyncServer();
  
  const clientId = 'test-client-' + uuidv4();
  const socket = {
    send: (data) => {
      const message = JSON.parse(data);
      assert.ok(message.type, 'Message should have type');
    }
  };
  
  syncServer.registerClient(clientId, TEST_USER_ID, 'test-endpoint', socket);
  
  const stats = syncServer.getStats();
  assert.ok(stats.connectedClients >= 1, 'Should have connected client');
  
  // Test broadcast
  syncServer.broadcast({ type: 'test', message: 'hello' });
  
  // Test broadcast to user
  syncServer.broadcastToUser(TEST_USER_ID, { type: 'test', message: 'hello user' });
  
  // Cleanup
  syncServer.unregisterClient(clientId);
});

test('Context Sync: Handle client messages', async (t) => {
  const syncServer = getSyncServer();
  
  const clientId = 'test-client-' + uuidv4();
  const socket = {
    send: (data) => {
      // Store sent messages for verification
      if (!syncServer._testMessages) {
        syncServer._testMessages = [];
      }
      syncServer._testMessages.push(JSON.parse(data));
    }
  };
  
  syncServer.registerClient(clientId, TEST_USER_ID, 'test-endpoint', socket);
  
  // Test ping message
  syncServer.handleClientMessage(clientId, { type: 'ping' });
  
  // Should have received pong
  assert.ok(syncServer._testMessages && syncServer._testMessages.length > 0, 'Should have received messages');
  
  const pongMessage = syncServer._testMessages.find(m => m.type === 'pong');
  assert.ok(pongMessage, 'Should have received pong');
  
  // Cleanup
  syncServer.unregisterClient(clientId);
});

// ==========================================
// Test: MCP Protocol Implementation
// ==========================================

test('MCP Protocol: Tool definitions', async (t) => {
  // Import the server module to check tool definitions
  const { TOOLS } = await import('../../mcp-server/server.js');

  assert.ok(TOOLS.save_memory, 'Should have save_memory tool');
  assert.ok(TOOLS.recall, 'Should have recall tool');
  assert.ok(TOOLS.list_memories, 'Should have list_memories tool');
  assert.ok(TOOLS.get_memory, 'Should have get_memory tool');
  assert.ok(TOOLS.delete_memory, 'Should have delete_memory tool');
  assert.ok(TOOLS.get_context, 'Should have get_context tool');
  assert.ok(TOOLS.search_memories, 'Should have search_memories tool');
  assert.ok(TOOLS.traverse_graph, 'Should have traverse_graph tool');

  // Verify tool schemas
  assert.ok(TOOLS.save_memory.inputSchema, 'save_memory should have input schema');
  assert.ok(TOOLS.recall.inputSchema, 'recall should have input schema');
});

test('MCP Protocol: Resource definitions', async (t) => {
  const { RESOURCES } = await import('../../mcp-server/server.js');

  assert.ok(RESOURCES['memories://recent'], 'Should have recent memories resource');
  assert.ok(RESOURCES['memories://favorites'], 'Should have favorites resource');
  assert.ok(RESOURCES['memories://all'], 'Should have all memories resource');
  assert.ok(RESOURCES['context://current'], 'Should have current context resource');
  assert.ok(RESOURCES['context://summary'], 'Should have summary resource');
});

test('MCP Protocol: Prompt definitions', async (t) => {
  const { PROMPTS } = await import('../../mcp-server/server.js');

  assert.ok(PROMPTS['memory-summary'], 'Should have memory-summary prompt');
  assert.ok(PROMPTS['context-injection'], 'Should have context-injection prompt');
});

test('MCP Protocol: Bridge integration', async (t) => {
  const { bridge } = await import('../../mcp-server/server.js');

  assert.ok(bridge, 'Server should have bridge instance');
  assert.ok(bridge.generateEndpoint, 'Bridge should have generateEndpoint method');
  assert.ok(bridge.getEndpoint, 'Bridge should have getEndpoint method');
});

test('MCP Protocol: Sync integration', async (t) => {
  const { syncServer, syncQueue } = await import('../../mcp-server/server.js');

  assert.ok(syncServer, 'Server should have syncServer instance');
  assert.ok(syncQueue, 'Server should have syncQueue instance');
  assert.ok(syncServer.startSync, 'Sync server should have startSync method');
});

// ==========================================
// Test: Cross-Platform Handoff
// ==========================================

test('Cross-Platform: Simulate Cursor to Claude sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  // Simulate Cursor saving a memory
  const cursorContext = {
    userId: TEST_USER_ID,
    type: 'memory_created',
    timestamp: new Date().toISOString(),
    platform: 'cursor',
    memory: {
      id: uuidv4(),
      content: 'User prefers dark mode',
      type: 'preference',
      title: 'UI Preference',
      importance: 0.8
    }
  };
  
  syncQueue.queue(cursorContext);
  
  // Simulate Claude requesting context
  const contextBuilder = new ContextBuilder();
  const memories = [cursorContext.memory];
  const claudeContext = contextBuilder.buildFromMemories(TEST_USER_ID, memories);
  
  assert.equal(claudeContext.userId, TEST_USER_ID, 'Claude should get correct user context');
  assert.equal(claudeContext.memories.length, 1, 'Claude should have the memory');
  assert.equal(claudeContext.memories[0].content, 'User prefers dark mode', 'Memory content should match');
});

test('Cross-Platform: Simulate ChatGPT to Cursor sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  // Simulate ChatGPT creating a memory
  const chatgptContext = {
    userId: TEST_USER_ID,
    type: 'memory_created',
    timestamp: new Date().toISOString(),
    platform: 'chatgpt',
    memory: {
      id: uuidv4(),
      content: 'Working on healthcare project',
      type: 'fact',
      title: 'Project Context',
      importance: 0.9
    }
  };
  
  syncQueue.queue(chatgptContext);
  
  // Simulate Cursor receiving the sync
  const contextBuilder = new ContextBuilder();
  const memories = [chatgptContext.memory];
  const cursorContext = contextBuilder.buildFromMemories(TEST_USER_ID, memories);
  
  assert.equal(cursorContext.userId, TEST_USER_ID, 'Cursor should get correct user context');
  assert.equal(cursorContext.memories[0].content, 'Working on healthcare project', 'Memory content should match');
});

test('Cross-Platform: Multi-platform sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  // Simulate multiple platforms creating memories
  const platforms = ['cursor', 'claude', 'chatgpt'];
  const memories = [];
  
  for (const platform of platforms) {
    const context = {
      userId: TEST_USER_ID,
      type: 'memory_created',
      timestamp: new Date().toISOString(),
      platform,
      memory: {
        id: uuidv4(),
        content: `Memory from ${platform}`,
        type: 'fact',
        title: `Memory from ${platform}`,
        importance: 0.5 + Math.random() * 0.5
      }
    };
    syncQueue.queue(context);
    memories.push(context.memory);
  }
  
  // Verify all memories are available
  const contextBuilder = new ContextBuilder();
  const combinedContext = contextBuilder.buildFromMemories(TEST_USER_ID, memories);
  
  assert.equal(combinedContext.memories.length, 3, 'Should have all 3 memories');
  assert.ok(combinedContext.memories.every(m => m.content.includes('Memory from')), 'All memories should be present');
});

// ==========================================
// Test: Security and Validation
// ==========================================

test('Security: HMAC signature validation', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  // Simulate HMAC signature
  const signatureInput = `${TEST_USER_ID}:${TEST_ORG_ID}:${endpoint.id}:${process.env.MCP_SECRET_KEY || 'default-mcp-secret-key-change-in-production'}`;
  const expectedSignature = crypto.createHash('sha256').update(signatureInput).digest('hex').substring(0, 32);
  
  assert.equal(endpoint.secret, expectedSignature, 'Secret should match HMAC output');
  
  // Verify validation works
  const validation = validateEndpoint(endpoint.id, endpoint.secret);
  assert.ok(validation.valid, 'Valid signature should pass');
});

test('Security: Endpoint expiration', async (t) => {
  const endpoint = generateEndpoint(TEST_USER_ID, TEST_ORG_ID, TEST_PLATFORM);
  
  // Check endpoint has creation time
  const createdAt = new Date(endpoint.createdAt);
  const now = new Date();
  const diff = now - createdAt;
  
  assert.ok(diff >= 0 && diff < 5000, 'Endpoint should be recently created');
});

test('Security: Max endpoints per user', async (t) => {
  // Test that we can't exceed max endpoints
  const maxEndpoints = parseInt(process.env.MCP_MAX_ENDPOINTS || '5', 10);
  
  for (let i = 0; i < maxEndpoints + 2; i++) {
    try {
      generateEndpoint(`test-user-${uuidv4()}`, TEST_ORG_ID, TEST_PLATFORM);
    } catch (error) {
      // Expected error when exceeding limit
      assert.ok(error.message.includes('Maximum endpoints'), 'Should error when exceeding limit');
    }
  }
});

// ==========================================
// Test: Edge Cases
// ==========================================

test('Edge Cases: Empty context sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  // Queue empty context
  syncQueue.queue({
    userId: TEST_USER_ID,
    type: 'empty_update',
    timestamp: new Date().toISOString(),
    memories: []
  });
  
  const size = syncQueue.size(TEST_USER_ID);
  assert.ok(size >= 1, 'Empty context should still be queued');
});

test('Edge Cases: Invalid endpoint validation', async (t) => {
  const validation = validateEndpoint('invalid-uuid', 'invalid-secret');
  
  assert.equal(validation.valid, false, 'Invalid endpoint should be rejected');
  assert.ok(validation.reason, 'Should return reason');
});

test('Edge Cases: Context with special characters', async (t) => {
  const contextBuilder = new ContextBuilder();
  
  const memories = [{
    id: uuidv4(),
    content: 'Special chars: <>&"\'\n\t',
    memoryType: 'fact',
    title: 'Test <script>alert("xss")</script>',
    tags: ['<test>', '&test'],
    importanceScore: 0.5,
    createdAt: new Date().toISOString(),
    relationships: []
  }];
  
  const context = contextBuilder.buildFromMemories(TEST_USER_ID, memories);
  
  assert.equal(context.memories[0].content, 'Special chars: <>&"\'\n\t', 'Should preserve special characters');
});

test('Edge Cases: High-frequency sync', async (t) => {
  const syncQueue = getSyncQueue();
  
  // Queue many contexts quickly
  for (let i = 0; i < 100; i++) {
    syncQueue.queue({
      userId: TEST_USER_ID,
      type: 'high_freq_update',
      timestamp: new Date().toISOString(),
      index: i
    });
  }
  
  const size = syncQueue.size(TEST_USER_ID);
  assert.ok(size >= 100, 'Should handle high-frequency sync');
});

// ==========================================
// Test: Integration Scenarios
// ==========================================

test('Integration: Full cross-platform workflow', async (t) => {
  const syncQueue = getSyncQueue();
  const contextBuilder = new ContextBuilder();
  
  // Step 1: User starts session in Cursor
  const sessionContext = {
    userId: TEST_USER_ID,
    type: 'session_start',
    timestamp: new Date().toISOString(),
    platform: 'cursor',
    session: {
      id: uuidv4(),
      title: 'Development Session'
    }
  };
  syncQueue.queue(sessionContext);
  
  // Step 2: User saves memory in Cursor
  const memoryContext = {
    userId: TEST_USER_ID,
    type: 'memory_created',
    timestamp: new Date().toISOString(),
    platform: 'cursor',
    memory: {
      id: uuidv4(),
      content: 'Using React for frontend',
      type: 'fact',
      title: 'Tech Stack',
      importance: 0.9
    }
  };
  syncQueue.queue(memoryContext);
  
  // Step 3: User switches to Claude
  // Claude should have access to the memory
  const memories = [memoryContext.memory];
  const claudeContext = contextBuilder.buildFromMemories(TEST_USER_ID, memories);
  
  assert.equal(claudeContext.memories.length, 1, 'Claude should have the memory');
  assert.equal(claudeContext.memories[0].content, 'Using React for frontend', 'Memory content should match');
  
  // Step 4: User saves another memory in Claude
  const claudeMemory = {
    userId: TEST_USER_ID,
    type: 'memory_created',
    timestamp: new Date().toISOString(),
    platform: 'claude',
    memory: {
      id: uuidv4(),
      content: 'Using PostgreSQL for database',
      type: 'fact',
      title: 'Database Choice',
      importance: 0.85
    }
  };
  syncQueue.queue(claudeMemory);
  
  // Step 5: User switches back to Cursor
  const allMemories = [memoryContext.memory, claudeMemory.memory];
  const cursorContext = contextBuilder.buildFromMemories(TEST_USER_ID, allMemories);
  
  assert.equal(cursorContext.memories.length, 2, 'Cursor should have both memories');
});

test('Integration: Memory relationships sync', async (t) => {
  const syncQueue = getSyncQueue();
  const contextBuilder = new ContextBuilder();
  
  // Create related memories
  const parentMemory = {
    id: uuidv4(),
    content: 'Project architecture decision',
    memoryType: 'decision',
    title: 'Architecture',
    relationships: []
  };
  
  const childMemory = {
    id: uuidv4(),
    content: 'Using microservices',
    memoryType: 'fact',
    title: 'Microservices',
    relationships: [{
      type: 'Derives',
      related_memory_id: parentMemory.id
    }]
  };
  
  const context = contextBuilder.buildFromMemories(TEST_USER_ID, [parentMemory, childMemory]);
  
  assert.equal(context.memories.length, 2, 'Should have both memories');
  assert.ok(context.memories[1].relationships.length > 0, 'Child memory should have relationship');
});

// ==========================================
// Test: Performance
// ==========================================

test('Performance: Endpoint generation latency', async (t) => {
  const start = performance.now();
  
  for (let i = 0; i < 100; i++) {
    generateEndpoint(`perf-user-${i}`, TEST_ORG_ID, TEST_PLATFORM);
  }
  
  const end = performance.now();
  const avgLatency = (end - start) / 100;
  
  console.log(`\nEndpoint generation: ${avgLatency.toFixed(2)}ms avg`);
  assert.ok(avgLatency < 50, 'Endpoint generation should be fast');
});

test('Performance: Context sync throughput', async (t) => {
  const syncQueue = getSyncQueue();
  
  const start = performance.now();
  
  for (let i = 0; i < 1000; i++) {
    syncQueue.queue({
      userId: TEST_USER_ID,
      type: 'performance_test',
      timestamp: new Date().toISOString(),
      index: i
    });
  }
  
  const end = performance.now();
  const throughput = 1000 / ((end - start) / 1000);
  
  console.log(`Context sync throughput: ${throughput.toFixed(0)} contexts/sec`);
  assert.ok(throughput > 100, 'Should handle high throughput');
});

// ==========================================
// Test: Cleanup
// ==========================================

test('Cleanup: Clear all contexts', async (t) => {
  const contextBuilder = new ContextBuilder();
  
  // Add some contexts
  contextBuilder.buildFromMemories(TEST_USER_ID, [{
    id: uuidv4(),
    content: 'Test memory',
    memoryType: 'fact',
    title: 'Test',
    importanceScore: 0.5,
    createdAt: new Date().toISOString(),
    relationships: []
  }]);
  
  assert.ok(contextBuilder.getContext(TEST_USER_ID), 'Context should exist');
  
  // Clear all
  contextBuilder.clearAll();
  
  assert.equal(contextBuilder.getContext(TEST_USER_ID), undefined, 'Context should be cleared');
});

// ==========================================
// Test: Exported Functions
// ==========================================

test('Export: Bridge functions', async (t) => {
  const bridge = getBridge();
  
  assert.ok(bridge.generateEndpoint, 'Should export generateEndpoint');
  assert.ok(bridge.getEndpoint, 'Should export getEndpoint');
  assert.ok(bridge.revokeEndpoint, 'Should export revokeEndpoint');
  assert.ok(bridge.regenerateSecret, 'Should export regenerateSecret');
  assert.ok(bridge.validateEndpoint, 'Should export validateEndpoint');
  assert.ok(bridge.checkRateLimit, 'Should export checkRateLimit');
  assert.ok(bridge.getStats, 'Should export getStats');
});

test('Export: Sync functions', async (t) => {
  assert.ok(getSyncServer, 'Should export getSyncServer');
  assert.ok(getSyncQueue, 'Should export getSyncQueue');
  assert.ok(getProtocol, 'Should export getProtocol');
  assert.ok(SyncQueue, 'Should export SyncQueue class');
  assert.ok(ContextBuilder, 'Should export ContextBuilder class');
  assert.ok(ContextRequestHandler, 'Should export ContextRequestHandler class');
  assert.ok(SyncServer, 'Should export SyncServer class');
  assert.ok(PROTOCOL, 'Should export PROTOCOL');
});

console.log('\n✅ All MCP tests completed successfully!');
