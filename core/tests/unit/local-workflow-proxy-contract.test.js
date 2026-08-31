import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');

test('the hosted Workflow bridge is environment-gated, secret-authenticated, and path-bounded', () => {
  const start = source.indexOf('async function proxyKnowledgeWorkflowToCore');
  const relativeEnd = source.slice(start).search(/\r?\n}\r?\n/);
  const end = relativeEnd < 0 ? -1 : start + relativeEnd;
  assert.ok(start > 0 && end > start);
  const helper = source.slice(start, end);
  assert.match(helper, /knowledgeWorkflowEnabled/);
  assert.match(helper, /KNOWLEDGE_INGEST_WORKFLOW_SECRET/);
  assert.match(source, /import \{ knowledgeWorkflowEnabled \}/);
  assert.match(source, /internal\\\/knowledge-ingest\\\/v1\\\/jobs/);
  assert.match(source, /materialize\(\?:\\\/\(\?:start\|status\)\)\?/,
    'the bounded bridge must admit the durable dispatch and polling endpoints');
  assert.doesNotMatch(source, /proxyKnowledgeWorkflowToCore\(req, res, ['"]\/['"]\)/);
});

test('canonical projection bridge preserves signed bytes and cannot proxy arbitrary paths', () => {
  const start = source.indexOf('async function proxyCanonicalProjectionToCore');
  const relativeEnd = source.slice(start).search(/\r?\n}\r?\n/);
  const end = relativeEnd < 0 ? -1 : start + relativeEnd;
  const helper = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(helper, /x-hivemind-content-sha256/);
  assert.match(helper, /x-hivemind-signature/);
  assert.match(helper, /Buffer\.concat\(chunks\)/);
  assert.match(source, /internal\\\/canonical-projection\\\/v1\\\/memories/);
  assert.doesNotMatch(source, /proxyCanonicalProjectionToCore\(req, res, ['"]\/['"]\)/);
});
