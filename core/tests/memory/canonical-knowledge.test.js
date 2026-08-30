import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  canonicalKnowledgeMode, materializeCanonicalKnowledge, normalizePredicate,
  prepareCanonicalProjection, verifyCanonicalProjectionSignature,
} from '../../src/memory/canonical-knowledge.js';
import { CloudflareCanonicalProjectionClient } from '../../src/memory/cloudflare-canonical-projection-client.js';

test('feature mode fails closed and kill switch wins', () => {
  assert.equal(canonicalKnowledgeMode({ evaluatedMode: 'full', env: {} }), 'off');
  assert.equal(canonicalKnowledgeMode({ evaluatedMode: 'write', env: { CANONICAL_KNOWLEDGE_ENABLED: 'true' } }), 'write');
  assert.equal(canonicalKnowledgeMode({ evaluatedMode: 'full', env: { CANONICAL_KNOWLEDGE_ENABLED: 'true', CANONICAL_KNOWLEDGE_KILL_SWITCH: 'true' } }), 'off');
});

test('Cloudflare admission is tenant/user scoped and Queue payload remains identifier-only', async () => {
  const prior = {
    enabled: process.env.CANONICAL_KNOWLEDGE_ENABLED,
    url: process.env.CANONICAL_PROJECTION_WORKFLOW_URL,
    secret: process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET,
  };
  process.env.CANONICAL_KNOWLEDGE_ENABLED = 'true';
  process.env.CANONICAL_PROJECTION_WORKFLOW_URL = 'https://projection.test';
  process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = 'secret';
  const calls = [];
  const client = new CloudflareCanonicalProjectionClient({ fetchImpl: async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.includes('/enabled') ? { mode: 'write' } : { ok: true }), { status: 200 });
  } });
  try {
    assert.equal(await client.modeFor({ orgId: 'org-1', userId: 'user-1' }), 'write');
    await client.start({ memoryId: 'memory-1', orgId: 'org-1', userId: 'user-1', requiredProjection: 'write' });
    const admission = calls[1];
    assert.equal(admission.init.headers['x-hivemind-user-id'], 'user-1');
    assert.deepEqual(Object.keys(JSON.parse(admission.init.body)).sort(), ['memory_id', 'org_id', 'processing_version', 'required_projection']);
  } finally {
    if (prior.enabled === undefined) delete process.env.CANONICAL_KNOWLEDGE_ENABLED; else process.env.CANONICAL_KNOWLEDGE_ENABLED = prior.enabled;
    if (prior.url === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_URL; else process.env.CANONICAL_PROJECTION_WORKFLOW_URL = prior.url;
    if (prior.secret === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET; else process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = prior.secret;
  }
});

test('Uwe canary resolves bounded title pronoun and local tomorrow', () => {
  const result = prepareCanonicalProjection({
    title: 'Uwe Egly teaching deep learning', content: 'He started teaching deep learning from tomorrow.',
    entities: [{ name: 'Uwe Egly', kind: 'person' }, { name: 'Deep Learning', kind: 'technology' }],
    knownAt: '2026-08-30T18:23:00Z', timeZone: 'Europe/Berlin',
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].subject.name, 'Uwe Egly');
  assert.equal(result.claims[0].predicate, 'teaches');
  assert.equal(result.claims[0].object.name, 'Deep Learning');
  assert.equal(result.claims[0].validFrom, '2026-08-31');
  assert.equal(result.claims[0].assertionStatus, 'user_asserted');
});

test('claim reads are reserved for read/full modes in the server contract', () => {
  const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf('const claimsMatch = pathname.match'), server.indexOf('const relsMatch = pathname.match'));
  assert.match(route, /canonicalProjectionClient\.modeFor/);
  assert.match(route, /claimsMode !== 'read' && claimsMode !== 'full'/);
  assert.match(route, /Not found/);
});

test('Uwe repair upgrades a generic taught object hint to technology', () => {
  const result = prepareCanonicalProjection({
    title: 'Uwe Egly teaching deep learning', content: 'He started teaching deep learning from tomorrow.',
    entities: [{ name: 'uwe egly', kind: 'concept' }, { name: 'deep learning', kind: 'concept' }],
    knownAt: '2026-08-30T18:23:00Z', timeZone: 'Europe/Berlin',
  });
  assert.equal(result.claims[0].object.kind, 'technology');
  assert.deepEqual(result.entities.map((entity) => entity.kind).sort(), ['person', 'technology']);
});

test('repair reconstruction collapses generic tag hints onto typed claim endpoints', () => {
  const result = prepareCanonicalProjection({
    title: 'Uwe Egly teaching deep learning',
    content: 'He started teaching deep learning from tomorrow.',
    entities: [{ name: 'uwe egly', kind: 'concept' }, { name: 'deep learning', kind: 'concept' }],
    claims: [{
      subject: { name: 'deep learning', kind: 'technology' }, predicate: 'is_taught_by',
      object: { name: 'Uwe Egly', kind: 'person' }, valid_from: '2026-08-31',
    }],
  });
  assert.equal(result.entities.length, 2);
  assert.deepEqual(result.entities.map((entity) => entity.kind).sort(), ['person', 'technology']);
  assert.equal(result.claims[0].subject.name, 'Uwe Egly');
  assert.equal(result.claims[0].object.name, 'deep learning');
});

test('ambiguous pronoun does not publish a trusted claim', () => {
  const result = prepareCanonicalProjection({
    title: 'Teaching update', content: 'He started teaching deep learning tomorrow.',
    entities: [{ name: 'Uwe Egly', kind: 'person' }, { name: 'Max Mustermann', kind: 'person' }],
  });
  assert.equal(result.claims.length, 0);
  assert.equal(result.unresolvedSubject, true);
});

test('inverse predicate swaps endpoints into canonical teaches', () => {
  assert.deepEqual(normalizePredicate('is taught by'), { name: 'teaches', swap: true });
  const result = prepareCanonicalProjection({ content: 'Deep Learning is taught by Uwe', claims: [{
    subject: { name: 'Deep Learning', kind: 'technology' }, predicate: 'is_taught_by',
    object: { name: 'Uwe Egly', kind: 'person' },
  }] });
  assert.equal(result.claims[0].subject.name, 'Uwe Egly');
  assert.equal(result.claims[0].object.name, 'Deep Learning');
});

test('materializer is deterministic, persists roles/evidence, and never writes relationships', async () => {
  const calls = []; let entitySeq = 0;
  const tx = {
    memoryProjectionState: { upsert: async (x) => calls.push(['state.upsert', x]), update: async (x) => calls.push(['state.update', x]) },
    canonicalEntity: { findFirst: async () => null, create: async (x) => ({ id: `e${++entitySeq}`, ...x.data }) },
    memoryEntityLink: { upsert: async (x) => calls.push(['link', x]), findMany: async () => [], deleteMany: async (x) => calls.push(['link.deleteMany', x]) },
    canonicalPredicate: { upsert: async (x) => ({ id: 'p1', name: x.create.name }) },
    canonicalClaim: { upsert: async (x) => { calls.push(['claim', x]); return { id: 'c1', ...x.create }; } },
    claimEvidenceLink: { upsert: async (x) => calls.push(['evidence', x]) },
  };
  const prisma = { $transaction: (fn) => fn(tx) };
  const prior = process.env.CANONICAL_KNOWLEDGE_ENABLED; process.env.CANONICAL_KNOWLEDGE_ENABLED = 'true';
  try {
    const result = await materializeCanonicalKnowledge({ prisma, mode: 'write', input: {
      memoryId: '74fb72fc-08da-41cc-8c56-598eae67bfee', organizationId: '11111111-1111-1111-1111-111111111111',
      title: 'Uwe Egly teaching deep learning', content: 'He started teaching deep learning from tomorrow.',
      entities: [{ name: 'Uwe Egly', kind: 'person' }, { name: 'Deep Learning', kind: 'technology' }],
      knownAt: '2026-08-30T18:23:00Z', timeZone: 'Europe/Berlin',
    } });
    assert.equal(result.claimCount, 1);
    assert.ok(calls.some(([type, x]) => type === 'link' && x.create?.role === 'subject'));
    assert.ok(calls.some(([type, x]) => type === 'link' && x.create?.role === 'actor'));
    assert.ok(calls.some(([type, x]) => type === 'link' && x.create?.role === 'object'));
    assert.ok(calls.some(([type, x]) => type === 'link' && x.create?.role === 'technology'));
    assert.ok(calls.some(([type]) => type === 'evidence'));
    assert.equal('relationship' in tx, false);
  } finally { process.env.CANONICAL_KNOWLEDGE_ENABLED = prior; }
});

test('materializer removes only redundant same-name links from the projected memory', async () => {
  const deleted = []; let entitySeq = 0;
  const tx = {
    memoryProjectionState: { upsert: async () => {}, update: async () => {} },
    canonicalEntity: { findFirst: async () => null, create: async (x) => ({ id: `typed-${++entitySeq}`, ...x.data }) },
    memoryEntityLink: {
      upsert: async () => {},
      findMany: async () => [{ memoryId: 'm1', entityId: 'legacy', role: 'mentioned', entity: {
        organizationId: 'o1', canonicalName: 'Deep Learning',
      } }, { memoryId: 'm1', entityId: 'other', role: 'mentioned', entity: {
        organizationId: 'o1', canonicalName: 'Unrelated Entity',
      } }],
      deleteMany: async (x) => deleted.push(x),
    },
    canonicalPredicate: { upsert: async () => ({ id: 'p1' }) },
    canonicalClaim: { upsert: async (x) => ({ id: 'c1', ...x.create }) },
    claimEvidenceLink: { upsert: async () => {} },
  };
  const oldEnabled = process.env.CANONICAL_KNOWLEDGE_ENABLED; process.env.CANONICAL_KNOWLEDGE_ENABLED = 'true';
  try {
    await materializeCanonicalKnowledge({ prisma: { $transaction: (fn) => fn(tx) }, mode: 'write', input: {
      memoryId: 'm1', organizationId: 'o1', title: 'Uwe Egly teaching deep learning',
      content: 'He started teaching deep learning from tomorrow.',
      entities: [{ name: 'Uwe Egly', kind: 'person' }, { name: 'deep learning', kind: 'concept' }],
    } });
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].where.OR.length, 1);
    assert.equal(deleted[0].where.OR[0].entityId, 'legacy');
  } finally { process.env.CANONICAL_KNOWLEDGE_ENABLED = oldEnabled; }
});

test('repair callback signature validates canonical HMAC and rejects body changes', () => {
  const secret = 'test-secret'; const timestamp = '1788114180000'; const nonce = 'abc'; const pathname = '/internal/canonical-projection/repair';
  const rawBody = JSON.stringify({ memory_id: 'm1' });
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}\n${nonce}\nPOST\n${pathname}\n${digest}`).digest('hex');
  const headers = { 'x-hivemind-timestamp': timestamp, 'x-hivemind-nonce': nonce, 'x-hivemind-content-sha256': digest, 'x-hivemind-signature': `sha256=${signature}` };
  assert.equal(verifyCanonicalProjectionSignature({ headers, pathname, rawBody, secret, now: Number(timestamp) }).ok, true);
  assert.equal(verifyCanonicalProjectionSignature({ headers, pathname, rawBody: '{}', secret, now: Number(timestamp) }).ok, false);
});

test('explicit replacement supersedes claim history and creates only an Updates lineage edge', async () => {
  const relationshipWrites = []; const claimUpdates = [];
  const entityIds = new Map();
  const tx = {
    memoryProjectionState: { upsert: async () => {}, update: async () => {} },
    canonicalEntity: { findFirst: async () => null, create: async (x) => {
      const key = x.data.identityKey; if (!entityIds.has(key)) entityIds.set(key, `e${entityIds.size + 1}`);
      return { id: entityIds.get(key), ...x.data };
    } },
    memoryEntityLink: { upsert: async () => {} },
    canonicalPredicate: { upsert: async () => ({ id: 'p-teaches' }) },
    canonicalClaim: {
      findFirst: async () => ({ id: 'old-claim', evidence: [{ memoryId: '00000000-0000-4000-8000-000000000001' }] }),
      upsert: async (x) => ({ id: 'new-claim', ...x.create }),
      update: async (x) => claimUpdates.push(x),
    },
    claimEvidenceLink: { upsert: async () => {} },
    relationship: { upsert: async (x) => relationshipWrites.push(x) },
  };
  const oldEnabled = process.env.CANONICAL_KNOWLEDGE_ENABLED; process.env.CANONICAL_KNOWLEDGE_ENABLED = 'true';
  try {
    await materializeCanonicalKnowledge({ prisma: { $transaction: (fn) => fn(tx) }, mode: 'write', input: {
      memoryId: '00000000-0000-4000-8000-000000000002', organizationId: '11111111-1111-4111-8111-111111111111',
      title: 'Uwe teaching update', content: 'Uwe Egly teaches Machine Learning instead.',
      entities: [{ name: 'Uwe Egly', kind: 'person' }, { name: 'Machine Learning', kind: 'technology' }],
      claims: [{ subject: { name: 'Uwe Egly', kind: 'person' }, predicate: 'teaches', object: { name: 'Machine Learning', kind: 'technology' } }],
    } });
    assert.equal(claimUpdates[0].data.lifecycleStatus, 'superseded');
    assert.equal(relationshipWrites.length, 1);
    assert.equal(relationshipWrites[0].create.type, 'Updates');
    assert.equal(relationshipWrites[0].create.metadata.canonical_claim_supersession, true);
  } finally { process.env.CANONICAL_KNOWLEDGE_ENABLED = oldEnabled; }
});
