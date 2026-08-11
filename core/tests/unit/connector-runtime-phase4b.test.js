// Connector Runtime V1 — Phase 4b: MCP-backed mechanism + Slack plugin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRegistry, buildDefaultHooks } from '../../src/connectors/runtime/index.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { createSlackPlugin } from '../../src/connectors/runtime/plugins/slack/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';

const CTX = (o = {}) => ({ requestId: 'r1', userId: 'u1', orgId: 'o1', role: 'member', surface: 'chat', projectIds: [], ...o });

function fakeMcp(responses) {
  const calls = [];
  const fn = async (name, op, scope) => { calls.push({ name, op, scope }); if (responses[op.name] instanceof Error) throw responses[op.name]; return responses[op.name] ?? { content: [{ type: 'text', text: 'ok' }] }; };
  return { fn, calls };
}

test('buildRegistry now includes slack (gmail/google_docs/google_sheets/slack), no collisions', () => {
  const ids = buildRegistry().listConnectors().map((p) => p.id).sort();
  assert.deepEqual(ids, ['gmail', 'google_docs', 'google_sheets', 'slack']);
});

test('slack read wraps MCPIngestionService MCP-shaped result verbatim', async () => {
  const { fn, calls } = fakeMcp({ slack_search_messages: { content: [{ type: 'text', text: 'found 3 messages' }] } });
  const reg = new ConnectorRegistry();
  reg.register(createSlackPlugin({ mcpExec: fn }));
  const rt = new ConnectorRuntime({ registry: reg, db: {} });
  const res = await rt.executeTool('slack__search', { query: 'launch' }, CTX());
  assert.equal(res.status, 'completed');
  assert.equal(res.content[0].text, 'found 3 messages');
  // provider tool name mapped + caller-scoped identity
  assert.equal(calls[0].op.name, 'slack_search_messages');
  assert.equal(calls[0].name, 'slack');
  assert.deepEqual(calls[0].scope, { user_id: 'u1', org_id: 'o1' });
});

test('slack legacy alias (slack_channel_history) resolves to slack__get_history', async () => {
  const { fn, calls } = fakeMcp({ slack_channel_history: { content: [{ type: 'text', text: 'history' }] } });
  const reg = new ConnectorRegistry();
  reg.register(createSlackPlugin({ mcpExec: fn }));
  const rt = new ConnectorRuntime({ registry: reg, db: {} });
  const res = await rt.executeTool('slack_channel_history', { channel_id: 'C1' }, CTX());
  assert.equal(res.status, 'completed');
  assert.equal(calls[0].op.name, 'slack_channel_history');
});

test('slack__post_message is a write → approval-gated (mcp exec not called)', async () => {
  const { fn, calls } = fakeMcp({ slack_post_message: { content: [{ type: 'text', text: 'sent' }] } });
  const reg = new ConnectorRegistry();
  reg.register(createSlackPlugin({ mcpExec: fn }));
  const rows = [];
  const prisma = { pendingWrite: { async findUnique() { return null; }, async create({ data }) { const r = { id: 'pw-1', status: 'draft', ...data }; rows.push(r); return { ...r }; }, async updateMany() { return { count: 0 }; }, async update() { return {}; } } };
  const rt = new ConnectorRuntime({ registry: reg, db: {}, config: loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_CHAT: '1' }), hooks: buildDefaultHooks({ prisma }) });
  const res = await rt.executeTool('slack__post_message', { channel_id: 'C1', message: 'hi' }, CTX());
  assert.equal(res.status, 'approval_required');
  assert.equal(calls.length, 0);
  assert.equal(rows[0].provider, 'slack');
});

test('slack not-connected error → not_connected status', async () => {
  const { fn } = fakeMcp({ slack_search_messages: new Error('No Nango connection for provider slack') });
  const reg = new ConnectorRegistry();
  reg.register(createSlackPlugin({ mcpExec: fn }));
  const rt = new ConnectorRuntime({ registry: reg, db: {} });
  const res = await rt.executeTool('slack__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'not_connected');
});
