export const ORGANIZATION_POLICY_LIMITS = ['monthlyCredits','maxUsers','maxProjects','maxConnectors','maxMemories','llmTokensPerMonth','searchQueriesPerDay','searchQueriesPerMonth','knowledgeBasePagesPerDay','knowledgeBasePagesPerMonth','deepResearchPerDay','deepResearchPerMonth','webIntelPerDay','meetingMinutesPerMonth','hyperAgentRunsPerDay','hyperAgentRunsPerMonth','taraTalkSecondsPerDay','taraTalkSecondsPerMonth'];
// Only expose capability overrides that existing admission routes enforce.
export const ORGANIZATION_POLICY_FEATURES = ['agentSwarm','cognitiveDreaming'];
const fail = (message,status=400) => { const error=new Error(message);error.status=status;throw error; };
const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function normalizeOrganizationPolicy(input) {
 if(!input || typeof input!=='object' || Array.isArray(input)) fail('Settings are required');
 if(Object.keys(input).some(k=>!['revision','limits','features','reason'].includes(k))) fail('Unsupported setting');
 if(!Number.isSafeInteger(input.revision)||input.revision<0) fail('A current settings revision is required');
 const reason=String(input.reason??'').trim();if(reason.length<3||reason.length>500)fail('Provide a short reason for this change');
 const result={revision:input.revision,limits:{},features:{},reason};
 for(const [kind,allowed] of [['limits',ORGANIZATION_POLICY_LIMITS],['features',ORGANIZATION_POLICY_FEATURES]]){
  const values=input[kind]??{};if(typeof values!=='object'||Array.isArray(values))fail('Invalid settings');
  for(const [key,value] of Object.entries(values)){
   if(!allowed.includes(key))fail(`Unsupported ${kind} setting: ${key}`);
   if(value!==null && (kind==='features'?typeof value!=='boolean':!Number.isSafeInteger(value)||value< -1))fail(`Invalid ${key}`);
   result[kind][key]=value;
  }
 }
 return result;
}
export async function latestOrganizationPolicy(prisma,orgId){
 if(!uuid(orgId))fail('Invalid organization',400);
 try {return (await prisma.$queryRawUnsafe('SELECT version,limits,features,reason,created_at FROM hivemind.organization_policy_versions WHERE org_id=$1::uuid ORDER BY version DESC LIMIT 1',orgId))[0]??null;}
 catch(cause){const error=new Error('Organization settings are temporarily unavailable',{cause});error.code='ORGANIZATION_POLICY_UNAVAILABLE';error.status=503;throw error;}
}
export function materializeOrganizationPolicy(plan,row){
 return {...plan,inheritedLimits:plan.limits,inheritedFeatures:plan.features,limits:{...plan.limits,...(row?.limits??{})},features:{...plan.features,...(row?.features??{})},organizationPolicyVersion:row?.version??0};
}
export async function saveOrganizationPolicy({prisma,orgId,input,operator}){
 if(!uuid(orgId))fail('Invalid organization');
 if(!operator?.operator || !operator.sessionId)fail('Platform administrator required',401);
 const requested=normalizeOrganizationPolicy(input);
 return prisma.$transaction(async tx=>{
  // Same seat lock used by invitation and membership admission prevents lowering a cap during a join.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',`plan:seats:${orgId}`);
  const org=await tx.organization.findUnique({where:{id:orgId},select:{id:true,plan:true}});if(!org)fail('Organization not found',404);
  const previous=await latestOrganizationPolicy(tx,orgId);
  if((previous?.version??0)!==requested.revision)fail('Settings changed; reload before saving',409);
  const limits={...(previous?.limits??{})},features={...(previous?.features??{})};
  for(const kind of ['limits','features']){const target=kind==='limits'?limits:features;for(const [key,value] of Object.entries(requested[kind])){if(value===null)delete target[key];else target[key]=value;}}
  if(limits.maxUsers!==undefined && limits.maxUsers!==-1){
   const [members,invites]=await Promise.all([tx.userOrganization.count({where:{orgId,isActive:true}}),tx.orgInvite.count({where:{orgId,usedAt:null,revokedAt:null,expiresAt:{gt:new Date()}}})]);
   if(limits.maxUsers<members+invites)fail(`Seat limit must cover ${members+invites} members and pending invitations`);
  }
  const rows=await tx.$queryRawUnsafe(`INSERT INTO hivemind.organization_policy_versions(org_id,version,limits,features,reason,operator,operator_session_id)
    VALUES($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$6,$7::uuid) RETURNING version,limits,features,reason,created_at`,orgId,requested.revision+1,JSON.stringify(limits),JSON.stringify(features),requested.reason,operator.operator,operator.sessionId);
  return rows[0];
 });
}
export async function readOrganizationSettings({prisma,orgId,resolvePlan,creditService,usageTracker}){
 const org=await prisma.organization.findUnique({where:{id:orgId},select:{id:true,name:true,plan:true,accountType:true,hostingMode:true}});if(!org)fail('Organization not found',404);
 const [{plan,entitlement},policy,members,pendingInvites,credits,usage]=await Promise.all([
  resolvePlan(prisma,orgId),latestOrganizationPolicy(prisma,orgId),prisma.userOrganization.count({where:{orgId,isActive:true}}),
  prisma.orgInvite.count({where:{orgId,usedAt:null,revokedAt:null,expiresAt:{gt:new Date()}}}),creditService.getSummary(orgId),usageTracker.getUsage(orgId),
 ]);
 return {organization:org,revision:policy?.version??0,overrides:{limits:policy?.limits??{},features:policy?.features??{}},effective:{plan:plan.id,overridesActive:!plan.organizationPolicySuspended,limits:plan.limits,features:plan.features,inheritedLimits:plan.inheritedLimits??plan.limits,inheritedFeatures:plan.inheritedFeatures??plan.features,entitlement:entitlement?{source:entitlement.source,status:entitlement.status,effectiveUntil:entitlement.effectiveUntil}:null},usage:{members,pendingInvites,seats:members+pendingInvites,credits,monthly:usage},editable:{limits:ORGANIZATION_POLICY_LIMITS,features:ORGANIZATION_POLICY_FEATURES},lastChange:policy?{reason:policy.reason,at:policy.created_at}:null};
}
export async function handleOrganizationSettings({req,res,pathname,prisma,getPlatformAdminSession,parseBody,jsonResponse,resolvePlan,creditService,usageTracker,audit}){
 const match=pathname.match(/^\/admin\/api\/platform\/organizations\/([0-9a-f-]{36})\/settings$/i);if(!match)return false;
 const operator=getPlatformAdminSession(req);if(!operator){jsonResponse(res,{error:'Unauthorized'},401);return true;}
 if(!['GET','PATCH'].includes(req.method)){jsonResponse(res,{error:'Method not allowed'},405);return true;}
 if(!prisma){jsonResponse(res,{error:'Database unavailable'},503);return true;}
 try{
  if(req.method==='PATCH'){
   const saved=await saveOrganizationPolicy({prisma,orgId:match[1],input:await parseBody(req),operator});
   await audit?.({organizationId:match[1],eventType:'commercial.organization_settings_updated',eventCategory:'billing',action:'update',resourceType:'organization',resourceId:match[1],actorType:'platform_admin',sessionId:operator.sessionId,metadata:{version:saved.version,operator:operator.operator,reason:saved.reason}});
  }
  jsonResponse(res,{settings:await readOrganizationSettings({prisma,orgId:match[1],resolvePlan,creditService,usageTracker})});
 }catch(error){jsonResponse(res,{error:error.status?error.message:'Organization settings unavailable'},error.status??503);}
 return true;
}
