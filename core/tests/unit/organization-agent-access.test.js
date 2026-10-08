import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationAgentAccess } from '../../src/harness-chat/organization-agent-access.js';
const orgId='67503d34-97e9-49a8-8c52-8ee30cc7603e';
const first='54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const second='64f5568b-4d6a-4ae1-9a33-48cb2909d59b';
function db(role='admin', extras={}) {
  return { userOrganization:{findUnique:async({where})=>where.userId_orgId.orgId===orgId?({role,isActive:true,...extras}):null},
    user:{findUnique:async({where})=>({displayName:where.id===first?'Amar':'Second admin',deletedAt:null})},
    $queryRawUnsafe:async(_query, org)=>org===orgId?[{session_id:'session-canonical',user_id:first}]:[] };
}
test('two active admins resolve the same organization agent, preserving each human actor',async()=>{
  const a=await organizationAgentAccess(db('owner'),{orgId,userId:first});
  const b=await organizationAgentAccess(db(),{orgId,userId:second});
  assert.deepEqual(a.agent,b.agent);
  assert.equal(a.actor.user_id,first); assert.equal(b.actor.user_id,second);
  assert.equal(b.actor.name,'Second admin'); assert.equal(b.agent.storage_user_id,first);
});
for(const [role,extras] of [['member',{}],['admin',{isActive:false}],['admin',{deactivatedAt:new Date()}]]) {
  test(`denies ${role} ${JSON.stringify(extras)}`,async()=>{
    const mock=db(role,extras); mock.$queryRawUnsafe=()=>{throw Error('must not read agent storage');};
    await assert.rejects(organizationAgentAccess(mock,{orgId,userId:first}),/organization_agent_admin_required/);
  });
}
test('deleted user is denied',async()=>{
  const mock=db(); mock.user.findUnique=async()=>({deletedAt:new Date()});
  await assert.rejects(organizationAgentAccess(mock,{orgId,userId:first}),/organization_agent_admin_required/);
});
test('wrong organization cannot discover the canonical room',async()=>{
  await assert.rejects(organizationAgentAccess(db(),{orgId:'77503d34-97e9-49a8-8c52-8ee30cc7603e',userId:first}),/organization_agent_admin_required/);
});
test('invalid identities and schema fail before storage',async()=>{
  await assert.rejects(organizationAgentAccess(db(),{orgId,userId:'browser-name'}),/invalid_agent_actor/);
  await assert.rejects(organizationAgentAccess(db(),{orgId,userId:first},{schema:'public;DROP'}),/invalid_agent_schema/);
});

test('canonical session guard permits shared agents and refuses same-owner personal Brain',async()=>{
  const {organizationAgentSessionAccess}=await import('../../src/harness-chat/organization-agent-access.js');
  const headers={ 'session-canonical':{preset:'hivemind-hq',header:{}}, 'session-employee':{preset:'hivemind-hyperagents',header:{}},
    'session-private':{preset:'hivemind-chat',header:{}},'session-child':{preset:'native-child',header:{parentSession:'session-employee'}} };
  const tx={$queryRawUnsafe:async(sql,...args)=> {
    if(sql.includes('set_config')) return [];
    if(sql.includes('organization_agent_storage_scope')) return [{storage_user_id:first,runtime_session_id:'session-canonical'}];
    if(sql.includes('FROM hivemind.harness_company_hq')) return [{session_id:'session-canonical'}];
    return headers[args[0]]?[headers[args[0]]]:[];
  }};
  const mock={$transaction:async work=>work(tx)};
  for(const id of ['session-canonical','session-employee','session-child']) assert.equal(await organizationAgentSessionAccess(mock,{orgId,userId:second,sharedOrganizationAgents:true},id),true);
  assert.equal(await organizationAgentSessionAccess(mock,{orgId,userId:second,sharedOrganizationAgents:true},'session-private'),false);
});

test('fresh organization uses one initial storage principal for every admin without starting Runtime',async()=>{
  const mock=db();mock.$queryRawUnsafe=async()=>[];
  mock.$transaction=async work=>work({$queryRawUnsafe:async sql=>sql.includes('organization_agent_storage_scope')?[{storage_user_id:first,runtime_session_id:null}]:[]});
  const a=await organizationAgentAccess(mock,{orgId,userId:first});
  const b=await organizationAgentAccess(mock,{orgId,userId:second});
  assert.deepEqual(a.agent,b.agent);assert.equal(a.agent.runtime_session_id,null);
  assert.equal(b.actor.user_id,second);assert.equal(b.agent.storage_user_id,first);
});
