import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');

test('the hosted Workflow bridge is local-only, secret-authenticated, and path-bounded', () => {
  const start = source.indexOf('async function proxyLocalKnowledgeWorkflowToCore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const helper = source.slice(start, end);
  assert.match(helper, /HIVEMIND_LOCAL_MODE/);
  assert.match(helper, /KNOWLEDGE_INGEST_WORKFLOW_ENABLED/);
  assert.match(helper, /KNOWLEDGE_INGEST_WORKFLOW_SECRET/);
  assert.match(source, /internal\\\/knowledge-ingest\\\/v1\\\/jobs/);
  assert.doesNotMatch(source, /proxyLocalKnowledgeWorkflowToCore\(req, res, ['"]\/['"]\)/);
});
