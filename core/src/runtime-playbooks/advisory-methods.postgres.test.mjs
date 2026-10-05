/** Disposable database only: never point this at a platform database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { proposeAdvisoryMethod, readAdvisoryMethods, decideAdvisoryMethod } from './advisory-methods.js';
const url = process.env.ADVISORY_TEST_DATABASE_URL;
const allowed = url && /^advisory_test(?:_[a-z0-9]+)?$/.test(new URL(url).pathname.slice(1));
test('disposable PostgreSQL proves persistence, immutable versions, approval and concurrency', { skip: !url }, async () => {
  assert.ok(allowed, 'Use only a disposable database named advisory_test or advisory_test_<suffix>');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  const orgId = randomUUID(), userId = randomUUID(), otherOrg = randomUUID();
  const who = { orgId, userId, kind: 'human-session' };
  const adapter = connection => ({
    userOrganization: { findUnique: async ({ where }) => {
      const { userId, orgId } = where.userId_orgId;
      return (await connection.query('SELECT role,"isActive" FROM hivemind.test_advisory_members WHERE user_id=$1 AND org_id=$2', [userId, orgId])).rows[0] || null;
    } },
    $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
    $transaction: async fn => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(adapter(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS hivemind');
    await pool.query('CREATE TABLE hivemind.test_advisory_members (user_id uuid,org_id uuid,role text,"isActive" boolean)');
    await pool.query('INSERT INTO hivemind.test_advisory_members VALUES ($1,$2,\'admin\',true),($1,$3,\'admin\',true)', [userId, orgId, otherOrg]);
    await pool.query(await readFile(new URL('../../prisma/migrations/20261004140000_advisory_playbook_revisions/migration.sql', import.meta.url), 'utf8'));
    const db = adapter(pool);
    const input = { method_id: 'company-disposable-verification', prior_version: 0, rationale: 'Harmless test fixture only', evidence_refs: ['test:fixture'],
      body: { title: 'Disposable test method', description: 'Test persistence only', content: 'Label unsupported assumptions.', domains: ['research'], intents: [], parentGlobalIds: [], limitations: 'Not a real company publication' } };
    const first = await proposeAdvisoryMethod(db, who, input);
    assert.equal((await proposeAdvisoryMethod(db, who, input)).id, first.id);
    assert.deepEqual(await readAdvisoryMethods(db, who), []);
    await assert.rejects(decideAdvisoryMethod(db, { ...who, kind: 'runner-service' }, first.id, first.content_hash, true), /publication_authority/);
    await assert.rejects(decideAdvisoryMethod(db, who, first.id, 'changed', true), /hash_mismatch/);
    assert.equal(await readAdvisoryMethods(db, { ...who, orgId: otherOrg }, first.id), null);
    await decideAdvisoryMethod(db, who, first.id, first.content_hash, true);
    const contender = await proposeAdvisoryMethod(db, who, { ...input, prior_version: 0, rationale: 'Stale proposal' });
    await assert.rejects(decideAdvisoryMethod(db, who, contender.id, contender.content_hash, true), /prior_version_conflict/);
    const second = await proposeAdvisoryMethod(db, who, { ...input, prior_version: 1, body: { ...input.body, content: 'Label assumptions and evidence.' } });
    await decideAdvisoryMethod(db, who, second.id, second.content_hash, true);
    assert.equal((await readAdvisoryMethods(adapter(pool), who))[0].version, 2);
    assert.equal((await readAdvisoryMethods(db, who, first.id)).body.content, input.body.content);
    await assert.rejects(pool.query('UPDATE hivemind.advisory_playbook_revisions SET body=\'{}\' WHERE id=$1', [first.id]), /revision_immutable/);
    const proposals = await Promise.all(['A', 'B'].map(rationale => proposeAdvisoryMethod(db, who, { ...input, prior_version: 2, rationale })));
    const results = await Promise.allSettled(proposals.map(row => decideAdvisoryMethod(db, who, row.id, row.content_hash, true)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && /prior_version_conflict/.test(r.reason.message)).length, 1);
    const declined = await proposeAdvisoryMethod(db, who, { ...input, method_id: 'company-disposable-declined' });
    await decideAdvisoryMethod(db, who, declined.id, declined.content_hash, false);
    assert.equal((await readAdvisoryMethods(db, who)).some(row => row.method_id === declined.method_id), false);
  } finally { await pool.end(); }
});
