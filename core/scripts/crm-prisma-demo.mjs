/** Real Prisma 5.22 driver acceptance against synthetic loopback fixtures only.
 * Generate a scratch client matching Core's Prisma version; never loads production env.
 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {AppRuntimeStore} from '../src/app-runtime/store.js';
import {EXAMPLE_CRM_SPEC} from '../src/app-runtime/contract.js';
import {createPrismaAppRuntimeTransactionRunner} from '../src/app-runtime/prisma-transaction.js';
const url=new URL(process.env.CRM_PRISMA_DEMO_DATABASE_URL??'');
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/crm_demo_[a-z0-9_]+$/.test(url.pathname)||!url.username.startsWith('crm_demo_app_')) throw new Error('Isolated non-superuser loopback demo database required');
if(!process.env.CRM_PRISMA_DEMO_CLIENT_MODULE) throw new Error('Scratch generated Prisma5.22 client required');
const {PrismaClient,Prisma}=await import(pathToFileURL(process.env.CRM_PRISMA_DEMO_CLIENT_MODULE));
assert.equal(Prisma.prismaVersion.client,'5.22.0');
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
const C={orgId:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001'};
const D={orgId:'10000000-0000-4000-8000-000000000002',userId:'20000000-0000-4000-8000-000000000002'};
const prefix=`prisma522-${Date.now()}`;const checks=[];
try{
 const [role]=await db.$queryRawUnsafe('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
 const store=new AppRuntimeStore({transactionRunner:createPrismaAppRuntimeTransactionRunner(db)});
 const spec=EXAMPLE_CRM_SPEC; const input={spec,operationId:`${prefix}-draft`};
 const {app}=await store.createDraft(C,input);
 assert.equal((await store.createDraft(C,input)).app.id,app.id);
 await assert.rejects(()=>store.createDraft(C,{...input,spec:{...spec,name:'Conflicting'}}),e=>e.code==='idempotency_conflict');
 checks.push('Actual Prisma 5.22 non-superuser transaction adapter: draft + durable replay + operation conflict');
 assert.equal((await store.validate(C,app.id)).valid,true);
 await store.publish(C,app.id,{expectedVersion:1,operationId:`prefix-publish-${prefix}`});
 const {record:company}=await store.writeRecord(C,app.id,{entityId:'company',data:{name:'Synthetic Prisma Company'},operationId:`${prefix}-company`});
 const {record:contact}=await store.writeRecord(C,app.id,{entityId:'contact',data:{name:'Synthetic Contact',company:company.id},operationId:`${prefix}-contact`});
 assert.equal(contact.data.company,company.id);
 const {record:updated}=await store.writeRecord(C,app.id,{expectedVersion:1,data:{name:'Updated Contact'},operationId:`${prefix}-contact-update`},contact.id);assert.equal(updated.version,2);assert.equal(updated.data.company,company.id);
 assert.equal((await store.queryRecords(C,app.id,{entityId:'contact'})).records[0].id,contact.id);
 await assert.rejects(()=>store.writeRecord(C,app.id,{expectedVersion:1,data:{name:'Stale'},operationId:`${prefix}-stale`},contact.id),e=>e.code==='version_conflict');
 checks.push('Actual driver: publish, typed records, reference integrity, partial update, query, optimistic record conflict');
 const spec2={...spec,name:'Prisma Published Workspace'};
 await store.patch(C,app.id,{expectedVersion:1,spec:spec2,operationId:`${prefix}-patch`});
 assert.equal((await store.getPublished(C,app.id)).app.version,1);
 await store.publish(C,app.id,{expectedVersion:2,operationId:`${prefix}-publish2`});
 assert.equal((await store.list(C,{published:true})).apps.find(a=>a.id===app.id).name,spec2.name);
 assert.equal((await store.getPublished(C,app.id)).app.version,2);
 assert.deepEqual((await store.queryWorkflowReceipts(C,app.id)).workflows,[]);
 await assert.rejects(()=>store.get(D,app.id),e=>e.code==='not_found');
 checks.push('Actual driver: immutable published projection, compatible spec update, HQ receipt query, foreign-tenant denial');
 const outcomes=await Promise.allSettled(['a','b'].map(n=>store.patch(C,app.id,{expectedVersion:2,spec:{...spec2,name:`Prisma Concurrent ${n}`},operationId:`${prefix}-race-${n}`})));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='version_conflict').length,1);
 checks.push('Actual driver: concurrent expected-version updates admit exactly one winner');
 const report={driver:Prisma.prismaVersion.client,database:'isolated PostgreSQL loopback',checks,appId:app.id,scope:'Actual generated Prisma client and real service adapter. Synthetic identity fixtures only; no production server or connector execution.'};
 if(process.env.CRM_PRISMA_DEMO_REPORT)await writeFile(process.env.CRM_PRISMA_DEMO_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await db.$disconnect();}
