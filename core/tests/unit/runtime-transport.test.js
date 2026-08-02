import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  RuntimeTransportError,
  closeRuntimeTransports,
  runtimeRequestJson,
  runtimeTransportStats,
  warmRuntimeOrigin,
} from '../../src/runtime-transport/client.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('Runtime transport reuses one origin pool and classifies responses without blind replay', async (t) => {
  let connections = 0;
  let healthRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/reset') {
      req.socket.destroy();
      return;
    }
    if (req.url === '/health') healthRequests += 1;
    const status = req.url === '/missing' ? 404 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200 }));
  });
  server.on('connection', () => { connections += 1; });
  const baseUrl = await listen(server);
  t.after(async () => {
    await closeRuntimeTransports();
    await new Promise((resolve) => server.close(resolve));
  });

  const warm = await warmRuntimeOrigin(baseUrl, { force: true });
  assert.equal(warm.warmed, true);
  assert.equal(healthRequests, 1);

  const first = await runtimeRequestJson(`${baseUrl}/one`);
  const second = await runtimeRequestJson(`${baseUrl}/two`);
  assert.equal(first.classification, 'deterministic_response');
  assert.equal(second.classification, 'deterministic_response');
  assert.equal(runtimeTransportStats().filter((row) => row.origin === baseUrl).length, 1);
  assert.ok(connections < 3, `expected connection reuse, opened ${connections} sockets for three requests`);

  const missing = await runtimeRequestJson(`${baseUrl}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.classification, 'deterministic_response');
  assert.equal(missing.reconciliation_required, false);

  await assert.rejects(
    () => runtimeRequestJson(`${baseUrl}/reset`),
    (error) => error instanceof RuntimeTransportError
      && error.classification === 'uncertain_transport'
      && error.reconciliation_required === true,
  );
});
