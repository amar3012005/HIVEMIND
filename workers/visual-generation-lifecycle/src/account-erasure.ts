/** Trusted server-only lifecycle call. No arbitrary bucket, prefix or recursive deletion. */
export async function eraseOwnedVisualAsset(bucket: R2Bucket, input: any) {
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 const {org_id,job_id,key}=input||{};
 if(!uuid.test(org_id||'')||!uuid.test(job_id||'')||typeof key!=='string'||!key.startsWith(`org/${org_id}/visual-generation/${job_id}/`)||!/^[-a-zA-Z0-9_/.]+$/.test(key)||key.split('/').some((x: string)=>!x||x==='.'||x==='..'))return Response.json({error:'invalid_erasure_scope'},{status:400});
 await bucket.delete(key);
 if(await bucket.head(key))return Response.json({error:'asset_erasure_unverified'},{status:503});
 return Response.json({key,verifiedAbsent:true});
}
