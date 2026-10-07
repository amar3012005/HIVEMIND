/** Disposable database proof of the exact native Attention SQL; no production URL accepted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`);
const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres@attention-fixture-pg:5432/attention_fixture' });
await c.connect();
const source = fs.readFileSync('/source/attention.ts', 'utf8');
const sql = [...source.matchAll(/client\.query(?:<[^>]+>)?\(`([\s\S]+?)`, \[/g)].map(x => x[1].replaceAll('${config.triggerSchema}', 'hivemind').replaceAll('${config.schema}', 'hivemind'));
const owned = sql.find(x => x.includes('SELECT h.session_id'));
const memory = sql.find(x => x.includes('WITH heads'));
assert.ok(owned && memory, 'exact native owner and memory queries discovered');
const a = { org: '11111111-1111-4111-8111-111111111111', user: '22222222-2222-4222-8222-222222222222' };
const b = { org: '33333333-3333-4333-8333-333333333333', user: '44444444-4444-4444-8444-444444444444' };
try {
  await c.query(`CREATE SCHEMA hivemind; SET search_path=hivemind,public;
    CREATE ROLE attention_fixture LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE user_organizations(org_id uuid,user_id uuid,is_active bool,deactivated_at timestamptz);
    CREATE TABLE harness_company_hq(org_id uuid PRIMARY KEY,user_id uuid,session_id text);
    CREATE TABLE harness_sessions(id text PRIMARY KEY,org_id uuid,user_id uuid,status text);
    CREATE TABLE hivemind_trigger_subscriptions(id text PRIMARY KEY,org_id text,user_id text,status text,runtime_attention bool,runtime_attention_enabled_at timestamptz,toolkit text,runtime_attention_revision int);
    CREATE TABLE hivemind_trigger_events(id text PRIMARY KEY,subscription_id text,org_id text,user_id text,data jsonb,occurred_at timestamptz,received_at timestamptz,relevance_status text,relevance_decision jsonb);
    CREATE TABLE hyper_agent_operating_memories(id uuid PRIMARY KEY,org_id uuid,author_user_id uuid,project_slug text,agent_slug text,kind text,title text,summary text,context jsonb,created_at timestamptz);
    GRANT USAGE ON SCHEMA hivemind TO attention_fixture;
    GRANT SELECT ON ALL TABLES IN SCHEMA hivemind TO attention_fixture;`);
  for (const p of [a, b]) {
    await c.query('INSERT INTO users VALUES($1,NULL)', [p.user]);
    await c.query('INSERT INTO user_organizations VALUES($1,$2,true,NULL)', [p.org, p.user]);
    await c.query("INSERT INTO harness_company_hq VALUES($1,$2,$3)", [p.org, p.user, `room-${p.org}`]);
    await c.query("INSERT INTO harness_sessions VALUES($3,$1,$2,'active')", [p.org, p.user, `room-${p.org}`]);
    await c.query("INSERT INTO hivemind_trigger_subscriptions VALUES($3,$1,$2,'active',true,'2026-10-01','gmail',1)", [p.org, p.user, `sub-${p.org}`]);
    await c.query("INSERT INTO hivemind_trigger_events VALUES($3,$4,$1,$2,'{}',NULL,'2026-10-08','approved','{}')", [p.org, p.user, `event-${p.org}`, `sub-${p.org}`]);
    await c.query("INSERT INTO hyper_agent_operating_memories VALUES($3,$1,$2,'hyper-agents','runtime','user_agenda','Confirmed direction','Fixture only',$4,'2026-10-08')", [p.org, p.user, p.org, {state:'confirmed',priority:50,agendaKey:'fixture'}]);
  }
  for (const table of ['user_organizations','harness_company_hq','harness_sessions','hivemind_trigger_subscriptions','hivemind_trigger_events']) {
    await c.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; CREATE POLICY owner_scope ON ${table} USING (org_id::text=current_setting('app.hivemind_org_id',true) AND user_id::text=current_setting('app.hivemind_user_id',true))`);
  }
  await c.query("ALTER TABLE hyper_agent_operating_memories ENABLE ROW LEVEL SECURITY; CREATE POLICY private_scope ON hyper_agent_operating_memories USING (org_id::text=current_setting('app.hivemind_org_id',true) AND author_user_id::text=current_setting('app.hivemind_user_id',true))");
  async function read(p, operation) {
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE attention_fixture');
      await c.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [p.org,p.user]);
      const result = await operation(); await c.query('ROLLBACK'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
  }
  const checks=[];
  await read(a,async()=>{ const {rows:[flags]}=await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');assert.equal(flags.rolsuper,false);assert.equal(flags.rolbypassrls,false); });checks.push('restricted non-superuser non-bypass principal');
  assert.equal((await read(a,()=>c.query(owned,[`event-${a.org}`,a.org,a.user]))).rows.length,1);checks.push('exact native canonical owner query succeeds');
  assert.equal((await read(a,()=>c.query(owned,[`event-${b.org}`,b.org,b.user]))).rows.length,0);checks.push('foreign event denied by actual RLS');
  assert.equal((await read(a,()=>c.query(memory,[b.org,b.user]))).rows.length,0);checks.push('foreign private direction denied by actual RLS');
  assert.equal((await read(a,()=>c.query(memory,[a.org,a.user]))).rows[0].context.agendaKey,'fixture');checks.push('exact native Runtime private-head SQL succeeds');
  await c.query('UPDATE hivemind_trigger_subscriptions SET runtime_attention=false WHERE org_id=$1',[a.org]);
  assert.equal((await read(a,()=>c.query(owned,[`event-${a.org}`,a.org,a.user]))).rows.length,0);checks.push('withdrawn subscription consent denied');
  await c.query('UPDATE hivemind_trigger_subscriptions SET runtime_attention=true WHERE org_id=$1',[a.org]);
  await c.query("INSERT INTO hyper_agent_operating_memories VALUES('55555555-5555-4555-8555-555555555555',$1,$2,'hyper-agents','runtime','user_agenda','New direction','Fixture successor',$3,'2026-10-09')",[a.org,a.user,{state:'confirmed',priority:51,agendaKey:'fixture',supersedesId:a.org}]);
  const heads=(await read(a,()=>c.query(memory,[a.org,a.user]))).rows;assert.equal(heads.length,1);assert.equal(heads[0].title,'New direction');checks.push('actual successor head excludes replaced agenda');
  console.log(JSON.stringify({testOnly:true,proof:'exact native SQL with disposable scoped schema',checks}));
} finally { await c.end(); }
