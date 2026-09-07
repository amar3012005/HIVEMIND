import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createExternalMcpGateway } from './external-mcp-gateway.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('external MCP gateway rejects missing origin authorization', async (t) => {
  const upstream = http.createServer((_req, res) => res.end('upstream'));
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: true, token: 'secret', upstreamPort, logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
});

test('external MCP gateway streams authenticated MCP responses and strips credentials', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['cf-access-client-secret'], undefined);
    assert.equal(req.headers['mcp-session-id'], 'session-1');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-2' });
    res.write('event: message\n');
    res.end('data: ok\n\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: true, token: 'secret', upstreamPort, logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'mcp-session-id': 'session-1',
      'cf-access-client-id': 'agent-id',
      'cf-access-client-secret': 'must-not-reach-upstream',
    },
    body: '{"jsonrpc":"2.0"}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), 'session-2');
  assert.match(await response.text(), /data: ok/);
});

test('external MCP gateway is fail-closed unless explicitly enabled', async (t) => {
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: false, token: 'secret', logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(response.status, 404);
});
