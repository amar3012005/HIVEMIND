import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cpSource = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
const broadcastSource = cpSource.slice(cpSource.indexOf("  if (pathname === '/v1/notifications/broadcast'"), cpSource.indexOf("  if (pathname === '/v1/orgs' && req.method === 'POST')"));
const broadcast = new AsyncFunction('bindings', `const {pathname,req,res,requireSession,requireOrgAdmin,parseBody,prisma,jsonResponse,sendSystemEmailBatch}=bindings; ${broadcastSource}`);

for (const dryRun of [true, false]) test(`broadcast scopes ${dryRun ? 'dry run' : 'live dispatch'} to active organization members`, async () => {
  let query;
  let recipients;
  const result = await broadcast({
    pathname: '/v1/notifications/broadcast', req: {method:'POST'}, res: {},
    requireSession: async () => ({session:{orgId:'org-a',userId:'admin-a'}}),
    requireOrgAdmin: async () => ({}), parseBody: async () => ({subject:'Account notice',body:'Expected notice',dryRun}),
    prisma:{user:{findMany:async input=>{
      query=input;
      const rows=[{email:'a@example.test',displayName:'A',orgId:'org-a',active:true},{email:'b@example.test',displayName:'B',orgId:'org-b',active:true},{email:'inactive@example.test',orgId:'org-a',active:false}];
      const scope=input.where.organizations.some;
      return rows.filter(row=>row.orgId===scope.orgId && row.active===scope.isActive);
    }}}, jsonResponse:(_res,data,status=200)=>({data,status}),
    sendSystemEmailBatch:async rows=>{recipients=rows;return {total:rows.length,sent:rows.length,failed:0,skipped:0};},
  });
  assert.deepEqual(query.where.organizations,{some:{orgId:'org-a',isActive:true}});
  assert.equal(query.where.email,undefined,'nonnullable User.email rejects not:null in real Prisma');
  assert.equal(result.status,200);
  if(dryRun) {assert.equal(result.data.recipientCount,1);assert.deepEqual(result.data.sample,['a@example.test']);assert.equal(recipients,undefined);}
  else assert.deepEqual(recipients.map(row=>row.email),['a@example.test']);
});

test('broadcast refuses missing organization before querying users',async()=>{
  const result=await broadcast({pathname:'/v1/notifications/broadcast',req:{method:'POST'},res:{},requireSession:async()=>({session:{userId:'a'}}),jsonResponse:(_r,data,status)=>({data,status}),prisma:{user:{findMany:()=>assert.fail('must not query')}}});
  assert.equal(result.status,400);
});

test('broadcast denied administrator has no recipient query or dispatch',async()=>{
  const result=await broadcast({pathname:'/v1/notifications/broadcast',req:{method:'POST'},res:{},requireSession:async()=>({session:{userId:'member',orgId:'org-a'}}),requireOrgAdmin:async()=>null,prisma:{user:{findMany:()=>assert.fail('must not query')}},sendSystemEmailBatch:()=>assert.fail('must not dispatch')});
  assert.equal(result,undefined);
});

