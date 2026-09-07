import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params={evidence_job_id:string;org_id:string;user_id:string;room_id:string;turn_id:string};
type Env={EVIDENCE_WORKFLOW:Workflow<Params>;HIVEMIND_CONTROL_URL:string;HIVEMIND_EVIDENCE_WORKFLOW_SECRET:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const valid=(p:unknown):p is Params=>!!p&&typeof p==='object'&&['evidence_job_id','org_id','user_id','room_id','turn_id'].every(k=>UUID.test(String((p as Record<string,unknown>)[k]||'')));
const authorized=(r:Request,e:Env)=>(r.headers.get('authorization')||'')==='Bearer '+e.HIVEMIND_EVIDENCE_WORKFLOW_SECRET;

async function stage(env:Env,name:string,p:Params):Promise<Record<string,any>>{
  const control=env.HIVEMIND_CONTROL_URL.replace(/\/$/,'');
  const response=await fetch(control+'/internal/hyper-evidence/'+name,{method:'POST',headers:{authorization:'Bearer '+env.HIVEMIND_EVIDENCE_WORKFLOW_SECRET,'content-type':'application/json'},body:JSON.stringify(p)});
  const body:Record<string,any>=await response.json<Record<string,any>>().catch(()=>({}));
  if(!response.ok){const message=String(body.error||('evidence_'+name+'_http_'+response.status));if(body.retryable===false||[400,401,403,404,422].includes(response.status))throw new NonRetryableError(message);throw new Error(message);}
  return body;
}

export class HyperEvidenceWorkflow extends WorkflowEntrypoint<Env,Params>{
  async run(event:WorkflowEvent<Params>,step:WorkflowStep){
    if(!valid(event.payload))throw new NonRetryableError('invalid_evidence_payload');
    const p=event.payload;
    const prepare=await step.do('prepare evidence request',{retries:{limit:5,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'prepare',p));
    const acquire=await step.do('acquire governed evidence',{retries:{limit:5,delay:'30 seconds',backoff:'exponential'},timeout:'10 minutes'},()=>stage(this.env,'acquire',p));
    const receipt=await step.do('persist evidence receipt',{retries:{limit:5,delay:'10 seconds',backoff:'exponential'},timeout:'2 minutes'},()=>stage(this.env,'persist',p));
    return {ok:true,instance_id:event.instanceId,prepare,acquire,receipt};
  }
}

export default {async fetch(request:Request,env:Env):Promise<Response>{
  if(!authorized(request,env))return Response.json({error:'Unauthorized'},{status:401});
  const url=new URL(request.url);
  if(request.method==='POST'&&url.pathname==='/start'){
    const params=await request.json<unknown>().catch(()=>null);
    if(!valid(params))return Response.json({error:'invalid_payload'},{status:400});
    const id='evidence-'+params.evidence_job_id;
    try{await env.EVIDENCE_WORKFLOW.create({id,params,retention:{successRetention:'30 days',errorRetention:'30 days'}});}
    catch{const instance=await env.EVIDENCE_WORKFLOW.get(id);const status=await instance.status();if(status.status==='errored'||status.status==='terminated')await instance.restart();}
    return Response.json({ok:true,instance_id:id},{status:202});
  }
  if(request.method==='GET'&&url.pathname==='/status'){
    const id=url.searchParams.get('instance_id');if(!id)return Response.json({error:'instance_id_required'},{status:400});
    return Response.json({instance_id:id,status:await (await env.EVIDENCE_WORKFLOW.get(id)).status()});
  }
  return Response.json({error:'Not found'},{status:404});
}} satisfies ExportedHandler<Env>;
