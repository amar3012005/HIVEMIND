import assert from 'node:assert/strict';

const base = process.env.AGENT_URL || 'http://byod-agent:8787';
const token = process.env.AGENT_TOKEN || 'parity-token';
const org = process.env.ORG_ID || '00000000-0000-4000-8000-00000000c001';
const headers = { authorization: `Bearer ${token}`, 'x-org-id': org, 'content-type': 'application/json' };
const ids = {
  parent: '00000000-0000-4000-8000-00000000c101',
  claim: '00000000-0000-4000-8000-00000000c102',
  edge: '00000000-0000-4000-8000-00000000c103',
  document: '00000000-0000-4000-8000-00000000c201',
  segment: '00000000-0000-4000-8000-00000000c202',
};
const vector = (index) => Array.from({ length: 8 }, (_, position) => position === index ? 1 : 0);

async function call(path, body, customHeaders = headers) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: customHeaders, body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const health = await fetch(`${base}/health`).then(async (response) => ({ status: response.status, payload: await response.json() }));
assert.equal(health.status, 200);
assert.equal(health.payload.org, org);

const wrongToken = await call('/v1/stats', {}, { ...headers, authorization: 'Bearer wrong-token' });
assert.equal(wrongToken.status, 401);
const wrongOrg = await call('/v1/stats', {}, { ...headers, 'x-org-id': '00000000-0000-4000-8000-00000000ffff' });
assert.equal(wrongOrg.status, 403);

if (process.argv[2] === 'write') {
  assert.equal((await call('/v1/write', {
    record: {
      id: ids.parent, userId: '00000000-0000-4000-8000-00000000c301',
      title: 'Policy document', content: 'Document summary.', memoryType: 'summary',
      tags: ['document-summary'], layer: 'memory', isLatest: true, scope: 'organization',
      metadata: { source_metadata: { source_id: 'policy.md' } },
    }, vector: vector(0),
  })).payload.ok, true);
  assert.equal((await call('/v1/write', {
    record: {
      id: ids.claim, userId: '00000000-0000-4000-8000-00000000c301',
      title: 'Retention period', content: 'Records are retained for seven years.', memoryType: 'fact',
      tags: ['promoted-memory', 'entity:retention-policy'], layer: 'memory', isLatest: true,
      scope: 'organization', metadata: { segment_id: ids.segment, importance_score: 0.92 },
    }, vector: vector(1), rels: [{
      id: ids.edge, fromId: ids.claim, toId: ids.parent, type: 'PartOf', confidence: 1,
    }],
  })).payload.ok, true);
  assert.equal((await call('/v1/kb-doc', { doc: {
    id: ids.document, userId: '00000000-0000-4000-8000-00000000c301',
    filename: 'policy.md', contentType: 'text/markdown', status: 'ready', checksum: 'parity-checksum',
    metadata: { source_platform: 'knowledge_base', scope: 'organization' },
  } })).payload.ok, true);
  assert.equal((await call('/v1/kb-segment', { segment: {
    id: ids.segment, documentId: ids.document, userId: '00000000-0000-4000-8000-00000000c301',
    content: 'Records are retained for seven years.', contentHash: 'segment-hash', segmentIndex: 0,
    metadata: { source_start: 0, source_end: 38 },
  }, vector: vector(1) })).payload.ok, true);
}

const recalled = await call('/v1/recall', { vector: vector(1), limit: 5, filter: { layer: 'memory', is_latest: true } });
assert.equal(recalled.status, 200);
assert.equal(recalled.payload.results[0].id, ids.claim);
const hydrated = await call('/v1/hydrate', { ids: [ids.claim] });
assert.equal(hydrated.payload.memories[0].content, 'Records are retained for seven years.');
const evidence = await call('/v1/kb-recall', { vector: vector(1), limit: 5, documentId: ids.document });
assert.equal(evidence.payload.results[0].segment_id, ids.segment);
const evidenceHydrated = await call('/v1/kb-hydrate', { ids: [ids.segment] });
assert.equal(evidenceHydrated.payload.segments[0].content, 'Records are retained for seven years.');
const relationships = await call('/v1/mem-relationships', { memoryId: ids.claim });
assert.equal(relationships.payload.out[0].type, 'PartOf');
const stats = await call('/v1/stats', {});
assert.equal(stats.payload.memories, 2);
assert.equal(stats.payload.relationships, 1);

if (process.argv[2] === 'purge') {
  const purged = await call('/v1/purge', {});
  assert.equal(purged.status, 200);
  assert.equal(purged.payload.ok, true);

  const emptyStats = await call('/v1/stats', {});
  assert.deepEqual(emptyStats.payload, { memories: 0, relationships: 0 });
  assert.deepEqual((await call('/v1/hydrate', { ids: [ids.parent, ids.claim] })).payload.memories, []);
  assert.deepEqual((await call('/v1/kb-hydrate', { ids: [ids.segment] })).payload.segments, []);
  assert.deepEqual((await call('/v1/recall', {
    vector: vector(1), limit: 5, filter: { layer: 'memory', is_latest: true },
  })).payload.results, []);
  assert.deepEqual((await call('/v1/kb-recall', {
    vector: vector(1), limit: 5, documentId: ids.document,
  })).payload.results, []);
}

process.stdout.write(JSON.stringify({
  ok: true, phase: process.argv[2] || 'read', memories: stats.payload.memories, relationships: stats.payload.relationships,
  evidence: evidence.payload.results.length, auth: 'closed', orgIsolation: 'closed',
}));
