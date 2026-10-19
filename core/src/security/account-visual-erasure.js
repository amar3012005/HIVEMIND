/** Preserve asset coordinates until the exact tenant/job-owned R2 copy is verified absent. */
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function eraseExclusiveVisualAssets(prisma,userId,orgIds,{fetcher=fetch,accountId=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN}={}){
 const jobs=await prisma.visualGenerationJob.findMany({where:{userId,orgId:{in:orgIds}},select:{id:true,orgId:true,status:true,assets:true}});
 const coordinates=[];
 for(const job of jobs){
  if(!['completed','failed','cancelled'].includes(job.status))fail('ERASURE_VISUAL_WORK_ACTIVE');
  if(!Array.isArray(job.assets))fail('ERASURE_VISUAL_SCOPE_UNVERIFIED');
  for(const asset of job.assets){
   const key=asset.r2_key;
   if(typeof key!=='string'||!key.startsWith(`org/${job.orgId}/visual-generation/${job.id}/`)||!/^[-a-zA-Z0-9_/.]+$/.test(key)||key.split('/').some(x=>!x||x==='.'||x==='..'))fail('ERASURE_VISUAL_SCOPE_UNVERIFIED');
   const foreign=await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM hivemind.visual_generation_jobs j WHERE j.id<>$1::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.assets) a WHERE a->>'r2_key'=$2)",job.id,key);
   if(!foreign[0]?.count)coordinates.push(key);
  }
 }
 if(!coordinates.length)return{verified:true,objects:0};
 if(!/^[a-f0-9]{32}$/.test(accountId||'')||!token)fail('ERASURE_VISUAL_STORE_UNAVAILABLE');
 const root=`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/hivemind-visual-intelligence-artifacts`;
 const headers={authorization:`Bearer ${token}`,'cf-r2-data-catalog-check':'true'};
 const request=(url,method)=>fetcher(url,{method,headers,signal:AbortSignal.timeout(15000)});
 const bucket=await request(root,'GET');if(!bucket.ok)fail('ERASURE_VISUAL_STORE_UNAVAILABLE');await bucket.body?.cancel();
 for(const key of new Set(coordinates)){
  const url=`${root}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
  const removed=await request(url,'DELETE');if(!removed.ok&&removed.status!==404)fail('ERASURE_VISUAL_OBJECT_FAILED');await removed.body?.cancel();
  const check=await request(url,'GET');await check.body?.cancel();if(check.status!==404)fail('ERASURE_VISUAL_OBJECT_UNVERIFIED');
 }
 return{verified:true,objects:new Set(coordinates).size};
}
