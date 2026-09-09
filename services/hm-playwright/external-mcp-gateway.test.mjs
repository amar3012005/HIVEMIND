import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExternalMcpGateway, isExternalMcpPath } from './external-mcp-gateway.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function gateway(options = {}) {
  return http.createServer(createExternalMcpGateway({ enabled: true, token: 'secret', logger: () => {}, ...options }));
}

test('external MCP gateway exposes only the direct official route', () => {
  assert.equal(isExternalMcpPath('/mcp'), true);
  assert.equal(isExternalMcpPath('/mcp/'), true);
  assert.equal(isExternalMcpPath('/meta/mcp'), false);
});

test('external MCP gateway rejects missing origin authorization', async (t) => {
  const upstream = http.createServer((_req, res) => res.end('upstream'));
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const server = gateway({ upstreamPort });
  const port = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
});

test('external MCP gateway streams direct official MCP responses and strips credentials', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/mcp');
    assert.equal(req.headers.host, '127.0.0.1');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['cf-access-client-secret'], undefined);
    assert.equal(req.headers['mcp-session-id'], 'session-1');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-2' });
    res.end('event: message\ndata: ok\n\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const server = gateway({ upstreamPort });
  const port = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret', 'content-type': 'application/json',
      'mcp-session-id': 'session-1', 'cf-access-client-id': 'agent-id',
      'cf-access-client-secret': 'must-not-reach-upstream',
    },
    body: '{"jsonrpc":"2.0"}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), 'session-2');
  assert.match(await response.text(), /data: ok/);
});

test('direct official screenshots are projected to native MCP image blocks', async (t) => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-playwright-artifact-'));
  const image = Buffer.from('89504e470d0a1a0a', 'hex');
  fs.writeFileSync(path.join(artifactRoot, 'capture.png'), image);
  t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.params.name, 'browser_take_screenshot');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      result: { content: [{ type: 'text', text: '### Result\n- [Screenshot](./capture.png)' }] },
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const server = gateway({ upstreamPort, artifactRoot });
  const port = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: {} } }),
  });
  const payload = await response.json();
  assert.deepEqual(payload.result.content.at(-1), { type: 'image', mimeType: 'image/png', data: image.toString('base64') });
});

test('direct official screenshots refuse blank recovery artifacts', async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Page URL: about:blank' }] } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const server = gateway({ upstreamPort });
  const port = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: {} } }),
  });
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.structuredContent.code, 'browser_session_reset');
});

test('production Compose exposes only the authenticated gateway on host loopback', () => {
  const compose = fs.readFileSync(new URL('../../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
  const playwright = compose.match(/\n  playwright:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:|\nvolumes:)/)?.[1] || '';
  assert.match(playwright, /127\.0\.0\.1:8932:8932/);
  assert.match(playwright, /PLAYWRIGHT_EXTERNAL_MCP_ENABLED/);
  assert.match(playwright, /PLAYWRIGHT_EXTERNAL_MCP_TOKEN/);
  assert.doesNotMatch(playwright, /PLAYWRIGHT_EXTERNAL_MCP_META_MODE/);
});
