#!/usr/bin/env node
/**
 * HIVE-MIND Phase 1 - Evidence Collection Setup
 * 
 * Creates the hivemind_evidence collection for document-backed memory architecture.
 * This collection stores KnowledgeSegment vectors for document evidence retrieval.
 * 
 * Schema:
 * - Vector: 1024-dim (Mistral mistral-embed or LiteLLM)
 * - Payload:
 *   * segment_id: UUID from knowledge_segments table
 *   * document_id: UUID from knowledge_documents table
 *   * user_id: tenant isolation
 *   * org_id: organization scope
 *   * document_type: KB, enterprise, etc.
 *   * chunk_index: position in source document
 *   * tags: user-defined tags
 *   * visibility: private | organization | public
 *   * created_at: timestamp
 * 
 * Usage: 
 *   node scripts/init-evidence-collection.js
 *   QDRANT_URL=https://... QDRANT_API_KEY=... node scripts/init-evidence-collection.js
 */

import fetch from 'node-fetch';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const API_KEY = process.env.QDRANT_API_KEY || '';
const EVIDENCE_COLLECTION = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';
const MEMORY_COLLECTION = process.env.MEMORY_QDRANT_COLLECTION || 'hivemind_memories';

const headers = {
  'Content-Type': 'application/json',
  ...(API_KEY && { 'api-key': API_KEY })
};

async function checkHealth() {
  console.log('🏥 Checking Qdrant health...');
  const response = await fetch(`${QDRANT_URL}/`);
  if (!response.ok) {
    throw new Error(`Qdrant is not healthy: ${response.status}`);
  }
  const data = await response.json();
  console.log(`✅ Qdrant is healthy (version ${data.version || 'unknown'})`);
}

async function collectionExists(collectionName) {
  const response = await fetch(`${QDRANT_URL}/collections/${collectionName}`, { headers });
  return response.ok;
}

async function createEvidenceCollection() {
  console.log(`📦 Creating evidence collection: ${EVIDENCE_COLLECTION}...`);
  
  if (await collectionExists(EVIDENCE_COLLECTION)) {
    console.log('ℹ️  Collection already exists, skipping creation');
    return false;
  }

  const config = {
    vectors: {
      size: parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10),
      distance: 'Cosine',
      on_disk: false  // Keep vectors in RAM for faster retrieval
    },
    shard_number: 1,
    replication_factor: 1,
    write_consistency_factor: 1,
    on_disk_payload: true,  // Payloads on disk to save RAM
    hnsw_config: {
      m: 16,
      ef_construct: 100,
      full_scan_threshold: 10000,
      max_indexing_threads: 2,
      on_disk: false
    },
    optimizers_config: {
      deleted_threshold: 0.2,
      vacuum_min_vector_number: 1000,
      default_segment_number: 4,
      max_segment_size: 100000,
      memmap_threshold: 10000,
      indexing_threshold: 10000,
      flush_interval_sec: 60,
      max_optimization_threads: 2
    },
    wal_config: {
      wal_capacity_mb: 32,
      wal_segments_ahead: 0
    },
    quantization_config: {
      scalar: {
        type: 'int8',
        quantile: 0.99,
        always_ram: true  // Quantized vectors in RAM for speed
      }
    }
  };
  
  const response = await fetch(`${QDRANT_URL}/collections/${EVIDENCE_COLLECTION}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(config)
  });
  
  if (response.ok) {
    console.log('✅ Evidence collection created successfully');
    return true;
  } else {
    const error = await response.json();
    throw new Error(`Failed to create collection: ${JSON.stringify(error)}`);
  }
}

async function createPayloadIndexes() {
  console.log('📇 Creating payload indexes for evidence collection...');
  
  const indexes = [
    { field_name: 'segment_id', field_schema: 'keyword', description: 'Knowledge segment UUID' },
    { field_name: 'document_id', field_schema: 'keyword', description: 'Source document UUID' },
    { field_name: 'user_id', field_schema: 'keyword', description: 'Tenant isolation (required)' },
    { field_name: 'org_id', field_schema: 'keyword', description: 'Organization scope' },
    { field_name: 'document_type', field_schema: 'keyword', description: 'KB | enterprise | ...' },
    { field_name: 'chunk_index', field_schema: 'integer', description: 'Position in source document' },
    { field_name: 'tags', field_schema: 'keyword', description: 'User-defined tags' },
    { field_name: 'visibility', field_schema: 'keyword', description: 'private | organization | public' },
    { field_name: 'created_at', field_schema: 'datetime', description: 'Timestamp' }
  ];
  
  for (const index of indexes) {
    const response = await fetch(
      `${QDRANT_URL}/collections/${EVIDENCE_COLLECTION}/index`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ field_name: index.field_name, field_schema: index.field_schema })
      }
    );
    
    if (response.ok) {
      console.log(`  ✅ Indexed: ${index.field_name} (${index.description})`);
    } else {
      const error = await response.json();
      const msg = error.status?.error || '';
      if (msg.includes('already exists') || msg.includes('exist')) {
        console.log(`  ℹ️  ${index.field_name}: already exists`);
      } else {
        console.log(`  ⚠️  ${index.field_name}: ${msg}`);
      }
    }
  }
}

async function verifyMemoryCollection() {
  console.log(`🔍 Verifying canonical memory collection: ${MEMORY_COLLECTION}...`);
  
  if (await collectionExists(MEMORY_COLLECTION)) {
    console.log('✅ Canonical memory collection exists');
    return true;
  } else {
    console.log('⚠️  Canonical memory collection NOT found');
    console.log(`   Run: node scripts/setup-qdrant.js to create ${MEMORY_COLLECTION}`);
    return false;
  }
}

async function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 Phase 1 Qdrant Setup Summary');
  console.log('='.repeat(60));
  
  const evidenceExists = await collectionExists(EVIDENCE_COLLECTION);
  const memoryExists = await collectionExists(MEMORY_COLLECTION);
  
  console.log(`Evidence Collection: ${EVIDENCE_COLLECTION}`);
  console.log(`  Status: ${evidenceExists ? '✅ Ready' : '❌ Missing'}`);
  console.log(`  Purpose: KnowledgeSegment vectors for document evidence retrieval`);
  console.log('');
  console.log(`Memory Collection: ${MEMORY_COLLECTION}`);
  console.log(`  Status: ${memoryExists ? '✅ Ready' : '❌ Missing'}`);
  console.log(`  Purpose: Canonical Memory vectors for promoted memories`);
  console.log('');
  
  if (evidenceExists && memoryExists) {
    console.log('✅ Phase 1 dual-collection architecture is ready!');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Enable feature flags in core/.env:');
    console.log('     ENABLE_DOCUMENT_FIRST_INGEST=true');
    console.log('     ENABLE_EVIDENCE_RECALL=true');
    console.log('  2. Restart HIVEMIND server: pm2 restart hivemind-core');
    console.log('  3. Test dual-write: curl -X POST http://localhost:2026/api/kb/upload');
  } else {
    console.log('⚠️  Setup incomplete. Missing collections detected.');
    if (!memoryExists) {
      console.log('   Run: node scripts/setup-qdrant.js');
    }
  }
  console.log('='.repeat(60));
}

async function main() {
  console.log('🚀 HIVE-MIND Phase 1 - Evidence Collection Initialization\n');
  
  try {
    await checkHealth();
    console.log('');
    
    await verifyMemoryCollection();
    console.log('');
    
    const created = await createEvidenceCollection();
    console.log('');
    
    if (created) {
      await createPayloadIndexes();
      console.log('');
    }
    
    await printSummary();
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
