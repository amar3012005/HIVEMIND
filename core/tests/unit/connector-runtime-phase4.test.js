// Connector Runtime V1 — Phase 4 provider migration tests (Google family).
// Verifies connector-wise plugins register cleanly (no tool-name collisions),
// canonical names are valid, reads parity-wrap runGoogleTool, and writes route
// to approval. No network/DB — the Google executor is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRegistry } from '../../src/connectors/runtime/index.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { createGoogleDocsPlugin } from '../../src/connectors/runtime/plugins/google_docs/index.js';
import { createGoogleSheetsPlugin } from '../../src/connectors/runtime/plugins/google_sheets/index.js';
import { validateManifest, TOOL_NAME_RE } from '../../src/connectors/runtime/contracts.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';

const CTX = (over = {}) => ({ requestId: 'r1', userId: 'u1', orgId: 'o1', role: 'member', surface: 'chat', projectIds: [], ...over });

function fakeGoogle(payloads) {
  const calls = [];
  const fn = async (tool, args, scope) => { calls.push({ tool, args, scope }); if (payloads[tool] instanceof Error) throw payloads[tool]; return payloads[tool] ?? { ok: true }; };
  fn.calls = calls;
  return fn;
}

test('buildRegistry registers gmail + google_docs + google_sheets with no tool-name collisions', () => {
  const reg = buildRegistry();
  const ids = reg.listConnectors().map((p) => p.id).sort();
  assert.deepEqual(ids, ['gmail', 'google_docs', 'google_sheets']);
  // every tool name canonical + globally unique
  const all = reg.listConnectors().flatMap((p) => p.manifest.tools.map((t) => t.name));
  assert.ok(all.every((n) => TOOL_NAME_RE.test(n)), 'all tool names canonical');
  assert.equal(all.length, new Set(all).size, 'no duplicate tool names across connectors');
});

test('google_docs + google_sheets manifests validate', () => {
  assert.doesNotThrow(() => validateManifest(createGoogleDocsPlugin().manifest));
  assert.doesNotThrow(() => validateManifest(createGoogleSheetsPlugin().manifest));
});

function runtimeWith(payloads) {
  const exec = fakeGoogle(payloads);
  const reg = new ConnectorRegistry();
  reg.register(createGoogleDocsPlugin({ execGoogleTool: exec }));
  reg.register(createGoogleSheetsPlugin({ execGoogleTool: exec }));
  const config = loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_CHAT: '1' });
  // no prisma → writes cannot create approvals; provide a minimal fake for write test
  const rows = [];
  const prisma = { pendingWrite: {
    async findUnique() { return null; },
    async create({ data }) { const r = { id: `pw-${rows.length + 1}`, status: 'draft', ...data }; rows.push(r); return { ...r }; },
    async updateMany() { return { count: 0 }; }, async update() { return {}; },
  } };
  return { runtime: new ConnectorRuntime({ registry: reg, config, db: { fake: true }, hooks: undefined }), exec, prisma, rows };
}

test('google_docs__get read parity wraps drive/docs payload verbatim', async () => {
  const payload = { documentId: 'd1', title: 'Plan', text: 'hello world' };
  const exec = fakeGoogle({ docs_get: payload });
  const reg = new ConnectorRegistry();
  reg.register(createGoogleDocsPlugin({ execGoogleTool: exec }));
  const runtime = new ConnectorRuntime({ registry: reg, db: {} });
  const res = await runtime.executeTool('google_docs__get', { documentId: 'd1' }, CTX());
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.content[0].data, payload);
  assert.equal(exec.calls[0].tool, 'docs_get');
  assert.deepEqual(exec.calls[0].scope, { user_id: 'u1', org_id: 'o1' });
  assert.deepEqual(res.metadata.sourceIds, ['d1']);
});

test('legacy drive_search alias resolves to google_docs__search', async () => {
  const exec = fakeGoogle({ drive_search: { files: [{ id: 'f1' }] } });
  const reg = new ConnectorRegistry();
  reg.register(createGoogleDocsPlugin({ execGoogleTool: exec }));
  const runtime = new ConnectorRuntime({ registry: reg, db: {} });
  const res = await runtime.executeTool('drive_search', { query: 'x' }, CTX());
  assert.equal(res.status, 'completed');
  assert.equal(exec.calls[0].tool, 'drive_search');
  assert.deepEqual(res.metadata.sourceIds, ['f1']);
});

test('google_sheets__create is a write → requires approval (provider not called)', async () => {
  const exec = fakeGoogle({ sheets_create: { spreadsheetId: 's1' } });
  const reg = new ConnectorRegistry();
  reg.register(createGoogleSheetsPlugin({ execGoogleTool: exec }));
  const rows = [];
  const prisma = { pendingWrite: {
    async findUnique() { return null; },
    async create({ data }) { const r = { id: 'pw-1', status: 'draft', ...data }; rows.push(r); return { ...r }; },
    async updateMany() { return { count: 0 }; }, async update() { return {}; },
  } };
  const { buildDefaultHooks } = await import('../../src/connectors/runtime/index.js');
  const runtime = new ConnectorRuntime({ registry: reg, db: {}, hooks: buildDefaultHooks({ prisma }) });
  const res = await runtime.executeTool('google_sheets__create', { title: 'T', rows: [['a']] }, CTX());
  assert.equal(res.status, 'approval_required');
  assert.equal(exec.calls.length, 0, 'provider not called before approval');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'google_sheets');
});

test('google_docs__get not allowed on sync surface → forbidden', async () => {
  const { runtime } = runtimeWith({ docs_get: { documentId: 'd1' } });
  const res = await runtime.executeTool('google_docs__get', { documentId: 'd1' }, CTX({ surface: 'sync' }));
  assert.equal(res.status, 'forbidden');
});
