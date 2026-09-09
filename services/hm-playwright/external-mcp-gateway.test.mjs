import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

test('capture discovery exposes navigation before capture unless the current page is explicit', () => {
  const pageCapture = searchBrowserCapabilities({ intent: 'capture the product page', family: 'capture', mode: 'read' });
  assert.equal(pageCapture[0].name, 'browser_navigate');
  assert.ok(['browser_take_screenshot', 'browser_snapshot'].includes(pageCapture[1].name));

  const currentPageCapture = searchBrowserCapabilities({ intent: 'capture this page', family: 'capture', mode: 'read' });
  assert.ok(!currentPageCapture.some((tool) => tool.name === 'browser_navigate'));
  assert.equal(currentPageCapture[0].name, 'browser_take_screenshot');

  const explicitUrlCapture = searchBrowserCapabilities({
    intent: 'Open https://example.com and capture the current page', family: 'capture', mode: 'read',
  });
  assert.equal(explicitUrlCapture[0].name, 'browser_navigate');
});

test('fact-finding page capture inspects the rendered page before taking its image', () => {
  const steps = searchBrowserCapabilities({
    intent: 'find the latest item on the product page and show me a screenshot', family: 'capture', mode: 'read',
  }).map((tool) => tool.name);
  assert.deepEqual(steps.slice(0, 3), ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot']);
});

test('capability response includes an ordered browser plan for page capture', () => {
  const result = renderCapabilitySearchResponse(12, {
    jsonrpc: '2.0', id: 12, result: { tools: [
      { name: 'browser_navigate', inputSchema: { type: 'object' } },
      { name: 'browser_take_screenshot', inputSchema: { type: 'object' } },
    ] },
  }, { intent: 'capture the product page', family: 'capture' });
  const payload = JSON.parse(result.result.content[0].text);
  assert.deepEqual(payload.plan.ordered_actions, ['browser_navigate', 'browser_take_screenshot']);
  assert.deepEqual(payload.execution.capture_defaults, {
    type: 'png', scale: 'css', fullPage: false,
    note: 'Use this render-safe viewport capture unless the user explicitly needs a full-page or device-scale image.',
  });
  assert.ok(payload.execution.rules.some((rule) => rule.includes('not a chat attachment')));
  assert.ok(payload.execution.rules.some((rule) => rule.includes('Never guess a selector')));
  assert.ok(payload.execution.rules.some((rule) => rule.includes('retry once as a viewport PNG at CSS scale')));
});

test('live capability response preserves the evidence-before-image plan order', () => {
  const result = renderCapabilitySearchResponse(13, {
    jsonrpc: '2.0', id: 13, result: { tools: [
      { name: 'browser_navigate', inputSchema: { type: 'object' } },
      { name: 'browser_take_screenshot', inputSchema: { type: 'object' } },
      { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    ] },
  }, { intent: 'find the latest item and show a screenshot', family: 'capture' });
  const payload = JSON.parse(result.result.content[0].text);
  assert.deepEqual(payload.plan.ordered_actions, ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot']);
  assert.deepEqual(payload.execution.allowed_actions, payload.plan.ordered_actions);
  assert.ok(payload.execution.rules.some((rule) => rule.includes('absolute HTTPS origin')));
  assert.ok(payload.execution.rules.some((rule) => rule.includes('Do not call scripts')));
  assert.ok(payload.execution.rules.some((rule) => rule.includes('browser_session_reset')));
});

test('current entity lookup requires one source resolution before browser navigation', () => {
  const result = renderCapabilitySearchResponse(14, {
    jsonrpc: '2.0', id: 14, result: { tools: [
      { name: 'browser_navigate', inputSchema: { type: 'object' } },
      { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    ] },
  }, { intent: 'find the cost of the latest DJI Avata from its official website', family: 'inspect' });
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.execution.source_resolution.mode, 'resolve_before_navigation');
  assert.equal(payload.execution.source_resolution.required_before_navigation, true);
  assert.equal(payload.execution.source_resolution.query, 'find the cost of the latest DJI Avata from its official website');
  assert.ok(payload.execution.source_resolution.constraints.some((rule) => rule.includes('Do not repeatedly guess URL paths')));
});

test('an explicit absolute URL can proceed without mandatory source resolution', () => {
  const result = renderCapabilitySearchResponse(15, {
    jsonrpc: '2.0', id: 15, result: { tools: [
      { name: 'browser_navigate', inputSchema: { type: 'object' } },
      { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    ] },
  }, { intent: 'read the price at https://example.com/products/widget', family: 'inspect' });
  const payload = JSON.parse(result.result.content[0].text);
  assert.equal(payload.execution.source_resolution.mode, 'direct_when_unambiguous');
  assert.equal(payload.execution.source_resolution.required_before_navigation, false);
  assert.equal(payload.execution.source_resolution.query, undefined);
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

test('meta screenshot execution returns a native MCP image block for a bounded local artifact', async (t) => {
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
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: true, token: 'secret', upstreamPort, artifactRoot, logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());

  const execution = await fetch(`http://127.0.0.1:${port}/meta/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'browser_execute', arguments: { action: 'browser_take_screenshot', arguments: {} } },
    }),
  });
  assert.equal(execution.status, 200);
  const payload = await execution.json();
  assert.deepEqual(payload.result.content.at(-1), {
    type: 'image', mimeType: 'image/png', data: image.toString('base64'),
  });
});

test('meta screenshot execution rejects a blank page after browser session recovery', async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      result: {
        content: [{
          type: 'text',
          text: '### Result\n- [Screenshot](./blank.png)\n\n### Page\n- Page URL: about:blank',
        }],
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const gateway = http.createServer(createExternalMcpGateway({
    enabled: true, token: 'secret', upstreamPort, logger: () => {},
  }));
  const port = await listen(gateway);
  t.after(() => gateway.close());

  const execution = await fetch(`http://127.0.0.1:${port}/meta/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'browser_execute', arguments: { action: 'browser_take_screenshot', arguments: {} } },
    }),
  });
  assert.equal(execution.status, 200);
  const payload = await execution.json();
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.structuredContent.code, 'browser_session_reset');
  assert.ok(payload.result.content[0].text.includes('restart its ordered plan from browser_navigate'));
  assert.ok(!payload.result.content.some((block) => block.type === 'image'));
});
