import test from 'node:test';
import assert from 'node:assert/strict';
import { withPdfRenderSlot } from '../src/knowledge/enterprise/groq-vision-parser.js';

test('PDF rendering is serialized while downstream work can remain concurrent', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const run = (id) => withPdfRenderSlot(async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end-${id}`);
    active -= 1;
  });
  await Promise.all([run(1), run(2), run(3)]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});

test('a failed renderer releases the slot for the next document', async () => {
  await assert.rejects(() => withPdfRenderSlot(async () => { throw new Error('render failed'); }));
  const value = await withPdfRenderSlot(async () => 'next-ran');
  assert.equal(value, 'next-ran');
});
