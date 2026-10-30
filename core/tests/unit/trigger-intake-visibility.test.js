import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
process.env.COMPOSIO_API_KEY = 'fixture'; process.env.COMPOSIO_WEBHOOK_SECRET = 'fixture-secret';
const { receiveTriggerEvent, triggerIntakeStats, checkTriggerIntake } = await import('../../src/connectors/composio/hivemind-triggers.js');

const signed = (body, secret = 'fixture-secret') => {
  const id = 'msg_1', timestamp = String(Math.floor(Date.now() / 1000)), raw = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(`${id}.${timestamp}.${raw.toString('utf8')}`).digest('base64');
  return { raw, headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } };
};

test('every webhook decision is counted by outcome, so a silent drop is visible', async () => {
  const lines = []; const info = console.info; console.info = (tag, value) => { if (tag === '[composio-webhook]') lines.push(JSON.parse(value)); };
  try {
    const db = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [] };
    const unknown = signed({ type: 'composio.trigger.message', metadata: { trigger_id: 'ti_x', connected_account_id: 'ca_x', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' }, data: {} });
    assert.deepEqual(await receiveTriggerEvent(unknown.raw, unknown.headers, db), { ignored: true });
    const other = signed({ type: 'composio.connection.expired' });
    assert.deepEqual(await receiveTriggerEvent(other.raw, other.headers, db), { ignored: true });
    const forged = signed({ type: 'composio.trigger.message' }, 'wrong-secret');
    await assert.rejects(receiveTriggerEvent(forged.raw, forged.headers, db), error => error.status === 401);
    const stats = triggerIntakeStats();
    assert.equal(stats.counts.unknown_trigger, 1); assert.equal(stats.counts.ignored_type, 1); assert.equal(stats.counts.bad_signature, 1);
    assert.deepEqual(lines.map(line => line.outcome), ['unknown_trigger', 'ignored_type', 'bad_signature']);
    assert.equal(lines[0].slug, 'GMAIL_NEW_GMAIL_MESSAGE');
    assert.doesNotMatch(JSON.stringify(lines), /ti_x|ca_x/, 'no ids or content in the log');
  } finally { console.info = info; }
});

test('the intake alarm fires once an hour when subscriptions exist and nothing was stored for three hours', async () => {
  const warnings = []; const warn = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const now = Date.parse('2026-10-30T07:00:00Z');
    let last = new Date(now - 17 * 3_600_000).toISOString();
    const db = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [{ last, subs: 50 }] };
    assert.deepEqual(await checkTriggerIntake(db, { now }), { quietHours: 17 });
    assert.match(warnings[0], /no connected-app event stored/);
    assert.equal(await checkTriggerIntake(db, { now: now + 60_000 }), null, 'at most hourly');
    last = new Date(now + 2 * 3_600_000 - 60_000).toISOString();
    assert.equal(await checkTriggerIntake(db, { now: now + 2 * 3_600_000 }), null, 'recent events raise nothing');
  } finally { console.warn = warn; }
});
