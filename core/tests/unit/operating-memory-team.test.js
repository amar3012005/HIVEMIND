import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateOperatingMemory, validateOperatingMemoryFilter, saveOperatingMemory, recallOperatingMemory, confirmOperatingMemory,
} from '../../src/hyperagents/operating-memory.js';
import { buildBrief, tokenize } from '../../src/hyperagents/team-memory.js';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const identity = { orgId, userId };

// In-memory stand-in for the queries the module issues; it interprets only the
// statements these tests exercise.
function fakeDb(seed = []) {
  const rows = [...seed];
  const supersededIds = () => new Set(rows.map(r => r.context?.supersedesId).filter(Boolean));
  const db = {
    rows, sql: [],
    $transaction: async fn => fn(db),
    $executeRawUnsafe: async () => 0,
    project: { upsert: async () => ({ id: 'b79673b4-4578-4fc2-8144-05056983f4e1', name: 'Hyper Agents', policy: 'private' }) },
    projectMember: { upsert: async () => ({}) },
    $queryRawUnsafe: async (sql, ...args) => {
      db.sql.push(sql);
      if (sql.includes('INSERT INTO')) {
        const [org, , key, kind, status, agent, author, , run, , title, summary, context] = args;
        if (rows.some(r => r.org_id === org && r.idempotency_key === key)) return [];
        const row = { id: randomUUID(), org_id: org, idempotency_key: key, kind, status, agent_slug: agent, author_user_id: author, run_id: run, title, summary, context: JSON.parse(context), created_at: new Date(Date.now() + rows.length) };
        rows.push(row);
        return [row];
      }
      if (sql.includes('WHERE org_id = $1::uuid AND idempotency_key = $2')) return rows.filter(r => r.org_id === args[0] && r.idempotency_key === args[1]);
      if (sql.includes("m.context->>'task_key'") || sql.includes("m.context->>'agenda_key'")) {
        const field = sql.includes("'task_key'") ? 'task_key' : 'agenda_key';
        const gone = supersededIds();
        return rows.filter(r => r.org_id === args[0] && r.kind === args[1] && r.context[field] === args[2] && !gone.has(r.id)).slice(-1).map(r => ({ id: r.id }));
      }
      if (sql.includes('AS superseded')) {
        const r = rows.find(x => x.id === args[0] && x.org_id === args[1]);
        return r ? [{ ...r, superseded: supersededIds().has(r.id) }] : [];
      }
      if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1::uuid')) return rows.filter(r => r.id === args[0] && r.org_id === args[1] && r.kind === args[2]).map(r => ({ id: r.id }));
      if (sql.includes("context->>'supersedesId'=$2")) return rows.filter(r => r.context.supersedesId === args[1] && r.idempotency_key !== args[2]).map(r => ({ id: r.id }));
      if (sql.startsWith('\n      UPDATE')) {
        const r = rows.find(x => x.id === args[1]);
        r.context = JSON.parse(args[0]);
        return [r];
      }
      if (sql.includes('LIMIT 200') || sql.includes('to_tsquery')) {
        const gone = supersededIds();
        return rows.filter(r => r.org_id === args[0] && !gone.has(r.id) && !['user_agenda', 'uncertainty'].includes(r.kind)
          && (!sql.includes("m.context->>'promoted' = 'true'") || (['lesson', 'procedure'].includes(r.kind) && r.context.promoted === true)));
      }
      return [];
    },
  };
  return db;
}

const lesson = { kind: 'lesson', agent_slug: 'sofia', when: 'a customer email asks for pricing', do: 'quote from the price sheet in the Library', because: 'three quotes were rejected when improvised', confidence: 0.8 };
const procedure = { kind: 'procedure', agent_slug: 'sofia', trigger: 'weekly invoice run', steps: ['export open invoices', 'match payments', 'email overdue list'], check: 'overdue list matches the ledger', source: 'shown' };
const progress = { kind: 'progress', agent_slug: 'sofia', task_key: 'q4-outreach', goal: 'Contact 40 leads', done: ['10 contacted'], next: ['contact 15 more'], open_questions: ['Which template?'], evidence: ['library:leads.csv'] };
const agenda = { kind: 'agenda', agent_slug: 'omar', agenda_key: 'q4-pipeline', outcome: 'Grow pipeline', target: { text: 'qualified leads', value: 120, unit: 'leads' }, milestones: ['audit list', { text: 'launch', due: '2026-11-15' }], task_keys: ['q4-outreach'], status: 'active' };

test('legacy kinds validate exactly as before and reject team-only fields', () => {
  const learning = { kind: 'learning', agent_slug: 'sofia', title: 'Use UTC', summary: 'Schedules are stored in UTC.', idempotency_key: 'k1', context: { a: 1 } };
  const row = validateOperatingMemory(learning, identity);
  assert.deepEqual([row.kind, row.status, row.title, row.summary, row.idempotencyKey, row.context], ['learning', 'recorded', 'Use UTC', 'Schedules are stored in UTC.', 'k1', { a: 1 }]);
  assert.throws(() => validateOperatingMemory({ ...learning, when: 'x' }, identity), /invalid_memory_field/);
  assert.throws(() => validateOperatingMemory({ ...learning, steps: ['x'] }, identity), /invalid_memory_field/);
  assert.throws(() => validateOperatingMemory({ ...learning, title: '' }, identity), /invalid_memory_content/);
  assert.throws(() => validateOperatingMemory({ ...learning, idempotency_key: '' }, identity), /invalid_idempotency_key/);
  assert.throws(() => validateOperatingMemory({ ...learning, status: 'completed' }, identity), /runtime_status_required/);
  assert.throws(() => validateOperatingMemory({ ...learning, kind: 'task_status' }, identity), /runtime_receipt_required/);
});

test('lesson validation bounds each field and derives title, summary and a stable key', () => {
  const row = validateOperatingMemory(lesson, identity);
  assert.equal(row.kind, 'lesson');
  assert.equal(row.status, 'recorded');
  assert.equal(row.context.confidence, 0.8);
  assert.match(row.title, /^When a customer email/);
  assert.match(row.summary, /do quote from the price sheet.*Because three quotes/);
  assert.equal(row.idempotencyKey, validateOperatingMemory(lesson, identity).idempotencyKey);
  assert.notEqual(row.idempotencyKey, validateOperatingMemory({ ...lesson, agent_slug: 'omar' }, identity).idempotencyKey);
  assert.equal(validateOperatingMemory({ ...lesson, confidence: undefined }, identity).context.confidence, 0.5);
  assert.equal(validateOperatingMemory({ ...lesson, title: 'Own title', summary: 'Own summary', idempotency_key: 'mine' }, identity).title, 'Own title');
  for (const [patch, error] of [
    [{ when: '' }, /invalid_lesson_when/], [{ when: 'x'.repeat(301) }, /invalid_lesson_when/],
    [{ do: undefined }, /invalid_lesson_do/], [{ do: 'x'.repeat(501) }, /invalid_lesson_do/],
    [{ because: 7 }, /invalid_lesson_because/], [{ because: 'x'.repeat(501) }, /invalid_lesson_because/],
    [{ confidence: 1.1 }, /invalid_lesson_confidence/], [{ confidence: -0.1 }, /invalid_lesson_confidence/], [{ confidence: '0.5' }, /invalid_lesson_confidence/],
    [{ steps: ['x'] }, /invalid_memory_field/], [{ context: { promoted: true } }, /invalid_memory_field/],
    [{ agent_slug: 'Bad Slug' }, /invalid_agent_slug/],
  ]) assert.throws(() => validateOperatingMemory({ ...lesson, ...patch }, identity), error, JSON.stringify(patch));
});

test('procedure validation bounds steps, check and source', () => {
  const row = validateOperatingMemory(procedure, identity);
  assert.deepEqual(row.context.steps, procedure.steps);
  assert.equal(row.context.source, 'shown');
  assert.equal(validateOperatingMemory({ ...procedure, source: undefined }, identity).context.source, 'learned');
  assert.equal(validateOperatingMemory({ ...procedure, steps: Array.from({ length: 12 }, (_, i) => `step ${i}`) }, identity).context.steps.length, 12);
  for (const [patch, error] of [
    [{ steps: Array.from({ length: 13 }, (_, i) => `step ${i}`) }, /invalid_procedure_steps/], [{ steps: [] }, /invalid_procedure_steps/],
    [{ steps: ['ok', ''] }, /invalid_procedure_steps/], [{ steps: ['x'.repeat(301)] }, /invalid_procedure_steps/], [{ steps: 'one' }, /invalid_procedure_steps/],
    [{ trigger: undefined }, /invalid_procedure_trigger/], [{ check: '' }, /invalid_procedure_check/], [{ check: 'x'.repeat(301) }, /invalid_procedure_check/],
    [{ source: 'dreamed' }, /invalid_procedure_source/],
  ]) assert.throws(() => validateOperatingMemory({ ...procedure, ...patch }, identity), error, JSON.stringify(patch));
});

test('progress and agenda validation bounds keys, arrays, target and status', () => {
  assert.equal(validateOperatingMemory(progress, identity).teamKey, 'q4-outreach');
  const minimal = validateOperatingMemory({ kind: 'progress', agent_slug: 'sofia', task_key: 'a', goal: 'g' }, identity);
  assert.deepEqual([minimal.context.done, minimal.context.next, minimal.context.open_questions, minimal.context.evidence], [[], [], [], []]);
  for (const [patch, error] of [
    [{ task_key: 'bad key!' }, /invalid_progress_task_key/], [{ task_key: 'k'.repeat(121) }, /invalid_progress_task_key/], [{ goal: '' }, /invalid_progress_goal/],
    [{ done: Array(13).fill('x') }, /invalid_progress_done/], [{ next: Array(9).fill('x') }, /invalid_progress_next/],
    [{ open_questions: Array(9).fill('x') }, /invalid_progress_open_questions/], [{ evidence: Array(9).fill('x') }, /invalid_progress_evidence/],
    [{ evidence: ['x'.repeat(301)] }, /invalid_progress_evidence/], [{ next: [3] }, /invalid_progress_next/], [{ supersedes_id: randomUUID() }, /invalid_supersession_kind/],
  ]) assert.throws(() => validateOperatingMemory({ ...progress, ...patch }, identity), error, JSON.stringify(patch));

  const row = validateOperatingMemory(agenda, identity);
  assert.deepEqual(row.context.target, { text: 'qualified leads', value: 120, unit: 'leads' });
  assert.deepEqual(row.context.milestones, [{ text: 'audit list', done: false }, { text: 'launch', done: false, due: '2026-11-15' }]);
  assert.equal(row.status, 'recorded');
  assert.equal(row.context.status, 'active');
  assert.equal(validateOperatingMemory({ ...agenda, status: undefined, target: 'ship it' }, identity).context.target.text, 'ship it');
  for (const [patch, error] of [
    [{ agenda_key: 'Bad Key' }, /invalid_agenda_agenda_key/], [{ outcome: '' }, /invalid_agenda_outcome/], [{ status: 'finished' }, /invalid_agenda_status/],
    [{ target: { text: 'x', value: Infinity } }, /invalid_agenda_target/], [{ target: { text: 'x', extra: 1 } }, /invalid_agenda_target/], [{ target: {} }, /invalid_agenda_target/],
    [{ milestones: Array(13).fill('m') }, /invalid_agenda_milestones/], [{ milestones: [{ text: 'm', due: 'tomorrow' }] }, /invalid_agenda_milestones/],
    [{ task_keys: Array(13).fill('t') }, /invalid_agenda_task_keys/], [{ task_keys: ['bad key'] }, /invalid_agenda_task_keys/],
  ]) assert.throws(() => validateOperatingMemory({ ...agenda, ...patch }, identity), error, JSON.stringify(patch));
});

test('agents cannot use runtime-only kinds and runtime keeps its own kinds', () => {
  assert.throws(() => validateOperatingMemory({ kind: 'user_agenda', agent_slug: 'runtime', title: 't', summary: 's', idempotency_key: 'k' }, identity), /runtime_receipt_required/);
});

test('save lesson and procedure persist structured fields; retry replays', async () => {
  const db = fakeDb();
  const saved = await saveOperatingMemory(db, lesson, identity);
  assert.equal(saved.memory.kind, 'lesson');
  assert.equal(saved.memory.context.because, lesson.because);
  assert.equal(saved.memory.promoted, false);
  assert.deepEqual(saved.memory.confirmedBy, []);
  const replay = await saveOperatingMemory(db, lesson, identity);
  assert.equal(replay.replayed, true);
  assert.equal(db.rows.length, 1);
  const proc = await saveOperatingMemory(db, procedure, identity);
  assert.equal(proc.memory.context.steps.length, 3);
  assert.equal(db.rows.length, 2);
});

test('progress upserts by task_key: latest replaces previous, history kept, retries replay', async () => {
  const db = fakeDb();
  const first = await saveOperatingMemory(db, { ...progress, idempotency_key: 'p1' }, identity);
  assert.equal(first.memory.supersedesId, null);
  const second = await saveOperatingMemory(db, { ...progress, agent_slug: 'omar', done: ['25 contacted'], next: ['finish'], idempotency_key: 'p2' }, identity);
  assert.equal(second.memory.supersedesId, first.memory.id);
  const other = await saveOperatingMemory(db, { ...progress, task_key: 'other-task', idempotency_key: 'p3' }, identity);
  assert.equal(other.memory.supersedesId, null);
  const third = await saveOperatingMemory(db, { ...progress, done: ['30 contacted'], idempotency_key: 'p4' }, identity);
  assert.equal(third.memory.supersedesId, second.memory.id);
  const retry = await saveOperatingMemory(db, { ...progress, agent_slug: 'omar', done: ['25 contacted'], next: ['finish'], idempotency_key: 'p2' }, identity);
  assert.equal(retry.replayed, true);
  assert.equal(retry.memory.id, second.memory.id);
  assert.equal(db.rows.length, 4);
  await assert.rejects(saveOperatingMemory(db, { ...progress, goal: 'different', idempotency_key: 'p2' }, identity), /memory_idempotency_conflict/);
  const brief = await recallOperatingMemory(db, orgId, { mode: 'brief' });
  assert.deepEqual(brief.items.filter(i => i.kind === 'progress').map(i => i.id).sort(), [third.memory.id, other.memory.id].sort());
});

test('agenda upserts by agenda_key and carries status changes', async () => {
  const db = fakeDb();
  const first = await saveOperatingMemory(db, agenda, identity);
  const done = await saveOperatingMemory(db, { ...agenda, status: 'done' }, identity);
  assert.equal(done.memory.supersedesId, first.memory.id);
  assert.equal(done.memory.context.status, 'done');
  assert.equal(done.memory.status, 'recorded');
  const brief = await recallOperatingMemory(db, orgId, { mode: 'brief' });
  assert.equal(brief.items.filter(i => i.kind === 'agenda').length, 1);
  assert.match(brief.items[0].gist, /\[done\]/);
});

test('a lesson with supersedes_id retires the old one, even across employees', async () => {
  const db = fakeDb();
  const old = await saveOperatingMemory(db, lesson, identity);
  const fresh = await saveOperatingMemory(db, { ...lesson, agent_slug: 'omar', do: 'ask finance for a quote', supersedes_id: old.memory.id }, identity);
  assert.equal(fresh.memory.supersedesId, old.memory.id);
  const brief = await recallOperatingMemory(db, orgId, {});
  assert.deepEqual(brief.items.map(i => i.id), [fresh.memory.id]);
  await assert.rejects(saveOperatingMemory(db, { ...lesson, agent_slug: 'zed', do: 'third', supersedes_id: old.memory.id }, identity), /superseded_memory_already_replaced/);
  await assert.rejects(saveOperatingMemory(db, { ...lesson, do: 'x', supersedes_id: randomUUID() }, identity), /superseded_memory_unavailable/);
  await assert.rejects(saveOperatingMemory(db, { ...procedure, supersedes_id: old.memory.id }, identity), /superseded_memory_unavailable/);
});

test('confirm records the employee and promotes on the second confirmation', async () => {
  const db = fakeDb();
  const { memory } = await saveOperatingMemory(db, lesson, identity);
  const first = await confirmOperatingMemory(db, { id: memory.id, agent_slug: 'omar' }, identity);
  assert.equal(first.promoted, false);
  assert.equal(first.confirmations, 1);
  assert.deepEqual(first.memory.confirmedBy.map(c => c.agentSlug), ['omar']);
  assert.ok(!JSON.stringify(first).includes(userId), 'server-bound user ids stay out of responses');
  assert.equal(db.rows[0].context.confirmations[0].user_id, userId);
  const second = await confirmOperatingMemory(db, { id: memory.id, agent_slug: 'zed' }, identity);
  assert.equal(second.promoted, true);
  assert.equal(second.memory.promoted, true);
  assert.deepEqual(second.memory.confirmedBy.map(c => c.agentSlug), ['omar', 'zed']);
  assert.ok(db.rows[0].context.promoted_at);
});

test('the same employee confirming twice also promotes; an idempotency_key makes a retry a no-op', async () => {
  const db = fakeDb();
  const { memory } = await saveOperatingMemory(db, procedure, identity);
  await confirmOperatingMemory(db, { id: memory.id, agent_slug: 'omar', idempotency_key: 'c1' }, identity);
  const retry = await confirmOperatingMemory(db, { id: memory.id, agent_slug: 'omar', idempotency_key: 'c1' }, identity);
  assert.equal(retry.replayed, true);
  assert.equal(retry.promoted, false);
  assert.equal(retry.confirmations, 1);
  const again = await confirmOperatingMemory(db, { id: memory.id, agent_slug: 'omar', idempotency_key: 'c2' }, identity);
  assert.equal(again.promoted, true);
});

test('confirm rejects unknown, foreign-org, wrong-kind, runtime-private and superseded memories', async () => {
  const db = fakeDb();
  const old = (await saveOperatingMemory(db, lesson, identity)).memory;
  const learning = (await saveOperatingMemory(db, { kind: 'learning', agent_slug: 'sofia', title: 't', summary: 's', idempotency_key: 'l1' }, identity)).memory;
  db.rows.push({ id: randomUUID(), org_id: orgId, kind: 'uncertainty', context: {}, agent_slug: 'runtime', title: 't', summary: 's', created_at: new Date() });
  await saveOperatingMemory(db, { ...lesson, do: 'new way', supersedes_id: old.id }, identity);
  const check = (input, identityOverride = identity) => confirmOperatingMemory(db, { agent_slug: 'omar', ...input }, identityOverride);
  await assert.rejects(check({ id: randomUUID() }), error => error.message === 'memory_not_found' && error.status === 404);
  await assert.rejects(check({ id: old.id }, { orgId: '11111111-1111-4111-8111-111111111111', userId }), /memory_not_found/);
  await assert.rejects(check({ id: db.rows.find(r => r.kind === 'uncertainty').id }), /memory_not_found/);
  await assert.rejects(check({ id: learning.id }), /invalid_confirm_kind/);
  await assert.rejects(check({ id: old.id }), /superseded_memory_unavailable/);
  await assert.rejects(check({ id: 'nope' }), /invalid_memory_id/);
  await assert.rejects(check({ id: learning.id, agent_slug: 'Bad Slug' }), /invalid_agent_slug/);
  await assert.rejects(check({ id: learning.id, idempotency_key: '' }), /invalid_idempotency_key/);
  await assert.rejects(confirmOperatingMemory(db, { id: learning.id, agent_slug: 'omar' }, { orgId: 'x', userId }), /invalid_identity/);
});

test('promoted:true filters recall and brief to promoted lessons and procedures', async () => {
  const db = fakeDb();
  const a = (await saveOperatingMemory(db, lesson, identity)).memory;
  await saveOperatingMemory(db, procedure, identity);
  await confirmOperatingMemory(db, { id: a.id, agent_slug: 'omar' }, identity);
  await confirmOperatingMemory(db, { id: a.id, agent_slug: 'zed' }, identity);
  const brief = await recallOperatingMemory(db, orgId, { promoted: true });
  assert.deepEqual(brief.items.map(i => [i.id, i.promoted]), [[a.id, true]]);
  await recallOperatingMemory(db, orgId, { promoted: true, kind: 'lesson' });
  assert.match(db.sql.at(-1), /m\.kind IN \('lesson', 'procedure'\) AND m\.context->>'promoted' = 'true'/);
  assert.throws(() => validateOperatingMemoryFilter({ promoted: 'yes' }), /invalid_promoted/);
});

test('recall by id and by query returns full records for the new kinds', async () => {
  const calls = [];
  const db = { $queryRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return []; } };
  await recallOperatingMemory(db, orgId, { id: randomUUID() });
  assert.match(calls[0].sql, /m\.id = \$2::uuid/);
  await recallOperatingMemory(db, orgId, { kind: 'procedure', query: 'invoice' });
  assert.ok(calls[1].sql.includes('to_tsquery'));
  assert.ok(calls[1].args.includes('procedure'));
  const full = await recallOperatingMemory({ $queryRawUnsafe: async () => [{ id: randomUUID(), kind: 'lesson', status: 'recorded', agent_slug: 'sofia', title: 't', summary: 's', context: { ...lesson, confirmations: [{ agent_slug: 'omar', user_id: userId, at: 'now' }] }, created_at: new Date() }] }, orgId, { kind: 'lesson' });
  assert.equal(full.memories[0].context.when, lesson.when);
  assert.ok(!JSON.stringify(full).includes(userId));
});

test('bare recall is the brief; any legacy filter or mode:full keeps the full listing', () => {
  assert.equal(validateOperatingMemoryFilter({}).brief, true);
  assert.equal(validateOperatingMemoryFilter({}).limit, 8);
  assert.equal(validateOperatingMemoryFilter({ mode: 'brief', agent_slug: 'sofia', context: 'pricing', hints: ['Acme'] }).brief, true);
  for (const legacy of [{ query: 'x' }, { kind: 'learning' }, { agent_slug: 'sofia' }, { status: 'recorded' }, { run_id: randomUUID() }, { mode: 'full' }, { id: randomUUID() }]) {
    assert.equal(validateOperatingMemoryFilter(legacy).brief, false, JSON.stringify(legacy));
  }
  assert.equal(validateOperatingMemoryFilter({ kind: 'learning' }).limit, 10);
  assert.throws(() => validateOperatingMemoryFilter({ mode: 'brief', kind: 'lesson' }), /invalid_brief_filter/);
  assert.throws(() => validateOperatingMemoryFilter({ mode: 'tiny' }), /invalid_recall_mode/);
  assert.throws(() => validateOperatingMemoryFilter({ limit: 21 }), /invalid_limit/);
  assert.equal(validateOperatingMemoryFilter({ limit: 20 }).limit, 20);
  assert.throws(() => validateOperatingMemoryFilter({ hints: Array(9).fill('a') }), /invalid_recall_hints/);
  assert.throws(() => validateOperatingMemoryFilter({ hints: [''] }), /invalid_recall_hints/);
  assert.throws(() => validateOperatingMemoryFilter({ context: 'x'.repeat(2001) }), /invalid_recall_context/);
  assert.throws(() => validateOperatingMemoryFilter({ context: { a: 1 } }), /invalid_recall_context/);
});

const DAY = 86400000;
const row = (over) => ({ id: randomUUID(), kind: 'learning', agent_slug: 'sofia', title: 'Note', summary: 'Plain note.', context: {}, created_at: new Date(), ...over });

test('brief ranks by context relevance, recency, same agent and entity hints', () => {
  const now = Date.now();
  const rows = [
    row({ id: 'recent-unrelated', title: 'Weather chatter', summary: 'Sunny.', created_at: new Date(now - 1000) }),
    row({ id: 'relevant-old', title: 'Invoice rounding', summary: 'Round invoice totals to cents before export.', created_at: new Date(now - 20 * DAY) }),
    row({ id: 'same-agent', agent_slug: 'omar', title: 'Standup', summary: 'Daily standup notes.', created_at: new Date(now - 2 * DAY) }),
    row({ id: 'hinted', title: 'Acme onboarding', summary: 'Acme prefers email.', created_at: new Date(now - 2 * DAY) }),
  ];
  const ids = (options) => buildBrief(rows, { limit: 4, now, ...options }).items.map(i => i.id);
  assert.equal(ids({ context: 'export the invoice totals' })[0], 'relevant-old');
  assert.equal(ids({})[0], 'recent-unrelated');
  assert.equal(ids({ agentSlug: 'omar' })[0], 'same-agent');
  assert.equal(ids({ hints: ['acme'] })[0], 'hinted');
  assert.equal(ids({ hints: ['Acme'] }).length, 4);
  const [item] = buildBrief([rows[1]], { limit: 1, now }).items;
  assert.deepEqual(Object.keys(item), ['id', 'kind', 'title', 'gist', 'author', 'updated_at']);
  assert.match(item.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('brief honours limit and stays near 2k characters with the longest fields', () => {
  const now = Date.now();
  const rows = Array.from({ length: 30 }, (_, i) => row({
    kind: 'lesson', agent_slug: 'a'.repeat(100), title: `When ${'x'.repeat(170)}`,
    summary: 'y'.repeat(2000), context: { when: 'w'.repeat(300), do: 'd'.repeat(500), because: 'b'.repeat(500) }, created_at: new Date(now - i * 1000),
  }));
  assert.equal(buildBrief(rows, { limit: 8, now }).items.length <= 8, true);
  const wide = buildBrief(rows, { limit: 20, now });
  assert.ok(JSON.stringify(wide.items).length <= 2000);
  assert.equal(wide.truncated, true);
  assert.ok(wide.items.length >= 1);
  const typical = Array.from({ length: 8 }, (_, i) => row({ title: `Learning number ${i} about invoices`, summary: 'Short typical summary about invoice exports and rounding in totals.', created_at: new Date(now - i * DAY) }));
  const brief = buildBrief(typical, { limit: 8, now });
  assert.equal(brief.items.length, 8);
  assert.ok(JSON.stringify(brief.items).length < 2300, String(JSON.stringify(brief.items).length));
});

test('brief recall queries only shared kinds, excludes superseded memories, and widens candidates by context terms', async () => {
  const db = fakeDb();
  await saveOperatingMemory(db, lesson, identity);
  db.rows.push({ id: randomUUID(), org_id: orgId, kind: 'uncertainty', agent_slug: 'runtime', title: 'secret', summary: 's', context: {}, created_at: new Date() });
  const result = await recallOperatingMemory(db, orgId, { mode: 'brief', context: 'pricing customer email', hints: ['Acme'], agent_slug: 'sofia' });
  assert.equal(result.mode, 'brief');
  assert.equal(result.count, 1);
  assert.equal(result.items[0].kind, 'lesson');
  assert.equal(result.items[0].author, 'sofia');
  assert.ok(!('memories' in result));
  for (const sql of db.sql.filter(s => s.includes('hyper_agent_operating_memories m'))) {
    assert.match(sql, /m\.kind NOT IN \('user_agenda', 'uncertainty'\)/);
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /m\.org_id = \$1::uuid/);
  }
  assert.ok(db.sql.some(s => s.includes('to_tsquery')));
  assert.equal(tokenize('The Acme pricing, pricing!').join(','), 'acme,pricing');
});

test('progress saved without a key: identical retry replays, but returning to an earlier state is a new revision', async () => {
  const db = fakeDb();
  const a = await saveOperatingMemory(db, progress, identity);
  const retry = await saveOperatingMemory(db, progress, identity);
  assert.equal(retry.replayed, true);
  assert.equal(retry.memory.id, a.memory.id);
  const b = await saveOperatingMemory(db, { ...progress, done: ['20 contacted'] }, identity);
  assert.equal(b.memory.supersedesId, a.memory.id);
  const again = await saveOperatingMemory(db, progress, identity);
  assert.equal(again.replayed, false);
  assert.equal(again.memory.supersedesId, b.memory.id);
  assert.equal(db.rows.length, 3);
});

test('migration is additive and allows exactly the kinds the module accepts', async () => {
  const { readFileSync } = await import('node:fs');
  const { OPERATING_MEMORY_KINDS } = await import('../../src/hyperagents/operating-memory.js');
  const sql = readFileSync(new URL('../../prisma/migrations/20261029140000_operating_memory_team_kinds/migration.sql', import.meta.url), 'utf8');
  const listed = [...sql.match(/CHECK \("kind" IN \(([^)]*)\)\)/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...listed].sort(), [...OPERATING_MEMORY_KINDS].sort());
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE|UPDATE\s+"hivemind"|ADD COLUMN/i);
  assert.equal([...sql.matchAll(/CREATE INDEX/g)].length, [...sql.matchAll(/CREATE INDEX IF NOT EXISTS/g)].length);
});
