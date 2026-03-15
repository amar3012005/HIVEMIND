#!/usr/bin/env node
/**
 * HIVE-MIND - Qdrant Collection Setup
 * 
 * Creates and configures the memories collection with:
 * - 1024-dim vectors (BGE-M3 embeddings)
 * - Cosine distance
 * - Multi-tenancy support (user_id filtering)
 * - Optimized HNSW index
 * - Payload indexing for fast filtering
 * 
 * Usage: node scripts/setup-qdrant.js
 */

import fetch from 'node-fetch';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:9200';
const API_KEY = process.env.QDRANT_API_KEY || 'dev_api_key_hivemind_2026';
const COLLECTION_NAME = 'hivemind_memories';

const headers = {
  'Content-Type': 'application/json',
  'api-key': API_KEY
};

async function checkHealth() {
  console.log('🏥 Checking Qdrant health...');
  const response = await fetch(`${QDRANT_URL}/`);
  if (!response.ok) {
    throw new Error(`Qdrant is not healthy: ${response.status}`);
  }
  console.log('✅ Qdrant is healthy');
}

async function createCollection() {
  console.log(`📦 Creating collection: ${COLLECTION_NAME}...`);
  
  const config = {
    vectors: {
      size: 1024,  // BGE-M3 / mistral-embed dimensions
      distance: 'Cosine'
    },
    shard_number: 1,
    replication_factor: 1,
    write_consistency_factor: 1,
    on_disk_payload: true,
    hnsw_config: {
      m: 16,
      ef_construct: 100,
      full_scan_threshold: 10000,
      on_disk: true
    },
    optimizers_config: {
      indexing_threshold: 20000,
      vacuum_min_vector_number: 1000,
      default_segment_number: 4
    },
    quantization_config: {
      scalar: {
        type: 'int8',
        quantile: 0.99,
        always_ram: false
      }
    }
  };
  
  const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(config)
  });
  
  if (response.ok) {
    console.log('✅ Collection created successfully');
  } else {
    const error = await response.json();
    if (error.status?.error?.includes('already exists')) {
      console.log('ℹ️  Collection already exists, skipping creation');
    } else {
      throw new Error(`Failed to create collection: ${JSON.stringify(error)}`);
    }
  }
}

async function createPayloadIndexes() {
  console.log('📇 Creating payload indexes...');
  
  const indexes = [
    { field_name: 'user_id', field_schema: 'keyword' },
    { field_name: 'org_id', field_schema: 'keyword' },
    { field_name: 'project', field_schema: 'keyword' },
    { field_name: 'tags', field_schema: 'keyword' },
    { field_name: 'is_latest', field_schema: 'bool' },
    { field_name: 'created_at', field_schema: 'datetime' },
    { field_name: 'document_date', field_schema: 'datetime' },
    { field_name: 'content_hash', field_schema: 'keyword' },
    { field_name: 'relationship_type', field_schema: 'keyword' },
    { field_name: 'importance_score', field_schema: 'float' },
    { field_name: 'decay_factor', field_schema: 'float' }
  ];
  
  for (const index of indexes) {
    const response = await fetch(
      `${QDRANT_URL}/collections/${COLLECTION_NAME}/index`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(index)
      }
    );
    
    if (response.ok) {
      console.log(`  ✅ Indexed: ${index.field_name}`);
    } else {
      const error = await response.json();
      console.log(`  ℹ️  ${index.field_name}: ${error.status?.error || 'exists'}`);
    }
  }
}

async function testEmbedding() {
  console.log('🧪 Testing Mistral AI embedding API...');
  
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠️  MISTRAL_API_KEY not set. Skipping embedding test.');
    console.log('  ℹ️  Set MISTRAL_API_KEY in .env to enable embeddings');
    return new Array(1024).fill(0).map(() => Math.random());
  }
  
  try {
    console.log('  📡 Sending request to Mistral API...');
    
    const response = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'mistral-embed',
        input: ['Test embedding for HIVE-MIND'],
        encoding_format: 'float'
      })
    });
    
    console.log(`  📊 Response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`  ❌ Response body: ${errorText}`);
      try {
        const error = JSON.parse(errorText);
        throw new Error(error.message || response.statusText);
      } catch {
        throw new Error(errorText || response.statusText);
      }
    }
    
    const result = await response.json();
    console.log(`  📦 Response: ${JSON.stringify(result, null, 2).substring(0, 200)}...`);
    
    const embedding = result.data?.[0]?.embedding;
    
    if (!embedding) {
      console.log(`  ❌ Full result: ${JSON.stringify(result)}`);
      throw new Error('No embedding returned');
    }
    
    console.log(`  ✅ Embedding dimensions: ${embedding.length}`);
    console.log(`  ✅ Model: mistral-embed (BGE-M3)`);
    console.log(`  ✅ Tokens used: ${result.usage?.total_tokens || 'N/A'}`);
    
    if (embedding.length !== 1024) {
      console.warn(`  ⚠️  Expected 1024 dimensions, got ${embedding.length}`);
    }
    
    return embedding;
  } catch (error) {
    console.error(`  ❌ Embedding test failed: ${error.message}`);
    console.log('  ℹ️  Check your MISTRAL_API_KEY and internet connection');
    return new Array(1024).fill(0).map(() => Math.random());
  }
}

async function testVectorSearch() {
  console.log('🔍 Testing vector search...');
  
  // Get a real embedding from Mistral
  const apiKey = process.env.MISTRAL_API_KEY;
  let testVector;
  
  if (apiKey) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'mistral-embed',
          input: ['Test vector for HIVE-MIND search'],
          encoding_format: 'float'
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        testVector = result.data?.[0]?.embedding;
      }
    } catch (error) {
      console.log('  ℹ️  Using random vector (Mistral API failed)');
    }
  }
  
  // Fallback to random vector
  if (!testVector) {
    testVector = new Array(1024).fill(0).map(() => Math.random());
  }
  
  const testPoint = {
    id: '123e4567-e89b-12d3-a456-426614174000',  // Valid UUID format
    vector: testVector,
    payload: {
      user_id: 'test-user',
      content: 'Test memory for validation',
      project: 'test',
      tags: ['test', 'validation'],
      is_latest: true,
      created_at: new Date().toISOString()
    }
  };
  
  // Upsert test point
  const upsertResponse = await fetch(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        points: [testPoint],
        wait: true
      })
    }
  );
  
  if (!upsertResponse.ok) {
    const error = await upsertResponse.json();
    throw new Error(`Failed to upsert test point: ${upsertResponse.status} - ${JSON.stringify(error)}`);
  }
  
  console.log('  ✅ Test point upserted');
  
  // Search for test point
  const searchResponse = await fetch(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        vector: testVector,
        limit: 1,
        with_payload: true,
        filter: {
          must: [
            { key: 'user_id', match: { value: 'test-user' } }
          ]
        }
      })
    }
  );
  
  if (!searchResponse.ok) {
    throw new Error(`Search failed: ${searchResponse.status}`);
  }
  
  const searchResult = await searchResponse.json();
  
  if (searchResult.result?.length > 0) {
    console.log('  ✅ Vector search working');
    console.log(`  📊 Score: ${searchResult.result[0].score}`);
  } else {
    console.warn('  ⚠️  No results returned');
  }
  
  // Delete test point
  await fetch(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        points: ['123e4567-e89b-12d3-a456-426614174000'],
        wait: true
      })
    }
  );
  
  console.log('  ✅ Test point cleaned up');
}

async function getCollectionInfo() {
  console.log('📊 Collection info:');
  
  const response = await fetch(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}`,
    { headers }
  );
  
  if (!response.ok) {
    console.log('  ❌ Could not retrieve collection info');
    return;
  }
  
  const info = await response.json();
  const data = info.result;
  
  console.log(`  Status: ${data.status}`);
  console.log(`  Vectors: ${data.config?.params?.vectors?.size || 'N/A'}`);
  console.log(`  Distance: ${data.config?.params?.vectors?.distance || 'N/A'}`);
  console.log(`  Points: ${data.points_count || 0}`);
  console.log(`  Indexed: ${data.indexed_vectors_count || 0}`);
}

async function main() {
  console.log('🚀 HIVE-MIND - Qdrant Setup\n');
  
  try {
    // Step 1: Check health
    await checkHealth();
    console.log('');
    
    // Step 2: Create collection
    await createCollection();
    console.log('');
    
    // Step 3: Create payload indexes
    await createPayloadIndexes();
    console.log('');
    
    // Step 4: Test embedding model
    await testEmbedding();
    console.log('');
    
    // Step 5: Test vector search
    await testVectorSearch();
    console.log('');
    
    // Step 6: Get collection info
    await getCollectionInfo();
    console.log('');
    
    console.log('✅ Qdrant setup complete!\n');
    console.log('Configuration:');
    console.log(`  Qdrant URL: ${QDRANT_URL}`);
    console.log(`  API Key: ${API_KEY}`);
    console.log(`  Collection: ${COLLECTION_NAME}`);
    console.log(`  Vector Size: 1024-dim (BGE-M3/mistral-embed)`);
    console.log(`  Embedding: Via API (Mistral AI or Groq)`);
    console.log('');
    
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

main();
