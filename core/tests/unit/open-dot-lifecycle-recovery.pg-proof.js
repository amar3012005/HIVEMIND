/** Disposable PostgreSQL17 proof; no production callback or identities. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {recoverBoundOpenDotLifecycles} from '../../src/employees/open-dot-lifecycle-recovery.js';
const url=process.env.OPEN_DOT_LIFECYCLE_TEST_DATABASE_URL;
if(!/^postgres:\/\/fixture:fixture@127\.0\.0\.1:\d+\/lifecycle_fixture$/.test(url||''))throw Error('Disposable database only');
const {Pool}=createRequire('/app/package.json')('pg');const pool=new Pool({connectionString:url});
const map=row=>row&&({id:row.id,orgId:row.org_id,createdBy:row.created_by,status:row.status,archivedAt:row.archived_at,policyRules:row.policy_rules,persona:row.persona,avatarUrl:row.avatar_url});
const api=client=>({$queryRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rows,digitalEmployee:{findUnique:async({where})=>map((await client.query('SELECT * FROM hivemind.digital_employees WHERE id=$1',[where.id])).rows[0]),update:async({where,data})=>map((await client.query('UPDATE hivemind.digital_employees SET policy_rules=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[where.id,data.policyRules])).rows[0])},userOrganization:{findUnique:async({where})=>{const key=where.userId_orgId;const row=(await client.query('SELECT is_active,role FROM hivemind.user_organizations WHERE user_id=$1 AND org_id=$2',[key.userId,key.orgId])).rows[0];return row&&{isActive:row.is_active,role:row.role};}}});
const db={...api(pool),$transaction:async work=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await work(api(client));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}};
const org=randomUUID(),user=randomUUID();
let clock=Date.now();const now=()=>clock;
const policy=()=>({keep:{untouched:true},open_dot_employee:{version:1,state:'bound',execution_backend:'open-dot',dot_id:'dot_fixture',binding_revision:1},native_lifecycle:{version:1,kind:'durable',phase:'active',creation_hash:'a'.repeat(64),profile_stage:'responsibilities',profile_revision:1}});
async function add(p=policy()){const id=randomUUID();await pool.query('INSERT INTO hivemind.digital_employees VALUES($1,$2,$3,\'draft\',NULL,$4,clock_timestamp(),\'Saved persona\',\'Saved avatar\')',[id,org,user,p]);return id;}
try{
await pool.query('CREATE SCHEMA hivemind;CREATE TABLE hivemind.digital_employees(id uuid PRIMARY KEY,org_id uuid,created_by uuid,status text,archived_at timestamptz,policy_rules jsonb,updated_at timestamptz,persona text,avatar_url text);CREATE TABLE hivemind.user_organizations(user_id uuid,org_id uuid,is_active boolean,role text,PRIMARY KEY(user_id,org_id))');
await pool.query('INSERT INTO hivemind.user_organizations VALUES($1,$2,true,\'owner\')',[user,org]);
// More than former limit*8 invalid/backoff rows must not starve a valid later row.
for(let i=0;i<40;i++){const p=policy();p.open_dot_employee.binding_revision='1';await add(p);}
for(let i=0;i<40;i++){const p=policy();p.open_dot_lifecycle_delivery={state:'pending',employee_id:'unused',creation_hash:'a'.repeat(64),binding_revision:1,dot_id:'dot_fixture',profile_revision:1,profile_stage:'responsibilities',next_attempt_at:clock+300000,claim_until:0};const id=await add(p);p.open_dot_lifecycle_delivery={...p.open_dot_lifecycle_delivery,employee_id:id,organization_id:org,user_id:user};await pool.query('UPDATE hivemind.digital_employees SET policy_rules=$2 WHERE id=$1',[id,p]);}
const id=await add();let count=0;
let result=await recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async(_p,row)=>{count++;assert.equal(row.id,id);return{status:'pending'};}});assert.equal(result.attempted,1,'later due candidate not starved');
clock+=2001;
// New invocation (restart semantics) reads persisted retry marker.
let enter,release;const entered=new Promise(r=>enter=r),blocked=new Promise(r=>release=r);
const first=recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async(_p,row)=>{count++;enter();await blocked;return{status:'ready',employeeId:row.id};}});
await entered;result=await recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async()=>{throw Error('duplicate callback');}});assert.equal(result.attempted,0);
await pool.query("UPDATE hivemind.digital_employees SET policy_rules=jsonb_set(policy_rules,'{open_dot_employee,binding_revision}','2') WHERE id=$1",[id]);release();await first;
assert.notEqual((await db.digitalEmployee.findUnique({where:{id}})).policyRules.open_dot_lifecycle_delivery.state,'delivered','changed binding fenced');
result=await recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async(_p,row)=>({status:'ready',employeeId:row.id})});assert.equal(result.delivered,1);
const saved=await db.digitalEmployee.findUnique({where:{id}});assert.equal(saved.persona,'Saved persona');assert.equal(saved.avatarUrl,'Saved avatar');assert.deepEqual(saved.policyRules.keep,{untouched:true});
await pool.query("UPDATE hivemind.digital_employees SET policy_rules=jsonb_set(policy_rules,'{native_lifecycle,profile_revision}','2') WHERE id=$1",[id]);
result=await recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async(_p,row)=>{clock+=60001;return{status:'ready',employeeId:row.id};}});assert.equal(result.delivered,0,'expired claim cannot acknowledge');
await pool.query('UPDATE hivemind.user_organizations SET is_active=false');result=await recoverBoundOpenDotLifecycles(db,{limit:1,now,activate:async()=>{throw Error('membership bypass');}});assert.equal(result.attempted,0);
console.log('PASS actual PG17 hivemind schema: invalid/backoff starvation, pending restart retry, concurrent single callback, rebound CAS, expiry fence, membership revocation, preserved persona/avatar/policy');
}finally{await pool.end();}
