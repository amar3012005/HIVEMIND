/** Purpose-separated callback to native Schedule; no second task loop or scheduler. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
export function lifecycleCallbackToken(payload, secret, now = Date.now()) {
  const at = Math.floor(now / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss:'hivemind-control-plane', aud:'hivemind-employee-lifecycle', sub:payload.userId,
    org_id:payload.orgId, body_sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    iat:at, exp:at+30, jti:randomUUID() };
  const input = `${encode({alg:'HS256',typ:'JWT'})}.${encode(claims)}`;
  return `${input}.${createHmac('sha256',secret).update(input).digest('base64url')}`;
}
export async function activateNativeEmployeeLifecycle(principal, employee, { env=process.env, fetchImpl=fetch }={}) {
  const secret=env.HIVE_HARNESS_RUNNER_SERVICE_SECRET, configured=env.HIVEMIND_EMPLOYEE_LIFECYCLE_URL;
  if (!configured || !secret || Buffer.byteLength(secret)<32) return {status:'pending',reason:'native_lifecycle_host_not_configured'};
  let url; try {url=new URL(configured);} catch {return {status:'pending',reason:'native_lifecycle_host_not_configured'};}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname!='/internal/hivemind/employee-lifecycle') return {status:'pending',reason:'native_lifecycle_host_not_configured'};
  const payload={orgId:principal.orgId,userId:principal.userId,employeeId:employee.id};
  try {
    const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:`Bearer ${lifecycleCallbackToken(payload,secret)}`,'content-type':'application/json'},body:JSON.stringify(payload)});
    const raw=await response.text();if(raw.length>32000) throw Error('oversized');
    const result=JSON.parse(raw);if(!response.ok || result.employeeId!==employee.id || result.status!=='ready') throw Error('unconfirmed');
    return result;
  } catch { return {status:'pending',reason:'native_lifecycle_host_unconfirmed'}; }
}
