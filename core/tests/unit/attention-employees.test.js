// Runtime's attention layer as the judge of a Runtime-off company's connected-app events for its AI employees, in shadow and active mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { attentionEmployeeModes, attentionEmployeeMode, eventTooOld, routingConfig } from '../../src/connectors/employee-event-routing.js';
import { classifyPendingActivity, judgeForEmployees } from '../../src/connectors/composio/activity-relevance.js';
import { createRuntimeAttentionBridge } from '../../src/connectors/composio/runtime-attention-bridge.js';
import { attentionSignal } from '../../src/connectors/attention-signal.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const base = { HIVEMIND_EMPLOYEE_EVENT_ROUTING: '1', HIVEMIND_EMPLOYEE_EVENT_FORWARD_ORGS: ORG };

test('modes: shadow and active list organization UUIDs; a malformed entry or an organization in both lists fails loud', () => {
  const modes = attentionEmployeeModes({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_SHADOW: ` ${ORG.toUpperCase()} `, HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: OTHER });
  assert.deepEqual([[...modes.shadowOrgs], [...modes.activeOrgs]], [[ORG], [OTHER]]);
  assert.throws(() => attentionEmployeeModes({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_SHADOW: `${ORG},nope` }), /must list organization UUIDs/);
  assert.throws(() => attentionEmployeeModes({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_SHADOW: ORG, HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }), /in both/);
  assert.throws(() => routingConfig({ HIVEMIND_ATTENTION_MAX_EVENT_AGE_MS: '5' }), /HIVEMIND_ATTENTION_MAX_EVENT_AGE_MS/);
  assert.throws(() => routingConfig({ HIVEMIND_EMPLOYEE_EVENT_FORWARD_COALESCE_MS: 'soon' }), /FORWARD_COALESCE_MS/);
  const config = routingConfig({});
  assert.deepEqual([config.maxEventAgeMs, config.forwardCoalesceMs, config.attentionShadowOrgs.size, config.attentionActiveOrgs.size], [600_000, 0, 0, 0]);
  assert.equal(attentionEmployeeMode(routingConfig({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }), ORG.toUpperCase()), 'active');
  assert.equal(attentionEmployeeMode(config, ORG), 'off');
});

test('live only: age counts from the earlier of occurrence and receipt', () => {
  const config = { maxEventAgeMs: 600_000 }, now = Date.parse('2026-10-31T08:12:00Z');
  // 08:12: Composio delivered GitHub PR events that happened at 07:19.
  assert.equal(eventTooOld({ occurred_at: '2026-10-31T07:19:00Z', received_at: '2026-10-31T08:12:00Z' }, config, now), true);
  assert.equal(eventTooOld({ occurred_at: null, received_at: '2026-10-31T08:05:00Z' }, config, now), false);
  assert.equal(eventTooOld({}, config, now), false);
});

/** One classification of one fresh event for a Runtime-off company. */
async function classify(envExtra, { verdict, bridgeError, thin = { status: 'rejected', choice: 'promotion_noise', probability: 0.9, margin: 0.6, source: 'jev', policy: 'company_activity_relevance_v3' }, row: rowExtra = {} } = {}) {
  const writes = [], calls = [], routed = [];
  const row = { id: 'ev', subscription_id: 'sub', org_id: ORG, user_id: USER, received_at: new Date(Date.now() - 30_000).toISOString(), occurred_at: null, data: { subject: 'PR 12 ready', text: 'Please review' }, ...rowExtra };
  const db = {
    userOrganization: { findUnique: async () => ({ isActive: true, role: 'owner' }) },
    organization: { findUnique: async () => ({ name: 'Acme', companyProfile: {} }) },
    $queryRawUnsafe: async sql => sql.includes('UPDATE hivemind_trigger_events') ? [row] : sql.includes('runtime_enabled') ? [{ runtime_enabled: false }]
      : [{ toolkit: 'github', slug: 'GITHUB_PULL_REQUEST_CREATED', subject: USER, runtime_attention: true, runtime_attention_enabled_at: '2026-10-01T00:00:00Z' }],
    $executeRawUnsafe: async (sql, ...args) => { writes.push({ sql, args }); },
  };
  await classifyPendingActivity({ orgId: ORG, userId: USER, allowedAccountIds: ['a'], prisma: db, routingConfig: routingConfig({ ...base, ...envExtra }),
    relevanceDecider: async () => { calls.push('thin'); return thin; },
    employeeRouter: async (_db, input, deps) => { routed.push({ id: input.event.id, mentionsOnly: deps?.mentionsOnly === true }); },
    runtimeAttention: {
      assess: async () => { calls.push('runtime'); throw new Error('Runtime is off'); },
      assessForEmployees: async () => { calls.push('employees'); if (bridgeError) throw new Error(bridgeError); return verdict; },
    } });
  const saved = writes.flatMap(write => write.args).find(arg => typeof arg === 'string' && arg.startsWith('{') && arg.includes('"policy"'));
  return { calls, routed, receipt: JSON.parse(saved) };
}
const wake = { policy: 'runtime_attention_v3', destination: 'employees', action: 'wake', reason: 'native_attention', urgency: { type: 'choice', choice: 'immediate' }, toolSlugs: ['GITHUB_GET_A_PULL_REQUEST'] };

test('off: a company on neither list takes the company relevance check only; Runtime is not asked', async () => {
  const r = await classify({});
  assert.deepEqual(r.calls, ['thin']);
  assert.equal(r.receipt.shadowRuntimeAttention, undefined);
});

test('shadow: the company relevance verdict still decides delivery; Runtime\'s verdict is stored next to it', async () => {
  const r = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_SHADOW: ORG }, { verdict: wake });
  assert.deepEqual(r.calls, ['employees', 'thin']);
  assert.equal(r.receipt.status, 'rejected');
  assert.deepEqual(r.receipt.shadowRuntimeAttention, wake);
  assert.deepEqual(r.routed, [{ id: 'ev', mentionsOnly: true }], 'delivery follows the company verdict');
  const failed = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_SHADOW: ORG }, { bridgeError: 'runtime_attention_unavailable' });
  assert.deepEqual(failed.receipt.shadowRuntimeAttention, { unavailable: 'runtime_attention_unavailable' });
});

test('active: Runtime\'s verdict decides; notify and wake are approved and carried with the assessment and tool slugs', async () => {
  const r = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }, { verdict: wake });
  assert.deepEqual(r.calls, ['employees'], 'no company relevance call');
  assert.equal(r.receipt.status, 'approved');
  assert.equal(r.receipt.source, 'runtime_attention_employees');
  assert.deepEqual(r.receipt.attentionForEmployees, wake);
  assert.deepEqual(r.routed, [{ id: 'ev', mentionsOnly: false }]);
  const retained = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }, { verdict: { ...wake, action: 'retain', toolSlugs: [] } });
  assert.equal(retained.receipt.status, 'rejected');
});

test('active: deliver-all turns a retain into a delivery and keeps the verdict', async () => {
  const r = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG, HIVEMIND_EMPLOYEE_EVENT_DELIVER_ALL_ORGS: ORG }, { verdict: { ...wake, action: 'retain' } });
  assert.deepEqual([r.receipt.status, r.receipt.deliveredAll, r.receipt.attentionAction], ['approved', true, 'retain']);
});

test('active: an unreachable Runtime falls back to the company relevance check and says why', async () => {
  const r = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }, { bridgeError: 'runtime_attention_unavailable', thin: { status: 'approved', choice: 'useful_company_work', probability: 0.9, margin: 0.5, source: 'jev', policy: 'company_activity_relevance_v3' } });
  assert.deepEqual(r.calls, ['employees', 'thin']);
  assert.deepEqual([r.receipt.status, r.receipt.attentionFallback], ['approved', 'runtime_attention_unavailable']);
  assert.deepEqual(await judgeForEmployees(undefined, {}), { unavailable: 'bridge_unconfigured' });
});

test('live only: an event that happened past the age limit is recorded as too old; nobody is asked and nothing is routed', async () => {
  const r = await classify({ HIVEMIND_ATTENTION_EMPLOYEE_ORGS_ACTIVE: ORG }, { verdict: wake, row: { occurred_at: new Date(Date.now() - 53 * 60_000).toISOString() } });
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.routed, []);
  assert.deepEqual([r.receipt.source, r.receipt.tooOld], ['too_old', true]);
});

test('bridge: an employees assessment signs and sends the destination; a malformed verdict is refused', async () => {
  const secret = 'x'.repeat(40), sent = [];
  let answer = wake;
  const bridge = createRuntimeAttentionBridge({ env: { HIVEMIND_RUNTIME_ATTENTION_URL: 'http://runtime-runner:3080/internal/hivemind/runtime-attention', HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async (_url, init) => { sent.push(init); return { ok: true, text: async () => JSON.stringify(answer) }; } });
  const row = { id: 'ev', org_id: ORG, user_id: USER };
  assert.deepEqual(await bridge.assessForEmployees(row), wake);
  assert.deepEqual(JSON.parse(sent[0].body), { operation: 'assess', eventId: 'ev', orgId: ORG, userId: USER, destination: 'employees' });
  const [header, claims, signature] = sent[0].headers.authorization.slice(7).split('.');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).destination, 'employees');
  assert.equal(createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url'), signature);
  await bridge.assess(row);
  assert.equal(JSON.parse(sent[1].body).destination, undefined, 'a Runtime assessment is unchanged on the wire');
  for (const bad of [{ ...wake, destination: 'runtime' }, { ...wake, action: 'escalate' }, { ...wake, targetSessionId: 's' }, { ...wake, toolSlugs: ['rm -rf'] }]) {
    answer = bad;
    await assert.rejects(bridge.assessForEmployees(row), /invalid_employee_verdict/);
  }
});

test('signal: a forwarded event carries the Runtime verdict\'s assessment, urgency and tool slugs', () => {
  const signal = attentionSignal({ toolkit: 'github', data: { title: 'PR 12' }, decision: { status: 'approved', attentionForEmployees: { ...wake, assessment: { type: 'choice', choice: 'needed' } } } });
  assert.deepEqual(signal.assessment, { suggestedDisposition: 'wake', reason: 'native_attention', need: 'needed', urgency: 'immediate' });
  assert.deepEqual(signal.appTools, { toolkit: 'github', slugs: ['GITHUB_GET_A_PULL_REQUEST'] });
  const thin = attentionSignal({ toolkit: 'github', data: { title: 'PR 12' }, decision: { status: 'approved', choice: 'useful_company_work' } });
  assert.equal(thin.assessment.need, 'useful_company_work');
  assert.equal(thin.appTools.slugs.length, 4, 'the default GitHub slugs');
});
