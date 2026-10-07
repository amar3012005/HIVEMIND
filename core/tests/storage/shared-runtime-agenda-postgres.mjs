// Opt-in disposable PostgreSQL proof of cross-admin Runtime agenda heads.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
const url=process.env.DSH_SHARED_ADMIN_TEST_DATABASE_URL;
if(!url || new URL(url).pathname!=='/shared_admin_test') throw Error('disposable_database_required');
const {saveOperatingMemory,recallOperatingMemory}=await import(process.env.SHARED_CORE_MEMORY_MODULE || '../../src/hyperagents/operating-memory.js');
const pool=new Pool({connectionString:url});
const orgId='67503d34-97e9-49a8-8c52-8ee30cc7603e',a='54f5568b-4d6a-4ae1-9a33-48cb2909d59b',b='64f5568b-4d6a-4ae1-9a33-48cb2909d59b',sessionId='session-canonical';
function adapter(client){return {
 $queryRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rows,
 $executeRawUnsafe:async(sql,...args)=>(await client.query(sql,args)).rowCount,
 project:{upsert:async()=> (await client.query(`INSERT INTO hivemind.projects(id,name,policy) VALUES('17503d34-97e9-49a8-8c52-8ee30cc7603e','Hyper Agents','private') ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,policy`)).rows[0]},
 projectMember:{upsert:async({create})=>client.query('INSERT INTO hivemind.project_members(project_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[create.projectId,create.userId])},
 }}
const prisma={...adapter(pool),$transaction:async work=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await work(adapter(c));await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}};
const options={source:'runtime',runtimeSessionId:sessionId};
const agenda=(key,id,supersedes)=>({kind:'user_agenda',agent_slug:'runtime',title:key,summary:'Confirmed user direction',idempotency_key:id,...(supersedes?{supersedes_id:supersedes}:{}),context:{sessionId,state:'confirmed',priority:70,agendaKey:key,confirmationRef:'event:0'}});
try{
 await pool.query('CREATE TABLE hivemind.projects(id uuid PRIMARY KEY,name text,policy text); CREATE TABLE hivemind.project_members(project_id uuid,user_id uuid,PRIMARY KEY(project_id,user_id))');
 await pool.query(await readFile('/shared-admin-fixtures/operating.sql','utf8'));
 await pool.query(await readFile('/shared-admin-fixtures/decision.sql','utf8'));
 const results=await Promise.allSettled([saveOperatingMemory(prisma,agenda('sales','A-sales'),{orgId,userId:a},options),saveOperatingMemory(prisma,agenda('sales','B-sales'),{orgId,userId:b},options)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected' && r.reason.message==='agenda_supersession_required').length,1);
 const initial=results.find(r=>r.status==='fulfilled').value.memory;
 const opposite=results[0].status==='fulfilled'?b:a;
 await saveOperatingMemory(prisma,agenda('sales','successor-sales',initial.id),{orgId,userId:opposite},options);
 await saveOperatingMemory(prisma,agenda('hiring','hiring'),{orgId,userId:b},options);
 const heads=await recallOperatingMemory(prisma,orgId,{kind:'user_agenda'},{runtimeUserId:a,runtimeSessionId:sessionId});
 assert.equal(heads.count,2);assert.equal(heads.memories.some(m=>m.id===initial.id),false);
 const first=(await pool.query('SELECT author_user_id FROM hivemind.hyper_agent_operating_memories WHERE id=$1',[initial.id])).rows[0];
 assert.notEqual(first.author_user_id,opposite);
 assert.equal((await recallOperatingMemory(prisma,orgId,{},{})).count,0);
 await assert.rejects(saveOperatingMemory(prisma,{...agenda('bad','bad'),context:{...agenda('bad','bad').context,sessionId:'session-other'}},{orgId,userId:a},options),/runtime_memory_scope_required/);
 console.log('PASS: concurrent admins share one agenda head; cross-admin supersession; independent goals; original author preserved; ordinary recall excludes private types; wrong room rejected');
}finally{await pool.end()}
