/**
 * Cross-Platform Handoff Test Suite
 * 
 * Tests memory synchronization and context preservation
 * across ChatGPT, Claude, MCP, and other AI platforms
 * 
 * @module tests/cross-platform/test-handoff
 */

import { strict as assert } from 'assert';
import { v4 as uuidv4 } from 'uuid';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  apiBaseUrl: process.env.HIVEMIND_API_URL || 'http://localhost:3000',
  testUserId: process.env.TEST_USER_ID || `test-user-${Date.now()}`,
  testApiKey: process.env.TEST_API_KEY || 'test-api-key',
  timeout: 30000,
  platforms: ['chatgpt', 'claude', 'mcp', 'perplexity']
};

// ==========================================
// Test Utilities
// ==========================================

const logger = {
  info: (msg) => console.log(`[TEST INFO] ${msg}`),
  pass: (msg) => console.log(`✓ [PASS] ${msg}`),
  fail: (msg) => console.error(`✗ [FAIL] ${msg}`),
  error: (msg, err) => console.error(`✗ [ERROR] ${msg}: ${err.message}`)
};

/**
 * Make API request
 */
async function apiRequest(method, path, body = null, authToken = null) {
  const url = new URL(path, CONFIG.apiBaseUrl);
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'HIVE-MIND-Test-Suite/1.0'
    }
  };

  if (authToken) {
    options.headers['Authorization'] = `Bearer ${authToken}`;
  } else if (CONFIG.testApiKey) {
    options.headers['X-API-Key'] = CONFIG.testApiKey;
  }

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${data.message || data.error || 'Unknown error'}`);
  }

  return data;
}

/**
 * Generate test token
 */
async function generateTestToken(userId) {
  // In production, this would use your JWT library
  // For testing, we use a simple token
  return Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@test.hivemind.io`,
    iat: Math.floor(Date.now() / 1000)
  })).toString('base64');
}

/**
 * Wait for condition
 */
async function waitForCondition(conditionFn, timeout = 5000, interval = 100) {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (await conditionFn()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  return false;
}

// ==========================================
// Test Fixtures
// ==========================================

const testMemories = {
  typescriptPreference: {
    content: 'User prefers TypeScript for backend development',
    memoryType: 'preference',
    title: 'Backend Language Preference',
    tags: ['typescript', 'backend', 'programming'],
    importanceScore: 0.8
  },
  healthcareProject: {
    content: 'User is working on a healthcare startup called MedTech',
    memoryType: 'fact',
    title: 'Current Project',
    tags: ['healthcare', 'startup', 'project'],
    importanceScore: 0.9
  },
  postgresqlDecision: {
    content: 'User decided to use PostgreSQL for the database',
    memoryType: 'decision',
    title: 'Database Choice',
    tags: ['database', 'postgresql', 'infrastructure'],
    importanceScore: 0.7
  },
  microservicesLesson: {
    content: 'User learned that microservices added unnecessary complexity for their team size',
    memoryType: 'lesson',
    title: 'Architecture Lesson',
    tags: ['architecture', 'microservices', 'lessons'],
    importanceScore: 0.6
  },
  mvpGoal: {
    content: 'User aims to launch MVP by Q2 2024',
    memoryType: 'goal',
    title: 'MVP Launch Goal',
    tags: ['goal', 'mvp', 'timeline'],
    importanceScore: 0.85
  }
};

// ==========================================
// Test Cases
// ==========================================

/**
 * Test Suite: Cross-Platform Handoff
 */
export class CrossPlatformHandoffTests {
  constructor() {
    this.authToken = null;
    this.userId = null;
    this.createdMemoryIds = [];
    this.results = {
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: []
    };
  }

  /**
   * Setup test environment
   */
  async setup() {
    logger.info('Setting up test environment...');
    
    this.userId = CONFIG.testUserId;
    this.authToken = await generateTestToken(this.userId);

    logger.info(`Test user: ${this.userId}`);
    logger.info(`API Base: ${CONFIG.apiBaseUrl}`);
  }

  /**
   * Cleanup test data
   */
  async teardown() {
    logger.info('Cleaning up test data...');

    // Delete created memories
    for (const memoryId of this.createdMemoryIds) {
      try {
        await apiRequest('DELETE', `/memories/${memoryId}`, null, this.authToken);
        logger.pass(`Deleted memory ${memoryId}`);
      } catch (error) {
        logger.error(`Failed to delete memory ${memoryId}`, error);
      }
    }

    logger.info(`Test run complete: ${this.results.passed} passed, ${this.results.failed} failed`);
  }

  /**
   * Record test result
   */
  recordResult(testName, passed, error = null) {
    this.results.tests.push({
      name: testName,
      passed,
      error: error?.message,
      timestamp: new Date().toISOString()
    });

    if (passed) {
      this.results.passed++;
      logger.pass(testName);
    } else {
      this.results.failed++;
      logger.fail(`${testName}: ${error?.message}`);
    }
  }

  // ==========================================
  // Scenario 1: ChatGPT → Claude Handoff
  // ==========================================

  async testChatGPTToClaudeHandoff() {
    const testName = 'Scenario 1: ChatGPT → Claude Handoff';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Step 1: Save memory via ChatGPT action
      logger.info('Step 1: Creating memory from ChatGPT...');
      const createResponse = await apiRequest('POST', '/memories', {
        ...testMemories.typescriptPreference,
        sourcePlatform: 'chatgpt',
        sourceSessionId: `chatgpt-session-${uuidv4()}`
      }, this.authToken);

      assert.ok(createResponse.id, 'Memory ID should be returned');
      this.createdMemoryIds.push(createResponse.id);
      logger.pass(`Memory created: ${createResponse.id}`);

      // Step 2: Wait for embedding generation
      logger.info('Waiting for embedding generation...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 3: Query from Claude context
      logger.info('Step 2: Recalling memory from Claude context...');
      const recallResponse = await apiRequest('POST', '/recall', {
        query: 'What programming language does the user prefer for backend?',
        limit: 5,
        recencyBias: 0.3
      }, this.authToken);

      assert.ok(Array.isArray(recallResponse.results), 'Results should be an array');
      assert.ok(recallResponse.results.length > 0, 'Should find at least one result');
      
      const foundMemory = recallResponse.results.find(
        r => r.content.includes('TypeScript') && r.sourcePlatform === 'chatgpt'
      );
      
      assert.ok(foundMemory, 'Should find the ChatGPT-sourced memory');
      logger.pass(`Found memory from ChatGPT: ${foundMemory.id}`);

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 2: Claude → ChatGPT Handoff
  // ==========================================

  async testClaudeToChatGPTHandoff() {
    const testName = 'Scenario 2: Claude → ChatGPT Handoff';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Step 1: Save memory via Claude action
      logger.info('Step 1: Creating memory from Claude...');
      const createResponse = await apiRequest('POST', '/memories', {
        ...testMemories.healthcareProject,
        sourcePlatform: 'claude',
        sourceSessionId: `claude-session-${uuidv4()}`
      }, this.authToken);

      assert.ok(createResponse.id, 'Memory ID should be returned');
      this.createdMemoryIds.push(createResponse.id);
      logger.pass(`Memory created: ${createResponse.id}`);

      // Step 2: Query from ChatGPT context
      logger.info('Step 2: Recalling memory from ChatGPT context...');
      const recallResponse = await apiRequest('POST', '/recall', {
        query: 'What project is the user working on?',
        limit: 5
      }, this.authToken);

      assert.ok(Array.isArray(recallResponse.results), 'Results should be an array');
      
      const foundMemory = recallResponse.results.find(
        r => r.content.includes('MedTech') && r.sourcePlatform === 'claude'
      );
      
      assert.ok(foundMemory, 'Should find the Claude-sourced memory');
      logger.pass(`Found memory from Claude: ${foundMemory.id}`);

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 3: Multi-Platform Sync
  // ==========================================

  async testMultiPlatformSync() {
    const testName = 'Scenario 3: Multi-Platform Memory Aggregation';
    logger.info(`\n=== ${testName} ===`);

    try {
      const platforms = ['chatgpt', 'claude', 'mcp'];
      const createdMemories = [];

      // Step 1: Create memories from each platform
      logger.info('Step 1: Creating memories from multiple platforms...');
      for (const platform of platforms) {
        const createResponse = await apiRequest('POST', '/memories', {
          content: `Memory created from ${platform} platform`,
          memoryType: 'fact',
          title: `${platform} Test Memory`,
          tags: [platform, 'test'],
          sourcePlatform: platform,
          importanceScore: 0.5
        }, this.authToken);

        createdMemories.push(createResponse);
        this.createdMemoryIds.push(createResponse.id);
        logger.pass(`Created memory from ${platform}`);
      }

      // Step 2: Verify all memories visible from any platform
      logger.info('Step 2: Verifying cross-platform visibility...');
      const recallResponse = await apiRequest('POST', '/recall', {
        query: 'Memory created from platform',
        limit: 10
      }, this.authToken);

      assert.ok(recallResponse.results.length >= platforms.length, 
        `Should find at least ${platforms.length} memories`);

      // Check each platform's memory is present
      for (const platform of platforms) {
        const found = recallResponse.results.some(
          r => r.content.includes(platform) && r.sourcePlatform === platform
        );
        assert.ok(found, `Should find memory from ${platform}`);
        logger.pass(`Found memory from ${platform}`);
      }

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 4: Context Injection Format
  // ==========================================

  async testContextInjectionFormat() {
    const testName = 'Scenario 4: XML Context Injection';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Get context in XML format
      logger.info('Getting context in XML format...');
      const contextResponse = await apiRequest('POST', '/recall/context', {
        format: 'xml',
        maxMemories: 10
      }, this.authToken);

      assert.ok(contextResponse.formatted, 'Should return formatted context');
      assert.ok(contextResponse.formatted.includes('<relevant-memories>'), 
        'Should contain XML root element');
      assert.ok(contextResponse.formatted.includes('</relevant-memories>'), 
        'Should contain XML closing element');
      
      logger.pass('XML format is valid');

      // Verify memory IDs are included
      assert.ok(Array.isArray(contextResponse.memoryIds), 
        'Should include memory IDs array');
      
      logger.pass('Memory IDs included');

      // Verify token count
      assert.ok(typeof contextResponse.tokenCount === 'number', 
        'Should include token count');
      
      logger.pass(`Token count: ${contextResponse.tokenCount}`);

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 5: Memory Updates Propagation
  // ==========================================

  async testMemoryUpdatesPropagation() {
    const testName = 'Scenario 5: Memory Updates Across Platforms';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Step 1: Create initial memory
      logger.info('Step 1: Creating initial memory...');
      const createResponse = await apiRequest('POST', '/memories', {
        content: 'Initial content for update test',
        memoryType: 'fact',
        title: 'Update Test Memory',
        sourcePlatform: 'chatgpt'
      }, this.authToken);

      const memoryId = createResponse.id;
      this.createdMemoryIds.push(memoryId);
      logger.pass(`Created memory: ${memoryId}`);

      // Step 2: Update memory
      logger.info('Step 2: Updating memory...');
      const updateResponse = await apiRequest('PATCH', `/memories/${memoryId}`, {
        content: 'Updated content from claude platform'
      }, this.authToken);

      assert.ok(updateResponse.content.includes('Updated'), 
        'Content should be updated');
      
      logger.pass('Memory updated successfully');

      // Step 3: Verify update is visible
      logger.info('Step 3: Verifying update visibility...');
      const getResponse = await apiRequest('GET', `/memories/${memoryId}`, null, this.authToken);

      assert.strictEqual(getResponse.content, 'Updated content from claude platform',
        'Should return updated content');
      
      logger.pass('Update visible across platforms');

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 6: Memory Type Filtering
  // ==========================================

  async testMemoryTypeFiltering() {
    const testName = 'Scenario 6: Memory Type Filtering';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Create memories of different types
      logger.info('Creating memories of different types...');
      
      const preferenceMemory = await apiRequest('POST', '/memories', {
        ...testMemories.typescriptPreference,
        sourcePlatform: 'test'
      }, this.authToken);
      this.createdMemoryIds.push(preferenceMemory.id);

      const decisionMemory = await apiRequest('POST', '/memories', {
        ...testMemories.postgresqlDecision,
        sourcePlatform: 'test'
      }, this.authToken);
      this.createdMemoryIds.push(decisionMemory.id);

      // Test filtering by type
      logger.info('Testing type filtering...');
      const preferenceResults = await apiRequest('POST', '/recall', {
        query: 'programming language',
        memoryTypes: ['preference'],
        limit: 10
      }, this.authToken);

      const allPreferences = preferenceResults.results.every(
        r => r.memoryType === 'preference'
      );
      assert.ok(allPreferences, 'All results should be preferences');
      logger.pass('Preference filter works');

      const decisionResults = await apiRequest('POST', '/recall', {
        query: 'database',
        memoryTypes: ['decision'],
        limit: 10
      }, this.authToken);

      const allDecisions = decisionResults.results.every(
        r => r.memoryType === 'decision'
      );
      assert.ok(allDecisions, 'All results should be decisions');
      logger.pass('Decision filter works');

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 7: Scoring Algorithm
  // ==========================================

  async testScoringAlgorithm() {
    const testName = 'Scenario 7: Scoring Algorithm Verification';
    logger.info(`\n=== ${testName} ===`);

    try {
      // Create high-importance memory
      logger.info('Creating high-importance memory...');
      const highImportanceMemory = await apiRequest('POST', '/memories', {
        content: 'Critical system architecture decision',
        memoryType: 'decision',
        importanceScore: 0.95,
        sourcePlatform: 'test'
      }, this.authToken);
      this.createdMemoryIds.push(highImportanceMemory.id);

      // Create low-importance memory
      logger.info('Creating low-importance memory...');
      const lowImportanceMemory = await apiRequest('POST', '/memories', {
        content: 'Minor preference note',
        memoryType: 'preference',
        importanceScore: 0.2,
        sourcePlatform: 'test'
      }, this.authToken);
      this.createdMemoryIds.push(lowImportanceMemory.id);

      // Query and verify scoring
      logger.info('Verifying scoring...');
      const results = await apiRequest('POST', '/recall', {
        query: 'decision preference',
        limit: 10,
        recencyBias: 0.1 // Low recency bias to test importance weighting
      }, this.authToken);

      assert.ok(results.results.length >= 2, 'Should find both memories');
      
      // High importance should score higher with low recency bias
      const highImportanceResult = results.results.find(
        r => r.id === highImportanceMemory.id
      );
      const lowImportanceResult = results.results.find(
        r => r.id === lowImportanceMemory.id
      );

      if (highImportanceResult && lowImportanceResult) {
        assert.ok(
          highImportanceResult.score > lowImportanceResult.score,
          'High importance memory should score higher'
        );
        logger.pass('Importance weighting works correctly');
      }

      // Verify score breakdown exists
      assert.ok(results.results[0].scoreBreakdown, 
        'Score breakdown should be included');
      logger.pass('Score breakdown included');

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Scenario 8: Performance Test
  // ==========================================

  async testRecallPerformance() {
    const testName = 'Scenario 8: Recall Performance (P99 < 300ms)';
    logger.info(`\n=== ${testName} ===`);

    try {
      const iterations = 20;
      const latencies = [];

      logger.info(`Running ${iterations} recall queries...`);

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        
        await apiRequest('POST', '/recall', {
          query: 'test query ' + i,
          limit: 10
        }, this.authToken);
        
        const latency = Date.now() - start;
        latencies.push(latency);
      }

      // Calculate statistics
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.5)];
      const p95 = latencies[Math.floor(iterations * 0.95)];
      const p99 = latencies[Math.floor(iterations * 0.99)];
      const avg = latencies.reduce((a, b) => a + b, 0) / iterations;

      logger.info(`Latency - P50: ${p50}ms, P95: ${p95}ms, P99: ${p99}ms, Avg: ${avg}ms`);

      assert.ok(p99 < 300, `P99 latency (${p99}ms) should be < 300ms`);
      logger.pass(`P99 latency ${p99}ms meets SLA (< 300ms)`);

      this.recordResult(testName, true);
    } catch (error) {
      this.recordResult(testName, false, error);
    }
  }

  // ==========================================
  // Run All Tests
  // ==========================================

  async run() {
    logger.info('\n' + '='.repeat(60));
    logger.info('HIVE-MIND Cross-Platform Handoff Test Suite');
    logger.info('='.repeat(60));

    await this.setup();

    try {
      await this.testChatGPTToClaudeHandoff();
      await this.testClaudeToChatGPTHandoff();
      await this.testMultiPlatformSync();
      await this.testContextInjectionFormat();
      await this.testMemoryUpdatesPropagation();
      await this.testMemoryTypeFiltering();
      await this.testScoringAlgorithm();
      await this.testRecallPerformance();
    } finally {
      await this.teardown();
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total: ${this.results.tests.length}`);
    console.log(`Passed: ${this.results.passed}`);
    console.log(`Failed: ${this.results.failed}`);
    console.log(`Success Rate: ${(this.results.passed / this.results.tests.length * 100).toFixed(1)}%`);
    console.log('='.repeat(60));

    return this.results;
  }
}

// ==========================================
// Main Entry Point
// ==========================================

async function main() {
  const tests = new CrossPlatformHandoffTests();
  const results = await tests.run();

  // Exit with error code if any tests failed
  if (results.failed > 0) {
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1]?.includes('test-handoff')) {
  main().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
  });
}

export default CrossPlatformHandoffTests;
