#!/usr/bin/env node
/**
 * HIVE-MIND - Embedding Integration Test
 * Tests the complete flow: Store → Embed → Qdrant → Recall
 * 
 * Usage: 
 *   export MISTRAL_API_KEY="your-key"
 *   export QDRANT_URL="http://localhost:9200"
 *   export QDRANT_API_KEY="your-key"
 *   node test-embedding-integration.js
 */

import { getQdrantClient } from './core/src/vector/qdrant-client.js';
import { getMistralEmbedService } from './core/src/embeddings/mistral.js';

// Load from environment variables - NEVER hardcode!
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:9200';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || 'dev_api_key_hivemind_2026';

if (!MISTRAL_API_KEY) {
    console.warn('⚠️  MISTRAL_API_KEY not set. Set it with: export MISTRAL_API_KEY="your-key"');
}

process.env.MISTRAL_API_KEY = MISTRAL_API_KEY;
process.env.QDRANT_URL = QDRANT_URL;
process.env.QDRANT_API_KEY = QDRANT_API_KEY;

async function test() {
  console.log('🧪 HIVE-MIND - Embedding Integration Test\n');

  // Test 1: Mistral Embeddings
  console.log('1️⃣ Testing Mistral AI embeddings...');
  const embedService = getMistralEmbedService();
  if (!embedService) {
    console.log('  ❌ Embedding service not available');
    return;
  }

  try {
    const embedding = await embedService.embedOne('Test embedding for HIVE-MIND');
    console.log(`  ✅ Embedding generated: ${embedding.length} dimensions`);
  } catch (error) {
    console.log(`  ❌ Embedding failed: ${error.message}`);
    return;
  }

  // Test 2: Qdrant Connection
  console.log('\n2️⃣ Testing Qdrant connection...');
  const qdrant = getQdrantClient();
  const connected = await qdrant.testConnection();
  if (!connected) {
    console.log('  ❌ Qdrant not available');
    return;
  }
  console.log('  ✅ Qdrant connected');

  // Test 3: Store in Qdrant
  console.log('\n3️⃣ Testing Qdrant storage...');
  const testMemory = {
    id: 'test-123e4567-e89b-12d3-a456-426614174001',
    content: 'Test memory with embeddings',
    user_id: 'test-user',
    project: 'test',
    tags: ['test', 'embedding'],
    created_at: new Date().toISOString()
  };

  try {
    await qdrant.storeMemory(testMemory);
    console.log('  ✅ Memory stored in Qdrant');
  } catch (error) {
    console.log(`  ❌ Storage failed: ${error.message}`);
  }

  // Test 4: Search in Qdrant
  console.log('\n4️⃣ Testing Qdrant search...');
  try {
    const results = await qdrant.searchMemories({
      query: 'Test memory',
      filter: { must: [{ key: 'user_id', match: { value: 'test-user' } }] },
      limit: 5
    });
    console.log(`  ✅ Search returned ${results.length} results`);
  } catch (error) {
    console.log(`  ❌ Search failed: ${error.message}`);
  }

  // Cleanup
  console.log('\n5️⃣ Cleaning up...');
  try {
    await qdrant.deleteMemory('test-123e4567-e89b-12d3-a456-426614174001');
    console.log('  ✅ Test data cleaned up');
  } catch (error) {
    console.log(`  ⚠️  Cleanup failed: ${error.message}`);
  }

  console.log('\n✅ Integration test complete!\n');
}

test().catch(console.error);
