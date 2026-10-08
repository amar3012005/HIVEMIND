/** Provider-attested account reconciliation wakes Runtime; it never resumes an employee or grants access. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { nativeAgentStoragePrincipal } from './organization-agent-access.js';
import { verifyDelegatedConnection } from './delegated-connection-verification.js';

export function completionToken(payload, secret, now = Date.now()) {
  const at = Math.floor(now / 1000), encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const claims = {iss:'hivemind-control-plane',aud:'hivemind-delegated-connection',sub:payload.userId,org_id:payload.orgId,
    body_sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),iat:at,exp:at+30,jti:randomUUID()};
  const input = `${encode({alg:'HS256',typ:'JWT'})}.${encode(claims)}`;
  return `${input}.${createHmac('sha256',secret).update(input).digest('base64url')}`;
}
async function readSaved(db, orgId, userId, sharedOrganizationAgents) {
  const storage=await nativeAgentStoragePrincipal(db,{orgId,userId,sharedOrganizationAgents});
  userId=storage.userId;
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",orgId,userId);
    const schemas=await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
    if(schemas.length!==1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema)) throw Error('native_storage_unavailable');
    const schema=schemas[0].table_schema;
    const roots=await tx.$queryRawUnsafe(`SELECT session_id FROM ${schema}.harness_company_hq WHERE org_id=$1::uuid`,orgId);
    if(roots.length!==1) return [];
    const rows=await tx.$queryRawUnsafe(`SELECT payload FROM (SELECT DISTINCT ON (payload->'data'->>'id') payload,sequence FROM ${schema}.harness_session_events
      WHERE session_id=$1 AND org_id=$2::uuid AND event_type='hivemind/hq-delegated-blocker'
      ORDER BY payload->'data'->>'id',sequence DESC) latest
      WHERE payload->'data'->>'kind'='connection' AND payload->'data'->>'state'='blocked' AND payload->'data'->>'rootId'=$1
      ORDER BY sequence DESC LIMIT 100`,roots[0].session_id,orgId);
    return rows.map(row=>row.payload.data).filter(b=>b.rootId===roots[0].session_id && b.kind==='connection' && b.state==='blocked');
  });
}
async function reconcile({prisma,orgId,userId}, {env=process.env,fetchImpl=fetch,read=readSaved,verify=verifyDelegatedConnection}={}) {
  const membership=await prisma.userOrganization.findUnique({where:{userId_orgId:{userId,orgId}},select:{isActive:true,role:true,deactivatedAt:true}});
  if(!membership?.isActive || membership.deactivatedAt || !['owner','admin'].includes(membership.role)) return {status:'admin_required',delivered:0};
  const secret=env.HIVE_HARNESS_RUNNER_SERVICE_SECRET;
  let url;try {url=new URL(env.HIVEMIND_EMPLOYEE_LIFECYCLE_URL);}catch{return {status:'not_configured',delivered:0};}
  if(!secret || Buffer.byteLength(secret)<32 || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname!=='/internal/hivemind/employee-lifecycle') return {status:'not_configured',delivered:0};
  url.pathname='/internal/hivemind/delegated-connection';
  let delivered=0, unavailable=0;
  for(const blocker of await read(prisma,orgId,userId,env.HIVE_SHARED_ORGANIZATION_AGENTS_ENABLED==='true')) {
    if(!blocker.workflowSessionId || !blocker.routerSessionId || !blocker.toolkits?.length) continue;
    try {
    const checked=await verify({db:prisma,claims:{org_id:orgId,sub:userId,operating_role:'runtime',operating_session:blocker.rootId},
      input:{session_id:blocker.employeeSessionId,router_session_id:blocker.routerSessionId,toolkits:blocker.toolkits},sharedOrganizationAgents:env.HIVE_SHARED_ORGANIZATION_AGENTS_ENABLED==='true'});
    if(checked.verified!==true) continue;
    const payload={orgId,userId,rootId:blocker.rootId,employeeId:blocker.employeeId,blockerId:blocker.id,workflowSessionId:blocker.workflowSessionId};
    const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:`Bearer ${completionToken(payload,secret)}`,'content-type':'application/json'},body:JSON.stringify(payload)});
    const raw=await response.text();if(raw.length>32000) throw Error('delegated_connection_response_too_large');
    const result=JSON.parse(raw);
    if(!response.ok || result.status!=='accepted' || result.blockerId!==blocker.id || result.rootId!==blocker.rootId) throw Error('delegated_connection_delivery_unconfirmed');
    delivered+=1;
    } catch { unavailable+=1; /* Preserve this blocker; other valid workflows can still reach Runtime. */ }
  }
  return {status:unavailable>0 && delivered===0?'pending':'reconciled',delivered,unavailable};
}

// Coalesce only concurrent reads; a later OAuth completion always causes a new check.
const inFlight=new Map();
export function reconcileDelegatedConnections(ctx,options={}) {
  const key=`${ctx.orgId}:${ctx.userId}`;
  if(inFlight.has(key)) return inFlight.get(key);
  const promise=reconcile(ctx,options).finally(()=>{if(inFlight.get(key)===promise)inFlight.delete(key)});
  inFlight.set(key,promise);return promise;
}
