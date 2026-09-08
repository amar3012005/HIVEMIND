import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
const migrationUrl = new URL('../../prisma/migrations/20260908150000_harness_chat_sessions/migration.sql', import.meta.url);
const composeUrl = new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url);

test('Harness provider schema is additive, tenant scoped, and RLS enforced', async () => {
  const [schema, migration] = await Promise.all([readFile(schemaUrl, 'utf8'), readFile(migrationUrl, 'utf8')]);
  for (const model of ['HarnessSession', 'HarnessSessionEvent', 'HarnessSessionLease']) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /id\s+String\s+@id\s+@db\.VarChar\(180\)/);
  assert.match(schema, /eventCount\s+BigInt/);
  assert.match(schema, /inheritedEventCount\s+BigInt/);
  assert.match(schema, /fencingToken\s+BigInt/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /current_setting\('app\.hivemind_org_id', true\)/);
  assert.match(migration, /current_setting\('app\.hivemind_user_id', true\)/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS "harness_session_leases_session_key"/);
});

test('canonical Compose uses the dedicated Harness image and existing Postgres and Redis', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const service = compose.slice(compose.indexOf('\n  harness-runner:'), compose.indexOf('\n  employees:'));
  assert.match(service, /image: \$\{HIVEMIND_HARNESS_IMAGE:-hivemind\/harness-chat:local\}/);
  assert.match(service, /@postgres:5432/);
  assert.match(service, /@redis:6379\/0/);
  assert.match(service, /postgres: \{ condition: service_healthy \}/);
  assert.match(service, /redis: \{ condition: service_started \}/);
  assert.doesNotMatch(service, /^\s{2}(postgres|redis):/m);
});
