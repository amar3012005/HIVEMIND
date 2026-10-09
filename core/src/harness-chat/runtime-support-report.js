import crypto from 'node:crypto';
import { nativeAgentStoragePrincipal } from './organization-agent-access.js';

const capabilities=new Set(['crm','employee_lifecycle','delegation','memory','voice','attention','artifacts','email','schedule','authorization','runtime']);
const codes=new Set(['invalid_identifier','permission_denied','missing_configuration','tool_contract','delivery_failed','unavailable','unknown']);
const severities=new Set(['critical','high','medium','low']);
const causes=new Set(['confirmed','suspected','unknown']);
function fail(code,status=400){const e=new Error(code);e.status=status;throw e;}
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));}
function count(value,max){return Number.isInteger(value)&&value>=0&&value<=max;}
export function validateSupportReport(input,now=Date.now()){
 if(!exact(input,['operation','occurrence','coverage','issues'])||!['submit','status'].includes(input.operation))fail('invalid_support_report');
 const date=new Date(input.occurrence);
 if(typeof input.occurrence!=='string'||!Number.isFinite(date.getTime())||date.toISOString()!==input.occurrence||date.getTime()>now+60000||date.getTime()<now-7*86400000)fail('invalid_support_occurrence');
 if(input.operation==='status'){
  if(input.coverage!==undefined||input.issues!==undefined)fail('invalid_support_status');
  return {operation:'status',occurrence:input.occurrence};
 }
 if(!exact(input.coverage,['expected','inspected','missing'])||Object.keys(input.coverage).length!==3||!['expected','inspected','missing'].every(k=>count(input.coverage[k],1000))||input.coverage.inspected+input.coverage.missing!==input.coverage.expected)fail('invalid_support_coverage');
 if(!Array.isArray(input.issues)||input.issues.length>20)fail('invalid_support_issues');
 const issues=input.issues.map(issue=>{
  if(!exact(issue,['capability','code','severity','count','cause'])||Object.keys(issue).length!==5||!capabilities.has(issue.capability)||!codes.has(issue.code)||!severities.has(issue.severity)||!causes.has(issue.cause)||!count(issue.count,1000000)||issue.count<1)fail('invalid_support_issue');
  return {capability:issue.capability,code:issue.code,severity:issue.severity,count:issue.count,cause:issue.cause};
 });
 issues.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return {operation:'submit',occurrence:input.occurrence,coverage:{expected:input.coverage.expected,inspected:input.coverage.inspected,missing:input.coverage.missing},issues};
}
async function authority(db,claims,sharedOrganizationAgents){
 if(claims.operating_role!=='runtime'||!/^session-[a-z0-9-]{1,120}$/.test(claims.operating_session||''))fail('runtime_authority_required',403);
 const member=await db.userOrganization.findUnique({where:{userId_orgId:{userId:claims.sub,orgId:claims.org_id}},select:{role:true,isActive:true,deactivatedAt:true}});
 const user=await db.user.findUnique({where:{id:claims.sub},select:{deletedAt:true}});
 if(!member?.isActive||member.deactivatedAt||!['owner','admin'].includes(member.role)||!user||user.deletedAt)fail('administrator_membership_required',403);
 const storage=await nativeAgentStoragePrincipal(db,{orgId:claims.org_id,userId:claims.sub,runtimeSessionId:claims.operating_session,sharedOrganizationAgents});
 await db.$transaction(async tx=>{
  await scope(tx,claims.org_id,storage.userId);
  const root=(await tx.$queryRawUnsafe(`SELECT h.session_id FROM hivemind.harness_company_hq h JOIN hivemind.harness_sessions s ON s.id=h.session_id AND s.org_id=h.org_id AND s.user_id=h.user_id WHERE h.org_id=$1::uuid AND h.session_id=$2 AND h.user_id=$3::uuid AND s.status='active'`,claims.org_id,claims.operating_session,storage.userId))[0];
  if(!root)fail('canonical_runtime_required',403);
 });
 return storage;
}
async function scope(tx,org,user){await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",org,user);}
function requireEnabled(env,claims){
 const allowed=typeof env.RUNTIME_NIGHTLY_SUPPORT_ORG_IDS==='string'?env.RUNTIME_NIGHTLY_SUPPORT_ORG_IDS.split(',').map(value=>value.trim()):[];
 if(!allowed.includes(claims.org_id))fail('runtime_nightly_not_enabled',403);
}
function configured(env){return typeof env.SYSTEM_EMAIL_SUPPORT==='string'&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.SYSTEM_EMAIL_SUPPORT);}
export async function nightlyRoutineContext({db,claims,sharedOrganizationAgents=false,env=process.env}){
 requireEnabled(env,claims);
 await authority(db,claims,sharedOrganizationAgents);
 const org=await db.organization.findUnique({where:{id:claims.org_id},select:{companyProfile:true}});
 let timeZone=org?.companyProfile?.timezone;let source='organization';
 try{if(typeof timeZone!=='string'||timeZone.length>80)throw new Error();new Intl.DateTimeFormat('en',{timeZone});}catch{timeZone='UTC';source='default_utc';}
 return {org_id:claims.org_id,session_id:claims.operating_session,time_zone:timeZone,time_zone_source:source,support_configured:configured(env)};
}
function projection(row,delivery){
 const receipt=row?.receipt||{};
 return {report_id:row?.id??null,status:row?.status==='dispatching'?'unknown':row?.status??'not_found',sent:row?.status==='accepted',delivery_status:delivery?.delivery_status??receipt.deliveryStatus??null,read_status:'not_tracked'};
}
export async function runtimeSupportReport({db,claims,input,send,sharedOrganizationAgents=false,env=process.env,now=Date.now()}){
 requireEnabled(env,claims);
 const report=validateSupportReport(input,now);const storage=await authority(db,claims,sharedOrganizationAgents);
 const key='support:'+crypto.createHash('sha256').update(JSON.stringify([claims.org_id,claims.operating_session,report.occurrence])).digest('hex');
 const hash=crypto.createHash('sha256').update(JSON.stringify({...report,operation:'submit'})).digest('hex');
 const saved=await db.$transaction(async tx=>{
  await scope(tx,claims.org_id,storage.userId);
  if(report.operation==='submit')await tx.$queryRawUnsafe(`INSERT INTO hivemind.runtime_administrator_messages(org_id,user_id,session_id,message_key,content_hash,message) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb) ON CONFLICT(org_id,user_id,session_id,message_key) DO NOTHING`,claims.org_id,storage.userId,claims.operating_session,key,hash,JSON.stringify(report));
  const row=(await tx.$queryRawUnsafe('SELECT * FROM hivemind.runtime_administrator_messages WHERE org_id=$1::uuid AND user_id=$2::uuid AND session_id=$3 AND message_key=$4 FOR UPDATE',claims.org_id,storage.userId,claims.operating_session,key))[0];
  if(report.operation==='status'||!row)return {row,replayed:true};
  if(row.content_hash!==hash)fail('support_occurrence_content_conflict',409);
  if(row.status!=='pending')return {row,replayed:true};
  if(!configured(env))return {row,disabled:true};
  await tx.$queryRawUnsafe("UPDATE hivemind.runtime_administrator_messages SET status='dispatching',updated_at=now() WHERE id=$1::uuid",row.id);
  return {row};
 });
 async function status(row){
  let delivery;
  if(row?.receipt?.messageId)delivery=(await db.$queryRawUnsafe("SELECT delivery_status FROM hivemind.system_email_deliveries WHERE org_id=$1::uuid AND provider='cloudflare' AND provider_message_id=$2 LIMIT 1",claims.org_id,row.receipt.messageId))[0];
  return projection(row,delivery);
 }
 if(saved.disabled)return {...await status(saved.row),status:'unavailable',sent:false,reason:'support_recipient_not_configured'};
 if(saved.replayed)return {...await status(saved.row),replayed:true};
 const lines=[`Occurrence: ${report.occurrence}`,`Coverage: ${report.coverage.inspected}/${report.coverage.expected}; missing: ${report.coverage.missing}`,...report.issues.map(i=>`${i.capability}: ${i.code}; severity=${i.severity}; count=${i.count}; cause=${i.cause}`)];
 const text=lines.join('\n');let receipt;
 try{receipt=await send({to:env.SYSTEM_EMAIL_SUPPORT,rendered:{subject:'Runtime nightly capability report',text,html:`<pre>${text}</pre>`},from:env.RUNTIME_EMAIL_FROM||'Runtime <runtime@admin.singulancelabs.com>',templateId:'runtime-support-sanitized-v1',notification:{orgId:claims.org_id,userId:storage.userId},providerAttempts:1,providerFallback:false,requiredProvider:'cloudflare'});}catch{receipt={ok:false,error:'outcome_unknown'};}
 const accepted=receipt.ok===true&&receipt.provider==='cloudflare'&&typeof receipt.messageId==='string'&&receipt.messageId.length>0;
 const result=accepted?'accepted':receipt.skipped||receipt.permanent?'rejected':'unknown';
 const safe={ok:accepted,provider:receipt.provider==='cloudflare'?'cloudflare':null,messageId:typeof receipt.messageId==='string'?receipt.messageId.slice(0,512):null,deliveryStatus:receipt.deliveryStatus??null,error:accepted?null:'transport_not_accepted'};
 await db.$transaction(async tx=>{await scope(tx,claims.org_id,storage.userId);await tx.$queryRawUnsafe('UPDATE hivemind.runtime_administrator_messages SET status=$2,receipt=$3::jsonb,updated_at=now() WHERE id=$1::uuid AND org_id=$4::uuid AND user_id=$5::uuid',saved.row.id,result,JSON.stringify(safe),claims.org_id,storage.userId);});
 return status({...saved.row,status:result,receipt:safe});
}
