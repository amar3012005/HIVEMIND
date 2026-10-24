import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Static checks on the staged (unapplied) runner-table RLS SQL. They do not execute
// SQL; the two-organization check is verify.sql, run against a real database.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/staged/20261024_core_rls_runner_tables');
const read = (name) => readFileSync(path.join(dir, name), 'utf8');
const stripComments = (sql) => sql.replace(/^\s*--.*$/gm, '');

const GROUPS = {
  'up.sql': { down: 'down.sql', tables: ['memories', 'relationships', 'source_metadata', 'usage_events', 'projects',
    'project_members', 'user_organizations', 'organizations', 'users', 'hq_workflows'] },
  'up-b.sql': { down: 'down-b.sql', tables: ['harness_dream_due'] },
};

for (const [upFile, { down, tables }] of Object.entries(GROUPS)) {
  const up = stripComments(read(upFile));
  const downSql = stripComments(read(down));

  test(`${upFile}: every table is ENABLEd, FORCEd and has a role-scoped policy`, () => {
    for (const table of tables) {
      assert.match(up, new RegExp(`ALTER TABLE hivemind\\.${table}\\s+ENABLE ROW LEVEL SECURITY`), `${table} enable`);
      assert.match(up, new RegExp(`ALTER TABLE hivemind\\.${table}\\s+FORCE\\s+ROW LEVEL SECURITY`), `${table} force`);
      assert.match(up, new RegExp(`CREATE POLICY \\w+ ON hivemind\\.${table}\\b[\\s\\S]*?TO hivemind_\\w+`), `${table} policy`);
    }
  });

  test(`${down} reverses every change in ${upFile}`, () => {
    for (const table of tables) {
      assert.match(downSql, new RegExp(`ALTER TABLE hivemind\\.${table}\\s+NO FORCE ROW LEVEL SECURITY`), `${table} no force`);
      assert.match(downSql, new RegExp(`ALTER TABLE hivemind\\.${table}\\s+DISABLE\\s+ROW LEVEL SECURITY`), `${table} disable`);
    }
    for (const [, name, table] of up.matchAll(/CREATE POLICY (\w+) ON hivemind\.(\w+)/g)) {
      assert.match(downSql, new RegExp(`DROP POLICY IF EXISTS ${name}\\s+ON hivemind\\.${table}\\b`), `${name} dropped`);
    }
  });

  test(`${upFile}: policies fail closed and read only the hivemind_* settings`, () => {
    const settings = [...up.matchAll(/current_setting\('([^']+)'(, true)?\)/g)];
    assert.ok(settings.length > 0);
    for (const [, name, missingOk] of settings) {
      assert.ok(missingOk, `${name} must use missing_ok = true`);
      assert.match(name, /^app\.hivemind_(org_id|user_id|dream_scheduler)$/);
    }
    for (const [, name] of up.matchAll(/NULLIF\(current_setting\('([^']+)'/g)) {
      assert.match(name, /^app\.hivemind_(org_id|user_id)$/);
    }
    assert.doesNotMatch(up, /TO\s+(PUBLIC|hivemind_user)\b/i, 'no policy for PUBLIC or the owner');
  });
}

test('only the broker organizations policy is unconditional', () => {
  const up = stripComments(read('up.sql'));
  const unconditional = [...up.matchAll(/CREATE POLICY (\w+) ON [\w.]+\s+AS PERMISSIVE FOR \w+ TO (\w+)\s+USING \(true\)/g)];
  assert.deepEqual(unconditional.map((m) => [m[1], m[2]]), [['organizations_rls_runner_broker', 'hivemind_broker']]);
});

test('up.sql refuses roles that bypass RLS and policies it does not own', () => {
  const up = read('up.sql');
  assert.match(up, /rolsuper OR rolbypassrls/);
  assert.match(up, /already has a policy that this file does not own/);
});

test('verify.sql is read-only and always rolls back', () => {
  const verify = stripComments(read('verify.sql'));
  assert.doesNotMatch(verify, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|TRUNCATE)\b/i);
  assert.equal((verify.match(/BEGIN READ ONLY;/g) ?? []).length, (verify.match(/ROLLBACK;/g) ?? []).length);
});

test('the tenant-context helper sets the same settings the policies read', () => {
  const helper = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/tenant-context.js'), 'utf8');
  assert.match(helper, /set_config\('app\.hivemind_org_id'/);
  assert.match(helper, /set_config\('app\.hivemind_user_id'/);
});
