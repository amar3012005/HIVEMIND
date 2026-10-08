import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPendingActivity } from '../../src/connectors/composio/activity-relevance.js';
let sequence = 0;
async function run({ optIn = true, attention = 'wake', prior, failDelivery = false, eventData } = {}) {
  const orgId = `org-${++sequence}`, userId = 'user', calls = [], writes = [], row = { id: 'event', subscription_id: 'sub', org_id: orgId, user_id: userId,
    received_at: '2026-10-04T12:00:00Z', data: eventData || { text: 'Customer deadline changed.' }, relevance_decision: prior };
  const ctx = { orgId, userId, allowedAccountIds: ['account'], prisma: {
    userOrganization: { findUnique: async () => ({ isActive: true }) }, organization: { findUnique: async () => ({ name: 'Company', companyProfile: {} }) },
    $queryRawUnsafe: async sql => sql.includes('SELECT title,tags') ? [] : sql.includes('UPDATE hivemind_trigger_events') ? [row]
      : [{ toolkit: 'slack', runtime_attention: optIn, runtime_attention_enabled_at: '2026-10-04T11:00:00Z' }],
    $executeRawUnsafe: async (sql, ...args) => { writes.push({ sql, args }); },
  }, runtimeAttention: {
    readConsent: async () => ({ enabled: true, orgId, userId, subscriptionId: 'sub' }),
    readSnapshot: async () => ({ orgId, userId, sessionId: 'native-root', revision: 'native-revision', enabled: true, decisionMemory:{ready:true,revision:'private-v1',userAgenda:[],uncertainties:[]}, tasks: [{ id: 'task', status: 'running' }] }),
    deliver: async () => { calls.push('deliver'); if (failDelivery) throw Error('unknown'); return { status: 'accepted', reused: Boolean(prior) }; },
  } };
  const original = globalThis.fetch, oldKey = process.env.JEV_OPENROUTER_API_KEY;
  process.env.JEV_OPENROUTER_API_KEY = 'fixture-only';
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    const index = payload.state.policy === 'runtime_attention_v2' ? { retain: 0, notify: 1, wake: 2 }[attention] : 0;
    return new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: `option_${index}`,
      probabilities: { [`option_${index}`]: 0.95, [`option_${index === 0 ? 1 : 0}`]: 0.05 } } } }));
  };
  try { await classifyPendingActivity(ctx); }
  finally { globalThis.fetch = original; if (oldKey === undefined) delete process.env.JEV_OPENROUTER_API_KEY; else process.env.JEV_OPENROUTER_API_KEY = oldKey; }
  return { calls, writes };
}
test('existing suggestions-only subscription never reads or wakes Runtime', async () => {
  const result = await run({ optIn: false });
  assert.equal(result.calls.length, 1);
  assert.ok(!result.calls.includes('deliver'));
  assert.ok(!result.writes[0].args[1].includes('runtimeAttention'));
});
test('opt-in uses native active context and saves exact decision before native delivery', async () => {
  const result = await run();
  assert.deepEqual(result.calls[0].state.runtime.tasks, [{id:'task',status:'running'}]);
  assert.equal(result.calls[0].state.runtime.autonomyEnabled, true);
  const receipt = JSON.parse(result.writes[0].args[1]);
  assert.equal(receipt.runtimeAttention.action, 'wake');
  assert.equal(receipt.runtimeAttention.contextRevision, 'native-revision');
  assert.equal(result.calls[1], 'deliver');
  assert.equal(result.calls.filter(call=>typeof call==='object').length,1);
  assert.ok(result.writes[1].sql.includes('runtimeDelivery'));
});
test('notify and quiet retain produce no native wake', async () => {
  for (const attention of ['notify', 'retain']) {
    const result = await run({ attention });
    assert.ok(!result.calls.includes('deliver'));
    assert.equal(JSON.parse(result.writes[0].args[1]).runtimeAttention.action, attention);
  }
});
test('unknown delivery is pending and reconciliation precedes new classification', async () => {
  const failed = await run({ failDelivery: true });
  assert.ok(failed.writes.at(-1).sql.includes("relevance_status='pending'"));
  const recovered = await run({ prior: { runtimeAttention: { action: 'wake' } } });
  assert.deepEqual(recovered.calls, ['deliver']);
  assert.ok(recovered.writes[0].sql.includes('runtimeDelivery'));
});

test('real Gmail preview object preserves message text through one shared attention projection', async () => {
  const body = 'Synthetic owner-approved test. No actual customer claim.';
  const result = await run({ eventData: { subject: 'Test only', preview: { body: 'Short preview', subject: 'Test only', credentials: 'secret' }, message_text: body } });
  assert.equal(result.calls[0].state.event.preview, body);
  assert.equal(result.calls.filter(call=>typeof call==='object').length,1);
  assert.ok(!JSON.stringify(result.calls).includes('[object Object]'));
  assert.ok(!JSON.stringify(result.calls).includes('secret'));
});
