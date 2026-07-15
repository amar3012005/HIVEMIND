import test from 'node:test';
import assert from 'node:assert/strict';
import { processDerivationBatch } from '../../src/memory/derivation-worker.js';

function makeJob(overrides = {}) {
  return {
    id: 'job-1', sourceMemoryId: 'source-1', targetMemoryId: 'target-1',
    confidence: 0.82, metadata: { reason: 'cross-source synthesis' },
    sourceMemory: {
      id: 'source-1', userId: 'user-1', orgId: 'org-1', content: 'Grounded source',
      sourceMetadata: { sourceId: 'segment-1', sourceUrl: null, sourceType: 'knowledge_segment' },
      evidenceLinks: [], synthesisEvidenceIds: [],
    },
    targetMemory: { id: 'target-1', userId: 'user-1', orgId: 'org-1', content: 'Derived claim' },
    ...overrides,
  };
}

function makePrisma(job, updates) {
  return { derivationJob: {
    findMany: async () => [job],
    updateMany: async () => ({ count: 1 }),
    update: async (args) => { updates.push(args); return args; },
  } };
}

test('derivation worker creates a same-tenant edge only after provenance and semantic validation', async () => {
  const updates = [];
  const calls = [];
  const result = await processDerivationBatch({
    prisma: makePrisma(makeJob(), updates),
    engine: { applyDerives: async (...args) => calls.push(args) },
    validate: async () => ({ approved: true, confidence: 0.91, reason: 'requires source' }),
  });
  assert.deepEqual(result, { claimed: 1, completed: 1, rejected: 0, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].async_verified, true);
  assert.equal(calls[0][2].verification.approved, true);
  assert.equal(calls[0][2].confidence, 0.82);
  assert.equal(updates.at(-1).data.status, 'completed');
});

test('derivation worker rejects a source with no evidence provenance before model validation', async () => {
  const updates = [];
  let validated = 0;
  let applied = 0;
  const sourceMemory = { id: 'source-1', userId: 'user-1', orgId: 'org-1', content: 'Unproven source', evidenceLinks: [], synthesisEvidenceIds: [] };
  const result = await processDerivationBatch({
    prisma: makePrisma(makeJob({ sourceMemory }), updates),
    engine: { applyDerives: async () => { applied += 1; } },
    validate: async () => { validated += 1; return { approved: true, confidence: 0.99 }; },
  });
  assert.deepEqual(result, { claimed: 1, completed: 0, rejected: 1, failed: 0 });
  assert.equal(validated, 0);
  assert.equal(applied, 0);
  assert.equal(updates.at(-1).data.metadata.validation.reason, 'source_provenance_unverified');
});

test('derivation worker rejects sub-threshold validation and fails closed across tenants', async () => {
  const lowUpdates = [];
  const low = await processDerivationBatch({
    prisma: makePrisma(makeJob(), lowUpdates),
    engine: { applyDerives: async () => assert.fail('must not apply') },
    validate: async () => ({ approved: false, confidence: 0.74, reason: 'not entailed' }),
  });
  assert.equal(low.rejected, 1);

  const scopeUpdates = [];
  const crossTenant = makeJob({ targetMemory: { id: 'target-1', userId: 'user-1', orgId: 'org-2', content: 'Derived claim' } });
  const scoped = await processDerivationBatch({
    prisma: makePrisma(crossTenant, scopeUpdates),
    engine: { applyDerives: async () => assert.fail('must not apply') },
    logger: { warn() {} },
    validate: async () => ({ approved: true, confidence: 0.99 }),
  });
  assert.equal(scoped.failed, 1);
  assert.equal(scopeUpdates.at(-1).data.status, 'failed');
});

test('derivation worker rejects a low-confidence candidate before model validation', async () => {
  const updates = [];
  let validated = 0;
  const result = await processDerivationBatch({
    prisma: makePrisma(makeJob({ confidence: 0.74 }), updates),
    engine: { applyDerives: async () => assert.fail('must not apply') },
    validate: async () => { validated += 1; return { approved: true, confidence: 0.99 }; },
  });
  assert.equal(result.rejected, 1);
  assert.equal(validated, 0);
  assert.equal(updates.at(-1).data.metadata.validation.reason, 'candidate_confidence_below_threshold');
});
