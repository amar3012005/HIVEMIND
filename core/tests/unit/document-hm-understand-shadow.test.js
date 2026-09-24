import test from 'node:test';
import assert from 'node:assert/strict';
import { runHmUnderstandShadow } from '../../src/knowledge/enterprise/hm-understand-shadow.js';

test('shadow analysis writes only bounded tenant-scoped metrics and never candidate text', async () => {
  let saved;
  const analyzer = async ({ orgId, userId, segments }) => {
    assert.equal(orgId, 'org-local-test');
    assert.equal(userId, 'user-local-test');
    assert.equal(segments.length, 1);
    return { enabled: true, ok: true, result: {
      complete: true, content_hash: 'hash', pipeline_version: 'v1', model_versions: { entity: 'm@r' },
      totals: { blocks: 1, mentions: 1, candidates: 1 },
      blocks: [{ language: { primary: 'en' }, mentions: [{ text: 'private name', label: 'person' }],
        candidates: [{ kind: 'decision', text: 'private decision', qualifiers: ['reported'] }] }],
    } };
  };
  const db = { knowledgeDocument: { updateMany: async (input) => { saved = input; return { count: 1 }; } } };
  const result = await runHmUnderstandShadow({ analyzer, db, logger: { info() {}, warn() {} },
    userId: 'user-local-test', orgId: 'org-local-test', documentId: 'doc-local-test',
    sourceRevision: 'revision-1', filename: 'brief.txt', segments: [{ id: 's1', content: 'evidence' }],
    parseMetadata: { parser: 'fixture' },
  });

  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.analysis, null);
  assert.deepEqual(saved.where, { id: 'doc-local-test', userId: 'user-local-test', orgId: 'org-local-test' });
  assert.equal(saved.data.parseMetadata.parser, 'fixture');
  assert.equal(saved.data.parseMetadata.hm_understand_shadow.entity_label_counts.person, 1);
  assert.equal(saved.data.parseMetadata.hm_understand_shadow.candidate_qualifier_counts.reported, 1);
  assert.equal(JSON.stringify(saved).includes('private name'), false);
  assert.equal(JSON.stringify(saved).includes('private decision'), false);
});

test('shadow analysis outage degrades without interrupting ingestion', async () => {
  const result = await runHmUnderstandShadow({ analyzer: async () => { throw new Error('service unavailable'); },
    logger: { info() {}, warn() {} },
    userId: 'user-local-test', orgId: 'org-local-test', documentId: 'doc-local-test',
    sourceRevision: 'revision-1', segments: [],
  });
  assert.deepEqual(result, { receipt: { status: 'degraded', source_revision: 'revision-1' }, analysis: null });
});

test('shadow analysis never sends BYOD text to the shared analyzer', async () => {
  let called = false;
  const result = await runHmUnderstandShadow({
    analyzer: async () => { called = true; },
    isRemoteOrg: (orgId) => orgId === 'org-byod-test',
    userId: 'user-local-test', orgId: 'org-byod-test', documentId: 'doc-local-test',
    sourceRevision: 'revision-1', segments: [],
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('assisted analysis returns private result in process but persists only metrics', async () => {
  const privateResult = { complete: true, blocks: [{ block_id: 's1', candidates: [{ text: 'private text' }] }] };
  let saved;
  const result = await runHmUnderstandShadow({
    analyzer: async () => ({ enabled: true, mode: 'assisted', ok: true, result: privateResult }),
    db: { knowledgeDocument: { updateMany: async (input) => { saved = input; return { count: 1 }; } } },
    logger: { info() {}, warn() {} }, userId: 'user-local-test', orgId: 'org-local-test',
    documentId: 'doc-local-test', sourceRevision: 'revision-1', segments: [],
  });
  assert.equal(result.analysis, privateResult);
  assert.equal(JSON.stringify(saved).includes('private text'), false);
});
