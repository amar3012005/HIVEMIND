import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSealedRoomOutput,
  deliverDayOneFirstMove,
  isDayOneWorkflowEnabled,
  isResearchTask,
  notifyDayOneWorkflowCompletion,
  renderDayOneEmail,
  renderDayOnePortraitReport,
  renderRoomReadme,
  prepareDayOneFirstMove,
  scheduleDayOneWorkflow,
  selectDayOneResearchTask,
} from '../../src/lifecycle/day1-first-move.js';
import { lifecycleEmailShell } from '../../src/email/templates/cartesia-lifecycle.js';

test('shared lifecycle email shell owns the responsive rich-content contract', () => {
  const html = lifecycleEmailShell({ title: 'Shared', preheader: 'Shared', body: '<tr><td class="section rich-content">Content</td></tr>' });
  assert.match(html, /\.rich-content\{overflow-wrap:anywhere/);
  assert.match(html, /\.data-table th,\.data-table td/);
  assert.match(html, /@media only screen and \(max-width:360px\)/);
  assert.match(html, /https:\/\/singulancelabs\.com\/images\/singulance-orbit\.png/);
});

test('Day 1 selects the first pending research-tagged task, not a generic todo', () => {
  const tasks = [
    { id: 'sales', status: 'todo', tag: 'outreach' },
    { id: 'done-research', status: 'done', room_tag: 'research' },
    { id: 'research', status: 'todo', room_tag: 'research' },
  ];
  assert.equal(isResearchTask(tasks[2]), true);
  assert.equal(selectDayOneResearchTask(tasks)?.id, 'research');
});

test('Day 1 prioritizes the website-onboarding competitor research task', () => {
  const tasks = [
    { id: 'generic-research', status: 'todo', room_tag: 'research' },
    { id: 'competitor-research', status: 'todo', room_tag: 'research', day1_first_move: true },
  ];
  assert.equal(selectDayOneResearchTask(tasks)?.id, 'competitor-research');
});

test('Day 1 reuses an already-started research task so its sealed Day-0 room output is delivered', () => {
  const tasks = [
    { id: 'generic', status: 'todo', room_tag: 'marketing' },
    { id: 'research-existing', status: 'active', room_tag: 'research', room_id: 'room-existing' },
  ];
  assert.equal(selectDayOneResearchTask(tasks)?.id, 'research-existing');
});

test('Day 1 backend master gate is fail-closed and accepts exact true only', () => {
  const previous = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  try {
    delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
    assert.equal(isDayOneWorkflowEnabled(), false);
    process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'TRUE';
    assert.equal(isDayOneWorkflowEnabled(), false);
    process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
    assert.equal(isDayOneWorkflowEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previous;
  }
});

test('Day 1 scheduling is skipped while the backend master gate is off', async () => {
  const previous = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  try {
    const result = await scheduleDayOneWorkflow({ orgId: 'org', hqRoomId: 'hq' });
    assert.deepEqual(result, { ok: false, skipped: true, reason: 'feature_disabled' });
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previous;
  }
});

test('Day 1 re-admits a sealed room through the durable queue when the Workflow event is unavailable', async () => {
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  const previousUrl = process.env.HIVEMIND_D1_WORKFLOW_URL;
  const previousSecret = process.env.HIVEMIND_D1_WORKFLOW_SECRET;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  process.env.HIVEMIND_D1_WORKFLOW_URL = 'https://workflow.example.test';
  process.env.HIVEMIND_D1_WORKFLOW_SECRET = 'test-secret';
  const company = { day1_first_move: { workflow_instance_id: 'd1-hq', status: 'running' } };
  const row = { id: 'hq', org_id: '11111111-1111-1111-1111-111111111111', company };
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async () => [row],
    $executeRawUnsafe: async (_sql, state) => { company.day1_first_move = JSON.parse(state); return 1; },
  };
  const fetchImpl = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    const eventRequest = String(url).endsWith('/event');
    return new Response(JSON.stringify(eventRequest ? { error: 'workflow_unavailable' } : { ok: true, admitted: true }), { status: eventRequest ? 401 : 202 });
  };
  try {
    const result = await notifyDayOneWorkflowCompletion({ prisma, turnId: 'turn-1', status: 'complete', fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.recovered_from_event_failure, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/event$/);
    assert.match(calls[1].url, /\/start$/);
    assert.equal(calls[1].body.hq_room_id, 'hq');
  } finally {
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
    if (previousUrl === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_URL; else process.env.HIVEMIND_D1_WORKFLOW_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_SECRET; else process.env.HIVEMIND_D1_WORKFLOW_SECRET = previousSecret;
  }
});

test('prepare starts the research task once and reuses its durable room turn on retry', async () => {
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  const company = {
    company: 'SOLVIS', mission: 'Efficient heating', profile: { location: 'Berlin, Germany' }, team: [{ id: 'agent-1' }],
    tasks: [
      { id: 'sales-1', title: 'Find leads', status: 'todo', room_tag: 'outreach' },
      { id: 'research-1', title: 'Validate market demand', detail: 'Use verified sources.', status: 'todo', room_tag: 'research' },
    ],
  };
  const hq = { id: '22222222-2222-2222-2222-222222222222', org_id: '11111111-1111-1111-1111-111111111111', user_id: '33333333-3333-3333-3333-333333333333', company };
  const rooms = new Map();
  const turns = new Map();
  let dispatches = 0;
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('SELECT id, user_id')) return [hq];
      if (sql.includes("jsonb_set(\"agent_connectors\", '{_company}'")) { hq.company = JSON.parse(args[0]); return []; }
      return [];
    },
    async $executeRawUnsafe() { return 1; },
    hyperRoom: {
      findFirst: async ({ where }) => rooms.get(where.id) || null,
      create: async ({ data }) => { const room = { id: '44444444-4444-4444-4444-444444444444', goal: '', projectId: null, ...data }; rooms.set(room.id, room); return room; },
      findUnique: async ({ where }) => rooms.get(where.id) || null,
    },
    hyperTurn: {
      findUnique: async ({ where }) => turns.get(where.idempotencyKey) || null,
      findFirst: async () => null,
      create: async ({ data }) => { const turn = { id: '55555555-5555-5555-5555-555555555555', sealedAt: null, ...data }; turns.set(data.idempotencyKey, turn); return turn; },
    },
  };
  const dispatchTurn = async ({ user_message }) => {
    dispatches += 1;
    assert.match(user_message, /Company HQ \/ operating location: Berlin, Germany/);
    return { ok: true };
  };
  const args = { prisma, orgId: hq.org_id, hqRoomId: hq.id, workflowInstanceId: `d1-${hq.id}`, dispatchTurn };
  try {
    const first = await prepareDayOneFirstMove(args);
    const second = await prepareDayOneFirstMove(args);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.task_id, 'research-1');
    assert.equal(first.room_id, '44444444-4444-4444-4444-444444444444');
    assert.equal(second.turn_id, first.turn_id);
    assert.equal(dispatches, 1);
    assert.equal(hq.company.tasks[0].status, 'todo');
    assert.equal(hq.company.tasks[1].status, 'active');
    const existingTurn = turns.values().next().value;
    existingTurn.status = 'complete';
    existingTurn.sealedAt = new Date();
    hq.company.day1_first_move.status = 'failed';
    hq.company.day1_first_move.failure_reason = 'delivery_transport_failed';
    const recovered = await prepareDayOneFirstMove({ ...args, workflowInstanceId: `d1-recovery-${hq.id}` });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.turn_id, first.turn_id);
    assert.equal(hq.company.day1_first_move.workflow_instance_id, `d1-recovery-${hq.id}`);
    assert.equal(dispatches, 1);
    assert.equal(hq.company.tasks[1].status, 'done');
  } finally {
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
  }
});

test('prepare adopts an existing research room turn rather than dispatching duplicate work', async () => {
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  const company = {
    company: 'Canary Co', mission: 'Evidence first', team: [{ id: 'agent-1' }],
    tasks: [{ id: 'research-1', title: 'Validate demand', status: 'active', room_tag: 'research', room_id: '44444444-4444-4444-4444-444444444444' }],
  };
  const hq = { id: '22222222-2222-2222-2222-222222222222', org_id: '11111111-1111-1111-1111-111111111111', user_id: '33333333-3333-3333-3333-333333333333', company };
  const room = { id: '44444444-4444-4444-4444-444444444444', participantIds: ['agent-1'], goal: 'existing', projectId: null };
  const existingTurn = { id: '55555555-5555-5555-5555-555555555555', roomId: room.id, status: 'blocked', sealedAt: new Date() };
  let dispatches = 0;
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('SELECT id, user_id')) return [hq];
      if (sql.includes("jsonb_set(\"agent_connectors\", '{_company}'")) { hq.company = JSON.parse(args[0]); return []; }
      return [];
    },
    async $executeRawUnsafe() { return 1; },
    hyperRoom: { findFirst: async () => room, findUnique: async () => room, create: async () => { throw new Error('must_not_create_room'); } },
    hyperTurn: { findFirst: async () => existingTurn, findUnique: async () => null, create: async () => { throw new Error('must_not_create_turn'); } },
  };
  try {
    const result = await prepareDayOneFirstMove({ prisma, orgId: hq.org_id, hqRoomId: hq.id, workflowInstanceId: `d1-${hq.id}`, dispatchTurn: async () => { dispatches += 1; } });
    assert.equal(result.status, 'completed');
    assert.equal(result.room_id, room.id);
    assert.equal(result.turn_id, existingTurn.id);
    assert.equal(dispatches, 0);
    assert.equal(hq.company.tasks[0].status, 'done');
  } finally {
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
  }
});

test('Day 1 takes the sealed final report verbatim', () => {
  const expected = '# Evidence\n\n- Claim **A**\n- Claim B';
  const lines = [
    { t: 'line', kind: 'lead', content: 'intermediate' },
    { t: 'final_report', text: expected },
    { t: 'seal', status: 'complete' },
  ];
  assert.equal(extractSealedRoomOutput(lines), expected);
});

test('Day 1 delivers a sealed blocked research report with its evidence gaps intact', async () => {
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  const output = '# Research result\n\n## Gaps to Confirm\n\n- Public evidence was insufficient.';
  const company = {
    company: 'Canary Co',
    tasks: [{ id: 'research-1', title: 'Validate evidence' }],
    day1_first_move: { status: 'completed', task_id: 'research-1', room_id: 'room-1', turn_id: 'turn-1', room_status: 'blocked' },
  };
  const hq = { id: 'hq-1', user_id: 'user-1', company };
  let sends = 0;
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('SELECT id, user_id')) return [hq];
      if (sql.includes('UPDATE "hivemind"."hyper_rooms"')) {
        company.day1_first_move = JSON.parse(args[0]);
        return [{ id: hq.id }];
      }
      return [];
    },
    async $executeRawUnsafe(_sql, value) { company.day1_first_move = JSON.parse(value); return 1; },
    hyperTurn: { findFirst: async () => ({ id: 'turn-1', roomId: 'room-1', status: 'blocked', sealedAt: new Date(), lines: [{ t: 'final_report', text: output }, { t: 'seal', status: 'blocked' }] }) },
    user: { findUnique: async () => ({ email: 'canary@example.test' }) },
  };
  try {
    const result = await deliverDayOneFirstMove({
      prisma, orgId: 'org-1', hqRoomId: 'hq-1',
      renderPdf: async () => Buffer.from('pdf'),
      sendEmail: async ({ rendered }) => { sends += 1; assert.match(rendered.text, /Public evidence was insufficient/); return { ok: true, provider: 'cloudflare', messageId: 'msg-blocked-1' }; },
    });
    assert.equal(result.status, 'sent');
    assert.equal(sends, 1);
  } finally {
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
  }
});

test('README rendering preserves content while escaping executable HTML', () => {
  const html = renderRoomReadme('# Findings\n\n<script>alert(1)</script>\n\n1. Verified **signal**');
  assert.match(html, /<h2>Findings<\/h2>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<strong>signal<\/strong>/);
});

test('README rendering produces safe tables and preserves international characters', () => {
  const html = renderRoomReadme(`# 市場調査 — نتائج البحث 🚀

| Region | Signal | Owner |
|:--|--:|:--:|
| भारत | **強い** | Léa & Omar |
| الخليج | 82% | Zoë |

Long token: https://example.test/${'segment/'.repeat(20)}`);
  assert.match(html, /<table class="data-table">/);
  assert.match(html, /<th style="text-align:left">Region<\/th>/);
  assert.match(html, /<td style="text-align:right"><strong>強い<\/strong><\/td>/);
  assert.match(html, /市場調査 — نتائج البحث 🚀/u);
  assert.match(html, /Léa &amp; Omar/u);
  assert.doesNotMatch(html, /\|:--\|/);
});

test('email and portrait report contain the exact sealed room output', () => {
  const input = {
    companyName: 'SOLVIS',
    taskTitle: 'Validate Market Need for Sovereign AI',
    output: '# Research findings\n\nThe verified demand signal remains **strong**.',
    roomUrl: 'https://next.singulancelabs.com/hivemind/app/employees/rooms/11111111-1111-1111-1111-111111111111',
    characters: [
      { id: 'agent-research', name: 'Léa', role: 'Researcher' },
      { id: 'agent-skeptic', name: 'Omar', role: 'Risk & Compliance' },
    ],
  };
  const email = renderDayOneEmail(input);
  const report = renderDayOnePortraitReport(input);
  assert.match(email.text, /# Research findings\n\nThe verified demand signal remains \*\*strong\*\*\./);
  assert.match(email.html, /The verified demand signal remains <strong>strong<\/strong>\./);
  assert.match(email.html, /class="character-strip"/);
  assert.match(email.html, /humation-avatar\.svg\?seed=agent-research&amp;role=Researcher&amp;v=2/);
  assert.match(email.html, /class="character-avatar" style="background:#e8f8f2;border-color:#10b981"/);
  assert.match(email.html, /class="character-role" style="color:#10b981"/);
  assert.match(email.html, /https:\/\/singulancelabs\.com\/images\/singulance-orbit\.png/);
  assert.match(email.html, /@media only screen and \(max-width:360px\)/);
  assert.match(email.html, /-webkit-overflow-scrolling:touch/);
  assert.match(report, /@page\{size:A4 portrait/);
  assert.match(report, /The verified demand signal remains <strong>strong<\/strong>\./);
  assert.match(report, /aria-label="Léa"/u);
  assert.match(report, /class="character-strip"/);
  assert.match(report, /aria-label="Singulance"/);
  assert.doesNotMatch(report, /re-synthesi|summary generated/i);
});

test('delivery persists exact output evidence and a duplicate retry sends nothing', async () => {
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  const output = '# Verified finding\n\nA source-backed result.';
  const company = {
    company: 'Canary Co',
    tasks: [{ id: 'research-1', title: 'Validate demand' }],
    day1_first_move: { status: 'completed', task_id: 'research-1', room_id: 'room-1', turn_id: 'turn-1' },
  };
  const hq = { id: 'hq-1', user_id: 'user-1', company };
  let sends = 0;
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      if (sql.includes('SELECT id, user_id')) return [hq];
      if (sql.includes('UPDATE "hivemind"."hyper_rooms"')) {
        company.day1_first_move = JSON.parse(args[0]);
        return [{ id: hq.id }];
      }
      return [];
    },
    async $executeRawUnsafe(_sql, value) { company.day1_first_move = JSON.parse(value); return 1; },
    hyperTurn: { findFirst: async () => ({ id: 'turn-1', roomId: 'room-1', status: 'complete', sealedAt: new Date('2026-08-29T12:00:00Z'), lines: [{ t: 'final_report', text: output }, { t: 'seal', status: 'complete' }] }) },
    user: { findUnique: async () => ({ email: 'canary@example.test' }) },
  };
  try {
    const args = {
      prisma, orgId: 'org-1', hqRoomId: 'hq-1',
      renderPdf: async (html) => { assert.match(html, /A source-backed result\./); return Buffer.from('portrait-pdf'); },
      sendEmail: async ({ rendered, attachments }) => {
        sends += 1;
        assert.match(rendered.text, /A source-backed result\./);
        assert.equal(attachments[0].type, 'application/pdf');
        return { ok: true, provider: 'cloudflare', deliveryStatus: 'accepted', messageId: 'msg-canary-1' };
      },
    };
    const first = await deliverDayOneFirstMove(args);
    const duplicate = await deliverDayOneFirstMove(args);
    assert.equal(first.accepted, true);
    assert.equal(first.output_sha256, 'a4e7885f4b020f48a3e77dcecc8384743abd2164e608499b2aeabbd653a771f6');
    assert.equal(first.output_length, Buffer.byteLength(output));
    assert.equal(company.day1_first_move.output_sha256, first.output_sha256);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.message_id, 'msg-canary-1');
    assert.equal(sends, 1);
  } finally {
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
  }
});

test('Day 0 schedules a deterministic Day 1 handoff without report persistence', async () => {
  const previousUrl = process.env.HIVEMIND_D1_WORKFLOW_URL;
  const previousSecret = process.env.HIVEMIND_D1_WORKFLOW_SECRET;
  const previousEnabled = process.env.HIVEMIND_D1_WORKFLOW_ENABLED;
  process.env.HIVEMIND_D1_WORKFLOW_ENABLED = 'true';
  process.env.HIVEMIND_D1_WORKFLOW_URL = 'https://workflow.example.test';
  process.env.HIVEMIND_D1_WORKFLOW_SECRET = 'unit-secret';
  let request = null;
  try {
    const result = await scheduleDayOneWorkflow({
      orgId: '11111111-1111-1111-1111-111111111111',
      hqRoomId: '22222222-2222-2222-2222-222222222222',
      onboardedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      fetchImpl: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ instance_id: 'd1-2222' }), { status: 202, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://workflow.example.test/start');
    assert.equal(request.init.headers.authorization, 'Bearer unit-secret');
    assert.equal(request.body.org_id, '11111111-1111-1111-1111-111111111111');
    assert.equal('report' in request.body, false);
  } finally {
    if (previousUrl === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_URL; else process.env.HIVEMIND_D1_WORKFLOW_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_SECRET; else process.env.HIVEMIND_D1_WORKFLOW_SECRET = previousSecret;
    if (previousEnabled === undefined) delete process.env.HIVEMIND_D1_WORKFLOW_ENABLED; else process.env.HIVEMIND_D1_WORKFLOW_ENABLED = previousEnabled;
  }
});
