/** Disposable, network-isolated PostgreSQL proof; never accepts a production connection string. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Pool } from 'pg';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope';
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres';
import { manageNativeEmployee, employeeCanDispatch, nativeLifecycleHostProof } from '/source/native-lifecycle.js';
const url='postgresql://postgres@127.0.0.1:5432/security_test';
const admin=new Pool({connectionString:url,options:'-c search_path=hivemind,public',max:4});
for(let n=0;n<40;n++){try{await admin.query('SELECT 1');break;}catch(error){if(n===39)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
const a={orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',profile:'hivemind-chat',variation:'harness'};
const b={...a,orgId:'17503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'14f5568b-4d6a-4ae1-9a33-48cb2909d59b'};
await admin.query('CREATE SCHEMA hivemind');
await admin.query(`CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);
INSERT INTO organizations VALUES('${a.orgId}'),('${b.orgId}');INSERT INTO users VALUES('${a.userId}'),('${b.userId}')`);
await admin.query(fs.readFileSync('/source/session-baseline.sql','utf8'));
await admin.query(fs.readFileSync('/source/session-hardening.sql','utf8'));
await admin.query(`CREATE TABLE digital_employees(id uuid PRIMARY KEY,org_id uuid,slug text,data jsonb,UNIQUE(org_id,slug));
CREATE TABLE fixture_memberships(org_id uuid,user_id uuid,role text,is_active bool);
CREATE TABLE fixture_memories(id text,org_id uuid,agent_slug text,status text,kind text,created_at timestamptz);
INSERT INTO fixture_memberships VALUES('${a.orgId}','${a.userId}','admin',true),('${b.orgId}','${b.userId}','admin',true);
CREATE ROLE fixture_runner LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA hivemind TO fixture_runner;
GRANT SELECT,INSERT,UPDATE,DELETE ON harness_sessions,harness_session_events,harness_session_leases TO fixture_runner;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hivemind TO fixture_runner`);
function adapter(client){return {
 $queryRawUnsafe:async(sql,...params)=>(await client.query(sql,params)).rows,
 digitalEmployee:{
  findUnique:async({where})=>(await client.query('SELECT data FROM digital_employees WHERE org_id=$1 AND slug=$2',[where.orgId_slug.orgId,where.orgId_slug.slug])).rows[0]?.data,
  findFirst:async({where})=>(await client.query('SELECT data FROM digital_employees WHERE org_id=$1 AND id=$2',[where.orgId,where.id])).rows[0]?.data,
  create:async({data})=>{await client.query('INSERT INTO digital_employees VALUES($1,$2,$3,$4)',[data.id,data.orgId,data.slug,data]);return data;},
  update:async({where,data})=>{const row=(await client.query('SELECT data FROM digital_employees WHERE id=$1 FOR UPDATE',[where.id])).rows[0].data;const updated={...row,...data};await client.query('UPDATE digital_employees SET data=$2 WHERE id=$1',[where.id,updated]);return updated;},
 },
 hyperAgentOperatingMemory:{findFirst:async({where})=>{
  const row=(await client.query('SELECT * FROM fixture_memories WHERE org_id=$1 AND agent_slug=$2 AND status=$3 AND kind=ANY($4::text[]) ORDER BY created_at DESC LIMIT 1',[where.orgId,where.agentSlug,where.status,where.kind.in])).rows[0];return row && {id:row.id,createdAt:row.created_at};
 }},
};}
const db={userOrganization:{findUnique:async({where})=>{
 const row=(await admin.query('SELECT role,is_active FROM fixture_memberships WHERE org_id=$1 AND user_id=$2',[where.userId_orgId.orgId,where.userId_orgId.userId])).rows[0];return row&&{role:row.role,isActive:row.is_active};
}},$transaction:async fn=>{const client=await admin.connect();try{await client.query('BEGIN');const result=await fn(adapter(client));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}};
const checks=[];
const input={operation:'create',creation_key:'dummy-native-1',name:'Dummy',persona:'Isolated lifecycle specialist',role:'Test specialist',lifecycle:'temporary',expires_at:'2030-01-01T00:00:00Z'};
const p={userId:a.userId,orgId:a.orgId};
const [one,two]=await Promise.all([manageNativeEmployee(db,p,input,{now:0}),manageNativeEmployee(db,p,input,{now:0})]);
assert.equal(one.employee.id,two.employee.id);assert.equal((await admin.query('SELECT count(*) FROM digital_employees')).rows[0].count,'1');checks.push('actual transactional concurrent creation replay');
const employee=one.employee;
assert.equal(employee.status,'draft');checks.push('native creation does not enroll old sidecar running/deploying reconciliation');
const excluded=await admin.query("SELECT id FROM digital_employees WHERE NOT (COALESCE(data->'policyRules','{}'::jsonb) ? 'native_lifecycle') AND id=$1",[employee.id]);
assert.equal(excluded.rows.length,0);checks.push('legacy explicit-id SQL predicate excludes native lifecycle profiles');
assert.equal(employeeCanDispatch(employee,Date.parse(input.expires_at)),false);checks.push('deadline stops dispatch');
await assert.rejects(()=>manageNativeEmployee(db,{userId:b.userId,orgId:b.orgId},{operation:'archive',employee_id:employee.id,expected_revision:1}),/employee_not_found/);checks.push('cross-organization archive denied');
const pool=new Pool({connectionString:'postgresql://fixture_runner@127.0.0.1:5432/security_test',options:'-c search_path=hivemind,public',max:2});
const ctx=new Context();const scope=new ExecutionScope(ctx);const store=new PostgresSessionPersistence(ctx,{connectionStringEnv:'FIXTURE_ONLY',schema:'hivemind',leaseTtlMs:30000,maxConnections:2},pool);
let seq=0;const writer=await scope.run(a,()=>store.create({version:SESSION_FORMAT_VERSION,id:SessionId('session-dummy-chief'),createdAt:1,isSeeded:false,agentPreset:'hivemind-hq'}));
const append=async(type,data)=>writer.append([{type,seq:SessionSeq(seq++),time:Date.now(),data}]);
await append('hivemind/session-owner',{id:null,slug:'runtime',name:'Runtime',role:'AI Chief of Staff'});
const setupAppearance={version:1,provider:'humation',template:'humation-1',asset_version:'1.0.1',seed:'dummy-setup',
 selections:{head:'hm1-p-000001',body:'hm1-p-000025',bottom:'hm1-p-000033',item:'hm1-p-000041',glasses:'hm1-p-000056'},
 colors:{stroke:'000000',hair:'000000',skin:'FFFFFF',clothes:'FFFFFF',bottom:'000000'},background:'transparent',crop:'avatar'};
const setup=(await manageNativeEmployee(db,p,{operation:'create',creation_key:'dummy-setup',name:'Dummy Setup',appearance:setupAppearance},{now:0})).employee;
const setupRoom=await scope.run(a,()=>store.create({version:SESSION_FORMAT_VERSION,id:SessionId('session-dummy-setup'),createdAt:1,isSeeded:false,agentPreset:'hivemind-hyperagents'}));
await setupRoom.append([{type:'hivemind/session-owner',seq:SessionSeq(0),time:Date.now(),data:{id:setup.id,slug:setup.slug,name:setup.name,role:setup.roleArchetype}}]);
const configure={operation:'configure',employee_id:setup.id,expected_profile_revision:1,role:'Evidence Research',persona:'Own agreed evidence research; existing permissions remain unchanged.'};
const ownPrincipal={...p,employeeSessionId:'session-dummy-setup',employeeId:setup.id};
const refined=await manageNativeEmployee(db,ownPrincipal,configure);
assert.equal(refined.employee.roleArchetype,'Evidence Research');assert.equal(refined.employee.policyRules.native_lifecycle.profile_revision,2);
assert.equal(refined.employee.policyRules.native_lifecycle.revision,1);assert.equal(refined.employee.policyRules.native_lifecycle.onboarding_required,false);
assert.deepEqual(refined.employee.policyRules.appearance,setupAppearance);
const persistedSetup=(await admin.query('SELECT data FROM digital_employees WHERE id=$1',[setup.id])).rows[0].data;
assert.deepEqual(persistedSetup.tools,[]);assert.deepEqual(persistedSetup.enabledConnectors,[]);
checks.push('actual persisted own employee room saves bounded responsibilities and canonical appearance without permission expansion');
assert.equal((await manageNativeEmployee(db,ownPrincipal,configure)).replayed,true);
await assert.rejects(()=>manageNativeEmployee(db,{...ownPrincipal,employeeSessionId:'session-dummy-chief'},configure),/employee_profile_scope_required/);
await assert.rejects(()=>manageNativeEmployee(db,ownPrincipal,{...configure,employee_id:employee.id}),/employee_profile_scope_required/);
checks.push('actual saved-room refinement replay and Chief/other-employee denial');
await setupRoom.close();

await append('hivemind/hq-employee-assignment',{taskId:'task-1',employeeId:employee.id,memberName:employee.slug,sessionId:'session-dummy-employee',personaSha256:'dummy'});
await append('team/task',{version:2,teamId:'session-dummy-chief',task:{id:'task-1',revision:2,subject:'Dummy work',description:'Isolated task',status:'in_progress',blockedBy:[],writeScopes:[],ownerName:employee.slug}});
let close=await manageNativeEmployee(db,p,{operation:'inspect_closeout',employee_id:employee.id});assert.equal(close.closeout.ready,false);checks.push('actual persisted native pending task blocks archive');
await append('hivemind/hq-task-review',{taskId:'task-1',taskRevision:2,artifactIds:['dummy-artifact'],inputHash:'dummy',status:'accepted',reviewer:'runtime',probabilities:[1],model:'runtime'});
await append('team/task',{version:2,teamId:'session-dummy-chief',task:{id:'task-1',revision:3,subject:'Dummy work',description:'Isolated task',status:'completed',blockedBy:[],writeScopes:[],ownerName:employee.slug}});
await admin.query("INSERT INTO fixture_memories VALUES('dummy-learning',$1,$2,'recorded','handoff',now())",[a.orgId,employee.slug]);
const other=(await manageNativeEmployee(db,p,{...input,creation_key:'reassigned-specialist',name:'Other Dummy'},{now:0})).employee;
await append('hivemind/hq-employee-assignment',{taskId:'task-2',employeeId:employee.id,memberName:employee.slug,sessionId:'session-dummy-employee',personaSha256:'dummy'});
await append('hivemind/hq-employee-assignment',{taskId:'task-2',employeeId:other.id,memberName:other.slug,sessionId:'session-dummy-other',personaSha256:'dummy'});
await append('team/task',{version:2,teamId:'session-dummy-chief',task:{id:'task-2',revision:2,subject:'Reassigned dummy work',status:'in_progress',blockedBy:[],writeScopes:[],ownerName:other.slug}});
await admin.query("UPDATE fixture_memories SET created_at=now() WHERE id='dummy-learning'");
const reassigned=await manageNativeEmployee(db,p,{operation:'inspect_closeout',employee_id:employee.id});
assert.equal(reassigned.closeout.ready,true);assert.equal(reassigned.closeout.reviewed_task_count,1);checks.push('current other-employee reassignment does not block former employee closeout');
const closing=await manageNativeEmployee(db,{...p,runtimeSessionId:'session-dummy-chief'},{operation:'begin_closeout',employee_id:employee.id,expected_revision:1});
assert.equal(closing.employee.policyRules.native_lifecycle.phase,'closing');assert.equal(employeeCanDispatch(closing.employee,0),false);checks.push('actual persisted closeout phase stops business dispatch without erasing evidence');
const activeRoom=await scope.run(a,()=>store.create({version:SESSION_FORMAT_VERSION,id:SessionId('active-employee-room'),createdAt:1,isSeeded:false,agentPreset:'hivemind-hyperagent'}));
await activeRoom.append([{type:'hivemind/session-owner',seq:SessionSeq(0),time:Date.now(),data:{id:employee.id,slug:employee.slug}},{type:'turn/start',seq:SessionSeq(1),time:Date.now(),data:{turn:1}}]);
const activeProof=await manageNativeEmployee(db,p,{operation:'inspect_closeout',employee_id:employee.id});assert.equal(activeProof.closeout.ready,false);assert.ok(activeProof.closeout.blockers.includes('employee_active_turn_requires_closeout'));checks.push('actual persisted active employee turn blocks archival');
await activeRoom.append([{type:'turn/end',seq:SessionSeq(2),time:Date.now(),data:{turn:1,reason:{kind:'interrupted'}}}]);await activeRoom.close();
const child=await scope.run(a,()=>store.create({version:SESSION_FORMAT_VERSION,id:SessionId('native-child-room'),parentSession:SessionId('active-employee-room'),createdAt:1,isSeeded:false,agentPreset:'hivemind-hyperagents'}));
await child.append([{type:'turn/start',seq:SessionSeq(0),time:Date.now(),data:{turn:1}}]);
let childProof=await manageNativeEmployee(db,p,{operation:'inspect_closeout',employee_id:employee.id});
assert.equal(childProof.closeout.ready,false);assert.ok(childProof.closeout.blockers.includes('employee_active_turn_requires_closeout'));checks.push('native parentSession descendant active turn blocks archive without copied owner');
await child.append([{type:'turn/end',seq:SessionSeq(1),time:Date.now(),data:{turn:1,reason:{kind:'stop'}}},{type:'team/task',seq:SessionSeq(2),time:Date.now(),data:{version:2,teamId:'native-child-room',task:{id:'child-task',revision:1,subject:'Dummy child task',description:'Fixture',status:'pending',blockedBy:[],writeScopes:[]}}}]);
childProof=await manageNativeEmployee(db,p,{operation:'inspect_closeout',employee_id:employee.id});
assert.equal(childProof.closeout.ready,false);assert.ok(childProof.closeout.blockers.includes('employee_child_work_requires_closeout'));checks.push('native descendant unfinished Team task blocks archive');
await child.append([{type:'team/task',seq:SessionSeq(3),time:Date.now(),data:{version:2,teamId:'native-child-room',task:{id:'child-task',revision:2,subject:'Dummy child task',description:'Fixture',status:'deleted',blockedBy:[],writeScopes:[]}}}]);await child.close();
close=await manageNativeEmployee(db,{...p,runtimeSessionId:'session-dummy-chief'},{operation:'archive',employee_id:employee.id,expected_revision:2});assert.equal(close.employee.policyRules.native_lifecycle.phase,'archived');checks.push('authenticated native Chief archives only accepted task plus private closeout');
const retained=await scope.run(a,()=>store.open(SessionId('session-dummy-chief'),'read'));
assert.equal(retained.header.id,'session-dummy-chief');await retained.read();await retained.close();checks.push('archival retains native Session and all task/review events');
const makeOwnedRoom=async(principal,id)=>{
 const room=await scope.run(principal,()=>store.create({version:SESSION_FORMAT_VERSION,id:SessionId(id),createdAt:1,isSeeded:false,agentPreset:'hivemind-hyperagent'}));
 await room.append([{type:'hivemind/session-owner',seq:SessionSeq(0),time:Date.now(),data:{id:employee.id,slug:employee.slug,name:employee.name,role:'Specialist'}}]);return room;
};
const roomA=await makeOwnedRoom({...a,userId:b.userId},'same-org-other-owner-room');
const roomB=await makeOwnedRoom(b,'other-org-room');
db.digitalEmployee=adapter(admin).digitalEmployee;
const hostProof=await nativeLifecycleHostProof(db,p,employee.id);
assert.equal(hostProof.chief.sessionId,'session-dummy-chief');assert.deepEqual(hostProof.rooms.map(room=>room.sessionId).sort(),['active-employee-room','native-child-room','same-org-other-owner-room']);checks.push('Core attests same-company rooms across owners and excludes another organization');
await assert.rejects(nativeLifecycleHostProof(db,{orgId:b.orgId,userId:b.userId},employee.id),/native_employee_not_found/);checks.push('native host proof is administrator and tenant bounded');
await admin.query('UPDATE fixture_memberships SET is_active=false WHERE org_id=$1 AND user_id=$2',[a.orgId,a.userId]);
await assert.rejects(nativeLifecycleHostProof(db,p,employee.id),/administrator_membership_required/);checks.push('revoked administrator cannot issue room cleanup attestation');
await roomA.close();await roomB.close();
await writer.close();await pool.end();
const {nativePluginProof}=await import('/source/native-employee-plugins.pg.mjs');
await nativePluginProof({admin,db,principal:a,checks,manageNativeEmployee,assert});
await admin.end();console.log(JSON.stringify({passed:checks.length,checks}));
