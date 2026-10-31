import test from 'node:test';
import assert from 'node:assert/strict';
import { routingConfig, routeApprovedEvent, flushEmployeeWakes, FORWARDED } from '../../src/connectors/employee-event-routing.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LEO = '44444444-4444-4444-8444-444444444444';
const WATCH = '55555555-5555-4555-8555-555555555555';
const OTHER_WATCH = '55555555-5555-4555-8555-555555555556';
const env = { HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1' };
const off = routingConfig(env);
const forward = routingConfig({ ...env, HIVEMIND_EMPLOYEE_EVENT_FORWARD_ORGS: ` ${ORG.toUpperCase()} , not-a-uuid` });
const sub = { toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: USER };
const mail = { sender: 'boss@acme.com', sender_verified: true, subject: '@leo invoice 42', message_text: 'Please pay by Friday.' };

/** In-memory Core tables: deliveries, events, watches and every query the forward path makes. Anything else fails the test. */
function fakeDb({ watches = [], runtimeOn = false } = {}) {
  const deliveries = [], events = new Map(), log = { watchesFired: [], queries: [] };
  const db = {
    userOrganization: { findUnique: async () => ({ role: 'admin', isActive: true, deactivatedAt: null }), findMany: async () => [{ userId: USER, role: 'admin', user: { email: 'boss@acme.com', deletedAt: null } }] },
    digitalEmployee: { findMany: async () => [{ id: LEO, name: 'Leo', slug: 'leo', createdBy: USER, teamId: null, scope: 'organization', status: 'running', slackBotUserId: null,
      policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_leo' }, native_lifecycle: { version: 1, phase: 'active' } } }] },
    teamMember: { findMany: async () => [] },
    organization: { findUnique: async () => ({ companyProfile: {} }) },
    organizationProfile: { findMany: async () => [{ value: 'https://acme.com' }] },
    $executeRawUnsafe: async (sql, ...a) => {
      if (/^\s*(CREATE|ALTER)/i.test(sql)) return 0;
      if (sql.includes('SET status=$2')) { for (const row of deliveries) if (a[0].includes(row.id)) Object.assign(row, { status: a[1], skip_reason: a[2], last_error: a[3] }); return 1; }
      if (sql.includes("SET status='forward_pending'")) { for (const row of deliveries) if (a[0].includes(row.id)) Object.assign(row, { status: 'forward_pending', last_error: a[1], retry_at: new Date(a[2]) }); return 1; }
      if (sql.includes('UPDATE hivemind_employee_watches SET last_fired_at')) { log.watchesFired.push(a[0]); return 1; }
      throw new Error(`unexpected execute: ${sql}`);
    },
    $queryRawUnsafe: async (sql, ...a) => {
      log.queries.push([sql.slice(0, 60)]);
      if (sql.includes('runtime_enabled')) return [{ runtime_enabled: runtimeOn }];
      if (sql.includes("'forward_pending',$9")) {
        const [id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, summary] = a;
        const existing = deliveries.find(row => row.event_id === event_id && row.employee_id === employee_id);
        if (existing) { if (existing.status === 'forward_pending' && reason === 'forward_approved') existing.reason = reason; return []; }
        deliveries.push({ id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, status: 'forward_pending', summary, attempts: 0, created_at: new Date() });
        return [{ id }];
      }
      if (sql.includes('INSERT INTO hivemind_employee_event_deliveries')) {
        const [id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, watch_id, status, skip_reason] = a;
        deliveries.push({ id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, watch_id, status, skip_reason, attempts: 0, created_at: new Date() });
        return [{ id }];
      }
      if (sql.includes('FROM hivemind_employee_watches WHERE org_id=$1 AND toolkit=$2 AND trigger_slug=$3 AND enabled ORDER BY')) return watches;
      if (sql.includes('FROM hivemind_employee_watches WHERE org_id=$1 AND toolkit')) return watches;
      if (sql.includes('GROUP BY org_id,employee_id')) return [];
      if (sql.includes("SET status='forwarding'")) {
        const rows = deliveries.filter(row => row.employee_id === a[0] && row.status === 'forward_pending' && (!row.retry_at || row.retry_at <= new Date(a[1])));
        for (const row of rows) { row.status = 'forwarding'; row.attempts += 1; }
        return rows.map(row => ({ ...row }));
      }
      if (sql.includes('FROM hivemind_trigger_events e')) return events.has(a[0]) ? [{ id: a[0], data: events.get(a[0]), occurred_at: null, received_at: new Date('2026-10-31T10:00:00Z'), relevance_decision: { status: 'approved' }, subject: USER }] : [];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { db, deliveries, events, log };
}

test('switch: HIVEMIND_EMPLOYEE_EVENT_FORWARD_ORGS lists organization ids, any case; anything else is ignored; empty by default', () => {
  assert.deepEqual([...forward.forwardOrgs], [ORG]);
  assert.equal(off.forwardOrgs.size, 0);
});

test('off: routing is unchanged, nothing is forwarded and the flush makes no forward query', async () => {
  const { db, deliveries, events, log } = fakeDb({ runtimeOn: false });
  events.set('ev1', mail);
  const decision = await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev1', data: mail }, sub }, { config: off, schedule: () => {} });
  assert.deepEqual(decision.targets.map(target => target.reason), ['mention'], 'Core decides the mention target itself');
  assert.ok(deliveries.every(row => row.employee_id !== FORWARDED));
  log.queries.length = 0;
  assert.deepEqual(await flushEmployeeWakes(db, { config: off, deliver: async () => {} }), { wakes: 0, briefed: 0, skipped: 0, failed: 0 });
  assert.ok(log.queries.every(([sql]) => !sql.includes('forwarding')));
});

test('on: an approved event is recorded once as forwarded work, without any routing decision in Core', async () => {
  const { db, deliveries, log } = fakeDb();
  let scheduled = 0;
  const route = () => routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev1', data: mail }, sub }, { config: forward, schedule: () => { scheduled += 1; } });
  assert.deepEqual(await route(), { forwarded: true, relevance: 'approved' });
  await route();
  assert.equal(deliveries.length, 1, 'a second delivery of the same event adds nothing');
  assert.deepEqual([deliveries[0].employee_id, deliveries[0].reason, deliveries[0].status], [FORWARDED, 'forward_approved', 'forward_pending']);
  assert.equal(scheduled, 2);
  assert.ok(log.queries.every(([sql]) => !/hivemind_employee_watches|runtime_enabled/.test(sql)), 'no watch, Runtime or roster read while routing');
  // An unapproved event without an @mention is not forwarded; with one it is, as mention-only, and approval later raises it.
  assert.deepEqual(await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev2', data: { subject: 'Newsletter' } }, sub }, { config: forward, mentionsOnly: true, schedule: () => {} }), { skipped: 'no_mention' });
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev3', data: mail }, sub }, { config: forward, mentionsOnly: true, schedule: () => {} });
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev3', data: mail }, sub }, { config: forward, schedule: () => {} });
  assert.equal(deliveries.find(row => row.event_id === 'ev3').reason, 'forward_approved');
  assert.deepEqual(await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev4', data: { subject: 'x' } }, sub }, { config: forward, mentionsOnly: true, nearMiss: true, schedule: () => {} }), { forwarded: true, relevance: 'near_miss' });
});

test('on: the flush sends the event facts, sender status and eligible watches to OpenDot and records its outcome', async () => {
  const watches = [
    { id: WATCH, user_id: USER, employee_id: LEO, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: { from: 'acme.com', other: 'x' }, instruction: 'Summarise.' },
    { id: OTHER_WATCH, user_id: 'someone-else', employee_id: LEO, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: {}, instruction: 'Not mine.' },
  ];
  const { db, deliveries, events, log } = fakeDb({ watches });
  events.set('ev1', mail);
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev1', data: mail }, sub }, { config: forward, schedule: () => {} });
  const sent = [];
  const totals = await flushEmployeeWakes(db, { config: forward, forward: async (request) => { sent.push(request); return { outcome: 'woken', targets: [{ employeeId: LEO, watchIds: [WATCH], wake: 'admitted' }] }; } });
  assert.equal(totals.forwarded, 1);
  assert.equal(sent.length, 1);
  const request = sent[0];
  assert.deepEqual([request.version, request.organizationId, request.userId, request.eventId, request.relevance, request.runtimeEnabled, request.orgWide], [1, ORG, USER, 'ev1', 'approved', false, false]);
  assert.equal(request.event.title, '@leo invoice 42');
  assert.ok(request.event.mentionText.includes('@leo'));
  assert.equal(request.sender.status, 'internal');
  assert.deepEqual(request.watches.map(watch => [watch.id, watch.filter]), [[WATCH, { from: 'acme.com' }]], 'only the account owner\'s watch, only known filter keys');
  assert.ok(request.event.signal?.evidence, 'the same attention signal a wake carries');
  assert.equal(deliveries[0].status, 'forwarded');
  assert.equal(deliveries[0].skip_reason, 'woken');
  assert.deepEqual(log.watchesFired, [[WATCH]]);
});

test('on: a temporary failure retries with backoff, a permanent refusal is final, and the event goes once', async () => {
  const { db, deliveries, events } = fakeDb();
  events.set('ev1', mail);
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev1', data: mail }, sub }, { config: forward, schedule: () => {} });
  const t0 = Date.now();
  await flushEmployeeWakes(db, { config: forward, now: t0, forward: async () => { throw Object.assign(new Error('open_dot_runtime_unavailable'), { status: 503 }); } });
  assert.equal(deliveries[0].status, 'forward_pending');
  assert.equal(deliveries[0].retry_at.getTime(), t0 + 60_000);
  let calls = 0;
  await flushEmployeeWakes(db, { config: forward, now: t0 + 30_000, forward: async () => { calls += 1; return {}; } });
  assert.equal(calls, 0, 'not before the retry time');
  await flushEmployeeWakes(db, { config: forward, now: t0 + 61_000, forward: async () => { calls += 1; return { outcome: 'skipped', targets: [] }; } });
  assert.equal(calls, 1);
  assert.equal(deliveries[0].status, 'forwarded');
  await flushEmployeeWakes(db, { config: forward, now: t0 + 999_000, forward: async () => { calls += 1; return {}; } });
  assert.equal(calls, 1, 'a forwarded event is not sent again');
  events.set('ev9', mail);
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'ev9', data: mail }, sub }, { config: forward, schedule: () => {} });
  await flushEmployeeWakes(db, { config: forward, now: t0, forward: async () => { throw Object.assign(new Error('bad_request'), { status: 400 }); } });
  assert.equal(deliveries.find(row => row.event_id === 'ev9').status, 'skipped');
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'gone', data: mail }, sub }, { config: forward, schedule: () => {} });
  await flushEmployeeWakes(db, { config: forward, now: t0, forward: async () => ({}) });
  assert.equal(deliveries.find(row => row.event_id === 'gone').skip_reason, 'event_unavailable');
});

test('on, other companies: an organization not on the list keeps Core routing', async () => {
  const { db, deliveries, events } = fakeDb();
  const otherOrg = '99999999-9999-4999-8999-999999999999';
  events.set('ev1', mail);
  const decision = await routeApprovedEvent(db, { orgId: otherOrg, userId: USER, event: { id: 'ev1', data: mail }, sub }, { config: forward, schedule: () => {} });
  assert.ok(Array.isArray(decision.targets));
  assert.ok(deliveries.every(row => row.employee_id !== FORWARDED));
});
