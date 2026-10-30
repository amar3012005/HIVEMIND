// The daily Composio trigger reconcile disables triggers no active membership owns, re-creates an active member's
// missing trigger while its account is ACTIVE, marks it missing otherwise, changes nothing in dry run, and logs counts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileComposioTriggers, planTriggerReconcile, triggerReconcileMode } from '../../src/connectors/composio/trigger-reconcile.js';

function fixture({ accounts = { 'acct-live': 'ACTIVE', 'acct-gone': 'EXPIRED' } } = {}) {
  const remote = [{ id: 'ti_ours' }, { id: 'ti_erased' }, { id: 'ti_stranger' }];
  const subscriptions = [
    { id: '00000000-0000-4000-8000-000000000001', remote_id: 'ti_ours', account_id: 'acct-live', member_active: true },
    { id: '00000000-0000-4000-8000-000000000002', remote_id: 'ti_erased', account_id: 'acct-live', member_active: false },
    { id: '00000000-0000-4000-8000-000000000003', remote_id: 'ti_lost', account_id: 'acct-live', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: 'org-1', toolkit: 'gmail', version: 'v1', config: {}, member_active: true },
    { id: '00000000-0000-4000-8000-000000000004', remote_id: 'ti_dead', account_id: 'acct-gone', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: 'org-1', toolkit: 'gmail', version: 'v1', config: {}, member_active: true },
  ];
  const calls = [];
  const writes = [];
  const request = async (method, path, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.startsWith('/trigger_instances/active')) return { items: remote.map(item => ({ ...item, disabled_at: null })), next_cursor: null };
    if (method === 'GET' && path.startsWith('/connected_accounts/')) return { status: accounts[decodeURIComponent(path.split('/')[2])] };
    if (method === 'POST') return { trigger_id: 'ti_new', echo: body };
    return {};
  };
  const db = {
    $queryRawUnsafe: async () => subscriptions,
    $executeRawUnsafe: async (sql, ...args) => { writes.push([sql.includes("status='missing'") ? 'missing' : 'remote_id', ...args]); return 1; },
  };
  const lines = [];
  return { request, db, calls, writes, lines, log: line => lines.push(line) };
}

test('dry run reports the plan and changes nothing', async () => {
  const f = fixture();
  const counts = await reconcileComposioTriggers(f.db, { dryRun: true, request: f.request, log: f.log });
  assert.equal(counts.unknownOnComposio, 2);
  assert.equal(counts.unknownNotOurs, 1);
  assert.equal(counts.unknownInactiveMember, 1);
  assert.equal(counts.missingOnComposio, 2);
  assert.equal(counts.accountActive, 1);
  assert.equal(counts.accountGone, 1);
  assert.deepEqual(f.calls.filter(call => !call.startsWith('GET')), []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.lines.length, 1);
  assert.doesNotMatch(f.lines[0], /ti_|acct-|org-1/);
});

test('apply disables unowned triggers, re-creates a live account trigger and marks a dead one missing', async () => {
  const f = fixture();
  const counts = await reconcileComposioTriggers(f.db, { dryRun: false, request: f.request, log: f.log });
  assert.deepEqual(f.calls.filter(call => call.startsWith('PATCH')).sort(), ['PATCH /trigger_instances/manage/ti_erased', 'PATCH /trigger_instances/manage/ti_stranger']);
  assert.ok(!f.calls.some(call => call.startsWith('DELETE')));
  assert.deepEqual(f.calls.filter(call => call.startsWith('POST')), ['POST /trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert']);
  assert.deepEqual(f.writes, [['remote_id', 'ti_new', '00000000-0000-4000-8000-000000000003'], ['missing', '00000000-0000-4000-8000-000000000004']]);
  assert.equal(counts.disabled, 2);
  assert.equal(counts.recreated, 1);
  assert.equal(counts.markedMissing, 1);
});

test('the plan never treats a trigger owned by an active membership as unknown', () => {
  const plan = planTriggerReconcile([{ id: 'a' }], [{ remote_id: 'a', member_active: true }]);
  assert.deepEqual(plan.disable, []);
  assert.deepEqual(plan.missing, []);
});

test('mode defaults to dry-run and rejects unknown values', () => {
  assert.equal(triggerReconcileMode({}), 'dry-run');
  assert.equal(triggerReconcileMode({ COMPOSIO_TRIGGER_RECONCILE: 'apply' }), 'apply');
  assert.equal(triggerReconcileMode({ COMPOSIO_TRIGGER_RECONCILE: 'off' }), 'off');
  assert.throws(() => triggerReconcileMode({ COMPOSIO_TRIGGER_RECONCILE: 'yes' }));
});

test('Control runs it daily as recurring maintenance', () => {
  const server = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  assert.match(server, /reconcileComposioTriggers\(prisma, \{ dryRun: mode !== 'apply' \}\)/);
  assert.match(server, /setInterval\(reconcileTriggers, 24 \* 3_600_000\)/);
});
