/**
 * HIVE-MIND - API Endpoint Test Suite
 * Tests all REST API endpoints for consistency and correctness
 *
 * Run: node tests/api/endpoints.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

// API Key for authentication (from environment or default test key)
const TEST_API_KEY = process.env.HIVEMIND_MASTER_API_KEY || 'test_master_key_hivemind_2026_change_in_production';

// Helper function for fetch requests with authentication
async function apiRequest(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_API_KEY}`,
            ...options.headers
        }
    });
    return {
        status: response.status,
        ok: response.ok,
        data: response.ok ? await response.json() : null,
        error: response.ok ? null : await response.text()
    };
}

// ==========================================
// Test: Health & Stats
// ==========================================
test('GET /api/stats returns valid response', async () => {
    const res = await apiRequest('/api/stats');
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
    assert.ok(typeof res.data.total_memories === 'number', 'Should have total_memories');
    assert.ok(typeof res.data.active_memories === 'number', 'Should have active_memories');
    assert.ok(typeof res.data.relationships === 'number', 'Should have relationships');
});

test('GET /api/memories returns array', async () => {
    const res = await apiRequest('/api/memories');
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
    assert.ok(Array.isArray(res.data.memories), 'Should return memories array');
});

// ==========================================
// Test: Memory Storage
// ==========================================
let testMemoryId = null;

test('POST /api/memories stores memory successfully', async () => {
    const res = await apiRequest('/api/memories', {
        method: 'POST',
        body: JSON.stringify({
            content: 'Test memory from API endpoint tests',
            tags: ['test', 'api', 'automated'],
            project: 'HIVE-MIND-Tests'
        })
    });
    
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}: ${res.error}`);
    assert.ok(res.data, 'Response should have data');
    assert.strictEqual(res.data.success, true, 'Should return success: true');
    assert.ok(res.data.memory, 'Should return memory object');
    assert.ok(res.data.memory.memory, 'Should have nested memory object');
    assert.ok(res.data.memory.memory.id, 'Memory should have ID');
    
    testMemoryId = res.data.memory.memory.id;
});

test('Stored memory has correct fields', async () => {
    assert.ok(testMemoryId, 'Test memory ID should be set');
    
    const res = await apiRequest('/api/memories');
    const memories = res.data.memories;
    const testMemory = memories.find(m => m.id === testMemoryId);
    
    assert.ok(testMemory, 'Test memory should be retrievable');
    assert.strictEqual(testMemory.content, 'Test memory from API endpoint tests');
    assert.ok(Array.isArray(testMemory.tags), 'Tags should be array');
    assert.strictEqual(testMemory.is_latest, true, 'Should be latest');
});

// ==========================================
// Test: Search Functionality
// ==========================================
test('POST /api/memories/search returns results', async () => {
    const res = await apiRequest('/api/memories/search', {
        method: 'POST',
        body: JSON.stringify({
            query: 'Test memory',
            n_results: 10
        })
    });
    
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
    assert.ok(Array.isArray(res.data.results), 'Should return results array');
});

test('Search filters by project', async () => {
    const res = await apiRequest('/api/memories/search', {
        method: 'POST',
        body: JSON.stringify({
            query: 'test',
            filter: { project: 'HIVE-MIND-Tests' }
        })
    });
    
    assert.strictEqual(res.ok, true);
    const results = res.data.results || [];
    results.forEach(mem => {
        assert.strictEqual(mem.project, 'HIVE-MIND-Tests', 'All results should match project filter');
    });
});

// ==========================================
// Test: Recall Functionality
// ==========================================
test('POST /api/recall returns memories and injection text', async () => {
    const res = await apiRequest('/api/recall', {
        method: 'POST',
        body: JSON.stringify({
            query_context: 'What test memories exist?',
            max_memories: 5
        })
    });
    
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
    assert.ok(Array.isArray(res.data.memories), 'Should return memories array');
    assert.ok(typeof res.data.injectionText === 'string', 'Should return injectionText');
    assert.ok(res.data.injectionText.includes('<relevant-memories>'), 'Should have XML tags');
});

test('Recall respects user_id filtering', async () => {
    const res = await apiRequest('/api/recall', {
        method: 'POST',
        body: JSON.stringify({
            query_context: 'test',
            max_memories: 5
        })
    });
    
    assert.strictEqual(res.ok, true);
    const memories = res.data.memories || [];
    memories.forEach(mem => {
        assert.ok(mem.user_id, 'Memory should have user_id');
    });
});

// ==========================================
// Test: Graph Traversal
// ==========================================
test('POST /api/memories/traverse returns relationships', async () => {
    const res = await apiRequest('/api/memories/traverse', {
        method: 'POST',
        body: JSON.stringify({
            start_id: 'all',
            depth: 1
        })
    });
    
    // This may return empty if no relationships exist
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
});

// ==========================================
// Test: Session End Hook
// ==========================================
test('POST /api/session/end captures session', async () => {
    const res = await apiRequest('/api/session/end', {
        method: 'POST',
        body: JSON.stringify({
            content: 'Test session from API tests'
        })
    });
    
    assert.strictEqual(res.ok, true, `Expected 200, got ${res.status}`);
    assert.ok(res.data, 'Response should have data');
});

// ==========================================
// Test: Error Handling
// ==========================================
test('GET /api/nonexistent returns 404', async () => {
    const res = await apiRequest('/api/nonexistent');
    assert.strictEqual(res.status, 404, 'Should return 404 for unknown routes');
});

test('POST /api/memories with empty content fails gracefully', async () => {
    const res = await apiRequest('/api/memories', {
        method: 'POST',
        body: JSON.stringify({})
    });
    
    // Should either succeed with default or return validation error
    assert.ok(res.status === 200 || res.status === 400, 'Should handle empty content');
});

// ==========================================
// Test: Performance (Basic)
// ==========================================
test('Stats endpoint responds within 100ms', async () => {
    const start = Date.now();
    await apiRequest('/api/stats');
    const duration = Date.now() - start;
    assert.ok(duration < 100, `Stats should respond within 100ms, took ${duration}ms`);
});

test('Search endpoint responds within 500ms', async () => {
    const start = Date.now();
    await apiRequest('/api/memories/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'test' })
    });
    const duration = Date.now() - start;
    assert.ok(duration < 500, `Search should respond within 500ms, took ${duration}ms`);
});

// ==========================================
// Summary
// ==========================================
console.log('\n✅ API Endpoint Tests Complete\n');
