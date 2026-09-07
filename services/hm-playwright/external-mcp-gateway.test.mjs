import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import { createExternalMcpGateway } from './external-mcp-gateway.mjs';
import {
  planMetaMcpRequest,
  renderCapabilitySearchResponse,
  searchBrowserCapabilities,
} from './playwright-meta-toolkit.mjs';

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
    assert.equal(req.headers.host, '127.0.0.1');
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

test('production Compose exposes only the Playwright gateway on host loopback', () => {
  const compose = fs.readFileSync(new URL('../../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
  const playwright = compose.match(/\n  playwright:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:|\nvolumes:)/)?.[1] || '';
  const withoutPlaywright = compose.replace(`\n  playwright:\n${playwright}`, '');
  assert.match(playwright, /127\.0\.0\.1:8932:8932/);
  assert.match(playwright, /PLAYWRIGHT_EXTERNAL_MCP_ENABLED/);
  assert.match(playwright, /PLAYWRIGHT_EXTERNAL_MCP_TOKEN/);
  assert.match(playwright, /PLAYWRIGHT_EXTERNAL_MCP_META_MODE/);
  assert.doesNotMatch(withoutPlaywright, /127\.0\.0\.1:8932:8932/);
  assert.doesNotMatch(withoutPlaywright, /PLAYWRIGHT_EXTERNAL_MCP_ENABLED/);
});

test('capability discovery returns the live underlying input schema', () => {
  const result = renderCapabilitySearchResponse(11, {
    jsonrpc: '2.0', id: 11, result: { tools: [{
      name: 'browser_navigate', description: 'Navigate',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    }] },
  }, { intent: 'navigate' });
  const payload = JSON.parse(result.result.content[0].text);
  assert.deepEqual(payload.capabilities[0].inputSchema.required, ['url']);
});

test('meta toolkit exposes two compact tools instead of the 24-tool catalog', () => {
  const plan = planMetaMcpRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  assert.deepEqual(plan.local.result.tools.map((tool) => tool.name), ['browser_capabilities', 'browser_execute']);
});

test('meta capability search progressively selects a bounded relevant subset', () => {
  const tools = searchBrowserCapabilities({ intent: 'navigate and take a screenshot', mode: 'read' });
  assert.ok(tools.length > 0 && tools.length <= 8);
  assert.ok(tools.some((tool) => tool.name === 'browser_navigate'));
  assert.ok(tools.some((tool) => tool.name === 'browser_take_screenshot'));
  assert.ok(tools.every((tool) => tool.risk !== 'write' && tool.risk !== 'unsafe'));
});

test('meta execution rewrites certified actions and blocks interactive or unsafe tools', () => {
  const allowed = planMetaMcpRequest({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'browser_execute', arguments: { action: 'browser_snapshot', arguments: {} } },
  });
  assert.equal(allowed.upstream.params.name, 'browser_snapshot');

  const interactive = planMetaMcpRequest({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'browser_execute', arguments: { action: 'browser_click', arguments: { target: 'e1' } } },
  });
  assert.equal(interactive.local.error.message, 'browser_meta_interactive_action_disabled');

  const unsafe = planMetaMcpRequest({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'browser_execute', arguments: { action: 'browser_run_code_unsafe', arguments: { code: '() => 1' } } },
  }, { mode: 'interactive' });
  assert.equal(unsafe.local.error.message, 'browser_meta_unsafe_action_forbidden');
});

test('meta MCP endpoint serves compact discovery and rewrites execution upstream', async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.url, '/mcp');
    assert.equal(body.params.name, 'browser_snapshot');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'snapshot' }] } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: true, token: 'secret', upstreamPort, logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());

  const discovery = await fetch(`http://127.0.0.1:${port}/meta/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).result.tools.length, 2);

  const execution = await fetch(`http://127.0.0.1:${port}/meta/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'browser_execute', arguments: { action: 'browser_snapshot', arguments: {} } },
    }),
  });
  assert.equal(execution.status, 200);
  assert.equal((await execution.json()).result.content[0].text, 'snapshot');
});
