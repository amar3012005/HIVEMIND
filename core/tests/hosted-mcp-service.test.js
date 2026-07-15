import test from 'node:test';
import assert from 'node:assert/strict';

async function loadHostedServiceModule(query) {
  const moduleUrl = new URL(`../src/mcp/hosted-service.js?${query}`, import.meta.url);
  return import(moduleUrl.href);
}

test('hosted MCP config keeps public URLs separate from internal API URLs', async () => {
  const originalEnv = {
    HIVEMIND_PUBLIC_BASE_URL: process.env.HIVEMIND_PUBLIC_BASE_URL,
    HIVEMIND_INTERNAL_BASE_URL: process.env.HIVEMIND_INTERNAL_BASE_URL,
    HIVEMIND_BASE_URL: process.env.HIVEMIND_BASE_URL,
  };

  process.env.HIVEMIND_PUBLIC_BASE_URL = 'https://public.example.com';
  process.env.HIVEMIND_INTERNAL_BASE_URL = 'http://hivemind-api:3000';
  process.env.HIVEMIND_BASE_URL = 'http://localhost:3000';

  try {
    const hostedService = await loadHostedServiceModule(`hosted-mcp-config=${Date.now()}`);
    const userId = '00000000-0000-4000-8000-000000000001';
    const orgId = '00000000-0000-4000-8000-000000000002';
    const descriptor = hostedService.generateHostedServer(userId, orgId, 'test-api-key');

    assert.equal(descriptor.connection.baseUrl, 'https://public.example.com');
    assert.equal(descriptor.connection.internalBaseUrl, 'http://hivemind-api:3000');
    assert.match(descriptor.connection.endpoints.jsonrpc, /^https:\/\/public\.example\.com\/api\/mcp\/servers\//);
    assert.equal(descriptor.clientConfig.publishedBridge.env.HIVEMIND_API_URL, 'https://public.example.com');
    assert.equal(descriptor.clientConfig.webappConnectors.xdata.raw.endpoint, 'https://public.example.com/api/ingest');
    assert.ok(descriptor.clientConfig.bridge.args.includes('@amar_528/mcp-bridge'));
    assert.equal(descriptor.clientConfig.claudeDesktop.mcpServers.hivemind.env.HIVEMIND_API_URL, 'https://public.example.com');
    assert.equal(descriptor.clientConfig.antigravity.mcp_servers.hivemind.env.HIVEMIND_API_URL, 'https://public.example.com');
    assert.equal(descriptor.clientConfig.antigravity.mcp_servers.hivemind.env.NODE_NO_WARNINGS, '1');

    const tokenized = await hostedService.getHostedServerByToken(descriptor.connection.token, userId);
    assert.ok(tokenized);
    assert.equal(tokenized.connection.baseUrl, 'https://public.example.com');
    assert.equal(tokenized.connection.token, descriptor.connection.token);
    assert.equal(tokenized.clientConfig.simpleUrl, descriptor.clientConfig.simpleUrl);
    assert.equal(await hostedService.validateConnectionToken(descriptor.connection.token, userId), true);
    assert.ok(descriptor.tools.some((tool) => tool.name === 'hivemind_chat_context'));
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('hosted MCP revocation invalidates signed tokens across lookups', async () => {
  const hostedService = await loadHostedServiceModule(`hosted-mcp-revoke=${Date.now()}`);
  const userId = '00000000-0000-4000-8000-000000000101';
  const orgId = '00000000-0000-4000-8000-000000000202';
  const descriptor = hostedService.generateHostedServer(userId, orgId, 'test-api-key');

  assert.equal(await hostedService.validateConnectionToken(descriptor.connection.token, userId), true);
  assert.ok(await hostedService.getHostedServerByToken(descriptor.connection.token, userId));

  await hostedService.revokeAllConnections(userId);

  assert.equal(await hostedService.validateConnectionToken(descriptor.connection.token, userId), false);
  assert.equal(await hostedService.getHostedServerByToken(descriptor.connection.token, userId), null);
});

test('hivemind_chat_context returns the server packet and escalates anchored fact recall once', async () => {
  const hostedService = await loadHostedServiceModule(`hosted-mcp-context=${Date.now()}`);
  const calls = [];
  const packet = {
    facts: [{ id: 'm1' }],
    sourceSections: [{ segment_id: 's1' }],
    citations: [{ id: 'C1', segment_id: 's1' }],
    coverage: { facts: 1, source_sections: 1 },
    cutoff_reason: null,
  };
  const apiClient = {
    post: async (path, body) => {
      calls.push({ path, body });
      if (body.mode === 'fact') {
        return {
          memories: [{ id: 'm1', tags: ['filename:brief.pdf'] }],
          evidence: [],
          mode_used: 'fact',
        };
      }
      return {
        memories: [{ id: 'm1' }],
        evidence: [{ segment_id: 's1' }],
        evidence_packet: packet,
        mode_used: 'explain',
        latency_ms: 42,
      };
    },
  };

  const response = await hostedService.handleToolCall({
    name: 'hivemind_chat_context',
    arguments: { query: 'What does the brief say?', mode: 'fact' },
  }, 'user-1', 'org-1', apiClient);
  const parsed = JSON.parse(response.content[0].text);

  assert.deepEqual(calls.map((call) => call.body.mode), ['fact', 'explain']);
  assert.ok(calls.every((call) => call.path === '/api/recall'));
  assert.equal(parsed.mode_used, 'explain');
  assert.deepEqual(parsed.context, packet);
  assert.equal(parsed.latency_ms, 42);
});
