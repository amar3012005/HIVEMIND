import {PERSONAL_COLLECTION,orgContainerName} from '../vector/container-router.js';
export async function transferSharedMemoryVectors({userId,orgId,replacementId,memoryIds},fetcher=fetch) {
 const root=process.env.QDRANT_URL;if(!root)throw Object.assign(new Error('Vector transfer unavailable'),{code:'VECTOR_TRANSFER_UNAVAILABLE'});
 const headers={'content-type':'application/json',...(process.env.QDRANT_API_KEY?{'api-key':process.env.QDRANT_API_KEY}:{})};
 for(const collection of new Set([PERSONAL_COLLECTION,orgContainerName(orgId)]))for(let i=0;i<memoryIds.length;i+=256){
  const ids=memoryIds.slice(i,i+256);const url=`${root}/collections/${collection}`;
  const filter={must:[{key:'user_id',match:{value:userId}},{key:'memory_id',match:{any:ids}},{key:'org_id',match:{value:orgId}}]};
  const response=await fetcher(`${url}/points/payload?wait=true`,{method:'POST',headers,body:JSON.stringify({payload:{user_id:replacementId},filter}),signal:AbortSignal.timeout(20000)});
  if(response.status===404)continue;
  if(!response.ok)throw Object.assign(new Error('Shared vector transfer failed'),{code:'VECTOR_TRANSFER_INCOMPLETE'});
  const counted=await fetcher(`${url}/points/count`,{method:'POST',headers,body:JSON.stringify({filter,exact:true}),signal:AbortSignal.timeout(20000)});
  if(!counted.ok||(await counted.json()).result?.count!==0)throw Object.assign(new Error('Shared vector transfer unconfirmed'),{code:'VECTOR_TRANSFER_INCOMPLETE'});
 }
}
