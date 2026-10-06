/** Native HTTP handler. Integration must authenticate before resolving principal. */
import { AppRuntimeStore } from './store.js';
import { AppRuntimeError } from './contract.js';
export const APP_RUNTIME_PREFIX = '/api/app-runtime/apps';
const MAX_BODY_BYTES = 300 * 1024;
const STATUS = {unauthorized:401,forbidden:403,not_found:404,version_conflict:409,idempotency_conflict:409,migration_required:409};
function error(code,message,details={}) {throw new AppRuntimeError(code,message,details);}
function fields(input,allowed,required=[]) {
  if(!input||typeof input!=='object'||Array.isArray(input)) error('invalid_arguments','Body must be an object');
  for(const key of Object.keys(input)) if(!allowed.includes(key)) error('invalid_arguments',`Unknown argument: ${key}`);
  for(const key of required) if(!Object.hasOwn(input,key)) error('invalid_arguments',`Missing argument: ${key}`);
  return input;
}
async function readBody(req) {
  let size=0; const chunks=[];
  for await(const chunk of req) {size+=Buffer.byteLength(chunk); if(size>MAX_BODY_BYTES) error('invalid_arguments','Request body is too large'); chunks.push(Buffer.from(chunk));}
  if(!size) return {};
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {error('invalid_arguments','Request body must be valid JSON');}
}
function respond(res,value,status=200) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
/** resolvePrincipal(req) must return VERIFIED {orgId,userId}; never accept model/browser IDs.
 * The embedding authentication layer must also enforce token scopes/audience and any
 * scoped service authority. This module intentionally grants no unauthenticated gateway.
 * Returns false for unrelated paths; true when a request was handled.
 */
export function createAppRuntimeHandler({pool,transactionRunner,resolvePrincipal,parseBody=readBody,jsonResponse=respond}) {
  if(typeof resolvePrincipal!=='function') throw new TypeError('Verified principal resolver is required');
  const store=new AppRuntimeStore({pool,transactionRunner});
  return async function handle({req,res,pathname}) {
    const url=new URL(req.url??pathname,'http://app-runtime.internal');
    const path=pathname??url.pathname;
    if(path!==APP_RUNTIME_PREFIX&&!path.startsWith(`${APP_RUNTIME_PREFIX}/`)) return false;
    try {
      const principal=await resolvePrincipal(req);
      if(!principal?.orgId||!principal?.userId) error('unauthorized','Authentication required');
      const parts=path.slice(APP_RUNTIME_PREFIX.length).split('/').filter(Boolean);
      const method=req.method; let result;
      let input;
      if(['POST','PATCH'].includes(method)) {
        input=await parseBody(req);
        if(Buffer.byteLength(JSON.stringify(input)??'','utf8')>MAX_BODY_BYTES) error('invalid_arguments','Request body is too large');
      }
      if(url.searchParams.size&&!(method==='GET'&&((parts.length===2&&parts[1]==='records')||parts.length===0))) error('invalid_arguments','Query arguments are not accepted for this operation');
      if(!parts.length&&method==='GET') {
        for(const key of url.searchParams.keys()) if(key!=='published'||url.searchParams.getAll(key).length!==1||url.searchParams.get(key)!=='true') error('invalid_arguments','Only published=true is accepted on the app list');
        result=await store.list(principal,{published:url.searchParams.get('published')==='true'});
      }
      else if(!parts.length&&method==='POST') result=await store.createDraft(principal,fields(input,['spec','operationId'],['spec','operationId']));
      else if(parts.length===1&&method==='GET') result=await store.get(principal,parts[0]);
      else if(parts.length===1&&method==='PATCH') result=await store.patch(principal,parts[0],fields(input,['expectedVersion','spec','operationId'],['expectedVersion','spec','operationId']));
      else if(parts.length===2&&parts[1]==='published'&&method==='GET') result=await store.getPublished(principal,parts[0]);
      else if(parts.length===2&&parts[1]==='workflows'&&method==='GET') result=await store.queryWorkflowReceipts(principal,parts[0]);
      else if(parts.length===2&&parts[1]==='validate'&&method==='POST') {fields(input,[]);result=await store.validate(principal,parts[0]);}
      else if(parts.length===2&&parts[1]==='publish'&&method==='POST') result=await store.publish(principal,parts[0],fields(input,['expectedVersion','operationId'],['expectedVersion','operationId']));
      else if(parts.length===2&&parts[1]==='records'&&method==='GET') {
        for(const key of url.searchParams.keys()) if(!['entityId','limit','after'].includes(key)||url.searchParams.getAll(key).length!==1) error('invalid_arguments',`Unknown or repeated query argument: ${key}`);
        const rawLimit=url.searchParams.get('limit');
        if(rawLimit!==null&&!/^[1-9][0-9]*$/.test(rawLimit)) error('invalid_arguments','limit must be a positive integer');
        result=await store.queryRecords(principal,parts[0],{entityId:url.searchParams.get('entityId'),limit:rawLimit===null?25:Number(rawLimit),after:url.searchParams.get('after')});
      }
      else if(parts.length===2&&parts[1]==='records'&&method==='POST') result=await store.writeRecord(principal,parts[0],fields(input,['entityId','data','operationId'],['entityId','data','operationId']));
      else if(parts.length===3&&parts[1]==='records'&&method==='PATCH') result=await store.writeRecord(principal,parts[0],fields(input,['expectedVersion','data','operationId'],['expectedVersion','data','operationId']),parts[2]);
      else error('not_found','App runtime operation not found');
      jsonResponse(res,result,200);
    } catch(cause) {
      if(cause instanceof AppRuntimeError) jsonResponse(res,{error:{code:cause.code,message:cause.message,details:cause.details}},STATUS[cause.code]??400);
      else jsonResponse(res,{error:{code:'internal_error',message:'App runtime operation failed',details:{}}},500);
    }
    return true;
  };
}
