/** Narrow adapter called only AFTER native runner-token verification + live membership.
 * Separate from application execution; it cannot create sessions or broaden project scope.
 */
import { isAllowedAppRuntimeOperation } from './access.js';
const MAX_RESPONSE_BYTES=1024*1024;
async function readBoundedJson(response) {
  if(!response.body?.getReader) {
    const text=await response.text();if(Buffer.byteLength(text,'utf8')>MAX_RESPONSE_BYTES) throw new Error('Response too large');return JSON.parse(text);
  }
  const reader=response.body.getReader();const chunks=[];let total=0;
  try {
    for (;;) {const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
      if(total>MAX_RESPONSE_BYTES){await reader.cancel();throw new Error('Response too large');}
      chunks.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
}
export async function forwardAppRuntimeRequest({req,res,corePath,claims,env,coreApiBaseUrl,internalApiKey,fetchImpl=fetch,parseBody,jsonResponse}) {
  if(corePath!=='/api/app-runtime/apps'&&!corePath.startsWith('/api/app-runtime/apps/')) return false;
  if(env.HIVE_APP_RUNTIME_ENABLED!=='true'||!isAllowedAppRuntimeOperation(corePath,req.method)) {
    jsonResponse(res,{error:{code:'not_found',message:'CRM operation is not enabled',details:{}}},404);return true;
  }
  if(claims.project_id) {
    jsonResponse(res,{error:{code:'forbidden',message:'Organization-wide CRM requires an unscoped session',details:{}}},403);return true;
  }
  if(!internalApiKey) {
    jsonResponse(res,{error:{code:'unavailable',message:'CRM gateway is unavailable',details:{}}},503);return true;
  }
  try {
    const target=new URL(corePath,coreApiBaseUrl);
    target.search=new URL(req.url,'http://harness.internal').search;
    const body=req.method==='GET'?undefined:await parseBody(req);
    const encoded=body===undefined?undefined:JSON.stringify(body);
    if(encoded&&Buffer.byteLength(encoded,'utf8')>300*1024) {
      jsonResponse(res,{error:{code:'invalid_arguments',message:'Request body is too large',details:{}}},400);return true;
    }
    const upstream=await fetchImpl(target,{
      method:req.method,redirect:'manual',signal:AbortSignal.timeout(20000),
      headers:{accept:'application/json',authorization:`Bearer ${internalApiKey}`,'x-hm-user-id':claims.sub,'x-hm-org-id':claims.org_id,...(encoded===undefined?{}:{'content-type':'application/json'})},
      ...(encoded===undefined?{}:{body:encoded}),
    });
    if(upstream.status>=300&&upstream.status<400) throw new Error('Unexpected redirect');
    const value=await readBoundedJson(upstream);jsonResponse(res,value,upstream.status);
  } catch {
    // A write may already have committed. Caller reconciles by replaying the
    // IDENTICAL operationId/body; this transport never automatically retries.
    jsonResponse(res,{error:{code:'unavailable',message:'CRM gateway could not confirm the result; reconcile using the same operation ID',details:{}}},503);
  }
  return true;
}
