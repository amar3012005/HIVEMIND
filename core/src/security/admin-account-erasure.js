import {erasureEmailHash} from './account-erasure-authority.js';
import {admitAccountErasure} from './account-erasure-ledger.js';
import {planAccountErasureScope} from './account-erasure-scope.js';
const normalizedEmail=value=>String(value||'').trim().toLowerCase();
export async function handleAdminAccountErasure({req,res,pathname,prisma,getPlatformAdminSession,parseBody,jsonResponse,recover,audit}) {
 const match=pathname.match(/^\/admin\/api\/platform\/users\/([0-9a-f-]{36})\/erasure$/i);if(!match)return false;
 const operator=getPlatformAdminSession(req);
 if(!operator){jsonResponse(res,{error:'Unauthorized'},401);return true;}
 if(!['GET','POST'].includes(req.method)){jsonResponse(res,{error:'Method not allowed'},405);return true;}
 if(req.method==='POST' && (req.headers.origin!=='https://admin.hivemind.singulancelabs.com'||!String(req.headers['content-type']||'').startsWith('application/json'))){jsonResponse(res,{error:'origin_denied'},403);return true;}
 try {
  const userId=match[1];
  const [user,operations]=await Promise.all([
   prisma.user.findUnique({where:{id:userId},select:{id:true,email:true,displayName:true}}),
   prisma.$queryRawUnsafe('SELECT id,state,failure_code,updated_at FROM hivemind.account_erasure_operations WHERE user_id=$1::uuid ORDER BY created_at DESC LIMIT 1',userId),
  ]);
  const op=operations[0];
  const operation=op?{id:op.id,status:op.state==='reconciled'&&op.failure_code?'blocked':op.state,failureCode:op.failure_code||null,updatedAt:op.updated_at}:null;
  if(!user){jsonResponse(res,operation&&req.method==='GET'?{user:null,operation}:{error:'User not found'},operation&&req.method==='GET'?200:404);return true;}
  if(req.method==='GET') {
   const [scope,memories,documents,integrations,sessions,apiKeys]=await Promise.all([
    planAccountErasureScope(prisma,userId),prisma.memory.count({where:{userId}}),prisma.knowledgeDocument.count({where:{userId}}),prisma.platformIntegration.count({where:{userId}}),prisma.session.count({where:{userId}}),prisma.apiKey.count({where:{userId}}),
   ]);
   jsonResponse(res,{user,operation,counts:{memories,documents,integrations,sessions,apiKeys},organizations:scope.organizations.map(org=>({orgId:org.orgId,disposition:org.disposition,otherMembers:org.remainingMembers.length})),retention:{sharedCompanyData:'ownership_checked',auditRecords:'retained',backups:'existing_retention_policy',externalOriginals:'retained_at_provider'}});return true;
  }
  const input=await parseBody(req);
  if(input.confirm!=='DELETE'||normalizedEmail(input.email)!==normalizedEmail(user.email)){jsonResponse(res,{error:'Enter DELETE and the exact target email. No deletion was started.'},400);return true;}
  const ownershipSnapshot=await planAccountErasureScope(prisma,userId);
  const platformAdmin={kind:'platform_admin',operator:operator.operator,sessionId:operator.sessionId,userId,targetEmailHash:erasureEmailHash(user.email)};
  const admitted=await admitAccountErasure(prisma,{userId,actorId:operator.sessionId,confirmation:'DELETE',ownershipSnapshot,platformAdmin});
  // The durable operation retains verified admin identity even if the supplemental audit sink fails.
  try {await audit?.({eventType:'platform.account_erasure_requested',eventCategory:'security',action:'delete',resourceType:'user',resourceId:userId,sessionId:operator.sessionId,actorType:'platform_admin',metadata:{operator:operator.operator,operation_id:admitted.id}});}catch{}
  setImmediate(recover);
  jsonResponse(res,{operation:{id:admitted.id,status:admitted.state,failureCode:admitted.failure_code||null},message:'Erasure was queued. Completion requires verified cleanup; unresolved shared or remote ownership is reported as blocked.'},202);return true;
 }catch(error){jsonResponse(res,{error:error.code||'Account erasure is unavailable',code:error.code||'ERASURE_ADMIN_UNAVAILABLE'},error.status||503);return true;}
}
