// With Runtime off, a clear but less confident "useful company work" verdict wakes an employee only when one clearly owns the event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPendingActivity, decideActivityRelevance } from '../../src/connectors/composio/activity-relevance.js';
import { routingConfig } from '../../src/connectors/employee-event-routing.js';

const ORG = '8de2085e-45d4-452b-878e-37ffc751c193', USER = '2323d7bc-3ae1-4f9e-9d37-5c8c77a8416c';
const on = routingConfig({ HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1' });

test('the near-miss probability is configurable and bounded', () => {
  assert.equal(on.nearMissProbability, 0.5);
  assert.equal(routingConfig({ HIVEMIND_EMPLOYEE_EVENT_NEAR_MISS_PROBABILITY: '0.6' }).nearMissProbability, 0.6);
  for (const bad of ['0.1', '0.9', 'x', '']) assert.equal(routingConfig({ HIVEMIND_EMPLOYEE_EVENT_NEAR_MISS_PROBABILITY: bad }).nearMissProbability, 0.5, bad);
});

/** Runs the real relevance decision with a provider that answers one verdict. */
const decide = result => decideActivityRelevance({ event: { toolkit: 'gmail', data: { subject: 'Pricing', message_text: 'Can we talk' } }, context: {}, env: {}, provider: { decideChoice: async () => result } });

function classify({ decision, runtimeOn, target, routerCalls, writes }) {
  const row = { id: 'ev', subscription_id: 'sub', org_id: ORG, user_id: USER, received_at: '2026-10-30T12:00:00Z', data: { sender: 'a@b.co', subject: 'Pricing', message_text: 'Can we talk' } };
  const db = {
    userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin' }) },
    organization: { findUnique: async () => ({ name: 'Acme', companyProfile: {} }) },
    $queryRawUnsafe: async sql => sql.includes('UPDATE hivemind_trigger_events') ? [row] : sql.includes('runtime_enabled') ? [{ runtime_enabled: runtimeOn }]
      : sql.includes('FROM memories') ? [] : [{ toolkit: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', subject: USER, runtime_attention: true, runtime_attention_enabled_at: '2026-10-01T00:00:00Z' }],
    $executeRawUnsafe: async (sql, ...args) => { writes.push({ sql, args }); },
  };
  return classifyPendingActivity({ orgId: ORG, userId: USER, allowedAccountIds: ['a'], prisma: db, routingConfig: on,
    relevanceDecider: async () => decision, employeeTargeter: async () => target,
    employeeRouter: async (_db, input, deps) => { routerCalls.push({ mentionsOnly: deps?.mentionsOnly === true, attentionTarget: deps?.attentionTarget?.employeeId ?? null }); } });
}
const stored = writes => JSON.parse(writes.find(w => w.sql.includes("SET relevance_status=$1,relevance_decision=$2")).args[1]);
const near = { status: 'rejected', choice: 'useful_company_work', probability: 0.53, margin: 0.25, source: 'jev', policy: 'company_activity_relevance_v3', nearMiss: true };
const owner = { employeeId: 'emp-1', probability: 0.8, margin: 0.4, because: 'it fits your role' };

test('Runtime off: a near miss owned by an employee is approved and wakes that employee', async () => {
  const writes = [], routerCalls = [];
  await classify({ decision: near, runtimeOn: false, target: owner, routerCalls, writes });
  const receipt = stored(writes);
  assert.equal(receipt.status, 'approved'); assert.equal(receipt.promotedByOwner, true); assert.equal(receipt.employeeAttention.targetEmployeeId, 'emp-1');
  assert.deepEqual(routerCalls, [{ mentionsOnly: false, attentionTarget: 'emp-1' }]);
});

test('Runtime off: a near miss nobody clearly owns stays rejected, and Runtime on never promotes', async () => {
  const none = [], noneRoute = [];
  await classify({ decision: near, runtimeOn: false, target: null, routerCalls: noneRoute, writes: none });
  assert.equal(stored(none).status, 'rejected');
  assert.deepEqual(noneRoute, [{ mentionsOnly: true, attentionTarget: null }]);
  const on1 = [], onRoute = [];
  let asked = 0;
  await classify({ decision: near, runtimeOn: true, target: (asked++, owner), routerCalls: onRoute, writes: on1 });
  assert.notEqual(stored(on1).status, 'approved');
});

test('the relevance decision marks only a useful verdict between the near-miss floor and the approval floor', async () => {
  const mid = await decide({ choice: 'useful_company_work', probability: 0.53, margin: 0.25 });
  assert.equal(mid.source, 'jev');
  assert.equal(mid.status, 'rejected'); assert.equal(mid.nearMiss, true);
  const low = await decide({ choice: 'useful_company_work', probability: 0.4, margin: 0.3 });
  assert.equal(low.nearMiss, undefined);
  const noise = await decide({ choice: 'promotion_noise', probability: 0.9, margin: 0.8 });
  assert.equal(noise.nearMiss, undefined);
  const high = await decide({ choice: 'useful_company_work', probability: 0.8, margin: 0.3 });
  assert.equal(high.status, 'approved'); assert.equal(high.nearMiss, undefined);
});
