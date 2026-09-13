import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourceFiles = [
  '../../src/connectors/runtime/index.js',
  '../../src/connectors/framework/sync-engine.js',
  '../../src/connectors/framework/webhook-processor.js',
  '../../src/connectors/providers/slack/adapter.js',
  '../../src/services/chat-ingest-distill.js',
  '../../src/ingestion/persistence.js',
];

test('connector and chat adapters cannot bypass the canonical ingestion funnel', () => {
  for (const relative of sourceFiles) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /ingestSource\(/, `${relative} must submit a canonical envelope`);
    assert.doesNotMatch(source, /(?:prisma|this\.prisma)\.memory\.(?:create|upsert|update)\(/,
      `${relative} must not persist memories directly`);
    assert.doesNotMatch(source, /canonicalEntity\.(?:create|upsert|update)\(/,
      `${relative} must not persist canonical entities directly`);
  }
});

test('legacy environment flags cannot fork canonical generation or Workflow admission', () => {
  const canonical = fs.readFileSync(new URL('../../src/knowledge/document-first-ingestion.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const workflow = fs.readFileSync(new URL('../../../workers/knowledge-ingest-lifecycle/src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(canonical, /KB_ENTITY_LINK_MODE|KB_ENRICH_ENABLED|KB_ALLOW_PER_FACT_LLM_LINKING|KB_ENABLE_ALGO_VERSION_EDGES/);
  assert.doesNotMatch(server, /V5_MEMORIES_CANONICAL/);
  assert.match(workflow, /const KNOWLEDGE_INGEST_FLAG = 'knowledge_ingest_workflow_v1'/);
  assert.equal((workflow.match(/knowledge_ingest_workflow_v1/g) || []).length, 1);
});
