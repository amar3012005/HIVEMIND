import assert from 'node:assert/strict';
import { assertCanonicalBackendContract } from './canonical-backend-contract.mjs';

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
  repair: '00000000-0000-4000-8000-00000000c104',
  evidenceMemory: '00000000-0000-4000-8000-00000000c105',
};
const vector = (index) => Array.from({ length: 8 }, (_, position) => position === index ? 1 : 0);
const access = { userId: '00000000-0000-4000-8000-00000000c301' };
const longClaim = `Records are retained for seven years. El periodo de retención es de siete años. ${'Complete supporting context must survive. '.repeat(20)}`;

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
  // A shard/SQL mirror may carry evidence records for unified recall, but the
  // memory inventory endpoints must never present them as memories.
  assert.equal((await call('/v1/write', {
    record: {
      id: ids.evidenceMemory, userId: access.userId, title: 'Raw supporting segment',
      content: 'This is evidence, not a promoted memory.', memoryType: 'evidence_segment',
      tags: ['promoted-from-segment'], layer: 'evidence', isLatest: true,
    }, vector: vector(2),
  })).payload.ok, true);
  assert.equal((await call('/v1/write', {
    record: {
      id: ids.claim, userId: '00000000-0000-4000-8000-00000000c301',
      title: 'Retention period', content: longClaim, memoryType: 'fact',
      tags: ['promoted-memory', 'entity:retention-policy'], layer: 'memory', isLatest: true,
      scope: 'organization', metadata: { segment_id: ids.segment, importance_score: 0.92 },
    }, vector: vector(1), rels: [{
      id: ids.edge, fromId: ids.claim, toId: ids.parent, type: 'PartOf', confidence: 1,
    }],
  })).payload.ok, true);
  // A relational-first row simulates the exact failure window: PostgreSQL
  // committed, vector phase pending. The specialized repair must index it
  // without replaying or mutating the canonical row.
  assert.equal((await call('/v1/write', {
    record: {
      id: ids.repair, userId: access.userId, title: 'Pending vector',
      content: 'The recovery code is VECTOR-35113.', memoryType: 'fact',
      tags: ['entity:vector-recovery'], layer: 'memory', isLatest: true,
    },
  })).payload.ok, true);
  assert.equal((await call('/v1/kb-doc', { doc: {
    id: ids.document, userId: '00000000-0000-4000-8000-00000000c301',
    filename: 'policy.md', contentType: 'text/markdown', status: 'ready', checksum: 'parity-checksum',
    title: 'German policy',
    tags: ['scope-key:org:00000000-0000-4000-8000-00000000c001'],
    metadata: { source_platform: 'knowledge_base', scope: 'organization' },
  } })).payload.ok, true);
  assert.equal((await call('/v1/kb-segment', { segment: {
    id: ids.segment, documentId: ids.document, userId: '00000000-0000-4000-8000-00000000c301',
    content: 'Die Vertragsnummer lautet 35113. رمز العقد هو ٩٨٧٦. Records are retained for seven years.', contentHash: 'segment-hash', segmentIndex: 0,
    startPage: 4, endPage: 4, wordCount: 9, metadata: { source_start: 0, source_end: 67 },
  }, vector: vector(1) })).payload.ok, true);
}

if (process.argv[2] === 'write') {
  const statusBefore = await call('/v1/vector-status', {});
  assert.equal(statusBefore.payload.memories.pending, 1);
  const pending = await call('/v1/vector-pending', { kind: 'memory', limit: 10 });
  assert.deepEqual(pending.payload.items.map((row) => row.id), [ids.repair]);
  assert.equal((await call('/v1/vector-repair', { kind: 'memory', id: ids.repair, vector: vector(2) })).payload.ok, true);
  // Idempotent replay: same point, same row, still successful.
  assert.equal((await call('/v1/vector-repair', { kind: 'memory', id: ids.repair, vector: vector(2) })).payload.ok, true);
  const statusAfter = await call('/v1/vector-status', {});
  assert.equal(statusAfter.payload.memories.pending, 0);
}

const recalled = await call('/v1/recall', { vector: vector(1), limit: 5, filter: { layer: 'memory', is_latest: true } });
assert.equal(recalled.status, 200);
assert.equal(recalled.payload.results[0].id, ids.claim);
const hydrated = await call('/v1/hydrate', { ids: [ids.claim] });
assert.equal(hydrated.payload.memories[0].content, longClaim);
const spanishLexical = await call('/v1/lexical', { text: '¿Cuál es el periodo de retención de siete años?', filter: { layer: 'memory', is_latest: true }, limit: 5 });
assert.equal(spanishLexical.payload.results[0]?.id, ids.claim);
const evidence = await call('/v1/kb-recall', { vector: vector(1), limit: 5, documentId: ids.document, access });
assert.equal(evidence.payload.results[0].segment_id, ids.segment);
assert.equal(evidence.payload.results[0].title, 'German policy');
assert.equal(evidence.payload.results[0].start_page, 4);
const evidenceHydrated = await call('/v1/kb-hydrate', { ids: [ids.segment], access });
assert.match(evidenceHydrated.payload.segments[0].content, /35113/);
const unscopedLexical = await call('/v1/kb-lexical', { text: 'Welche Vertragsnummer ist 35113?', filter: { documentId: ids.document }, limit: 5 });
assert.equal(unscopedLexical.payload.results.length, 0);
const lexical = await call('/v1/kb-lexical', { text: 'Welche Vertragsnummer ist 35113?', filter: { documentId: ids.document, access }, limit: 5 });
assert.ok(lexical.payload.results.length > 0, 'AMR lexical canary must find segment 35113');
assert.equal(lexical.payload.results[0].segment_id, ids.segment);
assert.equal(lexical.payload.results[0].title, 'German policy');
assert.equal(lexical.payload.results[0].start_page, 4);
const arabicLexical = await call('/v1/kb-lexical', { text: 'ما هو رمز العقد ٩٨٧٦؟', filter: { documentId: ids.document, access }, limit: 5 });
assert.equal(arabicLexical.payload.results[0]?.segment_id, ids.segment);
const listedWithoutAccess = await call('/v1/kb-docs', { limit: 5 });
assert.equal(listedWithoutAccess.payload.documents.length, 0);
const listed = await call('/v1/kb-docs', { limit: 5, access });
assert.equal(listed.payload.documents[0].id, ids.document);
const relationships = await call('/v1/mem-relationships', { memoryId: ids.claim });
assert.equal(relationships.payload.out[0].type, 'PartOf');
const stats = await call('/v1/stats', {});
assert.equal(stats.payload.memories, 3);
assert.equal(stats.payload.relationships, 1);
const inventory = await call('/v1/list', { limit: 10 });
assert.equal(inventory.payload.memories.some((row) => row.id === ids.evidenceMemory), false);
assert.equal(inventory.payload.total, 3, 'BYOD inventory total excludes evidence and is independent of page length');
assertCanonicalBackendContract({
  backend: 'byod',
  memories: stats.payload.memories,
  evidence: evidence.payload.results.length,
  ev_in: lexical.payload.results.length,
  relationship: relationships.payload.out[0].type,
  recall_hit: recalled.payload.results[0].id === ids.claim,
  source_hydrated: /35113/.test(evidenceHydrated.payload.segments[0].content),
  isolated: wrongToken.status === 401 && wrongOrg.status === 403,
});

process.stdout.write(JSON.stringify({
  ok: true, memories: stats.payload.memories, relationships: stats.payload.relationships,
  evidence: evidence.payload.results.length, auth: 'closed', orgIsolation: 'closed',
}));
