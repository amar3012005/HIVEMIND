/** Pure ownership planning. Never invokes legacy validateAccountDeletion, which promotes owners. */
export async function planAccountErasureScope(prisma, userId) {
  const memberships = await prisma.userOrganization.findMany({where:{userId},select:{orgId:true,role:true,org:{select:{memoryStorageMode:true,hostingMode:true}}}});
  const organizations = [];
  for (const membership of memberships) {
    const others = await prisma.userOrganization.findMany({
      where:{orgId:membership.orgId,userId:{not:userId}},
      select:{userId:true,role:true},
    });
    organizations.push({orgId:membership.orgId,storageMode:membership.org?.memoryStorageMode || 'hybrid',hostingMode:membership.org?.hostingMode || 'managed',disposition:membership.role==='owner'&&!others.length?'delete_exclusive':'retain_shared',remainingMembers:others.map(row=>({userId:row.userId,role:row.role}))});
  }
  return {userId,organizations,connectorOriginals:'retain',plannedAt:new Date().toISOString()};
}
/** Shared object keys belong to the tenant, not the last uploader. */
export async function inspectSourceObjectRetention(prisma,{userId,sourceObjectKey}) {
  if (!userId || !sourceObjectKey) throw new Error('Owned source coordinates required');
  const foreign = await prisma.knowledgeIngestJob.count({where:{sourceObjectKey,userId:{not:userId}}});
  return {disposition:foreign?'retained_shared':'erase_owned_copy',foreignReferences:foreign};
}
/** Sole membership is not proof that all persisted company copies belong to this user. */
export async function countForeignExclusiveStoreRecords(prisma,userId,organizations) {
  const orgIds=organizations.filter(org=>org.disposition==='delete_exclusive').map(org=>org.orgId);
  if(!orgIds.length)return 0;
  const counts=await Promise.all(['memory','knowledgeDocument','sourceArtifact','knowledgeIngestJob','knowledgeSegment','documentTable'].map(name=>prisma[name].count({where:{orgId:{in:orgIds},userId:{not:userId}}})));
  return counts.reduce((total,count)=>total+count,0);
}

export async function countForeignEvidenceReferences(prisma,userId) {
  return prisma.memoryEvidenceLink.count({where:{memory:{userId:{not:userId}},OR:[{document:{userId}},{segment:{userId}}]}});
}
