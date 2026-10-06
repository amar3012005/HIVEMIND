import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Read-only managed job. No business rows or secret values are returned.
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  const url = new URL('postgresql://postgres:5432/');
  url.username = process.env.POSTGRES_USER || 'hivemind_user';
  url.password = process.env.POSTGRES_PASSWORD || '';
  url.pathname = `/${process.env.POSTGRES_DB || 'hivemind'}`;
  databaseUrl = url.href;
}
const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 5000 });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const { rows: [database] } = await client.query('SELECT current_database() AS database,current_user AS role');
  const { rows: [authority] } = await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  const { rows: [schema] } = await client.query("SELECT to_regclass('hivemind._prisma_migrations') IS NOT NULL AS ledger_present,to_regclass('hivemind.app_runtime_apps') IS NOT NULL AS crm_present");
  let ledger = null;
  if (schema.ledger_present) {
    const { rows: [count] } = await client.query('SELECT count(*)::int AS applied FROM hivemind._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    const { rows: crmMigration } = await client.query("SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM hivemind._prisma_migrations WHERE migration_name='20261005100000_app_runtime_infrastructure'");
    const { rows: unresolved } = await client.query('SELECT migration_name FROM hivemind._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY migration_name');
    ledger = { applied: count.applied, crmMigration, unresolved };
    if (process.env.CRM_MIGRATION_MANIFEST) {
      const names = JSON.parse(await readFile(process.env.CRM_MIGRATION_MANIFEST, 'utf8'));
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Invalid migration manifest');
      const { rows: applied } = await client.query('SELECT migration_name FROM hivemind._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
      const appliedNames = new Set(applied.map(row => row.migration_name));
      ledger.unappliedSourceMigrations = names.filter(name => !appliedNames.has(name));
    }
  }
  const { rows: runtimeRole } = await client.query("SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='hivemind_app_runtime'");
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), database, authority, schema, ledger, runtimeRole, managedSecretPresence: { postgresPassword: Boolean(process.env.POSTGRES_PASSWORD), crmUrl: Boolean(process.env.HIVE_APP_RUNTIME_DATABASE_URL), crmPassword: Boolean(process.env.HIVE_APP_RUNTIME_DATABASE_PASSWORD) }, productionMutations: false }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'CRM_PREFLIGHT_FAILED' }));
  process.exitCode = 1;
} finally { await client.end(); }
