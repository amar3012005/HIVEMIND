/** A dummy administrator answer through the real native question/inbox/persistence seams. */
export async function nativeSetupProof({ctx,scope,principal,db,chief,checks,manageNativeEmployee,nativeLifecycleHostProof,assert,documents}) {
 const repo='/opt/deepseek-harness',load=path=>import(`${repo}/${path}`);
 const {SessionId}=await load('packages/core/session/lib/index.js');
 const {RoomMessaging}=await load('packages/api/session-controller/src/room-messaging.ts');
 const {defineTool}=await load('packages/core/tools/lib/index.js');
 const {MockAdapter,textResponse,toolCallResponse}=await load('packages/core/agent-loop/tests/mock-adapter.ts');
 const {default:Questions}=await load('packages/interaction/user-questions/lib/index.js');
 const Ask=await load('packages/interaction/tool-ask-user/lib/index.js');
 const {employeeProfileTool,employeeLifecycleTool}=await load('packages/hivemind/runtime/src/employee-lifecycle.ts');
 const Host=await load('packages/hivemind/hq-runtime/src/lifecycle-host.ts');
 const {activateNativeEmployeeLifecycle}=await import('/source/native-lifecycle-bridge.js');
 const {createServer}=await import('node:http');
 const setup=(await manageNativeEmployee(db,{orgId:principal.orgId,userId:principal.userId},
  {operation:'create',creation_key:'actual-native-onboarding',name:'Dummy Alex'},{now:0})).employee;
 let answer,asked=0,worker,activate;let confirmed=0,contextReads=0,reports=0;
 const pending=new Promise(resolve=>{answer=resolve;});
 await ctx.plugin(Questions);await ctx.plugin(Ask);
 ctx.on('user-questions/request',async request=>{
  assert.equal(request.agent,worker);assert.equal(request.questions[0].id,'responsibilities');asked+=1;return pending;
 });
 ctx.llm.registerAdapter(['setup-fixture'],new MockAdapter([
  toolCallResponse('setup-question','ask_user_question',{questions:[{id:'responsibilities',question:'Which responsibility should I own?',
   options:[{label:'Evidence research',description:'Review the evidence already available.'},{label:'Other',description:'Describe a responsibility.'}]}]},'Hello, I am Dummy Alex. How can I help our team?'),
  toolCallResponse('setup-profile','hivemind_employee_profile',{expected_profile_revision:1,role:'Evidence Research',persona:'Own the evidence research agreed by the administrator; existing permissions stay unchanged.'}),
  textResponse('I will own evidence research. Runtime will confirm my profile.'),
  toolCallResponse('setup-read-context','fixture_company_context',{}),
  toolCallResponse('setup-report','fixture_report_runtime',{}),
  textResponse('I have reviewed the saved company context and recommend a bounded evidence check. I will await approval.'),
 ]));
 const open=async key=>{
  if(key==='runtime')return chief;
  assert.equal(key,setup.id);
  if(worker)return worker;
  worker=await ctx.agentLoop.create(SessionId(`session-onboarding-${setup.id}`),{provider:'setup-fixture',model:'mock'});
  worker.session.append('agent-preset/selected',{agentPreset:'hivemind-hyperagents'});
  worker.session.append('hivemind/session-owner',{id:setup.id,slug:setup.slug,name:setup.name,role:setup.roleArchetype});
  await ctx.sessions.flush(worker.session);return worker;
 };
 const messaging=new RoomMessaging(ctx,open);
 Object.assign(ctx.sessionController,{resolvePersistentEmployeeRoom:messaging.resolveRoom.bind(messaging),
  deliverAgentMessage:messaging.send.bind(messaging),resolveAgent:async id=>{assert.equal(id,chief.id);return {agent:chief};}});
 ctx.tools.register(defineTool({name:'hivemind_research_answer',description:'Unused fixture public research capability for native restriction.',parameters:{},output:{schema:{type:'object',additionalProperties:true,properties:{}}},isConcurrencySafe:()=>true,execute:async()=>{throw Error('unexpected fixture research');}}));
 ctx.tools.register(defineTool({name:'fixture_company_context',description:'Read authorized dummy company and actual saved fixture documents.',parameters:{},output:{schema:{type:'object',additionalProperties:true,properties:{}}},isConcurrencySafe:()=>true,execute:async()=>{contextReads++;assert.ok(JSON.stringify(documents).includes('isolated fixture verification'));return {company:'Dummy isolated organization',documents};}}));
 ctx.tools.register(defineTool({name:'fixture_report_runtime',description:'Report the inspected dummy context through real native room messaging.',parameters:{},output:{schema:{type:'object',additionalProperties:true,properties:{}}},isConcurrencySafe:()=>false,execute:async()=>{assert.equal(contextReads,1);reports++;return messaging.send(worker,{key:'setup-first-context-report',target:'runtime',kind:'update',text:'I inspected our saved context and brief. I recommend a bounded evidence review and will await approval.'},new AbortController().signal);}}));
 ctx.tools.register(employeeProfileTool(async(agent,input)=>{
  assert.equal(asked,1);assert.equal(agent,worker);
  const receipt=await manageNativeEmployee(db,{orgId:principal.orgId,userId:principal.userId,
   employeeSessionId:agent.session.id,employeeId:setup.id},input);
  await activate();return JSON.parse(JSON.stringify(receipt));
 }));
 ctx.llm.registerAdapter(['mock'],new MockAdapter([
  toolCallResponse('chief-complete-profile','hivemind_employee_lifecycle',{operation:'configure',employee_id:setup.id,expected_profile_revision:2,role:'Evidence Research',persona:'Company-relevant evidence research instructions. Inspect current sources and artifacts; propose useful bounded work; preserve existing permissions.'}),
  textResponse('Welcome to our team. Your evidence research responsibilities are confirmed.'),
 ]));
 ctx.tools.register(employeeLifecycleTool(async(agent,input)=>{
  assert.equal(agent,chief);const receipt=await manageNativeEmployee(db,{orgId:principal.orgId,userId:principal.userId,runtimeSessionId:chief.id},input);
  confirmed+=1;await activate();return JSON.parse(JSON.stringify(receipt));
 }));
 ctx.on('hivemind/employee-lifecycle-proof',request=>nativeLifecycleHostProof(db,
  {orgId:scope.require().orgId,userId:scope.require().userId},request.employeeId));
 const server=createServer();
 ctx.provide('webServer',{register:({handler})=>{server.on('request',handler);return()=>{};}});
 process.env.SETUP_FIXTURE_SECRET='dummy-onboarding-service-secret-at-least-32';
 Host.apply(ctx,{enabled:true,serviceSecretEnv:'SETUP_FIXTURE_SECRET'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const env={HIVE_HARNESS_RUNNER_SERVICE_SECRET:process.env.SETUP_FIXTURE_SECRET,
   HIVEMIND_EMPLOYEE_LIFECYCLE_URL:`http://127.0.0.1:${server.address().port}/internal/hivemind/employee-lifecycle`};
  const create=()=>activateNativeEmployeeLifecycle({orgId:principal.orgId,userId:principal.userId},setup,{env});
  activate=create;
  const admitted=await create();assert.equal(admitted.status,'ready');
  for(let n=0;n<100&&!asked;n++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(asked,1);assert.ok(worker.session.ownEvents().some(event=>event.type==='turn/start')); 
  const before=await db.$transaction(tx=>tx.digitalEmployee.findFirst({where:{id:setup.id,orgId:principal.orgId}}));
  assert.equal(before.policyRules.native_lifecycle.profile_revision,1);
  assert.equal((await create()).status,'ready');assert.equal(asked,1);
  answer({answers:[{id:'responsibilities',selected:['Evidence research']}]});
  for(let n=0;n<100&&!worker.session.ownEvents().some(event=>event.type==='turn/end');n++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(worker.session.ownEvents().some(event=>event.type==='turn/end'));
  await ctx.sessions.flush(worker.session);
  for(let n=0;n<100&&!worker.session.ownEvents().some(event=>event.type==='hivemind/employee-selection' && event.data.joining);n++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(confirmed,1,JSON.stringify({chief:chief.session.ownEvents().filter(e=>['tool/result','turn/end'].includes(e.type)).slice(-4),worker:worker.session.ownEvents().filter(e=>['tool/result','turn/end'].includes(e.type)).slice(-4)}));
  for(let n=0;n<100&&!reports;n++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(contextReads,1);assert.equal(reports,1);
  const milestones=worker.session.ownEvents().filter(event=>event.type==='hivemind/employee-selection' && event.data.joining);
  assert.equal(milestones.length,1);
  const after=await db.$transaction(tx=>tx.digitalEmployee.findFirst({where:{id:setup.id,orgId:principal.orgId}}));
  assert.equal(after.roleArchetype,'Evidence Research');assert.equal(after.policyRules.native_lifecycle.profile_revision,3);
  assert.equal(after.policyRules.native_lifecycle.onboarding_required,false);assert.deepEqual(after.tools,[]);assert.deepEqual(after.enabledConnectors,[]);
  assert.equal((await create()).status,'ready');assert.equal(asked,1);
  const retained=await ctx.sessionPersistence.open(worker.id,'read');const history=await retained.read();await retained.close();
  assert.ok(JSON.stringify(history).includes('How can I help our team?'));
  checks.push('actual signed creation callback starts one persistent native employee greeting and native responsibility question');
  checks.push('actual Chief profile completion, accepted native welcome and once-only joining milestone');
  checks.push('actual administrator answer precedes saved own-profile refinement with unchanged permissions and retained native history');
 } finally {await new Promise(resolve=>server.close(()=>resolve()));delete process.env.SETUP_FIXTURE_SECRET;}
}
