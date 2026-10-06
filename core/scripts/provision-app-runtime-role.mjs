import pg from 'pg';

// Run only in the scoped, immutable migration job with managed secrets.
// This never reads a local .env or prints a database URL/password.
const role = 'hivemind_app_runtime';
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const literal = value => `'${value.replaceAll("'", "''")}'`;

export async function provisionAppRuntimeRole(client, password) {
  if (typeof password !== 'string' || password.length < 32 || password.includes('\0')) {
    throw new Error('A managed CRM password of at least 32 characters is required');
  }
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hivemind:crm-role-provision',0))");
    const { rows: [existing] } = await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1', [role]);
    if (existing && Object.values(existing).some(Boolean)) throw new Error('Existing CRM role has unsafe privileges');
    const { rows: [membership] } = await client.query('SELECT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1) AS inherited', [role]);
    if (membership.inherited) throw new Error('CRM role must not inherit another role');
    if (!existing) await client.query(`CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`);
    await client.query(`ALTER ROLE ${identifier(role)} PASSWORD ${literal(password)}`);
    const { rows: [database] } = await client.query('SELECT current_database() AS name');
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(database.name)} TO ${identifier(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA hivemind TO ${identifier(role)}`);
    const { rows: [fn] } = await client.query("SELECT pg_get_userbyid(proowner) AS owner,prosecdef FROM pg_proc WHERE oid='hivemind.app_runtime_lock_membership(uuid,uuid)'::regprocedure");
    if (!fn.prosecdef || fn.owner === role) throw new Error('Membership boundary must be owned by the migration owner');
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA hivemind FROM ${identifier(role)}`);
    await client.query(`GRANT EXECUTE ON FUNCTION hivemind.app_runtime_lock_membership(uuid,uuid) TO ${identifier(role)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON hivemind.app_runtime_apps,hivemind.app_runtime_records TO ${identifier(role)}`);
    await client.query(`GRANT SELECT,INSERT ON hivemind.app_runtime_versions,hivemind.app_runtime_entities,hivemind.app_runtime_operations,hivemind.app_runtime_audit TO ${identifier(role)}`);
    await client.query(`GRANT SELECT,INSERT,DELETE ON hivemind.app_runtime_record_relations TO ${identifier(role)}`);
    await client.query(`GRANT SELECT(id,title,status,graph_version,started_at,completed_at,created_at,org_id,context) ON hivemind.hq_workflows TO ${identifier(role)}`);
    const { rows: guards } = await client.query("SELECT relname,relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid IN ('hivemind.app_runtime_apps'::regclass,'hivemind.app_runtime_versions'::regclass,'hivemind.app_runtime_entities'::regclass,'hivemind.app_runtime_records'::regclass,'hivemind.app_runtime_record_relations'::regclass,'hivemind.app_runtime_operations'::regclass,'hivemind.app_runtime_audit'::regclass)");
    if (guards.length !== 7 || guards.some(table => !table.relrowsecurity || !table.relforcerowsecurity || table.owner === role)) throw new Error('CRM table isolation guards are incomplete');
    const { rows: identity } = await client.query("SELECT table_name,has_any_column_privilege($1,'hivemind.'||table_name,'UPDATE') AS can_update,has_any_column_privilege($1,'hivemind.'||table_name,'INSERT') AS can_insert,has_table_privilege($1,'hivemind.'||table_name,'DELETE') AS can_delete FROM unnest(ARRAY['users','organizations','user_organizations']) AS table_name", [role]);
    if (identity.some(table => table.can_update || table.can_insert || table.can_delete)) throw new Error('CRM credential must not mutate platform identity');
    await client.query('COMMIT');
    return { role, tables: guards.length, forcedRowSecurity: true, identityWriteAccess: false, membershipLock: 'fixed security-definer function' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const client = new pg.Client({ connectionString: process.env.CRM_PROVISION_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    if (!process.env.CRM_PROVISION_DATABASE_URL) throw new Error('Managed migration database URL is required');
    await client.connect();
    console.log(JSON.stringify(await provisionAppRuntimeRole(client, process.env.HIVE_APP_RUNTIME_DATABASE_PASSWORD)));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code || 'CRM_ROLE_PROVISION_FAILED' }));
    process.exitCode = 1;
  } finally { await client.end(); }
}
