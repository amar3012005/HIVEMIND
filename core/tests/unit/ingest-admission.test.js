import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestAdmission } from '../../src/memory/ingest-admission.js';

test('ingest admission preserves FIFO order and releases capacity', async () => {
  const admission = createIngestAdmission({ concurrency: 1, maxQueue: 2 });
  const order = [];
  await admission.acquire();
  const second = admission.acquire().then(() => order.push('second'));
  const third = admission.acquire().then(() => order.push('third'));

  assert.deepEqual(admission.stats(), { active: 1, waiting: 2, concurrency: 1, maxQueue: 2 });
  admission.release();
  await second;
  admission.release();
  await third;
  admission.release();

  assert.deepEqual(order, ['second', 'third']);
  assert.deepEqual(admission.stats(), { active: 0, waiting: 0, concurrency: 1, maxQueue: 2 });
});

test('ingest admission rejects excess work without changing active capacity', async () => {
  const admission = createIngestAdmission({ concurrency: 1, maxQueue: 1 });
  await admission.acquire();
  const queued = admission.acquire();

  await assert.rejects(admission.acquire(), { code: 'INGEST_QUEUE_FULL' });
  assert.deepEqual(admission.stats(), { active: 1, waiting: 1, concurrency: 1, maxQueue: 1 });

  admission.release();
  await queued;
  admission.release();
});
