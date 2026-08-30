import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourceFiles = [
  '../../src/connectors/runtime/index.js',
  '../../src/connectors/framework/sync-engine.js',
  '../../src/connectors/framework/webhook-processor.js',
  '../../src/connectors/providers/slack/adapter.js',
  '../../src/services/chat-ingest-distill.js',
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
