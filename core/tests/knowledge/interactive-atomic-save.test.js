import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';

for (const deferred of [true, false]) {
  test(`atomic save ${deferred ? 'returns before' : 'waits for'} claim enrichment`, async () => {
    let finish;
    let started = false;
    const pending = new Promise((resolve) => { finish = resolve; });
    const service = new DocumentFirstIngestionService({
      db: {}, memoryGraphEngine: { ingestMemory: async () => ({ memoryId: 'saved-1' }) },
      logger: { info() {}, warn() {} },
    });
    service._structureClaimsAsync = () => { started = true; return pending; };
    let returned = false;
    const result = service.ingestSource({
      mode: 'atomic', userId: 'user-1', orgId: 'org-1', content: 'A synthetic durable test note.',
      source: { type: 'api' },
      metadata: deferred ? { defer_claim_structuring: true } : {},
    }).then((value) => { returned = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    assert.equal(returned, deferred);
    finish();
    assert.equal((await result).memoryId, 'saved-1');
  });
}
