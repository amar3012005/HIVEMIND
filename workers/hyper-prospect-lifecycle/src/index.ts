import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params={prospect_job_id:string;org_id:string;user_id:string;room_id:string;turn_id:string};
type Env={PROSPECT_WORKFLOW:Workflow<Params>;HIVEMIND_CONTROL_URL:string;HIVEMIND_PROSPECT_WORKFLOW_SECRET:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const valid=(p:unknown):p is Params=>!!p&&typeof p==='object'&&['prospect_job_id','org_id','user_id','room_id','turn_id'].every(k=>UUID.test(String((p as Record<string,unknown>)[k]||'')));
const authorized=(r:Request,e:Env)=>(r.headers.get('authorization')||'')==='Bearer '+e.HIVEMIND_PROSPECT_WORKFLOW_SECRET;
async function stage(env:Env,name:string,p:Params):Promise<any>{
 const control=env.HIVEMIND_CONTROL_URL.replace(/\/$/,'');
 const response=await fetch(control+'/internal/hyper-prospect/'+name,{method:'POST',headers:{authorization:'Bearer '+env.HIVEMIND_PROSPECT_WORKFLOW_SECRET,'content-type':'application/json'},body:JSON.stringify(p)});
 const body:any=await response.json<any>().catch(()=>({}));
 if(!response.ok){const message=String(body.error||('prospect_'+name+'_http_'+response.status));if(body.retryable===false||[400,401,403,404,422].includes(response.status))throw new NonRetryableError(message);throw new Error(message);}return body;
}
export class ProspectLifecycleWorkflow extends WorkflowEntrypoint<Env,Params>{
 async run(event:WorkflowEvent<Params>,step:WorkflowStep){
  if(!valid(event.payload))throw new NonRetryableError('invalid_prospect_payload');const p=event.payload;
  const prepare=await step.do('admit scoped prospect job',{retries:{limit:3,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'prepare',p));
  const discover=await step.do('discover through governed route',{retries:{limit:3,delay:'30 seconds',backoff:'exponential'},timeout:'15 minutes'},()=>stage(this.env,'discover',p));
  const normalize=await step.do('normalize and deduplicate',{retries:{limit:2,delay:'5 seconds'},timeout:'2 minutes'},()=>stage(this.env,'normalize',p));
  const verify=await step.do('verify candidate evidence',{retries:{limit:2,delay:'10 seconds'},timeout:'5 minutes'},()=>stage(this.env,'verify',p));
  const enrich=await step.do('enrich verified candidates',{retries:{limit:2,delay:'30 seconds',backoff:'exponential'},timeout:'15 minutes'},()=>stage(this.env,'enrich',p));
  const qualify=await step.do('qualify under room policy',{retries:{limit:2,delay:'10 seconds'},timeout:'5 minutes'},()=>stage(this.env,'qualify',p));
  const outreach=await step.do('prepare optional outreach assignments',{retries:{limit:2,delay:'10 seconds'},timeout:'2 minutes'},()=>stage(this.env,'prepare-outreach',p));
  const approval=await step.do('enforce external-action approval gate',{retries:{limit:1,delay:'5 seconds'},timeout:'2 minutes'},()=>stage(this.env,'approval',p));
  const compare=await step.do('compare with current room path',{retries:{limit:2,delay:'10 seconds'},timeout:'2 minutes'},()=>stage(this.env,'compare',p));
  const receipt=await step.do('persist shadow parity receipt',{retries:{limit:5,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'persist',p));
  return {ok:true,instance_id:event.instanceId,prepare,discover,normalize,verify,enrich,qualify,outreach,approval,compare,receipt};
 }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(!authorized(request,env))return Response.json({error:'Unauthorized'},{status:401});const url=new URL(request.url);
 if(request.method==='POST'&&url.pathname==='/start'){const params=await request.json<unknown>().catch(()=>null);if(!valid(params))return Response.json({error:'invalid_payload'},{status:400});const id='prospect-'+params.prospect_job_id;try{await env.PROSPECT_WORKFLOW.create({id,params,retention:{successRetention:'30 days',errorRetention:'30 days'}});}catch{const instance=await env.PROSPECT_WORKFLOW.get(id);const status=await instance.status();if(status.status==='errored'||status.status==='terminated')await instance.restart();}return Response.json({ok:true,instance_id:id},{status:202});}
 if(request.method==='GET'&&url.pathname==='/status'){const id=url.searchParams.get('instance_id');if(!id)return Response.json({error:'instance_id_required'},{status:400});const instance=await env.PROSPECT_WORKFLOW.get(id);return Response.json({instance_id:id,status:await instance.status()});}
 return Response.json({error:'Not found'},{status:404});
}} satisfies ExportedHandler<Env>;
