import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';

const secret = 'runner-service-secret-that-is-at-least-32-bytes';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy', sub: userId,
    org_id: orgId, profile: 'hivemind-chat', iat: now, exp: now + 30, jti: crypto.randomUUID(), ...overrides };
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

// Minimal stateful database: stores inserted rows and answers by-id and brief reads.
function routeDb() {
  const rows = [];
  const seen = [];
  const db = {
    rows, seen,
    userOrganization: { findUnique: async () => ({ isActive: true }) },
    project: { upsert: async () => ({ id: 'b79673b4-4578-4fc2-8144-05056983f4e1', name: 'Hyper Agents', policy: 'private' }) },
    projectMember: { upsert: async () => ({}) },
    $transaction: async fn => fn(db),
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async (sql, ...args) => {
      seen.push({ sql, args });
      if (sql.includes('INSERT INTO')) {
        const row = { id: crypto.randomUUID(), org_id: args[0], idempotency_key: args[2], kind: args[3], status: args[4], agent_slug: args[5], author_user_id: args[6], title: args[10], summary: args[11], context: JSON.parse(args[12]), created_at: new Date() };
        rows.push(row);
        return [row];
      }
      if (sql.includes('AS superseded')) return rows.filter(r => r.id === args[0]).map(r => ({ ...r, superseded: false }));
      if (sql.startsWith('\n      UPDATE')) { rows[0].context = JSON.parse(args[0]); return [rows[0]]; }
      if (sql.includes('LIMIT 200')) return rows;
      return [];
    },
  };
  return db;
}

async function call(db, body, claims = {}) {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token(claims)}` } }, res,
    pathname: '/internal/v1/harness-chat/core/v1/hyperagents/operating-memory', prisma: db,
    parseBody: async () => body, jsonResponse: (r, b, status = 200) => Object.assign(r, { body: b, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, fetchImpl: fetch,
  });
  return res;
}

test('route: save lesson, brief recall, confirm twice promotes; identity comes from the token', async () => {
  const db = routeDb();
  const saved = await call(db, { action: 'save', kind: 'lesson', agent_slug: 'sofia', when: 'pricing question', do: 'use the sheet', because: 'it is approved', confidence: 0.9 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.memory.kind, 'lesson');
  assert.equal(db.rows[0].author_user_id, userId);
  assert.equal(db.rows[0].org_id, orgId);
  const brief = await call(db, { action: 'recall', mode: 'brief', context: 'customer pricing', hints: ['Acme'], limit: 5 });
  assert.equal(brief.status, 200);
  assert.deepEqual(Object.keys(brief.body.items[0]), ['id', 'kind', 'title', 'gist', 'author', 'updated_at']);
  const bare = await call(db, { action: 'recall' });
  assert.equal(bare.body.mode, 'brief');
  const first = await call(db, { action: 'confirm', id: saved.body.memory.id, agent_slug: 'omar' });
  assert.equal(first.status, 200);
  assert.equal(first.body.promoted, false);
  const second = await call(db, { action: 'confirm', id: saved.body.memory.id, agent_slug: 'zed' });
  assert.equal(second.body.promoted, true);
  assert.equal(second.body.memory.promoted, true);
  assert.equal(JSON.stringify(second.body).includes(userId), false);
});

test('route: request contracts reject cross-kind fields, unknown keys and tenant overrides', async () => {
  const db = routeDb();
  const cases = [
    [{ action: 'save', kind: 'learning', agent_slug: 'sofia', title: 't', summary: 's', idempotency_key: 'k', when: 'x' }, 400, 'invalid_operating_memory_input'],
    [{ action: 'save', kind: 'lesson', agent_slug: 'sofia', when: 'a', do: 'b', because: 'c', steps: ['x'] }, 400, 'invalid_memory_field'],
    [{ action: 'save', kind: 'lesson', agent_slug: 'sofia', when: 'a', do: 'b', because: 'c', org_id: orgId }, 400, 'invalid_operating_memory_input'],
    [{ action: 'save', kind: 'learning', agent_slug: 'sofia', title: 't', summary: 's', idempotency_key: 'k', status: 'recorded' }, 400, 'invalid_operating_memory_input'],
    [{ action: 'save', kind: 'lesson', agent_slug: 'sofia', when: 'a', do: 'b' }, 400, 'invalid_lesson_because'],
    [{ action: 'save', kind: 'progress', agent_slug: 'sofia', task_key: 'bad key', goal: 'g' }, 400, 'invalid_progress_task_key'],
    [{ action: 'confirm', id: crypto.randomUUID(), agent_slug: 'sofia', org_id: orgId }, 400, 'invalid_operating_memory_input'],
    [{ action: 'confirm', id: crypto.randomUUID(), agent_slug: 'sofia' }, 404, 'memory_not_found'],
    [{ action: 'confirm', id: 'x', agent_slug: 'sofia' }, 400, 'invalid_memory_id'],
    [{ action: 'recall', mode: 'brief', kind: 'lesson' }, 400, 'invalid_brief_filter'],
    [{ action: 'recall', hints: 'Acme' }, 400, 'invalid_recall_hints'],
    [{ action: 'delete', id: crypto.randomUUID() }, 400, 'invalid_operating_memory_input'],
  ];
  for (const [body, status, error] of cases) {
    const res = await call(db, body);
    assert.deepEqual([res.status, res.body.error], [status, error], JSON.stringify(body));
  }
  assert.equal(db.rows.length, 0);
});

test('route: agenda accepts status only for agenda; legacy save and recall keep their shapes', async () => {
  const db = routeDb();
  const agenda = await call(db, { action: 'save', kind: 'agenda', agent_slug: 'omar', agenda_key: 'q4', outcome: 'Grow', target: { text: 'leads', value: 5 }, status: 'paused' });
  assert.equal(agenda.status, 200);
  assert.equal(agenda.body.memory.context.status, 'paused');
  const legacy = await call(db, { action: 'save', kind: 'handoff', agent_slug: 'sofia', title: 'Hand', summary: 'Over to omar', idempotency_key: 'h1' });
  assert.equal(legacy.status, 200);
  assert.deepEqual(Object.keys(legacy.body.memory).sort(), ['agentSlug', 'context', 'createdAt', 'id', 'kind', 'project', 'roomId', 'runId', 'status', 'summary', 'supersedesId', 'title', 'triggerId'].sort());
  const listed = await call(db, { action: 'recall', kind: 'handoff', limit: 3 });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.memories));
  assert.equal(listed.body.mode, undefined);
});
