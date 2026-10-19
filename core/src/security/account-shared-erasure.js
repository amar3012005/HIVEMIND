/** Transfer company-owned records, not private records, before erasing their author. */
export async function transferSharedAccountData(prisma,{userId,scope,transferVectors}) {
 for(const org of scope.organizations.filter(x=>x.disposition==='retain_shared')) {
  const next=org.remainingMembers.slice().sort((a,b)=>(a.role==='owner'?0:a.role==='admin'?1:2)-(b.role==='owner'?0:b.role==='admin'?1:2)||a.userId.localeCompare(b.userId))[0];
  if(!next)throw Object.assign(new Error('Company custodian unavailable'),{code:'ERASURE_SHARED_CUSTODIAN_REQUIRED'});
  // Explicit sharing is authority to retain; org association alone is not.
  const memories=await prisma.memory.findMany({where:{userId,orgId:org.orgId,OR:[{scope:{in:['organization','project','team']}},{visibility:{in:['organization','public']}}]},select:{id:true}});
  if(memories.length)await transferVectors({userId,orgId:org.orgId,replacementId:next.userId,memoryIds:memories.map(x=>x.id)});
  await prisma.$transaction(async tx=>{
   const member=await tx.userOrganization.findFirst({where:{userId:next.userId,orgId:org.orgId}});
   if(!member)throw Object.assign(new Error('Company ownership changed'),{code:'ERASURE_OWNERSHIP_CHANGED'});
   await tx.memory.updateMany({where:{id:{in:memories.map(x=>x.id)},userId,orgId:org.orgId},data:{userId:next.userId}});
   // Knowledge sources belong to the shared company; private chat/uploads without
   // a company source remain in the erasing user's scope.
   for(const model of ['knowledgeIngestJob','knowledgeDocument','sourceArtifact','knowledgeSegment','documentTable'])
    await tx[model].updateMany({where:{userId,orgId:org.orgId},data:{userId:next.userId}});
  });
 }
}
