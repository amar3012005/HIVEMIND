// Runtime's attention layer chooses the connected-app tools a signal needs, per company: what Core sends, validates and forwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAttentionBridge, toolsWithinCatalogue } from '../../src/connectors/composio/runtime-attention-bridge.js';
import { activeToolkits, createConnectedToolkitsLookup } from '../../src/connectors/composio/attention-toolkits.js';
import { attentionSignal, signalToolSlugs, verdictToolGroups } from '../../src/connectors/attention-signal.js';
import { judgeForEmployees } from '../../src/connectors/composio/activity-relevance.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const URL_ = 'http://runtime-runner:3080/internal/hivemind/runtime-attention';
const env = { HIVEMIND_RUNTIME_ATTENTION_URL: URL_, HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'x'.repeat(40) };
const rowOf = org => ({ id: 'ev', org_id: org, user_id: USER });

const verdict = (extra = {}) => ({ policy: 'runtime_attention_v3', destination: 'employees', action: 'wake', reason: 'native_attention', notification: 'employee',
  toolSlugs: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GOOGLECALENDAR_FIND_FREE_SLOTS', 'GOOGLECALENDAR_CREATE_EVENT', 'GMAIL_CREATE_EMAIL_DRAFT'],
  tools: [{ slug: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', toolkit: 'gmail', probability: 0.9, ownRead: true },
    { slug: 'GOOGLECALENDAR_FIND_FREE_SLOTS', toolkit: 'googlecalendar', probability: 0.93 },
    { slug: 'GOOGLECALENDAR_CREATE_EVENT', toolkit: 'googlecalendar', probability: 0.71 },
    { slug: 'GMAIL_CREATE_EMAIL_DRAFT', toolkit: 'gmail', probability: 0.8 }],
  toolSelection: { mode: 'decided', candidates: 8 }, ...extra });

function bridgeWith({ lookup, answer, status = 200, failFirst } = {}) {
  const sent = [];
  const bridge = createRuntimeAttentionBridge({ env, connectedToolkits: lookup,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      if (failFirst && body.connectedToolkits) return { ok: false, status: 400, text: async () => '{"error":"invalid_request"}' };
      return { ok: status < 400, status, text: async () => JSON.stringify(typeof answer === 'function' ? answer(body) : answer) };
    } });
  return { bridge, sent };
}

test('the bridge sends the company\'s connected apps with an assess, for both destinations, and with nothing else', async () => {
  const { bridge, sent } = bridgeWith({ lookup: async row => (row.org_id === ORG_A ? ['googlecalendar', 'gmail'] : ['slack']), answer: verdict() });
  await bridge.assessForEmployees(rowOf(ORG_A));
  await bridge.assess(rowOf(ORG_A));
  await bridge.readConsent(rowOf(ORG_A)).catch(() => {});
  assert.deepEqual(sent[0].connectedToolkits, ['googlecalendar', 'gmail']);
  assert.deepEqual(sent[1].connectedToolkits, ['googlecalendar', 'gmail']);
  assert.equal(sent[2].operation, 'context');
  assert.equal(sent[2].connectedToolkits, undefined, 'only an assess carries the catalogue');
});

test('company A\'s apps never ride on company B\'s request', async () => {
  const { bridge, sent } = bridgeWith({ lookup: async row => (row.org_id === ORG_A ? ['googlecalendar', 'gmail', 'hubspot'] : ['slack']), answer: { ...verdict(), toolSlugs: [], tools: undefined } });
  await bridge.assessForEmployees(rowOf(ORG_A));
  await bridge.assessForEmployees(rowOf(ORG_B));
  assert.deepEqual(sent.map(body => [body.orgId, body.connectedToolkits]), [[ORG_A, ['googlecalendar', 'gmail', 'hubspot']], [ORG_B, ['slack']]]);
  assert.doesNotMatch(JSON.stringify(sent[1]), /hubspot|googlecalendar|gmail/u);
});

test('an unreadable catalogue sends no list, which is the signal-app-only behaviour of today', async () => {
  for (const lookup of [async () => undefined, async () => [], undefined]) {
    const { bridge, sent } = bridgeWith({ lookup, answer: { ...verdict(), toolSlugs: [], tools: undefined } });
    await bridge.assessForEmployees(rowOf(ORG_A));
    assert.equal('connectedToolkits' in sent[0], false);
  }
});

test('a Runtime that predates the field answers 400; the assess is repeated without it', async () => {
  const { bridge, sent } = bridgeWith({ lookup: async () => ['gmail', 'googlecalendar'], failFirst: true,
    answer: { ...verdict(), toolSlugs: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID'], tools: undefined, toolSelection: undefined } });
  const result = await bridge.assessForEmployees(rowOf(ORG_A));
  assert.equal(sent.length, 2);
  assert.equal('connectedToolkits' in sent[1], false);
  assert.deepEqual(result.toolSlugs, ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID']);
});

test('a verdict that names an app outside the company\'s catalogue keeps its answer and loses its tools', async () => {
  const outside = { ...verdict(), tools: [...verdict().tools, { slug: 'HUBSPOT_SEARCH_DEALS', toolkit: 'hubspot', probability: 0.9 }], toolSlugs: [...verdict().toolSlugs, 'HUBSPOT_SEARCH_DEALS'] };
  const { bridge } = bridgeWith({ lookup: async () => ['gmail', 'googlecalendar'], answer: outside });
  const employees = await bridge.assessForEmployees(rowOf(ORG_A));
  assert.deepEqual([employees.action, employees.toolSlugs, employees.tools], ['wake', [], undefined]);
  const runtime = await bridge.assess(rowOf(ORG_A));
  assert.equal(runtime.action, 'wake');
  assert.equal('toolSlugs' in runtime, false, 'Runtime then uses its fixed list');
});

test('tools are admissible only inside the sent catalogue, with a slug that starts with its app', () => {
  assert.equal(toolsWithinCatalogue(verdict(), ['gmail', 'googlecalendar']), true);
  assert.equal(toolsWithinCatalogue(verdict(), ['gmail']), false);
  assert.equal(toolsWithinCatalogue(verdict(), undefined), false, 'with no catalogue sent only one app may be named');
  assert.equal(toolsWithinCatalogue({ toolSlugs: ['GMAIL_FETCH_EMAILS'], tools: [{ slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', probability: 0.9, ownRead: true }] }, undefined), true);
  assert.equal(toolsWithinCatalogue({ toolSlugs: ['SLACK_SEARCH_MESSAGES'], tools: [{ slug: 'SLACK_SEARCH_MESSAGES', toolkit: 'gmail', probability: 1 }] }, ['gmail']), false);
  assert.equal(toolsWithinCatalogue({ toolSlugs: [] }, ['gmail']), true, 'a fixed-list verdict names no tools to check');
});

test('signal: a meeting-request email brings the calendar tools next to the Gmail ones', () => {
  const signal = attentionSignal({ toolkit: 'gmail', data: { subject: 'Can we meet Thursday?' }, decision: { status: 'approved', attentionForEmployees: verdict() } });
  assert.deepEqual(signal.appTools, { toolkit: 'gmail', slugs: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_CREATE_EMAIL_DRAFT'],
    others: [{ toolkit: 'googlecalendar', slugs: ['GOOGLECALENDAR_FIND_FREE_SLOTS', 'GOOGLECALENDAR_CREATE_EVENT'] }] });
});

test('signal: the same email without calendar tools in the verdict carries none', () => {
  const noCalendar = verdict({ toolSlugs: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_CREATE_EMAIL_DRAFT'],
    tools: [verdict().tools[0], verdict().tools[3]] });
  const signal = attentionSignal({ toolkit: 'gmail', data: { subject: 'Can we meet Thursday?' }, decision: { status: 'approved', attentionForEmployees: noCalendar } });
  assert.deepEqual(signal.appTools, { toolkit: 'gmail', slugs: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_CREATE_EMAIL_DRAFT'] });
});

test('signal: malformed or mis-filed tools in a verdict are dropped, never repaired, and the total stays within eight', () => {
  const groups = verdictToolGroups('gmail', { toolSlugs: ['GMAIL_A', 'SLACK_X', 'bad slug', 'GOOGLECALENDAR_B', 'GOOGLECALENDAR_C'],
    tools: [{ slug: 'GMAIL_A', toolkit: 'gmail' }, { slug: 'SLACK_X', toolkit: 'gmail' }, { slug: 'bad slug', toolkit: 'gmail' }, { slug: 'GOOGLECALENDAR_B', toolkit: 'Bad Name' },
      { slug: 'GOOGLECALENDAR_C', toolkit: 'googlecalendar' }] });
  assert.deepEqual(groups, { slugs: ['GMAIL_A'], others: [{ toolkit: 'googlecalendar', slugs: ['GOOGLECALENDAR_C'] }] });
  const many = Array.from({ length: 12 }, (_, i) => `GMAIL_TOOL${i}`);
  const capped = verdictToolGroups('gmail', { toolSlugs: many, tools: many.map(slug => ({ slug, toolkit: 'gmail' })) });
  assert.equal(capped.slugs.length, 8);
  assert.deepEqual(verdictToolGroups('gmail', { toolSlugs: ['GMAIL_FETCH_EMAILS', 'GOOGLECALENDAR_FIND_FREE_SLOTS'] }),
    { slugs: ['GMAIL_FETCH_EMAILS'], others: [] }, 'a verdict without tools (older Runtime) keeps only the signal app\'s slugs');
});

test('fallback: with no Runtime verdict the event carries the fixed list of its own app', async () => {
  const thin = attentionSignal({ toolkit: 'gmail', data: { subject: 'Hi' }, decision: { status: 'approved', choice: 'useful_company_work' } });
  assert.deepEqual(thin.appTools, { toolkit: 'gmail', slugs: signalToolSlugs('gmail') });
  assert.deepEqual(thin.appTools.slugs, ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_ADD_LABEL_TO_EMAIL', 'GMAIL_REPLY_TO_THREAD']);
  assert.equal('others' in thin.appTools, false);
  const failing = createRuntimeAttentionBridge({ env, connectedToolkits: async () => ['gmail', 'googlecalendar'], fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.deepEqual(await judgeForEmployees(failing, rowOf(ORG_A)), { unavailable: 'connect ECONNREFUSED' });
  const unavailable = attentionSignal({ toolkit: 'gmail', data: { subject: 'Hi' }, decision: { status: 'approved', source: 'jev' } });
  assert.deepEqual(unavailable.appTools.slugs, signalToolSlugs('gmail'));
});

test('the connected-app lookup keeps only active, well-formed apps, caches per company and treats a failure as unknown', async () => {
  assert.deepEqual(activeToolkits([{ toolkit: 'GMAIL', status: 'ACTIVE' }, { toolkit: 'slack', status: 'EXPIRED' }, { toolkit: 'bad name', status: 'ACTIVE' },
    { toolkit: 'googlecalendar', status: 'active' }, { status: 'ACTIVE' }, { toolkit: 'gmail', status: 'ACTIVE' }]), ['gmail', 'googlecalendar']);
  let now = 1000, calls = [], fail = false;
  const lookup = createConnectedToolkitsLookup({ now: () => now, ttlMs: 60_000, failureMs: 5_000, timeoutMs: 50,
    list: async (org) => { calls.push(org); if (fail) throw new Error('provider down'); return org === ORG_A ? [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'googlecalendar', status: 'ACTIVE' }] : [{ toolkit: 'slack', status: 'ACTIVE' }]; } });
  assert.deepEqual(await lookup(rowOf(ORG_A)), ['gmail', 'googlecalendar']);
  assert.deepEqual(await lookup(rowOf(ORG_B)), ['slack']);
  assert.deepEqual(await lookup(rowOf(ORG_A)), ['gmail', 'googlecalendar']);
  assert.deepEqual(calls, [ORG_A, ORG_B], 'the second read of a company comes from the cache');
  now += 61_000; fail = true;
  assert.equal(await lookup(rowOf(ORG_A)), undefined);
  assert.equal(await lookup(rowOf(ORG_A)), undefined);
  assert.equal(calls.length, 3, 'a failure pauses reads for a few seconds');
  now += 6_000; fail = false;
  assert.deepEqual(await lookup(rowOf(ORG_A)), ['gmail', 'googlecalendar']);
  const slow = createConnectedToolkitsLookup({ timeoutMs: 20, list: () => new Promise(() => {}) });
  assert.equal(await slow(rowOf(ORG_A)), undefined);
  assert.equal(await lookup({}), undefined);
});
