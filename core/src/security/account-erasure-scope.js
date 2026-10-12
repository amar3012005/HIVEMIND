/** Pure ownership planning. Never invokes legacy validateAccountDeletion, which promotes owners. */
export async function planAccountErasureScope(prisma, userId) {
  const memberships = await prisma.userOrganization.findMany({where:{userId},select:{orgId:true,role:true}});
  const organizations = [];
  for (const membership of memberships) {
    const others = await prisma.userOrganization.findMany({
      where:{orgId:membership.orgId,userId:{not:userId}},
      select:{userId:true,role:true},
    });
    organizations.push({orgId:membership.orgId,disposition:membership.role==='owner'&&!others.length?'delete_exclusive':'retain_shared',remainingMembers:others.map(row=>({userId:row.userId,role:row.role}))});
  }
  return {userId,organizations,connectorOriginals:'retain',plannedAt:new Date().toISOString()};
}
/** Shared object keys belong to the tenant, not the last uploader. */
export async function inspectSourceObjectRetention(prisma,{userId,sourceObjectKey}) {
  if (!userId || !sourceObjectKey) throw new Error('Owned source coordinates required');
  const foreign = await prisma.knowledgeIngestJob.count({where:{sourceObjectKey,userId:{not:userId}}});
  return {disposition:foreign?'retained_shared':'erase_owned_copy',foreignReferences:foreign};
}
