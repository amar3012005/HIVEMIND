import test from 'node:test';
import assert from 'node:assert/strict';
process.env.COMPOSIO_API_KEY='fixture';process.env.COMPOSIO_WEBHOOK_SECRET='fixture';
const {reconcileConnectedActivity}=await import('../../src/connectors/composio/hivemind-triggers.js');
let counter=0;
async function run({role='admin',stopped=false,pending=false,newAccount=false}={}){
 const calls=[],writes=[],orgId=`fixture-${++counter}`;
 const type={slug:'SLACK_CHANNEL_MESSAGE_RECEIVED',toolkit:{slug:'slack'},version:'20261002_00',requires_webhook_endpoint_setup:true,config:{type:'object',properties:{}},payload:{type:'object',properties:{text:{type:'string'}}}};
 const db={userOrganization:{findUnique:async()=>({isActive:true,role})},$executeRawUnsafe:async()=>{},$transaction:async f=>f(db),$queryRawUnsafe:async(sql,...args)=>{
  if(sql.includes("status IN ('paused','deleted','pending')"))return pending?[{id:'pending',status:'pending'}]:[];
  if(sql.includes('SELECT * FROM'))return stopped?[{account_id:'account',slug:type.slug,status:'paused'}]:[];
  if(sql.includes('INSERT INTO')){writes.push(args);return[{id:'sub',account_id:'account',slug:type.slug,status:newAccount?'pending':'active',remote_id:newAccount?null:'remote',runtime_attention:true,config:{},version:'20261002_00'}]}
  if(sql.includes('UPDATE hivemind_trigger_subscriptions SET remote_id'))return[{id:'sub',status:'active',remote_id:'remote',runtime_attention:true}];
  return[];
 }};
 const old=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{calls.push({url,method:opts.method,body:opts.body?JSON.parse(opts.body):undefined});let value;
  if(url.includes('connected_accounts?'))value={items:[{id:'account',status:'ACTIVE',toolkit:{slug:'slack'},auth_config:{is_composio_managed:true}}]};
  else if(url.includes('triggers_types?'))value=url.includes('cursor=next')?{items:[{...type,slug:'REQUIRED',config:{type:'object',properties:{channel_id:{type:'string'}},required:['channel_id']}}]}:{items:[type],next_cursor:'next'};
  else if(url.includes('/triggers_types/'))value=type;else if(url.includes('/trigger_instances/'))value={trigger_id:'remote'};else throw Error('Unexpected provider path');
  return new Response(JSON.stringify(value));
 };
 try{return{result:await reconcileConnectedActivity({prisma:db,orgId,userId:'user'}),calls,writes}}finally{globalThis.fetch=old}
}
test('connection reconciliation paginates schemas, enables fresh attention and leaves required IDs unconfigured',async()=>{
 const{result,calls,writes}=await run();assert.equal(result.events[0].status,'active');assert.equal(result.events[1].status,'resource_configuration_required');assert.equal(writes[0][12],true);assert.equal(writes[0][13],false);assert.ok(calls.some(c=>c.url.includes('cursor=next')));assert.ok(calls.every(c=>c.method==='GET'));
});
test('explicit optout never resumes remote trigger',async()=>{const x=await run({stopped:true});assert.equal(x.result.events[0].status,'disabled_by_user');assert.equal(x.writes.length,0)});
test('unknown pending provider write never blindly retried',async()=>{const x=await run({pending:true});assert.equal(x.result.events[0].status,'provider_outcome_unconfirmed');assert.equal(x.writes.length,0)});
test('ordinary member cannot automatically provision organization attention',async()=>{const x=await run({role:'member'});assert.equal(x.result.status,'admin_required');assert.equal(x.calls.length,0)});

test('new authorized account provisions version-pinned provider instance once with account-wide config',async()=>{const x=await run({newAccount:true});const posts=x.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.connected_account_id,'account');assert.deepEqual(posts[0].body.trigger_config,{});assert.equal(posts[0].body.toolkit_versions.slack,'20261002_00');assert.equal(x.result.events[0].status,'active')});
