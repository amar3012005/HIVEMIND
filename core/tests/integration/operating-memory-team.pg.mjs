// Runs the real operating-memory module against a throwaway Postgres that has the
// production table schema plus migration 20261029140000. Skips without OM_PG_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { saveOperatingMemory, recallOperatingMemory, confirmOperatingMemory } from '../../src/hyperagents/operating-memory.js';

const url = process.env.OM_PG_URL;
const skip = url ? false : 'OM_PG_URL not set';
const pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
const orgId = randomUUID();
const otherOrg = randomUUID();
const userId = randomUUID();
const projectIds = new Map();

function adapter(client) {
  const db = {
    $queryRawUnsafe: async (sql, ...args) => (await client.query(sql, args)).rows,
    $executeRawUnsafe: async (sql, ...args) => (await client.query(sql, args)).rowCount,
    project: { upsert: async ({ where }) => {
      const org = where.orgId_slug.orgId;
      if (!projectIds.has(org)) { const id = randomUUID(); await pool.query('INSERT INTO hivemind.projects(id, org_id, slug) VALUES ($1,$2,$3)', [id, org, 'hyper-agents']); projectIds.set(org, id); }
      return { id: projectIds.get(org), name: 'Hyper Agents', policy: 'private' };
    } },
    projectMember: { upsert: async () => ({}) },
    $transaction: async fn => {
      const tx = await pool.connect();
      try { await tx.query('BEGIN'); const out = await fn(adapter(tx)); await tx.query('COMMIT'); return out; }
      catch (error) { await tx.query('ROLLBACK'); throw error; }
      finally { tx.release(); }
    },
  };
  return db;
}
const db = pool ? adapter(pool) : null;
const id = { orgId, userId };

test('pg: legacy kinds save, replay and recall keep their shapes', { skip }, async () => {
  const note = { kind: 'learning', agent_slug: 'sofia', title: 'Use UTC', summary: 'Stored in UTC.', idempotency_key: 'legacy-1' };
  const saved = await saveOperatingMemory(db, note, id);
  assert.equal((await saveOperatingMemory(db, note, id)).replayed, true);
  const listed = await recallOperatingMemory(db, orgId, { kind: 'learning', query: 'UTC' });
  assert.deepEqual(Object.keys(listed), ['ok', 'project', 'count', 'memories']);
  assert.equal(listed.memories[0].id, saved.memory.id);
  const successor = await saveOperatingMemory(db, { ...note, summary: 'Always UTC.', idempotency_key: 'legacy-2', supersedes_id: saved.memory.id }, id);
  assert.equal(successor.memory.supersedesId, saved.memory.id);
  assert.equal((await recallOperatingMemory(db, orgId, { kind: 'learning' })).count, 1);
});

test('pg: concurrent progress upserts never fork the head', { skip }, async () => {
  const save = n => saveOperatingMemory(db, { kind: 'progress', agent_slug: `emp-${n}`, task_key: 'race', goal: 'g', done: [`step ${n}`] }, id);
  await Promise.all(Array.from({ length: 6 }, (_, n) => save(n)));
  const { rows } = await pool.query("SELECT m.id FROM hivemind.hyper_agent_operating_memories m WHERE org_id=$1 AND kind='progress' AND context->>'task_key'='race' AND NOT EXISTS (SELECT 1 FROM hivemind.hyper_agent_operating_memories s WHERE s.context->>'supersedesId'=m.id::text)", [orgId]);
  assert.equal(rows.length, 1);
  const total = await pool.query("SELECT count(*)::int AS n FROM hivemind.hyper_agent_operating_memories WHERE org_id=$1 AND context->>'task_key'='race'", [orgId]);
  assert.equal(total.rows[0].n, 6);
});

test('pg: progress and agenda upsert, replay and A-B-A', { skip }, async () => {
  const p = { kind: 'progress', agent_slug: 'sofia', task_key: 'q4', goal: 'Contact leads', next: ['more'] };
  const a = await saveOperatingMemory(db, p, id);
  assert.equal((await saveOperatingMemory(db, p, id)).replayed, true);
  const b = await saveOperatingMemory(db, { ...p, agent_slug: 'omar', done: ['10'] }, id);
  assert.equal(b.memory.supersedesId, a.memory.id);
  const again = await saveOperatingMemory(db, p, id);
  assert.equal(again.replayed, false);
  assert.equal(again.memory.supersedesId, b.memory.id);
  const ag = { kind: 'agenda', agent_slug: 'omar', agenda_key: 'pipeline', outcome: 'Grow', target: { text: 'leads', value: 120, unit: 'n' }, milestones: ['x'] };
  const first = await saveOperatingMemory(db, ag, id);
  const done = await saveOperatingMemory(db, { ...ag, status: 'done' }, id);
  assert.equal(done.memory.supersedesId, first.memory.id);
  const brief = await recallOperatingMemory(db, orgId, { mode: 'brief', limit: 20 });
  assert.equal(brief.items.filter(i => i.kind === 'progress' && /Contact leads/.test(i.title)).length, 1);
  assert.equal(brief.items.filter(i => i.kind === 'agenda').length, 1);
});

test('pg: brief survives quotes, colons and tsquery operators in context and hints', { skip }, async () => {
  const l = await saveOperatingMemory(db, { kind: 'lesson', agent_slug: 'sofia', when: 'Acme asks for the pricing sheet', do: 'send sheet v3', because: 'approved by finance' }, id);
  for (const context of [`it's "Acme" pricing: now & later | never ! (really) <-> a:*b \\ ';--`, "'", '&|!():*<>', 'ünïcödé 価格 pricing', '   ', 'a'.repeat(2000)]) {
    const r = await recallOperatingMemory(db, orgId, { mode: 'brief', context, hints: [`O'Reilly & Sons: "x"`, '(a|b)!'] });
    assert.equal(r.ok, true, context.slice(0, 20));
  }
  const hit = await recallOperatingMemory(db, orgId, { mode: 'brief', context: 'what is the Acme pricing sheet?', hints: ['Acme'], agent_slug: 'sofia' });
  assert.equal(hit.items[0].id, l.memory.id);
  assert.ok(JSON.stringify(hit.items).length <= 2000);
  const bare = await recallOperatingMemory(db, orgId, {});
  assert.equal(bare.mode, 'brief');
  const none = await recallOperatingMemory(db, otherOrg, {});
  assert.equal(none.count, 0);
});

test('pg: confirm, promotion, supersede and promoted filter', { skip }, async () => {
  const l = (await saveOperatingMemory(db, { kind: 'lesson', agent_slug: 'sofia', when: 'invoice total looks off', do: 'recompute from line items', because: 'rounding drift' }, id)).memory;
  const c1 = await confirmOperatingMemory(db, { id: l.id, agent_slug: 'omar', idempotency_key: 'k1' }, id);
  assert.deepEqual([c1.promoted, c1.confirmations], [false, 1]);
  assert.equal((await confirmOperatingMemory(db, { id: l.id, agent_slug: 'omar', idempotency_key: 'k1' }, id)).replayed, true);
  const c2 = await confirmOperatingMemory(db, { id: l.id, agent_slug: 'zed' }, id);
  assert.deepEqual([c2.promoted, c2.confirmations], [true, 2]);
  const promoted = await recallOperatingMemory(db, orgId, { promoted: true });
  assert.deepEqual(promoted.items.map(i => i.id), [l.id]);
  assert.equal((await recallOperatingMemory(db, orgId, { promoted: true, kind: 'lesson' })).memories.length, 1);
  assert.equal((await recallOperatingMemory(db, orgId, { id: l.id })).memories[0].promoted, true);
  await assert.rejects(confirmOperatingMemory(db, { id: l.id, agent_slug: 'omar' }, { orgId: otherOrg, userId }), /memory_not_found/);
  const next = await saveOperatingMemory(db, { kind: 'lesson', agent_slug: 'zed', when: 'invoice total looks off', do: 'recompute and compare to ledger', because: 'better', supersedes_id: l.id }, id);
  assert.equal(next.memory.supersedesId, l.id);
  await assert.rejects(confirmOperatingMemory(db, { id: l.id, agent_slug: 'omar' }, id), /superseded_memory_unavailable/);
  assert.equal((await recallOperatingMemory(db, orgId, { promoted: true })).count, 0);
  assert.ok(!(await recallOperatingMemory(db, orgId, { mode: 'brief', limit: 20 })).items.some(i => i.id === l.id));
});

test('pg: CHECK still rejects unknown kinds and runtime-private kinds stay out of the brief', { skip }, async () => {
  await assert.rejects(pool.query("INSERT INTO hivemind.hyper_agent_operating_memories (org_id,project_id,idempotency_key,kind,status,agent_slug,author_user_id,title,summary) VALUES ($1,$2,'bad','nonsense','recorded','x',$3,'t','s')", [orgId, projectIds.get(orgId), userId]), /kind_check/);
  await pool.query("INSERT INTO hivemind.hyper_agent_operating_memories (org_id,project_id,idempotency_key,kind,status,agent_slug,author_user_id,title,summary,context) VALUES ($1,$2,'rt','uncertainty','recorded','runtime',$3,'secret','s','{\"sessionId\":\"session-x\"}')", [orgId, projectIds.get(orgId), userId]);
  assert.ok(!(await recallOperatingMemory(db, orgId, { mode: 'brief', limit: 20 })).items.some(i => i.title === 'secret'));
});

test.after(async () => { await pool?.end(); });
