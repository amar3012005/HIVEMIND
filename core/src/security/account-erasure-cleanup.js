/** Safe SQL-copy cleanup after durable object receipts; shared/remote scopes need transfer adapters. */
export async function cleanupExclusiveSourceCopies(prisma,{userId,operationId,workerId,ownershipSnapshot,inventory,verifiedObjects}) {
  if(!verifiedObjects)throw Object.assign(new Error('Source object receipts are required'),{code:'SOURCE_ERASURE_RECEIPTS_REQUIRED'});
  if(inventory.remote.length)throw Object.assign(new Error('Remote erasure adapter required'),{code:'SOURCE_ERASURE_AUTHORIZATION_REQUIRED'});
  const retained=new Set(ownershipSnapshot.organizations.filter(org=>org.disposition==='retain_shared').map(org=>org.orgId));
  if([...inventory.jobs,...inventory.documents,...inventory.artifacts].some(row=>retained.has(row.orgId)||(row.documents||[]).some(doc=>doc.userId!==userId))) {
    throw Object.assign(new Error('Shared source ownership transfer required'),{code:'SHARED_SOURCE_TRANSFER_REQUIRED'});
  }
  // Known source relations cascade their dependent evidence/step rows. Do not touch
  // connector provider originals, foreign records, or arbitrary storage-location paths.
  return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',`account-erasure:${userId}`);
    const operation=await tx.$queryRawUnsafe("SELECT id FROM hivemind.account_erasure_operations WHERE user_id=$1::uuid AND id=$2::uuid AND lease_owner=$3::uuid AND lease_until>now() AND state='processing' LIMIT 1",userId,operationId,workerId);
    if(!operation.length)throw Object.assign(new Error('Active erasure operation required'),{code:'ERASURE_OPERATION_REQUIRED'});
    const leases=await tx.$queryRawUnsafe("SELECT count(*)::integer AS count FROM hivemind.account_ingestion_leases WHERE user_id=$1::uuid AND state<>'settled'",userId);
    if(leases[0]?.count!==0)throw Object.assign(new Error('Ingestion is not drained'),{code:'ERASURE_INGEST_DRAIN_REQUIRED'});
    await tx.knowledgeIngestJob.deleteMany({where:{userId}});
    await tx.knowledgeDocument.deleteMany({where:{userId}});
    await tx.sourceArtifact.deleteMany({where:{userId,documents:{none:{}}}});
  });
}
