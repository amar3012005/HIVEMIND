/** Synthetic-only actual PostgreSQL role and lock serialization proof. */
import pg from 'pg';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
if(process.env.CRM_AUTH_PREVIEW!=='synthetic-only')throw Error('Isolated preview guard required');
const opts={host:'crm-isolated-demo-20261006',database:'crm_demo_full_auth',port:5432};
const role=new pg.Client({...opts,user:'hivemind_app_runtime',password:'synthetic-crm-role-password-isolated-only'});
const admin=new pg.Client({...opts,user:'crm_demo_admin',password:'synthetic-local-demo-only'});
const checks=[];const org='10000000-0000-4000-8000-000000000001',user='20000000-0000-4000-8000-000000000001';
try{await role.connect();await admin.connect();
 for(const[table,query]of[['users',"UPDATE hivemind.users SET display_name=display_name WHERE id=$1::uuid"],['organizations',"UPDATE hivemind.organizations SET name=name WHERE id=$1::uuid"],['user_organizations',"UPDATE hivemind.user_organizations SET is_active=false WHERE user_id=$1::uuid"]]){let code;try{await role.query(query,[table==='organizations'?org:user]);}catch(e){code=e.code;}assert.equal(code,'42501');checks.push({name:`CRM credential cannot UPDATE ${table}`,sqlstate:code});}
 await role.query('BEGIN');await role.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",[org,user]);
 const rows=(await role.query('SELECT * FROM hivemind.app_runtime_lock_membership($1::uuid,$2::uuid)',[org,user])).rows;assert.equal(rows.length,1);assert.equal(rows[0].is_active,true);
 await admin.query("SET statement_timeout='250ms'");let code;try{await admin.query('UPDATE hivemind.user_organizations SET is_active=false WHERE user_id=$1::uuid AND org_id=$2::uuid',[user,org]);}catch(e){code=e.code;}assert.equal(code,'57014');checks.push({name:'Membership revoke waits for admitted CRM transaction lock',sqlstate:code});
 await role.query('ROLLBACK');await admin.query("SET statement_timeout='5s'");await admin.query('UPDATE hivemind.user_organizations SET is_active=false WHERE user_id=$1::uuid AND org_id=$2::uuid',[user,org]);checks.push({name:'Membership revoke succeeds after lock release',status:'passed'});
 await admin.query('UPDATE hivemind.user_organizations SET is_active=true WHERE user_id=$1::uuid AND org_id=$2::uuid',[user,org]);
 await fs.writeFile('/tmp/crm-role-boundary-report.json',JSON.stringify({checks,productionMutations:false},null,2));console.log(JSON.stringify({passed:checks.length,report:'/tmp/crm-role-boundary-report.json'}));
}finally{await role.query('ROLLBACK').catch(()=>{});await admin.query('UPDATE hivemind.user_organizations SET is_active=true WHERE user_id=$1::uuid AND org_id=$2::uuid',[user,org]).catch(()=>{});await role.end();await admin.end();}
