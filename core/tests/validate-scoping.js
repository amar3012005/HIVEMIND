#!/usr/bin/env node
/**
 * Test Script: Memory Scoping Validation
 * 
 * Tests that:
 * 1. Schema has user_id, org_id, project fields
 * 2. API accepts and returns scoped data
 * 3. Validation rejects requests missing required fields
 * 
 * Usage: node tests/validate-scoping.js
 */

import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// Test schema fields
async function testSchemaFields() {
  console.log('\n📋 Testing Schema Fields...\n');
  
  // Read SQL schema
  const sqlSchemaPath = path.join(PROJECT_ROOT, 'src/db/schema.sql');
  const sqlSchema = fs.readFileSync(sqlSchemaPath, 'utf-8');
  
  // Read Prisma schema
  const prismaSchemaPath = path.join(PROJECT_ROOT, 'prisma/schema.prisma');
  const prismaSchema = fs.readFileSync(prismaSchemaPath, 'utf-8');
  
  // Test SQL schema
  console.log('SQL Schema (schema.sql):');
  const sqlHasUserId = sqlSchema.includes('user_id UUID NOT NULL');
  const sqlHasOrgId = sqlSchema.includes('org_id UUID');
  const sqlHasProject = sqlSchema.includes('project VARCHAR(255)');
  const sqlHasProjectIndex = sqlSchema.includes('idx_memories_project');
  
  console.log(`  ✓ user_id: ${sqlHasUserId ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ org_id: ${sqlHasOrgId ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ project: ${sqlHasProject ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ project index: ${sqlHasProjectIndex ? '✅ PRESENT' : '❌ MISSING'}`);
  
  // Test Prisma schema
  console.log('\nPrisma Schema (schema.prisma):');
  const prismaHasUserId = prismaSchema.includes('userId');
  const prismaHasOrgId = prismaSchema.includes('orgId');
  const prismaHasProject = prismaSchema.includes('project');
  const prismaHasProjectIndex = prismaSchema.includes('@@index([project])');
  
  console.log(`  ✓ userId: ${prismaHasUserId ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ orgId: ${prismaHasOrgId ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ project: ${prismaHasProject ? '✅ PRESENT' : '❌ MISSING'}`);
  console.log(`  ✓ project index: ${prismaHasProjectIndex ? '✅ PRESENT' : '❌ MISSING'}`);
  
  // Assertions
  assert.strictEqual(sqlHasUserId, true, 'SQL schema missing user_id');
  assert.strictEqual(sqlHasOrgId, true, 'SQL schema missing org_id');
  assert.strictEqual(sqlHasProject, true, 'SQL schema missing project');
  assert.strictEqual(sqlHasProjectIndex, true, 'SQL schema missing project index');
  assert.strictEqual(prismaHasUserId, true, 'Prisma schema missing userId');
  assert.strictEqual(prismaHasOrgId, true, 'Prisma schema missing orgId');
  assert.strictEqual(prismaHasProject, true, 'Prisma schema missing project');
  assert.strictEqual(prismaHasProjectIndex, true, 'Prisma schema missing project index');
  
  console.log('\n✅ All schema fields present!\n');
}

// Test validators
async function testValidators() {
  console.log('🔍 Testing Validators...\n');
  
  const { validateCreateMemory, validateSearchMemory } = await import('../src/api/validators/memory.validators.js');
  
  // Test valid memory creation
  console.log('Test: Valid memory creation');
  const validCreate = validateCreateMemory({
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    org_id: '660e8400-e29b-41d4-a716-446655440000',
    project: 'test-project',
    content: 'Test memory content'
  });
  
  console.log(`  Result: ${validCreate.success ? '✅ PASSED' : '❌ FAILED'}`);
  assert.strictEqual(validCreate.success, true, 'Valid memory creation should pass');
  
  // Test missing user_id
  console.log('Test: Missing user_id');
  const missingUserId = validateCreateMemory({
    org_id: '660e8400-e29b-41d4-a716-446655440000',
    content: 'Test memory'
  });
  
  console.log(`  Result: ${!missingUserId.success ? '✅ REJECTED (expected)' : '❌ ACCEPTED (should reject)'}`);
  assert.strictEqual(missingUserId.success, false, 'Should reject missing user_id');
  
  // Test missing org_id
  console.log('Test: Missing org_id');
  const missingOrgId = validateCreateMemory({
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    content: 'Test memory'
  });
  
  console.log(`  Result: ${!missingOrgId.success ? '✅ REJECTED (expected)' : '❌ ACCEPTED (should reject)'}`);
  assert.strictEqual(missingOrgId.success, false, 'Should reject missing org_id');
  
  // Test missing content
  console.log('Test: Missing content');
  const missingContent = validateCreateMemory({
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    org_id: '660e8400-e29b-41d4-a716-446655440000'
  });
  
  console.log(`  Result: ${!missingContent.success ? '✅ REJECTED (expected)' : '❌ ACCEPTED (should reject)'}`);
  assert.strictEqual(missingContent.success, false, 'Should reject missing content');
  
  // Test valid search
  console.log('Test: Valid search request');
  const validSearch = validateSearchMemory({
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    org_id: '660e8400-e29b-41d4-a716-446655440000',
    query: 'test query'
  });
  
  console.log(`  Result: ${validSearch.success ? '✅ PASSED' : '❌ FAILED'}`);
  assert.strictEqual(validSearch.success, true, 'Valid search should pass');
  
  console.log('\n✅ All validator tests passed!\n');
}

// Test engine scoping
async function testEngineScoping() {
  console.log('⚙️ Testing Engine Scoping...\n');
  
  const { MemoryEngine } = await import('../src/engine.local.js');
  const engine = new MemoryEngine();
  
  // Store memory with scoping
  console.log('Test: Store memory with full scoping');
  const result = await engine.storeMemory({
    content: 'Test memory with project',
    user_id: 'test-user-1',
    org_id: 'test-org-1',
    project: 'test-project-1'
  });
  
  console.log(`  Memory ID: ${result.memory.id}`);
  console.log(`  user_id: ${result.memory.user_id}`);
  console.log(`  org_id: ${result.memory.org_id}`);
  console.log(`  project: ${result.memory.project}`);
  
  assert.strictEqual(result.memory.user_id, 'test-user-1', 'user_id should match');
  assert.strictEqual(result.memory.org_id, 'test-org-1', 'org_id should match');
  assert.strictEqual(result.memory.project, 'test-project-1', 'project should match');
  console.log('  ✅ Memory stored with correct scoping\n');
  
  // Test search with scoping
  console.log('Test: Search respects scoping');
  const searchResults = await engine.searchMemories({
    query: 'test',
    user_id: 'test-user-1',
    org_id: 'test-org-1',
    project: 'test-project-1'
  });
  
  console.log(`  Results count: ${searchResults.length}`);
  assert.ok(searchResults.length > 0, 'Should find the memory');
  console.log('  ✅ Search respects scoping\n');
  
  // Test isolation - different user should not see memory
  console.log('Test: Multi-tenant isolation');
  const isolatedResults = await engine.searchMemories({
    query: 'test',
    user_id: 'different-user',
    org_id: 'different-org'
  });
  
  console.log(`  Results for different user: ${isolatedResults.length}`);
  assert.strictEqual(isolatedResults.length, 0, 'Should not see other user\'s memory');
  console.log('  ✅ Multi-tenant isolation works\n');
  
  // Skip engine.reset() as it may fail with null situationalizer
  // engine.reset();
  console.log('✅ All engine scoping tests passed!\n');
}

// Run all tests
async function runTests() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║   HIVE-MIND Memory Scoping Validation Tests              ║');
  console.log('║   Testing: user_id, org_id, project scoping              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  try {
    await testSchemaFields();
    await testValidators();
    await testEngineScoping();
    
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   ✅ ALL TESTS PASSED                                     ║');
    console.log('║                                                           ║');
    console.log('║   Schema: user_id ✅, org_id ✅, project ✅               ║');
    console.log('║   Validation: Required fields enforced ✅                 ║');
    console.log('║   Scoping: Multi-tenant isolation working ✅              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTests();
