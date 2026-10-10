import { attentionEventIdentity } from './attention-event-identity.js';
/** Source adapters share the existing durable event ledger and attention policy. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {ensureTriggerStore} from './composio/hivemind-triggers.js';
import {classifyPendingActivity} from './composio/activity-relevance.js';
const fail=(code,status=403)=>{const error=new Error(code);error.status=status;throw error};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function activeSignalAdmin(db,userId,orgId){
 if(!uuid(userId)||!uuid(orgId))fail('signal_scope_required');
 const member=await db.userOrganization.findUnique({where:{userId_orgId:{userId,orgId}},select:{role:true,isActive:true,deactivatedAt:true}});
 const user=await db.user.findUnique({where:{id:userId},select:{deletedAt:true}});
 if(!member?.isActive||member.deactivatedAt||!['owner','admin'].includes(member.role)||!user||user.deletedAt)fail('signal_admin_required');
}
export async function resolveNativeSlackSource(db,payload){
 const team=payload?.team_id;if(typeof team!=='string'||!/^T[A-Z0-9]+$/.test(team))fail('slack_workspace_required',400);
 const rows=await db.platformIntegration.findMany({where:{platformType:'slack',isActive:true,connectorMetadata:{path:['provider_metadata','team_id'],equals:team}}});
 if(rows.length!==1)fail('slack_workspace_ambiguous');
 const connection=rows[0],orgId=connection.connectorMetadata?.attention_org_id;
 if(orgId)await activeSignalAdmin(db,connection.userId,orgId);
 return {connection,orgId:orgId??null,teamId:team,accountId:'native:slack:'+connection.id};
}
export async function retainAdmittedSignal(db,{source,orgId,userId,accountId,identity,data,occurredAt=null},classify=classifyPendingActivity){
 await activeSignalAdmin(db,userId,orgId);await ensureTriggerStore(db);
 const digest=createHash('sha256').update(JSON.stringify([source,orgId,userId,accountId])).digest('hex');
 const subId=digest.slice(0,8)+'-'+digest.slice(8,12)+'-4'+digest.slice(13,16)+'-8'+digest.slice(17,20)+'-'+digest.slice(20,32);
 const config={source,account_id:accountId,...(source==='native_slack'?data._source:{})};
 await db.$executeRawUnsafe(`INSERT INTO hivemind_trigger_subscriptions
 (id,org_id,user_id,account_id,toolkit,slug,subject,config_key,config,config_schema,payload_schema,version,status,runtime_attention,runtime_attention_revision,runtime_attention_enabled_at)
 VALUES($1::uuid,$2,$3,$4,$5,$6,$3,$7,$8::jsonb,'{}','{}','native-v1','active',true,1,now()) ON CONFLICT(org_id,user_id,account_id,slug,config_key) DO NOTHING`,subId,orgId,userId,accountId,source==='native_slack'?'slack':'dreaming',source==='native_slack'?'NATIVE_SLACK_EVENT':'NATIVE_DREAM_OUTPUT',digest,JSON.stringify(config));
 const subs=await db.$queryRawUnsafe("SELECT id,status,runtime_attention FROM hivemind_trigger_subscriptions WHERE id=$1::uuid AND org_id=$2 AND user_id=$3",subId,orgId,userId);
 if(subs[0]?.status!=='active'||subs[0]?.runtime_attention!==true)return {accepted:true,quiet:'source_paused'};
 const id=attentionEventIdentity(source==='native_slack'?'slack':source,data,orgId,userId,'native:'+source+':'+createHash('sha256').update(identity+':'+subId).digest('hex'));
 await db.$executeRawUnsafe(`INSERT INTO hivemind_trigger_events(id,subscription_id,org_id,user_id,data,occurred_at)
 VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6::timestamptz) ON CONFLICT(id) DO NOTHING`,id,subId,orgId,userId,JSON.stringify(data),occurredAt);
 classify({prisma:db,orgId,userId,allowedAccountIds:[accountId]});return {accepted:true,eventId:id};
}
/** OAuth proves the installing Slack identity only; it never identifies other message authors. */
export async function nativeSlackSender(db, source, event) {
 const slackUserId = event.user;
 const oauthUserId = source.connection.connectorMetadata?.provider_metadata?.authed_user_id;
 if (!slackUserId || slackUserId !== oauthUserId || event.bot_id || event.app_id)
  return {verified:false,providerUserId:slackUserId??null};
 const member = await db.userOrganization.findUnique({where:{userId_orgId:{userId:source.connection.userId,orgId:source.orgId}},select:{role:true,isActive:true,deactivatedAt:true}});
 const user = await db.user.findUnique({where:{id:source.connection.userId},select:{displayName:true,deletedAt:true}});
 if(!member?.isActive||member.deactivatedAt||!['owner','admin'].includes(member.role)||!user||user.deletedAt)
  return {verified:false,providerUserId:slackUserId};
 return {verified:true,providerUserId:slackUserId,userId:source.connection.userId,orgId:source.orgId,role:member.role,name:user.displayName??null,verification:'slack_oauth_subject'};
}
export async function admitNativeSlackSignal(db,payload,source,classify){
 const ev=payload.event??{};if(!source.orgId)return {accepted:true,quiet:'org_binding_required'};
 const activated=Date.parse(source.connection.connectorMetadata?.attention_enabled_at??'');
 if(!Number.isFinite(activated))return {accepted:true,quiet:'activation_window_required'};
 if(!payload.event_id||!['message','app_mention','reaction_added','reaction_removed','pin_added','pin_removed'].includes(ev.type))return {accepted:true,quiet:'unsupported_or_noise'};
 if(ev.metadata?.event_type==='hivemind_runtime_output')return {accepted:true,quiet:'runtime_output_loop'};
 const channel=ev.channel??ev.item?.channel;
 if(!channel)return {accepted:true,quiet:'empty_event'};
 const text=typeof ev.text==='string'?ev.text:`Slack ${ev.type} activity${ev.reaction?' ('+String(ev.reaction).slice(0,80)+')':''}`;
 const ts=Number(ev.event_ts??ev.ts);const occurredAt=Number.isFinite(ts)?new Date(ts*1000).toISOString():null;
 if(!occurredAt||Date.parse(occurredAt)<activated)return {accepted:true,quiet:'before_activation'};
 const sender = await nativeSlackSender(db,source,ev);
 return retainAdmittedSignal(db,{source:'native_slack',orgId:source.orgId,userId:source.connection.userId,accountId:source.accountId,identity:payload.team_id+':'+payload.event_id,occurredAt,data:{text:text.slice(0,12000),activity_type:ev.type,subtype:ev.subtype??null,reaction:ev.reaction??null,channel:channel,user:ev.user??null,team_id:payload.team_id,ts:ev.item?.ts??ev.ts,event_id:payload.event_id,thread_ts:ev.thread_ts??null,_source:{integration_id:source.connection.id,team_id:source.teamId},_hivemind:{title:'Slack activity',source_is_untrusted:true,sender}}},classify);
}
export function verifyDreamSignalToken(token,input,secret,now=Date.now()){
 if(!secret||Buffer.byteLength(secret)<32)fail('signal_auth_unavailable',503);
 const parts=String(token??'').replace(/^Bearer /,'').split('.');if(parts.length!==3)fail('signal_auth_required');
 const signature=createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest('base64url');
 if(signature.length!==parts[2].length||!timingSafeEqual(Buffer.from(signature),Buffer.from(parts[2])))fail('signal_auth_invalid');
 let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'))}catch{fail('signal_auth_invalid')}
 const at=Math.floor(now/1000);if(header.alg!=='HS256'||claims.iss!=='hivemind-dreamer'||claims.aud!=='hivemind-attention-signals'||claims.sub!==input.userId||claims.org_id!==input.orgId||claims.run_id!==input.runId||!claims.jti||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<=at||claims.iat>at+5||claims.exp-claims.iat>30)fail('signal_auth_invalid');
}
export async function admitDreamSignal(db,input,classify,env=process.env){
 if(input.source!=='dreaming'||!uuid(input.runId))fail('dream_signal_invalid',400);
 await activeSignalAdmin(db,input.userId,input.orgId);
 const run=await db.harnessDreamRun.findUnique({where:{id:input.runId},include:{outputs:{include:{memory:true}}}});
 const settings=await db.harnessDreamSettings.findUnique({where:{orgId:input.orgId}});
 if(!run||run.orgId!==input.orgId||run.userId!==input.userId)fail('dream_signal_scope_mismatch');
 if(!settings?.enabled||settings.userId!==input.userId||run.revision!==settings.revision||run.status!=='completed'||String(run.triggerId).includes('introduction'))return {accepted:true,quiet:'dream_not_admitted'};
 const cutoff=Date.parse(env.HIVEMIND_NATIVE_SIGNAL_ADMIT_AFTER??'');
 if(!Number.isFinite(cutoff))return {accepted:true,quiet:'activation_window_required'};
 const receipts=[];
 for(const output of run.outputs){const memory=output.memory;
  if(!output.memoryId||!output.receipt||!memory||memory.orgId!==input.orgId||memory.deletedAt||!(memory.scope==='organization'||(memory.scope==='project'&&memory.projectId&&await db.project.findFirst({where:{id:memory.projectId,orgId:input.orgId,policy:'org_visible',status:'active'},select:{id:true}})))||!memory.tags?.includes('flashback')||!Number.isFinite(new Date(memory.createdAt).getTime())||new Date(memory.createdAt).getTime()<cutoff)continue;
  receipts.push(await retainAdmittedSignal(db,{source:'dreaming',orgId:input.orgId,userId:input.userId,accountId:'native:dreaming:'+input.userId,identity:input.runId+':'+output.idempotencyKey,data:{title:String(memory.title??'Dreaming finding').slice(0,200),text:String(memory.content??'').slice(0,4000),_source:{run_id:run.id,output_key:output.idempotencyKey,memory_id:output.memoryId,settings_revision:run.revision},_hivemind:{title:'Dreaming finding',source_is_untrusted:true}}},classify));
 }return {accepted:true,outputs:receipts.length};
}
