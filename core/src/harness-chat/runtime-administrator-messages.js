import { nativeAgentStoragePrincipal } from './organization-agent-access.js';
import crypto from 'node:crypto';
import { renderRuntimeAdministratorEmail } from '../email/templates/runtime-administrator.js';
import { resolvePublicFrontendBaseUrl } from '../public-frontend-url.js';

const kinds = new Set(['completion','decision','approval']);
function fail(code, status = 400) { const e = new Error(code); e.status = status; throw e; }
export function validateAdministratorMessage(input) {
 if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['message_key','kind','subject','message','request_call_id'].includes(k))) fail('invalid_administrator_message');
 if (typeof input.message_key !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(input.message_key || '') || !kinds.has(input.kind)) fail('invalid_message_identity');
 for (const [key, limit] of [['subject',120],['message',4000]]) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit || (key === 'subject' && /[\r\n]/.test(input[key]))) fail('invalid_message_content');
 if (input.request_call_id !== undefined && !/^[A-Za-z0-9._:-]{1,180}$/.test(input.request_call_id)) fail('invalid_request_reference');
 if (input.kind !== 'completion' && !input.request_call_id) fail('native_request_reference_required');
 return { message_key: input.message_key, kind: input.kind, subject: input.subject.trim(), message: input.message.trim(), ...(input.request_call_id ? { request_call_id: input.request_call_id } : {}) };
}
export async function messageAdministrator({ db, claims, input, send, publicBase, portraitBase, sharedOrganizationAgents = false }) {
 if (claims.operating_role !== 'runtime' || !/^session-[a-z0-9-]{1,120}$/.test(claims.operating_session || '')) fail('runtime_authority_required',403);
 const membership = await db.userOrganization.findUnique({ where:{userId_orgId:{userId:claims.sub,orgId:claims.org_id}}, select:{role:true,isActive:true} });
 if (!membership?.isActive || !['owner','admin'].includes(membership.role)) fail('administrator_membership_required',403);
 const message = validateAdministratorMessage(input);
 // The recipient comes from this authenticated administrator, never model input or a legacy email override.
 const user = await db.user.findUnique({where:{id:claims.sub},select:{email:true,displayName:true,deletedAt:true}});
 const organization = await db.organization.findUnique({where:{id:claims.org_id},select:{name:true}});
 if (!user?.email || user.deletedAt || !organization) fail('administrator_unavailable',409);
 const preference = await db.hqRuntime.findUnique({where:{orgId:claims.org_id},select:{ownerUserId:true,emailUpdatesEnabled:true}});
 if (preference?.ownerUserId === claims.sub && preference.emailUpdatesEnabled === false) return {status:'disabled',sent:false};
 const schemas=await db.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
 if(schemas.length!==1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema))fail('harness_storage_unavailable',503);
 const schema=schemas[0].table_schema;
 const storage=await nativeAgentStoragePrincipal(db,{orgId:claims.org_id,userId:claims.sub,runtimeSessionId:claims.operating_session,sharedOrganizationAgents});
 await db.$transaction(async tx=>{
  await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",claims.org_id,storage.userId);
 const session = (await tx.$queryRawUnsafe(`SELECT id FROM ${schema}.harness_sessions WHERE id=$1 AND org_id=$2::uuid AND user_id=$3::uuid`,claims.operating_session,claims.org_id,storage.userId))[0];
 if (!session) fail('runtime_session_not_found',403);
 if (message.request_call_id) {
  // A decision email refers to an existing native call in this exact authenticated room.
  const events = await tx.$queryRawUnsafe(`SELECT event_type,payload FROM ${schema}.harness_session_events WHERE session_id=$1 AND org_id=$2::uuid AND user_id=$3::uuid AND event_type IN ('tool/call','approval/asked') ORDER BY sequence DESC LIMIT 500`,claims.operating_session,claims.org_id,storage.userId);
  const found = events.some(row => {
   const data=row.payload.data??row.payload;
   if(data.callId!==message.request_call_id && data.id!==message.request_call_id)return false;
   if(row.event_type==='approval/asked')return message.kind==='approval';
   if(data.name!=='ask_user_question')return false;
   if(message.kind==='decision')return true;
   try {return JSON.parse(data.arguments).questions?.some(q=>q.intent?.kind==='plan-review')===true;} catch{return false;}
  });
  if (!found) fail('native_request_not_found',409);
 }
 });
 const hash=crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex');
 const row=await db.$transaction(async tx=>{
  await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",claims.org_id,claims.sub);
  await tx.$queryRawUnsafe(`INSERT INTO hivemind.runtime_administrator_messages(org_id,user_id,session_id,message_key,content_hash,message) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb) ON CONFLICT(org_id,user_id,session_id,message_key) DO NOTHING RETURNING id`,claims.org_id,claims.sub,claims.operating_session,message.message_key,hash,JSON.stringify(message));
  const saved=(await tx.$queryRawUnsafe('SELECT * FROM hivemind.runtime_administrator_messages WHERE org_id=$1::uuid AND user_id=$2::uuid AND session_id=$3 AND message_key=$4 FOR UPDATE',claims.org_id,claims.sub,claims.operating_session,message.message_key))[0];
  if(saved.content_hash!==hash)fail('message_key_content_conflict',409);
  if(saved.status!=='pending')return {...saved,replayed:true};
  await tx.$queryRawUnsafe("UPDATE hivemind.runtime_administrator_messages SET status='dispatching',updated_at=now() WHERE id=$1::uuid RETURNING id",saved.id);
  return saved;
 });
 if(row.replayed)return {message_id:row.id,status:row.status==='dispatching'?'unknown':row.status,replayed:true,receipt:row.receipt??null,sent:row.status==='accepted'};
 const app=resolvePublicFrontendBaseUrl(publicBase);
 const conversation=new URL('/hivemind/app/employee/harness',app);conversation.searchParams.set('session',claims.operating_session);
 if(message.request_call_id)conversation.searchParams.set('request',message.request_call_id);
 const portrait=new URL('/assets/runtime-computer-c2305f5b.webp',portraitBase || 'https://chat.singulancelabs.com');
 const rendered=renderRuntimeAdministratorEmail({companyName:organization.name,administratorName:user.displayName,subject:message.subject,message:message.message,kind:message.kind,conversationUrl:conversation.href,portraitUrl:portrait.href});
 let receipt;
 try {receipt=await send({to:user.email,rendered,from:process.env.RUNTIME_EMAIL_FROM || 'Runtime <runtime@admin.singulancelabs.com>',templateId:'runtime-administrator-v1',notification:{orgId:claims.org_id,userId:claims.sub},providerAttempts:1,providerFallback:false,requiredProvider:'cloudflare'});}catch{receipt={ok:false,error:'outcome_unknown'};}
 const status=receipt.ok?'accepted':receipt.skipped||receipt.permanent?'rejected':'unknown';
 const safe={ok:receipt.ok===true,provider:receipt.provider??null,messageId:receipt.messageId??null,deliveryStatus:receipt.deliveryStatus??null,error:receipt.error??null};
 await db.$transaction(async tx=> {
  await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",claims.org_id,claims.sub);
  await tx.$queryRawUnsafe('UPDATE hivemind.runtime_administrator_messages SET status=$2,receipt=$3::jsonb,updated_at=now() WHERE id=$1::uuid AND org_id=$4::uuid AND user_id=$5::uuid RETURNING id',row.id,status,JSON.stringify(safe),claims.org_id,claims.sub);
 });
 return {message_id:row.id,status,sent:status==='accepted',receipt:safe,conversation_url:conversation.href};
}
