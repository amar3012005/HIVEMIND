/** Read-only actual event + fresh native context + real classifier. Never admits or writes. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [orgId,userId,eventId,authorization]=process.argv.slice(2);
if(![orgId,userId].every(v=>/^[0-9a-f-]{36}$/i.test(v||'')) || !eventId || eventId.length>300
  || authorization!=='--authorize-owner-event-shadow')throw Error('explicit_owner_shadow_authorization_required');
const root=process.env.HIVEMIND_CANARY_CORE_ROOT || resolve(import.meta.dirname,'..');
const load=p=>import(pathToFileURL(resolve(root,p)).href);
const {getPrismaClient}=await load('src/db/prisma.js');
const {runtimeAttentionToken}=await load('src/connectors/composio/runtime-attention-bridge.js');
const {assessRuntimeAttention}=await load('src/connectors/composio/runtime-attention.js');
const {createOpenRouterJevProvider}=await load('src/agent/decision-gateway.js');
const {decisionGatewayProviderConfig}=await load('src/agent/decision-gateway-service.js');
const db=getPrismaClient();
try{
 const rows=await db.$queryRawUnsafe(`SELECT e.*,s.toolkit FROM hivemind.hivemind_trigger_events e
  JOIN hivemind.hivemind_trigger_subscriptions s ON s.id=e.subscription_id
  JOIN hivemind.harness_company_hq h ON h.org_id::text=e.org_id AND h.user_id::text=e.user_id
  WHERE e.id=$1 AND e.org_id=$2 AND e.user_id=$3 AND s.org_id=e.org_id AND s.user_id=e.user_id
   AND s.status='active' AND s.runtime_attention AND e.received_at>=s.runtime_attention_enabled_at`,eventId,orgId,userId);
 if(rows.length!==1)throw Error('existing_owner_opted_in_event_required');
 const event=rows[0];
 const response=await fetch(process.env.HIVEMIND_RUNTIME_ATTENTION_URL,{method:'POST',headers:{'content-type':'application/json',
  authorization:`Bearer ${runtimeAttentionToken(event,'context',process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET)}`},
  body:JSON.stringify({operation:'context',eventId,orgId,userId})});
 const context=await response.json();
 if(response.status!==200 || context.snapshot?.decisionMemory?.ready!==true)throw Error(`fresh_native_direction_unavailable_http_${response.status}`);
 let providerDecision;
 const gateway=createOpenRouterJevProvider({...decisionGatewayProviderConfig(),timeoutMs:10000,siteName:'HIVEMIND owner event shadow canary'});
 const provider={decideChoice:async input=>{providerDecision=await gateway.decideChoice(input);return providerDecision;}};
 const result=await assessRuntimeAttention({event,snapshot:context.snapshot,consent:context.consent,provider,mode:'shadow'});
 console.log(JSON.stringify({readOnly:true,actualStoredProviderEvent:true,eventReceivedAt:event.received_at,
  contextRevision:context.snapshot.revision,privateMemoryRevision:context.snapshot.decisionMemory.revision,
  agendaHeads:context.snapshot.decisionMemory.userAgenda.length,openUncertainties:context.snapshot.decisionMemory.uncertainties.length,
  activationCutoff:context.snapshot.admissionWindow?.notBefore,policy:result.policy,action:result.action,reason:result.reason,
  providerChoice:providerDecision?.choice,probability:providerDecision?.probability,margin:providerDecision?.margin,
  eventLedgerWrites:0,nativeAdmissions:0}));
 if(result.policy!=='runtime_attention_v2_shadow' || !providerDecision)process.exitCode=1;
}finally{await db.$disconnect();}
