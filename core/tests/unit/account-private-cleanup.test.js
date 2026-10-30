import test from 'node:test';import assert from 'node:assert/strict';import {erasePrivateConnectorGrants} from '../../src/security/account-private-cleanup.js';import {eraseNativeAccount} from '../../src/security/account-native-erasure.js';
test('private Nango grants deleted; shared provider grant retained for surviving users',async()=>{const removed=[];const db={nangoConnection:{findMany:async()=>[{providerKey:'gmail',connectionId:'private'},{providerKey:'gmail',connectionId:'shared'}],count:async q=>q.where.connectionId==='shared'?1:0,deleteMany:async q=>{assert.equal(q.where.userId,'u');removed.push('local')}}};await erasePrivateConnectorGrants(db,'u',['org'],{eraseComposio:async(u,orgs)=>assert.deepEqual(orgs,['org']),eraseNango:async(p,c)=>removed.push(c)});assert.deepEqual(removed,['private','local']);});
test('provider failure leaves local coordinates for retry',async()=>{let removed=false;const db={nangoConnection:{findMany:async()=>[{providerKey:'gmail',connectionId:'p'}],count:async()=>0,deleteMany:async()=>{removed=true}}};await assert.rejects(erasePrivateConnectorGrants(db,'u',[],{eraseComposio:async()=>{},eraseNango:async()=>{throw Error('outage')}}));assert.equal(removed,false);});
test('native adapter must be configured and return matching operation receipt',async()=>{const old={...process.env};try{delete process.env.ACCOUNT_ERASURE_NATIVE_URL;await assert.rejects(eraseNativeAccount({operationId:'a',workerId:'b'}),e=>e.code==='NATIVE_ERASURE_UNAVAILABLE');process.env.ACCOUNT_ERASURE_NATIVE_URL='http://private/erase';process.env.ACCOUNT_ERASURE_NATIVE_TOKEN='secret';await assert.rejects(eraseNativeAccount({operationId:'a',workerId:'b'},async()=>({ok:true,json:async()=>({verified:true,operationId:'wrong'})})),e=>e.code==='NATIVE_ERASURE_INCOMPLETE');}finally{for(const k of ['ACCOUNT_ERASURE_NATIVE_URL','ACCOUNT_ERASURE_NATIVE_TOKEN']){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]}}});
test('personal notification deliveries are erased using base tables only',async()=>{const removed=[];const db={$queryRawUnsafe:async(sql,...args)=>{assert(sql.includes("table_type='BASE TABLE'"));return[{column_name:'user_id'}]},$executeRawUnsafe:async sql=>{removed.push(sql);return 0}};const {cleanupPrivateAccountRows}=await import('../../src/security/account-private-cleanup.js');await cleanupPrivateAccountRows(db,'u',[]);assert(removed.some(sql=>sql.includes('system_email_deliveries')));assert(!removed.some(sql=>sql.includes('audit_logs')));});
test('private trigger event children are erased before subscriptions; another user is untouched',async()=>{
 const target='11111111-1111-4111-8111-111111111111';const other='22222222-2222-4222-8222-222222222222';
 const rows={events:[{userId:target},{userId:other}],subscriptions:[{userId:target},{userId:other}]};const order=[];
 const db={$queryRawUnsafe:async(_sql,table)=>['hivemind_trigger_events','hivemind_trigger_subscriptions'].includes(table)?[{column_name:'user_id'}]:[],$executeRawUnsafe:async(sql,id)=>{
  assert.equal(id,target);assert.match(sql,/WHERE user_id::text=\$1::text/);
  if(sql.includes('hivemind_trigger_events')){rows.events=rows.events.filter(x=>x.userId!==id);order.push('events');}
  else if(sql.includes('hivemind_trigger_subscriptions')){assert(!rows.events.some(x=>x.userId===id),'subscription FK still has an owned child');rows.subscriptions=rows.subscriptions.filter(x=>x.userId!==id);order.push('subscriptions');}
  return 1;
 }};
 const {cleanupPrivateAccountRows}=await import('../../src/security/account-private-cleanup.js');await cleanupPrivateAccountRows(db,target,[]);
 assert.deepEqual(order,['events','subscriptions']);assert.deepEqual(rows.events,[{userId:other}]);assert.deepEqual(rows.subscriptions,[{userId:other}]);
});
test('exclusive company output cleanup is scoped; shared company output is reassigned first',async()=>{
 const mutations=[];const db={$queryRawUnsafe:async(_sql,table,column)=>column?[{column_name:'org_id'},{column_name:column}]:[{column_name:'user_id'}],$executeRawUnsafe:async(sql,...args)=>{mutations.push({sql,args});return 1}};
 const {cleanupPrivateAccountRows}=await import('../../src/security/account-private-cleanup.js');
 await cleanupPrivateAccountRows(db,'target',[{orgId:'shared',disposition:'retain_shared',remainingMembers:[{userId:'colleague',role:'owner'}]},{orgId:'exclusive',disposition:'delete_exclusive'}]);
 const update=mutations.findIndex(x=>x.sql.includes('UPDATE hivemind.web_intel_jobs'));
 const erase=mutations.findIndex(x=>x.sql.includes('DELETE FROM hivemind.web_intel_jobs'));
 assert(update>=0&&erase>update);assert.deepEqual(mutations[erase].args,['target',['exclusive']]);
 for(const table of ['tara_turns','tara_insights','tara_calls']){const row=mutations.find(x=>x.sql.includes('DELETE FROM hivemind.'+table));assert.deepEqual(row.args,['target',['exclusive']]);assert(mutations.some(x=>x.sql.includes('UPDATE hivemind.'+table)));}
 assert(mutations.some(x=>x.sql.includes('DELETE FROM hivemind.tara_voice_sessions')&&x.args[0]==='target'));
 assert(!mutations.some(x=>x.sql.includes('DELETE FROM hivemind.audit_logs')||x.sql.includes('DELETE FROM hivemind.knowledge_usage_settlements')));
});
test('personal agent runs, meetings, model keys, watches and instructions are erased; Library artifacts only in exclusive companies, versions first',async()=>{
 const mutations=[];const db={$queryRawUnsafe:async(_sql,table,column)=>column?[{column_name:'org_id'},{column_name:column}]:[{column_name:'user_id'}],$executeRawUnsafe:async(sql,...args)=>{mutations.push({sql,args});return 1}};
 const {cleanupPrivateAccountRows}=await import('../../src/security/account-private-cleanup.js');
 await cleanupPrivateAccountRows(db,'target',[{orgId:'shared',disposition:'retain_shared',remainingMembers:[{userId:'colleague',role:'owner'}]},{orgId:'exclusive',disposition:'delete_exclusive'}]);
 const at=table=>mutations.findIndex(x=>x.sql.includes(`DELETE FROM hivemind.${table} `));
 for(const table of ['agent_runs','governed_agent_events','meeting_sessions','meeting_audio_segments','custom_model_providers','hivemind_employee_watches','hivemind_employee_event_deliveries','hq_instructions']){assert(at(table)>=0,table);assert.equal(mutations[at(table)].args[0],'target');}
 assert(at('governed_agent_events')<at('agent_runs'));assert(at('meeting_audio_segments')<at('meeting_sessions'));assert(at('hivemind_employee_event_deliveries')<at('hivemind_employee_watches'));
 assert(at('harness_artifact_versions')>=0&&at('harness_artifact_versions')<at('harness_artifacts'));
 assert.deepEqual(mutations[at('harness_artifacts')].args,['target',['exclusive']]);
 assert(!mutations.some(x=>/UPDATE hivemind\.harness_artifacts|DELETE FROM hivemind\.(ai_usage_events|relationships) /.test(x.sql)));
});
