import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
const migrationUrl = new URL('../../prisma/migrations/20260908150000_harness_chat_sessions/migration.sql', import.meta.url);
const usageMigrationUrl = new URL('../../prisma/migrations/20260913143000_harness_chat_usage_projection/migration.sql', import.meta.url);
const composeUrl = new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url);

test('Harness provider schema is additive, tenant scoped, and RLS enforced', async () => {
  const [schema, migration] = await Promise.all([readFile(schemaUrl, 'utf8'), readFile(migrationUrl, 'utf8')]);
  for (const model of ['HarnessSession', 'HarnessSessionEvent', 'HarnessSessionLease', 'ConnectedAppReceipt']) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /id\s+String\s+@id\s+@db\.VarChar\(180\)/);
  assert.match(schema, /eventCount\s+BigInt/);
  assert.match(schema, /inheritedEventCount\s+BigInt/);
  assert.match(schema, /fencingToken\s+BigInt/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /current_setting\('app\.hivemind_org_id', true\)/);
  assert.match(migration, /current_setting\('app\.hivemind_user_id', true\)/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS "harness_session_leases_session_key"/);
});

test('native Harness usage projects idempotently into the existing content-free AI ledger', async () => {
  const migration = await readFile(usageMigrationUrl, 'utf8');
  assert.match(migration, /AFTER INSERT ON harness_session_events/);
  assert.match(migration, /WHEN \(NEW\.event_type = 'assistant\/message'\)/);
  assert.match(migration, /'harness:' \|\| md5\(p_session_id\) \|\| ':' \|\| p_sequence::text/);
  assert.match(migration, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(migration, /p_payload #> '\{data,usage\}'/);
  assert.match(migration, /'harness_chat'/);
  assert.doesNotMatch(migration, /p_payload\s*#>{1,2}\s*'\{data,(?:message|content)/i);
});

test('canonical Compose uses the dedicated Harness image and existing Postgres and Redis', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const service = compose.slice(compose.indexOf('\n  harness-runner:'), compose.indexOf('\n  employees:'));
  assert.match(service, /image: \$\{HIVEMIND_HARNESS_IMAGE:-hivemind\/harness-chat:sha-[0-9a-f]{9}\}/);
  assert.match(service, /@postgres:5432/);
  assert.match(service, /@redis:6379\/0/);
  assert.match(service, /postgres: \{ condition: service_healthy \}/);
  assert.match(service, /redis: \{ condition: service_started \}/);
  assert.doesNotMatch(service, /^\s{2}(postgres|redis):/m);
  assert.doesNotMatch(service, /container_name:/);
  assert.doesNotMatch(service, /env_file:/);
  assert.match(service, /profiles: \["harness-chat"\]/);
  assert.match(service, /PGOPTIONS: -c search_path=hivemind,public/);
  assert.match(service, /HIVEMIND_HARNESS_TRUSTED_HOSTS: \$\{HIVE_HARNESS_TRUSTED_HOSTS:-dev\.next\.singulancelabs\.com\}/);
  assert.match(service, /CLOUDFLARE_API_KEY: \$\{CLOUDFLARE_AI_GATEWAY_TOKEN:-\}/);
  assert.match(service, /COMPOSIO_API_KEY: \$\{COMPOSIO_API_KEY:-\}/);
  assert.match(service, /HIVEMIND_CONNECTED_APP_CALLBACK_URL: \$\{HIVEMIND_CONNECTED_APP_CALLBACK_URL:-https:\/\/dev\.next\.singulancelabs\.com\/hivemind\/app\/overview\}/);
  assert.doesNotMatch(service, /(?:OPENROUTER|XAI|GROK)_API_KEY:/);
});

test('Control Plane owns an explicit encrypted connected-app receipt key', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const service = compose.slice(compose.indexOf('\n  control-plane:'), compose.indexOf('\n  # Native DeepSeek Harness'));
  assert.match(service, /HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY: \$\{HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY:-\}/);
});
