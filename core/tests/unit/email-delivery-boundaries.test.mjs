import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sendEmail, buildInviteEmail, escapeEmailHtml } from '../../src/services/email-sender.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cpSource = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
const coreSource = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
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
  assert.equal(result.status,200);
  if(dryRun) {assert.equal(result.data.recipientCount,1);assert.deepEqual(result.data.sample,['a@example.test']);assert.equal(recipients,undefined);}
  else assert.deepEqual(recipients.map(row=>row.email),['a@example.test']);
});

test('broadcast refuses missing organization before querying users',async()=>{
  const result=await broadcast({pathname:'/v1/notifications/broadcast',req:{method:'POST'},res:{},requireSession:async()=>({session:{userId:'a'}}),jsonResponse:(_r,data,status)=>({data,status}),prisma:{user:{findMany:()=>assert.fail('must not query')}}});
  assert.equal(result.status,400);
});

test('legacy sender uses Cloudflare receipt and does not escape suppressed request',async()=>{
  const saved=global.fetch;
  const keys=['CLOUDFLARE_EMAIL_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','SYSTEM_EMAIL_NANGO_CONNECTION_ID'];
  const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN='isolated-token';process.env.CLOUDFLARE_ACCOUNT_ID='isolated-account';process.env.SYSTEM_EMAIL_NANGO_CONNECTION_ID='isolated-fallback';
    let calls=0;
    global.fetch=async(url,init)=>{
      calls++;assert.match(url,/api.cloudflare.com.*email\/sending\/send$/);
      const body=JSON.parse(init.body);assert.equal(body.text,'Plaintext');
      return new Response(JSON.stringify({result:{queued:['a@example.test'],message_id:'receipt-a'}}),{status:200});
    };
    const accepted=await sendEmail({to:'a@example.test',subject:'Account notice',html:'<p>Plaintext</p>',text:'Plaintext'});
    assert.equal(accepted.ok,true);assert.equal(accepted.id,'receipt-a');assert.equal(accepted.deliveryStatus,'queued');assert.equal(calls,1);
    global.fetch=async()=>{calls++;return new Response(JSON.stringify({errors:[{code:'E_RECIPIENT_SUPPRESSED'}]}),{status:400});};
    const rejected=await sendEmail({to:'a@example.test',subject:'Account notice',html:'<p>Plaintext</p>',text:'Plaintext'});
    assert.equal(rejected.ok,false);assert.equal(rejected.permanent,true);assert.equal(rejected.reason,'cloudflare_E_RECIPIENT_SUPPRESSED');assert.equal(calls,2);
  }finally{global.fetch=saved;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
});

test('invitation HTML escapes context while preserving plaintext and invite URL',()=>{
  const rendered=buildInviteEmail({orgName:'A <B>',inviteUrl:'https://example.test/join?x=1&y=2',inviterEmail:'<admin>',projectNames:['<project>'],teamNames:['<team>'],role:'<role>'});
  assert.match(rendered.html,/A &lt;B&gt;/);assert.match(rendered.html,/&lt;project&gt;/);assert.match(rendered.html,/href="https:\/\/example.test\/join\?x=1&amp;y=2"/);
  assert.match(rendered.text,/A <B>/);assert.match(rendered.text,/https:\/\/example.test\/join\?x=1&y=2/);
});

test('meeting route counts acceptance and rejection separately',async()=>{
  const start=coreSource.indexOf("      if (pathname === '/api/meetings/invite'");
  const end=coreSource.indexOf('      // GET /api/meetings/:id',start);
  const route=coreSource.slice(start,end).replace("await import('./services/email-sender.js')",'bindings.sender');
  const execute=new AsyncFunction('bindings',`const {pathname,req,res,body,_mOrgId,prisma,jsonResponse}=bindings; ${route}`);
  const result=await execute({pathname:'/api/meetings/invite',req:{method:'POST'},res:{},_mOrgId:'org-a',body:{title:'<meeting>',participants:[{email:'a@example.test',name:'<Alice>'},{email:'b@example.test'}]},prisma:{organization:{findUnique:async()=>({name:'<Company>'})}},sender:{escapeEmailHtml,sendEmail:async input=>{assert.doesNotMatch(input.html,/<meeting>|<Alice>|<Company>/);return {ok:input.to==='a@example.test'};}},jsonResponse:(_r,data)=>data});
  assert.equal(result.sent,1);assert.equal(result.failed,1);assert.equal(result.ok,false);assert.equal(result.delivery_status,'accepted');
});


test('broadcast denied administrator has no recipient query or dispatch',async()=>{
  const result=await broadcast({pathname:'/v1/notifications/broadcast',req:{method:'POST'},res:{},requireSession:async()=>({session:{userId:'member',orgId:'org-a'}}),requireOrgAdmin:async()=>null,prisma:{user:{findMany:()=>assert.fail('must not query')}},sendSystemEmailBatch:()=>assert.fail('must not dispatch')});
  assert.equal(result,undefined);
});

test('legacy sender reports disabled configuration without counting acceptance',async()=>{
  const keys=['CLOUDFLARE_EMAIL_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','SYSTEM_EMAIL_NANGO_CONNECTION_ID'];
  const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const saved=global.fetch;
  try {
    for(const k of keys)delete process.env[k];global.fetch=()=>assert.fail('must not send');
    const receipt=await sendEmail({to:'a@example.test',subject:'Invite',text:'Plaintext'});
    assert.equal(receipt.ok,false);assert.equal(receipt.reason,'no_email_provider');assert.equal(receipt.skipped,true);
  }finally{global.fetch=saved;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
});
