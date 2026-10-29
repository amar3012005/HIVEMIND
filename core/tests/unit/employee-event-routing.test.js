import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFacts, mentionedEmployees, internalSender, watchMatches, decideRouting, routingConfig, routeApprovedEvent, flushEmployeeWakes, wakeIdFor, EVENT_LEVEL } from '../../src/connectors/employee-event-routing.js';
import { runEventWatch, watchKey } from '../../src/connectors/employee-event-watches.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MAYA = '33333333-3333-4333-8333-333333333333';
const LEO = '44444444-4444-4444-8444-444444444444';
const on = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1' });
const employees = [{ id: MAYA, name: 'Maya Chen', slug: 'maya-chen', slackBotUserId: 'UBOTMAYA', tenantUserId: USER }, { id: LEO, name: 'Leo', slug: 'leo', tenantUserId: USER }];
const directory = { memberEmails: new Set(['boss@acme.com']), companyDomains: new Set(['acme.com']) };
const slackFacts = (data) => eventFacts('slack', 'SLACK_NEW_MESSAGE', data, on);
const mail = (data) => eventFacts('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', data, on);
const decide = (facts, watches = [], config = on) => decideRouting({ facts, orgId: ORG, eventUserId: USER, subject: USER, employees, watches, directory, config });

test('mention: name or slug, case-insensitive, word boundary, not an address, longest name wins', () => {
  assert.deepEqual(mentionedEmployees('hey @maya-chen please look', employees), [MAYA]);
  assert.deepEqual(mentionedEmployees('hey @MAYA CHEN please', employees), [MAYA]);
  assert.deepEqual(mentionedEmployees('@Leo, can you check?', employees), [LEO]);
  assert.deepEqual(mentionedEmployees('ping @leopard', employees), [], 'a longer word is not a mention');
  assert.deepEqual(mentionedEmployees('mail leo@leo.com and see @leo.com', employees), [], 'an address or domain is not a mention');
  assert.deepEqual(mentionedEmployees('@Maya Chen and @leo', employees).sort(), [MAYA, LEO].sort());
  assert.deepEqual(mentionedEmployees('no mention here', employees), []);
});

test('mention wakes only the mentioned employee when the sender is a member or on the company domain', () => {
  const fromMember = decide(mail({ sender: 'The Boss <boss@acme.com>', subject: 'Q3 numbers @leo', message_text: 'please prep' }));
  assert.deepEqual(fromMember.targets.map(t => [t.employeeId, t.reason]), [[LEO, 'mention']]);
  const fromDomain = decide(mail({ sender: 'new.hire@acme.com', subject: 'hi', message_text: 'thanks @Maya Chen' }));
  assert.deepEqual(fromDomain.targets.map(t => t.employeeId), [MAYA]);
});

test('external senders never wake an employee, and a free-mail domain is not the company domain', () => {
  const outside = decide(mail({ sender: 'stranger@evil.example', subject: '@leo do this now' }));
  assert.deepEqual(outside.targets, []);
  assert.deepEqual(outside.skips, [{ employeeId: LEO, reason: 'external_sender' }]);
  const freeMail = decideRouting({ facts: mail({ sender: 'x@gmail.com', subject: '@leo' }), orgId: ORG, eventUserId: USER, subject: USER, employees, watches: [], directory: { memberEmails: new Set(), companyDomains: new Set(['gmail.com'].filter(() => false)) }, config: on });
  assert.equal(freeMail.targets.length, 0);
  assert.equal(internalSender(mail({ sender: 'x@gmail.com' }), { memberEmails: new Set(), companyDomains: new Set(['gmail.com']) }, on), false);
});

test('Slack: only a verified native sender is inside; GitHub trusts OWNER and MEMBER only of a listed organization', () => {
  assert.equal(decide(slackFacts({ text: '@leo look', user: 'U1', _hivemind: { sender: { verified: true } } })).targets.length, 1);
  assert.equal(decide(slackFacts({ text: '@leo look', user: 'U1', _hivemind: { sender: { verified: false } } })).targets.length, 0);
  const gh = (assoc, repo = 'acme/app') => eventFacts('github', 'GITHUB_ISSUE_COMMENT', { comment: { body: 'cc @leo', user: { login: 'dev' }, author_association: assoc }, repository: { full_name: repo } }, on);
  const listed = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_GITHUB_ORGS: 'Acme' });
  assert.equal(decide(gh('MEMBER'), [], listed).targets.length, 1);
  assert.equal(decide(gh('OWNER'), [], listed).targets.length, 1);
  assert.equal(decide(gh('NONE'), [], listed).targets.length, 0);
  assert.equal(decide(gh('COLLABORATOR'), [], listed).targets.length, 0);
  assert.equal(decide(gh('MEMBER', 'upstream/lib'), [], listed).targets.length, 0, 'a member of somebody else\'s organization is not inside');
  assert.equal(decide(gh('MEMBER')).targets.length, 0, 'by default no GitHub author is inside');
});

test('a Dot owned by another user does not receive this user\'s mailbox unless the account is organization-wide', () => {
  const facts = mail({ sender: 'boss@acme.com', subject: '@leo task' });
  const foreign = [{ ...employees[1], tenantUserId: 'someone-else' }];
  const run = (subject) => decideRouting({ facts, orgId: ORG, eventUserId: USER, subject, employees: foreign, watches: [], directory, config: on });
  assert.deepEqual(run(USER).skips, [{ employeeId: LEO, reason: 'other_owner' }]);
  assert.equal(run(ORG).targets.length, 1);
});

test('watch: every set filter key must match, and the watch needs the same trigger', () => {
  const facts = mail({ sender: 'Ana <ana@client.io>', subject: 'Invoice 42', message_text: 'please pay', label_ids: ['INBOX', 'IMPORTANT'] });
  const watch = (filter, extra = {}) => ({ id: 'w', user_id: USER, employee_id: LEO, enabled: true, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter, ...extra });
  assert.equal(watchMatches(watch({ from: 'client.io' }), facts), true);
  assert.equal(watchMatches(watch({ from: 'other.io' }), facts), false);
  assert.equal(watchMatches(watch({ label: 'important' }), facts), true);
  assert.equal(watchMatches(watch({ keyword: 'INVOICE' }), facts), true);
  assert.equal(watchMatches(watch({ keyword: 'invoice', label: 'spam' }), facts), false);
  assert.equal(watchMatches(watch({}, { enabled: false }), facts), false);
  assert.equal(watchMatches(watch({}, { trigger_slug: 'GMAIL_NEW_SENT_MESSAGE' }), facts), false);
  assert.equal(watchMatches(watch({ repo: 'acme/app' }), eventFacts('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', { repository: { full_name: 'Acme/App' } }, on)), true);
  const routed = decide(facts, [watch({ from: 'client.io' })]);
  assert.deepEqual(routed.targets.map(t => [t.employeeId, t.reason]), [[LEO, 'watch']], 'an external sender can still match an explicit watch');
  assert.deepEqual(decide(facts, [watch({}, { user_id: 'someone-else' })]).targets, [], "another user's watch does not read this user's account");
  assert.equal(decideRouting({ facts, orgId: ORG, eventUserId: USER, subject: ORG, employees, watches: [watch({}, { user_id: 'someone-else' })], directory, config: on }).targets.length, 1, 'an organization-wide account is visible to every watch');
  assert.deepEqual(decide(facts, [watch({}, { employee_id: '99999999-9999-4999-8999-999999999999' })]).skips, [{ employeeId: '99999999-9999-4999-8999-999999999999', reason: 'employee_unavailable' }]);
});

test('a mention plus a matching watch is one target with both reasons', () => {
  const facts = mail({ sender: 'boss@acme.com', subject: '@leo invoice', message_text: 'x' });
  const watch = { id: 'w1', user_id: USER, employee_id: LEO, enabled: true, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: {} };
  assert.deepEqual(decide(facts, [watch]).targets, [{ employeeId: LEO, reason: 'mention+watch', watchIds: ['w1'] }]);
});

test('loop guard: bots, content marked as produced by HIVEMIND, and an employee\'s own Slack identity never wake', () => {
  const bot = decide(slackFacts({ text: '@leo hi', bot_id: 'B1', _hivemind: { sender: { verified: true } } }));
  assert.deepEqual(bot.skips, [{ employeeId: LEO, reason: 'bot_sender' }]);
  const marked = decide(mail({ sender: 'boss@acme.com', subject: '[Event:gmail] @leo', message_text: 'x' }));
  assert.deepEqual(marked.skips, [{ employeeId: LEO, reason: 'loop_guard' }]);
  const runtimeOut = decide(slackFacts({ text: '@leo update', metadata: { event_type: 'hivemind_runtime_output' }, _hivemind: { sender: { verified: true } } }));
  assert.equal(runtimeOut.targets.length, 0);
  const own = decide(slackFacts({ text: '@leo see this', user: 'UBOTMAYA', _hivemind: { sender: { verified: true } } }));
  assert.deepEqual(own.skips, [{ employeeId: LEO, reason: 'own_output' }]);
});

test('email mention reads the subject and the first 2000 characters only', () => {
  const late = mail({ sender: 'boss@acme.com', subject: 'hello', message_text: `${'x '.repeat(1100)} @leo` });
  assert.equal(decide(late).targets.length, 0);
  const early = mail({ sender: 'boss@acme.com', subject: 'hello', message_text: `@leo ${'x '.repeat(1100)}` });
  assert.equal(decide(early).targets.length, 1);
});

// ---------- an in-memory store for the routing step and the wake flush ----------
function fakeDb({ watches = [], runtimeOn = true, bound = true } = {}) {
  const deliveries = [], store = { watches, events: new Map(), watchLog: [] };
  const policyRules = bound ? { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_abc' }, native_lifecycle: { version: 1, phase: 'active' } } : {};
  const emp = (id, name, slug) => ({ id, name, slug, createdBy: USER, teamId: null, scope: 'organization', status: 'running', policyRules, slackBotUserId: null });
  const db = {
    userOrganization: { findUnique: async () => ({ role: 'admin', isActive: true, deactivatedAt: null }), findMany: async () => [{ user: { email: 'boss@acme.com', deletedAt: null } }] },
    digitalEmployee: { findMany: async () => [emp(MAYA, 'Maya Chen', 'maya-chen'), emp(LEO, 'Leo', 'leo')] },
    teamMember: { findMany: async () => [] },
    organization: { findUnique: async () => ({ companyProfile: {} }) },
    organizationProfile: { findMany: async () => [{ value: 'https://www.acme.com/about' }] },
    $executeRawUnsafe: async (sql, ...a) => {
      if (/^\s*(CREATE|ALTER)/i.test(sql)) return 0;
      if (sql.includes('SET wake_id')) { for (const row of deliveries) if (a[0].includes(row.id)) row.wake_id = a[1]; return 1; }
      if (sql.includes('SET status=$2')) { for (const row of deliveries) if (a[0].includes(row.id)) { row.status = a[1]; row.skip_reason = a[2]; row.last_error = a[3]; if (a[1] === 'delivered') row.delivered_at = new Date(store.now ?? Date.now()); } return 1; }
      if (sql.includes("SET status='pending'")) { for (const row of deliveries) if (a[0].includes(row.id)) row.status = 'pending'; return 1; }
      if (sql.includes('UPDATE hivemind_employee_watches')) { store.watchLog.push(sql.includes('last_fired_at') ? ['fired', a[0]] : ['error', a[0], a[1]]); return 1; }
      throw new Error(`unexpected execute: ${sql}`);
    },
    $queryRawUnsafe: async (sql, ...a) => {
      if (sql.includes('FROM hivemind_readonly_runtime') ) return [];
      if (sql.includes('runtime_enabled')) return [{ runtime_enabled: runtimeOn }];
      if (sql.includes('FROM hivemind_employee_watches WHERE org_id=$1 AND toolkit')) return store.watches;
      if (sql.includes('FROM hivemind_employee_watches WHERE id')) return store.watches.map(w => ({ id: w.id, instruction: w.instruction ?? 'summarise' }));
      if (sql.includes('INSERT INTO hivemind_employee_event_deliveries')) {
        const [id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, watch_id, status, skip_reason, summary] = a;
        if (deliveries.some(r => r.event_id === event_id && r.employee_id === employee_id)) return [];
        deliveries.push({ id, org_id, user_id, employee_id, event_id, toolkit, trigger_slug, reason, watch_id, status, skip_reason, summary, attempts: 0, created_at: new Date(store.now ?? Date.now()) });
        return [{ id }];
      }
      if (sql.includes('GROUP BY org_id,employee_id')) {
        const cutoff = new Date(a[0]).getTime(), groups = new Map();
        for (const r of deliveries) if (r.employee_id !== EVENT_LEVEL && r.status === 'pending') groups.set(r.employee_id, Math.min(groups.get(r.employee_id) ?? Infinity, r.created_at.getTime()));
        return [...groups].filter(([, min]) => min <= cutoff).map(([employee_id]) => ({ org_id: ORG, employee_id }));
      }
      if (sql.startsWith('UPDATE hivemind_employee_event_deliveries SET status=\'sending\'')) {
        const rows = deliveries.filter(r => r.employee_id === a[1] && r.status === 'pending' && r.created_at <= new Date(a[2]));
        for (const r of rows) { r.status = 'sending'; r.attempts += 1; }
        return rows.map(r => ({ ...r }));
      }
      if (sql.includes('count(DISTINCT wake_id)')) {
        const since = new Date(a[2]);
        return [{ wakes: new Set(deliveries.filter(r => r.employee_id === a[1] && r.status === 'delivered' && r.delivered_at > since).map(r => r.wake_id)).size }];
      }
      if (sql.includes('FROM hivemind_trigger_events WHERE id')) return a[0].map(id => ({ id, data: store.events.get(id) ?? {}, occurred_at: null }));
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { db, deliveries, store };
}
const sub = { toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: USER };
const mention = (n, db, store, at) => { const id = `ev${n}`; store.events.set(id, { sender: 'boss@acme.com', subject: `@leo task ${n}`, message_text: 'body' }); store.now = at; return routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id, data: store.events.get(id) }, sub }, { config: on, schedule: () => {} }); };

test('routing records one pending delivery per (event, employee); a replay adds nothing', async () => {
  const { db, deliveries, store } = fakeDb();
  await mention(1, db, store, 1000);
  await mention(1, db, store, 2000);
  assert.equal(deliveries.length, 1);
  assert.deepEqual([deliveries[0].employee_id, deliveries[0].reason, deliveries[0].status], [LEO, 'mention', 'pending']);
});

test('disabled routing records nothing; the switch is off by default', async () => {
  const { db, deliveries, store } = fakeDb();
  store.events.set('e', { subject: '@leo' });
  const result = await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'e', data: {} }, sub }, { config: routingConfig({}), schedule: () => {} });
  assert.equal(result.skipped, 'routing_disabled');
  assert.equal(deliveries.length, 0);
});

test('Runtime off with no mention or watch: the event is audited as dropped; Runtime on keeps today\'s path and records nothing', async () => {
  const off = fakeDb({ runtimeOn: false });
  await routeApprovedEvent(off.db, { orgId: ORG, userId: USER, event: { id: 'plain', data: { subject: 'Newsletter' } }, sub }, { config: on, schedule: () => {} });
  assert.deepEqual(off.deliveries.map(r => [r.employee_id, r.status, r.skip_reason]), [[EVENT_LEVEL, 'skipped', 'no_target_runtime_off']]);
  const live = fakeDb({ runtimeOn: true });
  await routeApprovedEvent(live.db, { orgId: ORG, userId: USER, event: { id: 'plain', data: { subject: 'Newsletter' } }, sub }, { config: on, schedule: () => {} });
  assert.equal(live.deliveries.length, 0);
});

test('an external mention is audited as a skip with its reason and never queued', async () => {
  const { db, deliveries } = fakeDb();
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'x', data: { sender: 'x@evil.example', subject: '@leo now' } }, sub }, { config: on, schedule: () => {} });
  assert.deepEqual(deliveries.map(r => [r.employee_id, r.status, r.skip_reason]), [[LEO, 'skipped', 'external_sender']]);
});

test('burst coalescing: events inside the window leave as one wake with all of them, once', async () => {
  const { db, deliveries, store } = fakeDb();
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  await mention(1, db, store, t0); await mention(2, db, store, t0 + 30_000); await mention(3, db, store, t0 + 90_000);
  const sent = [];
  const deliver = async payload => { sent.push(payload); return { accepted: true }; };
  assert.deepEqual(await flushEmployeeWakes(db, { config: on, now: t0 + 60_000, deliver }), { wakes: 0, briefed: 0, skipped: 0, failed: 0 }, 'not due before the window closes');
  const totals = await flushEmployeeWakes(db, { config: on, now: t0 + 125_000, deliver });
  assert.equal(totals.wakes, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].events.map(e => e.eventId), ['ev1', 'ev2', 'ev3']);
  assert.equal(sent[0].dotId, 'dot_abc');
  assert.equal(sent[0].wakeId, wakeIdFor(LEO, ['ev1', 'ev2', 'ev3']));
  assert.ok(deliveries.every(r => r.status === 'delivered'));
  await flushEmployeeWakes(db, { config: on, now: t0 + 400_000, deliver });
  assert.equal(sent.length, 1, 'a delivered event is never sent twice');
});

test('rate limit: past the hourly cap the events go to the next brief instead of waking', async () => {
  const config = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_MAX_WAKES_PER_HOUR: '2' });
  const { db, deliveries, store } = fakeDb();
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  const sent = [];
  const deliver = async p => { sent.push(p); };
  for (let i = 0; i < 3; i++) {
    await mention(10 + i, db, store, t0 + i * 200_000);
    await flushEmployeeWakes(db, { config, now: t0 + i * 200_000 + 130_000, deliver });
  }
  assert.equal(sent.length, 2);
  assert.deepEqual(deliveries.map(r => [r.status, r.skip_reason ?? null]), [['delivered', null], ['delivered', null], ['briefed', 'rate_limited']]);
  await mention(20, db, store, t0 + 4_000_000);
  await flushEmployeeWakes(db, { config, now: t0 + 4_200_000, deliver });
  assert.equal(sent.length, 3, 'the window slides: an hour later the employee can be woken again');
});

test('a wake is capped at maxEventsPerWake; the rest are briefed', async () => {
  const config = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_MAX_EVENTS_PER_WAKE: '2' });
  const { db, deliveries, store } = fakeDb();
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  for (let i = 0; i < 4; i++) await mention(30 + i, db, store, t0 + i * 1000);
  const sent = [];
  await flushEmployeeWakes(db, { config, now: t0 + 200_000, deliver: async p => { sent.push(p); } });
  assert.equal(sent[0].events.length, 2);
  assert.equal(sent[0].omitted, 2);
  assert.equal(deliveries.filter(r => r.status === 'briefed').length, 2);
});

test('delivery failure: a server error retries, a client error is final, both are recorded on the watch', async () => {
  const watch = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: USER, employee_id: LEO, enabled: true, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: {}, instruction: 'triage' };
  const { db, deliveries, store } = fakeDb({ watches: [watch] });
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  store.events.set('w1', { sender: 'a@b.io', subject: 'hello' }); store.now = t0;
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'w1', data: store.events.get('w1') }, sub }, { config: on, schedule: () => {} });
  const unavailable = Object.assign(new Error('open_dot_runtime_unavailable'), { status: 503 });
  await flushEmployeeWakes(db, { config: on, now: t0 + 130_000, deliver: async () => { throw unavailable; } });
  assert.equal(deliveries[0].status, 'pending');
  assert.deepEqual(store.watchLog.at(-1), ['error', [watch.id], 'open_dot_runtime_unavailable']);
  const sent = [];
  await flushEmployeeWakes(db, { config: on, now: t0 + 200_000, deliver: async p => { sent.push(p); } });
  assert.equal(deliveries[0].status, 'delivered');
  assert.equal(sent[0].events[0].instruction, 'triage');
  assert.equal(sent[0].events[0].reason, 'watch');
  assert.deepEqual(store.watchLog.at(-1), ['fired', [watch.id]]);
  store.events.set('w2', { sender: 'a@b.io', subject: 'again' }); store.now = t0 + 300_000;
  await routeApprovedEvent(db, { orgId: ORG, userId: USER, event: { id: 'w2', data: store.events.get('w2') }, sub }, { config: on, schedule: () => {} });
  await flushEmployeeWakes(db, { config: on, now: t0 + 450_000, deliver: async () => { throw Object.assign(new Error('open_dot_employee_not_bound'), { status: 409 }); } });
  assert.deepEqual([deliveries[1].status, deliveries[1].skip_reason], ['skipped', 'open_dot_employee_not_bound']);
});

test('an employee that is no longer bound is skipped, not woken', async () => {
  const { db, deliveries, store } = fakeDb();
  const t0 = Date.parse('2026-10-29T10:00:00Z');
  await mention(40, db, store, t0);
  const unbound = fakeDb({ bound: false });
  unbound.deliveries.push(...deliveries.map(r => ({ ...r })));
  const sent = [];
  await flushEmployeeWakes(unbound.db, { config: on, now: t0 + 200_000, deliver: async p => { sent.push(p); } });
  assert.equal(sent.length, 0);
  assert.equal(unbound.deliveries[0].skip_reason, 'employee_unavailable');
});

// ---------- the watch tool ----------
function toolDb(extra = {}) {
  const rows = [];
  const base = fakeDb();
  const db = { ...base.db, $queryRawUnsafe: async (sql, ...a) => {
    if (sql.includes('FROM hivemind_trigger_subscriptions')) return extra.active ?? [{ toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE' }];
    if (sql.includes('count(*)::int')) return [{ n: rows.filter(r => r.dedupe_key !== a[2]).length }];
    if (sql.includes('INSERT INTO hivemind_employee_watches')) {
      const [id, org_id, user_id, employee_id, toolkit, trigger_slug, filter, instruction, dedupe_key] = a;
      const found = rows.find(r => r.dedupe_key === dedupe_key);
      if (found) { found.instruction = instruction; found.enabled = true; return [found]; }
      const row = { id, org_id, user_id, employee_id, toolkit, trigger_slug, filter: JSON.parse(filter), instruction, dedupe_key, enabled: true, last_fired_at: null, last_error: null };
      rows.push(row); return [row];
    }
    if (sql.startsWith('SELECT * FROM hivemind_employee_watches')) return rows;
    if (sql.startsWith('UPDATE hivemind_employee_watches')) { const row = rows.find(r => r.id === a[0]); if (!row) return []; row.enabled = a[3]; return [row]; }
    if (sql.startsWith('DELETE FROM hivemind_employee_watches')) { const i = rows.findIndex(r => r.id === a[0]); if (i < 0) return []; rows.splice(i, 1); return [{ id: a[0] }]; }
    if (sql.includes('FROM hivemind_employee_event_deliveries')) return [{ event_id: 'e', toolkit: 'gmail', trigger_slug: 'S', reason: 'watch', status: 'delivered', created_at: 'now' }];
    return base.db.$queryRawUnsafe(sql, ...a);
  } };
  return { db, rows };
}

test('event_watch tool: add, list, pause, resume, remove and recent for one employee', async () => {
  const { db, rows } = toolDb();
  const ctx = { orgId: ORG, userId: USER, prisma: db, config: on };
  const added = await runEventWatch({ operation: 'add', employee_id: LEO, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: { from: 'Client.io' }, instruction: 'Summarise and list actions.' }, ctx);
  assert.equal(added.watch.enabled, true);
  assert.equal(rows.length, 1);
  const again = await runEventWatch({ operation: 'add', employee_id: LEO, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: { from: 'client.io' }, instruction: 'New wording.' }, ctx);
  assert.equal(again.watch.id, added.watch.id, 'the same watch is updated, not duplicated');
  assert.equal((await runEventWatch({ operation: 'list', employee_id: LEO }, ctx)).watches.length, 1);
  assert.equal((await runEventWatch({ operation: 'pause', employee_id: LEO, watch_id: added.watch.id }, ctx)).watch.enabled, false);
  assert.equal((await runEventWatch({ operation: 'resume', employee_id: LEO, watch_id: added.watch.id }, ctx)).watch.enabled, true);
  assert.equal((await runEventWatch({ operation: 'recent', employee_id: LEO }, ctx)).events[0].status, 'delivered');
  assert.deepEqual(await runEventWatch({ operation: 'remove', employee_id: LEO, watch_id: added.watch.id }, ctx), { successful: true, removed: added.watch.id });
  await assert.rejects(runEventWatch({ operation: 'remove', employee_id: LEO, watch_id: added.watch.id }, ctx), { status: 404 });
});

test('event_watch tool refuses what is not real: no active event, bad filter, no instruction, unknown employee, cap', async () => {
  const { db } = toolDb({ active: [{ toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE' }] });
  const ctx = { orgId: ORG, userId: USER, prisma: db, config: on };
  const ok = { operation: 'add', employee_id: LEO, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', instruction: 'x' };
  await assert.rejects(runEventWatch({ ...ok, toolkit: 'slack', trigger_slug: 'SLACK_NEW_MESSAGE' }, ctx), { status: 409, message: /Active events: GMAIL_NEW_GMAIL_MESSAGE/ });
  await assert.rejects(runEventWatch({ ...ok, filter: { colour: 'red' } }, ctx), { status: 400 });
  await assert.rejects(runEventWatch({ ...ok, instruction: '  ' }, ctx), { status: 400 });
  await assert.rejects(runEventWatch({ ...ok, employee_id: '55555555-5555-4555-8555-555555555555' }, ctx), { status: 403 });
  await assert.rejects(runEventWatch({ ...ok }, { ...ctx, userId: 'not-a-uuid' }), { status: 401 });
  const capped = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_MAX_WATCHES: '1' });
  await runEventWatch({ ...ok, filter: { from: 'a' } }, { ...ctx, config: capped });
  await assert.rejects(runEventWatch({ ...ok, filter: { from: 'b' } }, { ...ctx, config: capped }), { status: 409, message: /At most 1 watches/ });
  assert.equal(watchKey('gmail', 'S', { from: 'A' }), watchKey('gmail', 'S', { from: 'a' }));
});

test('the company domain comes from the profile website, the only key the profile editor writes', async () => {
  const { loadCompanyDirectory } = await import('../../src/connectors/employee-event-routing.js');
  const { db } = fakeDb();
  const directory = await loadCompanyDirectory(db, ORG);
  assert.deepEqual([...directory.companyDomains], ['acme.com']);
  const webmail = { ...db, organizationProfile: { findMany: async () => [{ value: 'gmail.com' }] } };
  assert.deepEqual([...(await loadCompanyDirectory(webmail, ORG)).companyDomains], [], 'a webmail host is never the company domain');
});

test('mention-only routing: an in-company mention is queued without reading watches; an external one is only audited', async () => {
  const { db, deliveries, store } = fakeDb({ watches: [{ id: 'w', user_id: USER, employee_id: LEO, enabled: true, toolkit: 'gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', filter: {} }] });
  const watched = [];
  const spy = { ...db, $queryRawUnsafe: async (sql, ...a) => { if (sql.includes('FROM hivemind_employee_watches')) watched.push(sql); return db.$queryRawUnsafe(sql, ...a); } };
  const route = (id, data) => routeApprovedEvent(spy, { orgId: ORG, userId: USER, event: { id, data }, sub }, { config: on, schedule: () => {}, mentionsOnly: true });
  await route('m1', { sender: 'boss@acme.com', subject: '@leo please look', message_text: 'x' });
  await route('m2', { sender: 'stranger@evil.example', subject: '@leo now', message_text: 'x' });
  await route('m3', { sender: 'boss@acme.com', subject: 'no mention', message_text: 'x' });
  assert.deepEqual(watched, [], 'watches wait for approval');
  assert.deepEqual(deliveries.map(r => [r.event_id, r.status, r.skip_reason ?? null]), [['m1', 'pending', null], ['m2', 'skipped', 'external_sender']]);
  void store;
});

// ---------- the call from the classifier ----------
import { classifyPendingActivity } from '../../src/connectors/composio/activity-relevance.js';
function classifyRun(action, { routerCalls }) {
  const row = { id: `ev-${routerCalls.length}`, subscription_id: 'sub', org_id: ORG, user_id: USER, received_at: '2026-10-04T12:00:00Z', data: { sender: 'boss@acme.com', subject: '@leo hello' } };
  const db = {
    userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin' }) },
    $queryRawUnsafe: async sql => sql.includes('UPDATE hivemind_trigger_events') ? [row] : sql.includes('runtime_enabled') ? [{ runtime_enabled: true }] : [{ toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: USER, runtime_attention: true, runtime_attention_enabled_at: '2026-10-04T11:00:00Z' }],
    $executeRawUnsafe: async () => {}, workspaceNotification: { upsert: async () => ({ id: 'n' }) },
  };
  return classifyPendingActivity({ orgId: ORG, userId: USER, allowedAccountIds: ['a'], prisma: db,
    employeeRouter: async (_db, input, deps) => { routerCalls.push({ id: input.event.id, mentionsOnly: deps?.mentionsOnly === true }); },
    runtimeAttention: { assess: async () => ({ action, policy: 'runtime_attention_v3', targetSessionId: 'r' }), deliver: async () => ({ status: 'accepted', targetSessionId: 'r', inboxPersisted: true }) } });
}

test('the classifier routes mentions for a rejected event, and routes watches only after approval', async () => {
  const rejected = [];
  await classifyRun('retain', { routerCalls: rejected });
  assert.deepEqual(rejected, [{ id: 'ev-0', mentionsOnly: true }], 'rejected: mention routing only');
  const approved = [];
  await classifyRun('notify', { routerCalls: approved });
  assert.deepEqual(approved.map(c => c.mentionsOnly), [true, false], 'approved: mention routing, then the full routing step');
});

// ---------- brief ----------
function briefDb() {
  const reads = new Set();
  const rows = [
    { org_id: ORG, user_id: USER, employee_id: LEO, event_id: 'h1', toolkit: 'gmail', trigger_slug: 'S', status: 'briefed', skip_reason: 'rate_limited', summary: 'held back', created_at: '2026-10-29T09:00:00Z' },
    { org_id: ORG, user_id: USER, employee_id: EVENT_LEVEL, event_id: 'u1', toolkit: 'gmail', trigger_slug: 'S', status: 'skipped', skip_reason: 'no_target_runtime_off', summary: 'newsletter', created_at: '2026-10-29T10:00:00Z' },
    { org_id: ORG, user_id: USER, employee_id: EVENT_LEVEL, event_id: 'u2', toolkit: 'slack', trigger_slug: 'S', status: 'skipped', skip_reason: 'no_target_runtime_off', summary: 'other app', created_at: '2026-10-29T10:30:00Z' },
  ];
  const base = fakeDb();
  const db = { ...base.db,
    $executeRawUnsafe: async (sql, ...a) => { if (sql.includes('INSERT INTO hivemind_employee_brief_reads')) { for (const id of a[2]) if (rows.some(r => r.event_id === id && [LEO, EVENT_LEVEL].includes(r.employee_id))) reads.add(`${a[1]}:${id}`); return 1; } return base.db.$executeRawUnsafe(sql, ...a); },
    $queryRawUnsafe: async (sql, ...a) => {
      if (sql.includes('SELECT DISTINCT toolkit FROM hivemind_employee_watches')) return [{ toolkit: 'gmail' }];
      if (sql.includes("d.status='briefed'")) return rows.filter(r => r.employee_id === a[1] && r.status === 'briefed' && !reads.has(`${a[1]}:${r.event_id}`));
      if (sql.includes("d.employee_id='*'")) return rows.filter(r => r.employee_id === EVENT_LEVEL && a[1].includes(r.toolkit) && r.user_id === a[3] && !reads.has(`${a[4]}:${r.event_id}`));
      return base.db.$queryRawUnsafe(sql, ...a);
    } };
  return { db, reads };
}

test('brief: held-back wakes and unmatched events of watched apps, newest first; consumed ones do not repeat', async () => {
  const { db } = briefDb();
  const ctx = { orgId: ORG, userId: USER, prisma: db, config: on };
  const first = await runEventWatch({ operation: 'brief', employee_id: LEO }, ctx);
  assert.deepEqual(first.items.map(i => [i.event_id, i.kind]), [['u1', 'unmatched'], ['h1', 'held_back']], 'the other app is not this employee\'s');
  assert.deepEqual(await runEventWatch({ operation: 'consume', employee_id: LEO, event_ids: ['h1', 'u1'] }, ctx), { successful: true, consumed: 2 });
  assert.deepEqual((await runEventWatch({ operation: 'brief', employee_id: LEO }, ctx)).items, []);
  await assert.rejects(runEventWatch({ operation: 'consume', employee_id: LEO, event_ids: [] }, ctx), { status: 400 });
});
