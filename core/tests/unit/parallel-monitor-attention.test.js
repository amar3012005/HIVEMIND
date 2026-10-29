import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parallelPollConfig, normalizeMonitors, normalizeMonitorEvents, parallelEventId, ownersOfSubject,
  pollParallelMonitors, startParallelMonitorPoller,
} from '../../src/connectors/composio/parallel-monitor-poll.js';

const ORG = '11111111-1111-4111-8111-111111111111'; const USER = '22222222-2222-4222-8222-222222222222';
const config = parallelPollConfig({ PARALLEL_MONITOR_POLL_INTERVAL_MS: '300000' });

function fakeDb({ optOut = false } = {}) {
  const subs = new Map(); const events = new Map();
  return {
    subs, events,
    userOrganization: {
      findMany: async ({ where }) => (where.userId === USER ? [{ orgId: ORG, userId: USER }] : []),
      findFirst: async ({ where }) => (where.orgId === ORG ? { orgId: ORG, userId: USER } : null),
    },
    $executeRawUnsafe: async () => 0,
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('INSERT INTO hivemind_trigger_subscriptions')) {
        const key = [args[1], args[2], args[3], args[4]].join('|');
        const existing = subs.get(key);
        if (existing) return [{ ...existing, inserted: false }];
        const row = { id: args[0], org_id: args[1], user_id: args[2], account_id: args[3], status: optOut ? 'paused' : 'active',
          runtime_attention: true, runtime_attention_opt_out: false, created_at: new Date('2026-10-20T00:00:00Z') };
        subs.set(key, row); return [{ ...row, inserted: true }];
      }
      if (sql.includes('INSERT INTO hivemind_trigger_events')) {
        if (events.has(args[0])) return [];
        events.set(args[0], { id: args[0], subscription_id: args[1], org_id: args[2], user_id: args[3], data: JSON.parse(args[4]), occurred_at: args[5] });
        return [{ id: args[0] }];
      }
      throw new Error(`unexpected sql ${sql.slice(0, 40)}`);
    },
  };
}

const monitorsResult = { successful: true, data: { monitors: [
  { monitor_id: 'monitor_a', query: 'Acme pricing changes', status: 'active' },
  { monitor_id: 'monitor_dead', query: 'old', status: 'canceled' }] } };
const eventsResult = { successful: true, data: { events: [
  { event_group_id: 'evg_1', event_date: '2026-10-28T10:00:00Z', result: { summary: 'Acme raised Pro to $49.' } },
  { event_group_id: 'evg_old', event_date: '2026-10-01T10:00:00Z', result: { summary: 'Older change.' } }] } };

function harness(db, { run, classified = [] } = {}) {
  const runs = [];
  return {
    runs, classified,
    poll: (extra = {}) => pollParallelMonitors({ prisma: db, config, listAccounts: async () => [{ id: 'ca_par', subject: `hivemind:${USER}` }],
      run: run || (async (subject, slug, args) => { runs.push({ subject, slug, args }); return slug === 'PARALLEL_LIST_MONITORS' ? monitorsResult : eventsResult; }),
      classify: (ctx) => classified.push(ctx), ...extra }),
  };
}

test('a monitor event becomes one attention row with source, monitor id, query and change summary', async () => {
  const db = fakeDb(); const h = harness(db);
  const result = await h.poll();
  assert.equal(result.written, 1);
  const [row] = [...db.events.values()];
  assert.equal(row.org_id, ORG); assert.equal(row.user_id, USER);
  assert.deepEqual([row.data.source, row.data.monitor_id, row.data.query, row.data.summary],
    ['parallel', 'monitor_a', 'Acme pricing changes', 'Acme raised Pro to $49.']);
  assert.equal(row.id, parallelEventId(ORG, USER, 'monitor_a', 'evg_1'));
  assert.deepEqual(h.runs.map((r) => [r.subject, r.slug]), [[`hivemind:${USER}`, 'PARALLEL_LIST_MONITORS'], [`hivemind:${USER}`, 'PARALLEL_LIST_MONITOR_EVENTS']]);
  assert.deepEqual(h.runs[1].args, { monitor_id: 'monitor_a', lookback_period: '2d' });
  assert.equal([...db.subs.values()][0].runtime_attention, true);
  assert.deepEqual([h.classified[0].orgId, h.classified[0].allowedAccountIds], [ORG, ['ca_par']]);
});

test('repeated polls never write an event twice, and pre-connection history is not replayed', async () => {
  const db = fakeDb(); const h = harness(db);
  await h.poll(); await h.poll(); const third = await h.poll();
  assert.equal(db.events.size, 1);
  assert.equal(third.written, 0);
});

test('a paused or opted-out subscription receives nothing', async () => {
  const db = fakeDb({ optOut: true }); const h = harness(db);
  assert.equal((await h.poll()).written, 0);
  assert.equal(db.events.size, 0);
});

test('failures are isolated: a failing monitor list or event call writes nothing and does not throw', async () => {
  const db = fakeDb();
  const failList = harness(db, { run: async () => { throw new Error('provider down'); } });
  assert.equal((await failList.poll()).written, 0);
  const failEvents = harness(db, { run: async (_s, slug) => { if (slug === 'PARALLEL_LIST_MONITORS') return monitorsResult; return { successful: false }; } });
  assert.equal((await failEvents.poll()).written, 0);
});

test('accounts per tick are bounded and rotate', async () => {
  const db = fakeDb();
  const accounts = Array.from({ length: 30 }, (_, i) => ({ id: `ca_${String(i).padStart(2, '0')}`, subject: `hivemind:${USER}` }));
  const small = { ...config, maxAccounts: 5 };
  const seen = [];
  const run = async (_s, slug) => { if (slug === 'PARALLEL_LIST_MONITORS') seen.push(1); return { successful: false }; };
  const first = await pollParallelMonitors({ prisma: db, config: small, listAccounts: async () => accounts, run, classify() {}, offset: 0 });
  const second = await pollParallelMonitors({ prisma: db, config: small, listAccounts: async () => accounts, run, classify() {}, offset: first.nextOffset });
  assert.deepEqual([first.accounts, first.nextOffset, second.nextOffset], [5, 5, 10]);
  assert.equal(seen.length, 10);
});

test('config is validated and the poller is off by default', () => {
  assert.equal(parallelPollConfig({}), null);
  assert.equal(parallelPollConfig({ PARALLEL_MONITOR_POLL_INTERVAL_MS: '0' }), null);
  assert.equal(parallelPollConfig({ PARALLEL_MONITOR_POLL_INTERVAL_MS: '300000' }).maxAccounts, 25);
  for (const bad of ['abc', '59999', '86400001', '1.5', '-1']) {
    assert.throws(() => parallelPollConfig({ PARALLEL_MONITOR_POLL_INTERVAL_MS: bad }), /PARALLEL_MONITOR_POLL_INTERVAL_MS/);
  }
  assert.throws(() => parallelPollConfig({ PARALLEL_MONITOR_POLL_INTERVAL_MS: '60000', PARALLEL_MONITOR_POLL_MAX_ACCOUNTS: '0' }), /MAX_ACCOUNTS/);
  assert.equal(startParallelMonitorPoller({ prisma: {}, env: {} }), null);
  assert.throws(() => startParallelMonitorPoller({ prisma: {}, env: { PARALLEL_MONITOR_POLL_INTERVAL_MS: 'x' } }));
  const stop = startParallelMonitorPoller({ prisma: {}, env: { PARALLEL_MONITOR_POLL_INTERVAL_MS: '60000' }, log: { log() {}, warn() {} }, poll: async () => ({ nextOffset: 0 }) });
  assert.equal(typeof stop, 'function'); stop();
});

test('result parsing tolerates field naming and drops unusable rows', () => {
  assert.deepEqual(normalizeMonitors([{ id: 'm1', query: 'q' }, { query: 'no id' }, 'x']).map((m) => m.id), ['m1']);
  const events = normalizeMonitorEvents({ data: { items: [{ id: 'e1', summary: 'S', created_at: '2026-10-28T00:00:00Z' }, { id: 'e2' }, { summary: 'no id', timestamp: 1 }] } });
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'e1');
  assert.match(events[1].id, /^h:/);
});

test('subjects map to the companies they act for', async () => {
  const db = fakeDb();
  assert.deepEqual(await ownersOfSubject(db, `hivemind:${USER}`), [{ orgId: ORG, userId: USER }]);
  assert.deepEqual(await ownersOfSubject(db, `${ORG}:${USER}`), [{ orgId: ORG, userId: USER }]);
  assert.deepEqual(await ownersOfSubject(db, ORG), [{ orgId: ORG, userId: USER }]);
  assert.deepEqual(await ownersOfSubject(db, 'hivemind:someone-else'), []);
});
