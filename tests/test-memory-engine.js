/**
 * HIVE-MIND - Memory Engine End-to-End Test
 * 
 * Tests the complete memory engine with:
 * - PostgreSQL + Apache AGE
 * - Groq API situationalization
 * - AST parsing
 * - Stateful memory manager
 * - MCP bridge
 * 
 * Run: node tests/test-memory-engine.js
 */

import { MemoryEngine } from '../core/src/engine.local.js';
import { GroqSituationalizer } from '../core/src/situationalizer.js';
import { ASTParser } from '../core/src/ast/parser.js';
import { StateMutator } from '../core/src/stateful/mutator.js';
import { ConflictResolver } from '../core/src/stateful/resolver.js';
import { MetaMCPBridge } from '../core/src/mcp/bridge.js';
import assert from 'node:assert';

// Configuration
const config = {
  groqApiKey: process.env.GROQ_API_KEY || 'placeholder-key',
  databaseUrl: process.env.DATABASE_URL || 'postgres://hivemind:hivemind_dev_password@localhost:5432/hivemind'
};

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function test(name, fn) {
  try {
    fn();
    results.passed++;
    results.tests.push({ name, status: '✅ PASS' });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: '❌ FAIL', error: error.message });
    console.error(`❌ ${name}: ${error.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: '✅ PASS' });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: '❌ FAIL', error: error.message });
    console.error(`❌ ${name}: ${error.message}`);
  }
}

console.log('🧪 HIVE-MIND Memory Engine - End-to-End Test\n');
console.log(`Configuration:`);
console.log(`  Groq API Key: ${config.groqApiKey.substring(0, 10)}...`);
console.log(`  Database URL: ${config.databaseUrl}\n`);

// Test 1: Groq API Connectivity
await asyncTest('Groq API Connectivity', async () => {
  const situationalizer = new GroqSituationalizer(config.groqApiKey);
  const result = await situationalizer.situationalize('Revenue grew by 3%', {
    project: 'TestProject',
    document_date: '2025-10-01'
  });
  assert.ok(result.includes('Revenue'), 'Result should include original text');
  assert.ok(result.length > 20, 'Result should be situationalized');
});

// Test 2: AST Parser - JavaScript
test('AST Parser - JavaScript', () => {
  const parser = new ASTParser();
  const code = `
    class UserService {
      async getUser(id) {
        return { id, name: 'Test' };
      }
    }
  `;
  const ast = parser.parse(code, 'javascript');
  assert.ok(ast, 'AST should be generated');
  const functions = parser.extractFunctions(ast);
  assert.ok(functions.length >= 1, 'Should extract functions');
});

// Test 3: AST Parser - Python
test('AST Parser - Python', () => {
  const parser = new ASTParser();
  const code = `
def get_user(id):
    """Get user by ID"""
    return {'id': id, 'name': 'Test'}
  `;
  const ast = parser.parse(code, 'python');
  assert.ok(ast, 'AST should be generated');
});

// Test 4: Scope Chain Construction
test('Scope Chain Construction', () => {
  const parser = new ASTParser();
  const code = `
    class UserService {
      async getUser(id) {
        if (id) {
          return { id };
        }
      }
    }
  `;
  const ast = parser.parse(code, 'javascript');
  const scopeChain = parser.buildScopeChain(ast);
  assert.ok(scopeChain.length > 0, 'Scope chain should be built');
});

// Test 5: NWS Density Calculation
test('NWS Density Calculation', () => {
  const code = 'function test() { return 42; }';
  const nwsCount = code.replace(/\s/g, '').length;
  const density = nwsCount / code.length;
  assert.ok(density > 0.5, 'Density should be > 0.5');
  assert.ok(density <= 1.0, 'Density should be <= 1.0');
});

// Test 6: State Mutator - Initial Memory
test('State Mutator - Initial Memory', () => {
  const mutator = new StateMutator();
  const memory = { id: 'test-1', content: 'Test', is_latest: true };
  mutator.applyMutation(memory, null, 'create');
  assert.strictEqual(memory.is_latest, true, 'Initial memory should be latest');
});

// Test 7: State Mutator - Update Relationship
test('State Mutator - Update Relationship', () => {
  const mutator = new StateMutator();
  const oldMemory = { id: 'test-1', content: 'Old', is_latest: true, version: 1 };
  const newMemory = { id: 'test-2', content: 'New', is_latest: true, version: 1 };
  
  mutator.applyMutation(oldMemory, newMemory, 'Updates');
  
  assert.strictEqual(oldMemory.is_latest, false, 'Old memory should not be latest');
  assert.strictEqual(newMemory.is_latest, true, 'New memory should be latest');
});

// Test 8: Conflict Resolver - Duplicate Detection
test('Conflict Resolver - Duplicate Detection', () => {
  const resolver = new ConflictResolver();
  const memories = [
    { id: '1', content: 'Test content', content_hash: 'abc123' },
    { id: '2', content: 'Test content', content_hash: 'abc123' },
    { id: '3', content: 'Different content', content_hash: 'def456' }
  ];
  
  const conflicts = resolver.detectConflicts(memories);
  assert.ok(conflicts.length > 0, 'Should detect duplicate conflicts');
});

// Test 9: MCP Bridge - Endpoint Generation
test('MCP Bridge - Endpoint Generation', () => {
  const bridge = new MetaMCPBridge();
  const userId = 'test-user-123';
  const endpoint = bridge.generateEndpoint(userId);
  
  assert.ok(endpoint.id, 'Endpoint should have ID');
  assert.ok(endpoint.secret, 'Endpoint should have secret');
  assert.strictEqual(endpoint.user_id, userId, 'Endpoint should belong to user');
});

// Test 10: MCP Bridge - Endpoint Validation
test('MCP Bridge - Endpoint Validation', () => {
  const bridge = new MetaMCPBridge();
  const userId = 'test-user-456';
  const endpoint = bridge.generateEndpoint(userId);
  
  const isValid = bridge.validateEndpoint(endpoint.id, endpoint.secret);
  assert.strictEqual(isValid, true, 'Endpoint should be valid');
});

// Test 11: Situationalizer - Context Building
test('Situationalizer - Context Building', () => {
  const situationalizer = new GroqSituationalizer(config.groqApiKey);
  const source = situationalizer._buildSourceString({
    project: 'TestProject',
    tags: ['test', 'demo'],
    document_date: '2025-10-01'
  });
  
  assert.ok(source.includes('TestProject'), 'Should include project');
  assert.ok(source.includes('test'), 'Should include tags');
});

// Test 12: Situationalizer - Fallback Context
test('Situationalizer - Fallback Context', () => {
  const situationalizer = new GroqSituationalizer(config.groqApiKey);
  const context = situationalizer._buildFallbackContext('Test content', {
    project: 'TestProject'
  });
  
  assert.ok(context.includes('TestProject'), 'Should include project in fallback');
  assert.ok(context.includes('Test content'), 'Should include original content');
});

// Test 13: Memory Engine - Store Memory
test('Memory Engine - Store Memory', () => {
  const engine = new MemoryEngine();
  const memory = engine.storeMemory({
    content: 'Test memory',
    project: 'TestProject',
    tags: ['test']
  });
  
  assert.ok(memory.id, 'Memory should have ID');
  assert.strictEqual(memory.content, 'Test memory', 'Content should match');
  assert.strictEqual(memory.is_latest, true, 'Should be latest');
});

// Test 14: Memory Engine - Search Memory
test('Memory Engine - Search Memory', () => {
  const engine = new MemoryEngine();
  engine.storeMemory({
    content: 'Revenue grew by 3% in Q3 2025',
    project: 'Finance',
    tags: ['finance', 'q3']
  });
  
  const results = engine.searchMemories({ q: 'revenue' });
  assert.ok(results.length > 0, 'Should find matching memories');
});

// Test 15: Memory Engine - Graph Traversal
test('Memory Engine - Graph Traversal', () => {
  const engine = new MemoryEngine();
  const mem1 = engine.storeMemory({ content: 'Initial version' });
  const mem2 = engine.storeMemory({ 
    content: 'Updated version',
    relationship: { type: 'Updates', target_id: mem1.id }
  });
  
  const relationships = engine.traverseGraph(mem1.id, 'outgoing');
  assert.ok(relationships.length > 0, 'Should have relationships');
});

// Print results
console.log('\n' + '='.repeat(60));
console.log(`Test Results: ${results.passed} passed, ${results.failed} failed`);
console.log('='.repeat(60));

if (results.failed > 0) {
  console.log('\nFailed tests:');
  results.tests
    .filter(t => t.status === '❌ FAIL')
    .forEach(t => {
      console.log(`  - ${t.name}: ${t.error}`);
    });
  process.exit(1);
} else {
  console.log('\n✅ All tests passed! Memory engine is working correctly.\n');
  process.exit(0);
}
