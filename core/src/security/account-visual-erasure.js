/** Preserve asset coordinates until the exact tenant/job-owned R2 copy is verified absent. */
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function eraseExclusiveVisualAssets(prisma,userId,orgIds,{fetcher=fetch,endpoint=process.env.HIVEMIND_VISUAL_GENERATION_URL||'https://hivemind-visual-generation.amarsai2005.workers.dev',token=process.env.HIVEMIND_VISUAL_GENERATION_SECRET||process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET}={}){
 const jobs=await prisma.visualGenerationJob.findMany({where:{userId,orgId:{in:orgIds}},select:{id:true,orgId:true,status:true,assets:true}});
 const coordinates=[];
 for(const job of jobs){
  if(!['completed','failed','cancelled'].includes(job.status))fail('ERASURE_VISUAL_WORK_ACTIVE');
  if(!Array.isArray(job.assets))fail('ERASURE_VISUAL_SCOPE_UNVERIFIED');
  for(const asset of job.assets){
   const key=asset.r2_key;
   if(typeof key!=='string'||!key.startsWith(`org/${job.orgId}/visual-generation/${job.id}/`)||!/^[-a-zA-Z0-9_/.]+$/.test(key)||key.split('/').some(x=>!x||x==='.'||x==='..'))fail('ERASURE_VISUAL_SCOPE_UNVERIFIED');
   const foreign=await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM hivemind.visual_generation_jobs j WHERE j.id<>$1::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.assets) a WHERE a->>'r2_key'=$2)",job.id,key);
   if(!foreign[0]?.count)coordinates.push({key,orgId:job.orgId,jobId:job.id});
  }
 }
 if(!coordinates.length)return{verified:true,objects:0};
 if(!endpoint||!token)fail('ERASURE_VISUAL_STORE_UNAVAILABLE');
 for(const {key,orgId,jobId} of coordinates){
  const response=await fetcher(`${endpoint.replace(/\/$/,'')}/erase-owned-asset`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({org_id:orgId,job_id:jobId,key}),signal:AbortSignal.timeout(15000)});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result?.verifiedAbsent||result.key!==key)fail('ERASURE_VISUAL_OBJECT_UNVERIFIED');
 }
 return{verified:true,objects:coordinates.length};
}
