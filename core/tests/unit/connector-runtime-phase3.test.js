// Connector Runtime V1 — Phase 3 acceptance tests (safety pipeline + writes).
//
// plan §8 Phase 3 acceptance:
//   - Read executes immediately.
//   - Write creates one approval (provider NOT called).
//   - Tampered approval arguments fail.
//   - Double approval sends once.
//   - OAuth credentials never appear in output or logs.
// Plus ajv input validation, idempotency, and policy (role floor). No real DB —
// an in-memory prisma fake enforces the unique idempotencyKey + updateMany claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildConnectorRuntime } from '../../src/connectors/runtime/index.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';
import { hashArgs, idempotencyKeyFor } from '../../src/connectors/runtime/approval-hash.js';

const CTX = (over = {}) => ({ requestId: 'trace-1', userId: 'u1', orgId: 'o1', role: 'member', surface: 'chat', projectIds: [], ...over });

// ── in-memory prisma fake ────────────────────────────────────────────────
function fakePrisma() {
  const rows = new Map(); // id -> row
  let seq = 0;
  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gt' in v) return new Date(row[k]).getTime() > new Date(v.gt).getTime();
      return false;
    }
    return (row[k] ?? null) === (v ?? null);
  });
  return {
    _rows: rows,
    pendingWrite: {
      async create({ data }) {
        if (data.idempotencyKey && [...rows.values()].some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const e = new Error('Unique constraint failed on idempotencyKey'); e.code = 'P2002'; throw e;
        }
        const id = `pw-${++seq}`;
        const row = { id, status: 'draft', result: null, ...data };
        rows.set(id, row);
        return { ...row };
      },
      async findUnique({ where }) {
        if (where.id) return rows.has(where.id) ? { ...rows.get(where.id) } : null;
        if (where.idempotencyKey) { const r = [...rows.values()].find((x) => x.idempotencyKey === where.idempotencyKey); return r ? { ...r } : null; }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
        return { count };
      },
      async update({ where, data }) {
        const row = rows.get(where.id); if (!row) throw new Error('not found');
        Object.assign(row, data); return { ...row };
      },
    },
  };
}

const SEARCH_PAYLOAD = { count: 1, messages: [{ id: 'm1', subject: 's' }] };

function build({ payloads = {}, config, prisma, auditLogger } = {}) {
  const calls = [];
  const exec = async (tool, args, scope) => {
    calls.push({ tool, args, scope });
    if (payloads[tool] instanceof Error) throw payloads[tool];
    if (typeof payloads[tool] === 'function') return payloads[tool](args);
    return payloads[tool] ?? { ok: true };
  };
  const registry = new ConnectorRegistry();
  registry.register(new GmailPlugin({ execGoogleTool: exec }));
  const runtime = buildConnectorRuntime({ registry, prisma, db: { fake: true }, config: config || loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_CHAT: '1' }), auditLogger });
  return { runtime, calls, prisma };
}

// ── Reads execute immediately ────────────────────────────────────────────
test('read executes immediately (no approval)', async () => {
  const { runtime, calls } = build({ payloads: { gmail_search: SEARCH_PAYLOAD }, prisma: fakePrisma() });
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 1);
});

// ── ajv input validation ────────────────────────────────────────────────
test('missing required arg → invalid_input, provider NOT called', async () => {
  const { runtime, calls } = build({ payloads: { gmail_search: SEARCH_PAYLOAD }, prisma: fakePrisma() });
  const res = await runtime.executeTool('gmail__search', { max: 5 }, CTX()); // no query
  assert.equal(res.status, 'invalid_input');
  assert.equal(calls.length, 0, 'provider must not be called on invalid input');
});

test('undeclared property is stripped; type coerced', async () => {
  const seen = [];
  const { runtime } = build({ payloads: { gmail_search: (args) => { seen.push(args); return SEARCH_PAYLOAD; } }, prisma: fakePrisma() });
  await runtime.executeTool('gmail__search', { query: 'x', max: '7', evil: 'drop-me' }, CTX());
  assert.equal(seen[0].max, 7, 'string coerced to integer');
  assert.ok(!('evil' in seen[0]), 'undeclared prop stripped before provider');
});

// ── Write creates one approval, provider NOT called ───────────────────────
test('write (gmail__send) creates ONE approval and does not call the provider', async () => {
  const prisma = fakePrisma();
  const { runtime, calls } = build({ payloads: {}, prisma });
  const res = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  assert.equal(res.status, 'approval_required');
  assert.ok(res.approval?.id, 'approval id returned');
  assert.ok(res.approval?.expiresAt, 'expiry returned');
  assert.equal(calls.length, 0, 'provider must NOT be called before approval');
  assert.equal(prisma._rows.size, 1, 'exactly one pending_writes row');
  const row = [...prisma._rows.values()][0];
  assert.equal(row.status, 'draft');
  assert.equal(row.provider, 'gmail');
  assert.equal(row.toolName, 'gmail__send');
});

// ── Idempotency ──────────────────────────────────────────────────────────
test('same write twice while pending → same approval, one row (idempotent)', async () => {
  const prisma = fakePrisma();
  const { runtime } = build({ payloads: {}, prisma });
  const a = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  const b = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  assert.equal(a.approval.id, b.approval.id, 'same approval id');
  assert.equal(prisma._rows.size, 1, 'no duplicate row');
});

test('runtime idempotencyKey matches the shared chat formula byte-for-byte', () => {
  // Pins the runtime to draft-approval.js's formula so they can never drift.
  const args = { to: 'a@x.com', subject: 's', body: 'b' };
  const ah = hashArgs(args);
  const expected = idempotencyKeyFor({ orgId: 'o1', userId: 'u1', projectId: '', toolGroup: 'gmail', toolName: 'gmail__send', argsHash: ah, traceId: 'trace-1' });
  // recompute via the exact draft-approval string
  const chatStyle = createHash('sha256').update(`o1:u1::gmail:gmail__send:${ah}:trace-1`).digest('hex');
  assert.equal(expected, chatStyle);
});

// ── Approved execution: sends once, uses STORED args ──────────────────────
async function approve(prisma, draftId) {
  await prisma.pendingWrite.update({ where: { id: draftId }, data: { status: 'approved', approvedAt: new Date() } });
}

test('approved write executes exactly once with STORED args', async () => {
  const prisma = fakePrisma();
  const { runtime, calls } = build({ payloads: { gmail_send: { id: 'sent-1', sent: true } }, prisma });
  const draft = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  await approve(prisma, draft.approval.id);
  const res = await runtime.executeApproved(draft.approval.id, 'gmail__send', CTX());
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 1, 'provider called exactly once');
  assert.equal(calls[0].tool, 'gmail_send');
  // schema default (markdown:false) is applied at validation and persisted with
  // the stored args — the approved execution replays exactly what was validated.
  assert.deepEqual(calls[0].args, { to: 'a@x.com', subject: 's', body: 'b', markdown: false });
  assert.equal([...prisma._rows.values()][0].status, 'sent');
});

test('double approval sends ONCE (claim guard)', async () => {
  const prisma = fakePrisma();
  const { runtime, calls } = build({ payloads: { gmail_send: { id: 'sent-1', sent: true } }, prisma });
  const draft = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  await approve(prisma, draft.approval.id);
  const [r1, r2] = await Promise.all([
    runtime.executeApproved(draft.approval.id, 'gmail__send', CTX()),
    runtime.executeApproved(draft.approval.id, 'gmail__send', CTX()),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, ['completed', 'forbidden'], 'one completes, one is rejected');
  assert.equal(calls.length, 1, 'provider invoked exactly once');
});

test('tampered stored args (hash mismatch) → forbidden, provider not called', async () => {
  const prisma = fakePrisma();
  const { runtime, calls } = build({ payloads: { gmail_send: { id: 'x' } }, prisma });
  const draft = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  await approve(prisma, draft.approval.id);
  // simulate tampering: mutate stored args after approval so hash != argsHash
  const row = [...prisma._rows.values()][0];
  row.toolArgs = { to: 'attacker@evil.com', subject: 's', body: 'b' };
  const res = await runtime.executeApproved(draft.approval.id, 'gmail__send', CTX());
  assert.equal(res.status, 'forbidden');
  assert.equal(calls.length, 0, 'tampered draft must not execute');
});

// ── Secret leakage ────────────────────────────────────────────────────────
test('OAuth token in a provider error is redacted from output', async () => {
  const { runtime } = build({ payloads: { gmail_get: new Error('Google API 500: Authorization: Bearer ya29.LEAKED') }, prisma: fakePrisma() });
  const res = await runtime.executeTool('gmail__get_message', { id: 'm1' }, CTX());
  assert.ok(!JSON.stringify(res).includes('ya29.LEAKED'));
});

// ── Policy: role floor ────────────────────────────────────────────────────
test('role floor: viewer cannot run a tool requiring manager', async () => {
  // custom plugin with a minimumRole tool
  const { ConnectorPlugin } = await import('../../src/connectors/runtime/connector-plugin.js');
  class RolePlugin extends ConnectorPlugin {
    constructor() { super({ id: 'role', version: '1.0.0', displayName: 'R', authProvider: 'none', syncMode: 'none', tools: [{ name: 'role__admin_op', description: 'd', inputSchema: { type: 'object' }, access: 'read', approval: 'never', minimumRole: 'manager', allowedSurfaces: ['chat'] }] }); }
    async executeTool() { return { ok: true }; }
  }
  const registry = new ConnectorRegistry();
  registry.register(new RolePlugin());
  const runtime = buildConnectorRuntime({ registry, prisma: fakePrisma(), config: loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_CHAT: '1' }) });
  const denied = await runtime.executeTool('role__admin_op', {}, CTX({ role: 'viewer' }));
  assert.equal(denied.status, 'forbidden');
  const ok = await runtime.executeTool('role__admin_op', {}, CTX({ role: 'admin' }));
  assert.equal(ok.status, 'completed');
});

// ── Audit ──────────────────────────────────────────────────────────────────
test('audit event is emitted for each call', async () => {
  const events = [];
  const auditLogger = { log: (e) => events.push(e) };
  const { runtime } = build({ payloads: { gmail_search: SEARCH_PAYLOAD }, prisma: fakePrisma(), auditLogger });
  await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'connector_exec');
  assert.equal(events[0].connector, 'gmail');
  assert.equal(events[0].tool, 'gmail__search');
  assert.equal(events[0].status, 'completed');
});

test('write fails closed if audit throws', async () => {
  const auditLogger = { log: () => { throw new Error('audit sink down'); } };
  const prisma = fakePrisma();
  const { runtime, calls } = build({ payloads: { gmail_send: { id: 'x', sent: true } }, prisma, auditLogger });
  const draft = await runtime.executeTool('gmail__send', { to: 'a@x.com', subject: 's', body: 'b' }, CTX());
  await approve(prisma, draft.approval.id);
  const res = await runtime.executeApproved(draft.approval.id, 'gmail__send', CTX());
  // provider ran once, but audit failure makes the runtime render failed (fail-closed)
  assert.equal(res.status, 'failed');
  assert.equal(calls.length, 1);
});
