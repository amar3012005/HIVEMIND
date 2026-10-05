/** Private operator boundary: secrets enter stdin only; stdout is metadata only. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { Pool } = createRequire('/opt/deepseek-harness/packages/session/session-persistence-postgres/package.json')('pg');
const input = JSON.parse(readFileSync(0, 'utf8'));
const role = 'hivemind_harness_runner';
const pool = new Pool({ connectionString: input.operatorUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
    const existing = await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1', [role]);
    if (input.action === 'inspect') {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ exists: existing.rowCount !== 0 }));
    } else if (input.action === 'validate') {
      const current = (await client.query('SELECT current_user AS name')).rows[0];
      if (current.name !== role || !existing.rows[0]?.rolcanlogin
        || Object.entries(existing.rows[0]).some(([key,value]) => key !== 'rolcanlogin' && value)) throw new Error('effective_role_invalid');
      const inherited = await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1',[role]);
      if (inherited.rowCount) throw new Error('unreviewed_role_membership');
      for (const table of ['harness_sessions','harness_scheduled_tasks','harness_scheduled_due','harness_company_hq','harness_dream_settings']) {
        await client.query(`SELECT 1 FROM hivemind.${table} LIMIT 0`);
      }
      await client.query('ROLLBACK'); console.log(JSON.stringify({ effectiveRole: role, restricted: true, nativeTablesReadable: true }));
    } else if (input.action === 'disable') {
      if (existing.rowCount) await client.query('ALTER ROLE hivemind_harness_runner NOLOGIN');
      await client.query('COMMIT'); console.log(JSON.stringify({ disabled: true }));
    } else if (input.action === 'provision') {
      if (existing.rowCount) throw new Error('dedicated_role_exists');
      if (!/^[A-Za-z0-9_-]{48,}$/.test(input.password)) throw new Error('invalid_fresh_password');
      const sql = readFileSync('/source/provision-harness-runner-role.sql', 'utf8')
        .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
      await client.query(sql);
      const publicGrants = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname='hivemind' AND c.relkind IN ('r','S') AND a.grantee=0 LIMIT 1`);
      if (publicGrants.rowCount) throw new Error('unreviewed_public_relation_grants');
      const inherited = await client.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1`, [role]);
      if (inherited.rowCount) throw new Error('unreviewed_role_membership');
      // Generated password alphabet is restricted above; it never enters argv/stdout.
      await client.query(`ALTER ROLE hivemind_harness_runner LOGIN PASSWORD '${input.password}'`);
      const flags = (await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1', [role])).rows[0];
      if (!flags.rolcanlogin || Object.entries(flags).some(([key, value]) => key !== 'rolcanlogin' && value)) throw new Error('role_flags_invalid');
      await client.query('COMMIT'); console.log(JSON.stringify({ provisioned: true, flags }));
    } else throw new Error('invalid_operator_action');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
} catch (error) {
  console.error(JSON.stringify({ error: 'private_operator_failed', code: /^[A-Z0-9_]{5}$/.test(error.code || '') ? error.code : undefined }));
  process.exitCode = 1;
} finally { await pool.end(); }
