import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('AMR bootstrap creates document projection dependencies before foreign-key tables', () => {
  const source = fs.readFileSync(
    path.resolve('src/vector/mneme/embedded-agent.mjs'),
    'utf8',
  );
  const helper = source.indexOf('async function ensureKnowledgeProjectionDependencies');
  const documents = source.indexOf('CREATE TABLE IF NOT EXISTS hm.knowledge_documents', helper);
  const segments = source.indexOf('CREATE TABLE IF NOT EXISTS hm.knowledge_segments', helper);
  const invocation = source.indexOf('await ensureKnowledgeProjectionDependencies(db);');
  const mainSchemaQuery = source.indexOf('await db.query(`', invocation + 1);

  assert.ok(helper >= 0, 'bootstrap dependency helper is present');
  assert.ok(documents > helper, 'documents are created by the dependency helper');
  assert.ok(segments > documents, 'segments are created after documents');
  assert.ok(invocation > helper && invocation < mainSchemaQuery,
    'dependency helper runs before the schema DDL that adds foreign keys');
});
