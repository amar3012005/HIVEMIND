import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBodyBuffer, readJsonBody } from '../../src/http/read-json-body.js';

test('readJsonBody accepts JSON and rejects malformed or oversized bodies', async () => {
  assert.deepEqual(await readJsonBody(Readable.from(['{"ok":true}']), 64), { ok: true });
  await assert.rejects(() => readJsonBody(Readable.from(['{']), 64), { statusCode: 400 });
  await assert.rejects(() => readBodyBuffer(Readable.from(['12345']), 4), { statusCode: 413 });
});
