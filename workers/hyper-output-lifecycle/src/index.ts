import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
type Params={output_job_id:string;org_id:string;user_id:string;room_id:string;turn_id:string};
type Env={OUTPUT_WORKFLOW:Workflow<Params>;HIVEMIND_CONTROL_URL:string;HIVEMIND_OUTPUT_WORKFLOW_SECRET:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const valid=(p:unknown):p is Params=>!!p&&typeof p==='object'&&['output_job_id','org_id','user_id','room_id','turn_id'].every(k=>UUID.test(String((p as Record<string,unknown>)[k]||'')));
const authorized=(r:Request,e:Env)=>(r.headers.get('authorization')||'')==='Bearer '+e.HIVEMIND_OUTPUT_WORKFLOW_SECRET;
async function stage(env:Env,name:string,p:Params):Promise<Record<string,any>>{
 const control=env.HIVEMIND_CONTROL_URL.endsWith('/')?env.HIVEMIND_CONTROL_URL.slice(0,-1):env.HIVEMIND_CONTROL_URL;
 const response=await fetch(control+'/internal/hyper-output/'+name,{method:'POST',headers:{authorization:'Bearer '+env.HIVEMIND_OUTPUT_WORKFLOW_SECRET,'content-type':'application/json'},body:JSON.stringify(p)});
 const body:Record<string,any>=await response.json<Record<string,any>>().catch(()=>({}));
 if(!response.ok){const message=String(body.error||('output_'+name+'_http_'+response.status));if(body.retryable===false||[400,401,403,404,422].includes(response.status))throw new NonRetryableError(message);throw new Error(message);}
 return body;
}
export class HyperOutputWorkflow extends WorkflowEntrypoint<Env,Params>{
 async run(event:WorkflowEvent<Params>,step:WorkflowStep){
  if(!valid(event.payload))throw new NonRetryableError('invalid_output_payload');const p=event.payload;
  const prepare=await step.do('prepare sealed output',{retries:{limit:5,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'prepare',p));
  const render=await step.do('render governed artifact',{retries:{limit:3,delay:'30 seconds',backoff:'exponential'},timeout:'5 minutes'},()=>stage(this.env,'render',p));
  const validate=await step.do('validate governed artifact',{retries:{limit:1,delay:'5 seconds'},timeout:'2 minutes'},()=>stage(this.env,'validate',p));
  const receipt=await step.do('persist digest bound receipt',{retries:{limit:5,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'persist',p));
  return {ok:true,instance_id:event.instanceId,prepare,render,validate,receipt};
 }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(!authorized(request,env))return Response.json({error:'Unauthorized'},{status:401});const url=new URL(request.url);
 if(request.method==='POST'&&url.pathname==='/start'){const params=await request.json<unknown>().catch(()=>null);if(!valid(params))return Response.json({error:'invalid_payload'},{status:400});const id='output-'+params.output_job_id;try{await env.OUTPUT_WORKFLOW.create({id,params,retention:{successRetention:'30 days',errorRetention:'30 days'}});}catch{const instance=await env.OUTPUT_WORKFLOW.get(id);const status=await instance.status();if(status.status==='errored'||status.status==='terminated')await instance.restart();}return Response.json({ok:true,instance_id:id},{status:202});}
 if(request.method==='GET'&&url.pathname==='/status'){const id=url.searchParams.get('instance_id');if(!id)return Response.json({error:'instance_id_required'},{status:400});const instance=await env.OUTPUT_WORKFLOW.get(id);return Response.json({instance_id:id,status:await instance.status()});}
 return Response.json({error:'Not found'},{status:404});
}} satisfies ExportedHandler<Env>;
