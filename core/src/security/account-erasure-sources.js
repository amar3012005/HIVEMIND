const TERMINAL = new Set(['ready','failed','dead','cancelled']);
const keyFrom = row => row.sourceObjectKey || row.metadata?.sourceObjectKey || row.metadata?.source_object_key || row.metadata?.objectKey || row.metadata?.object_key || null;
/** Includes linked artifacts rather than assuming a document's uploader owns its bytes. */
export async function inventoryAccountErasureSources(prisma,{userId,ownershipSnapshot}) {
  const [jobs,documents,artifacts] = await Promise.all([
    prisma.knowledgeIngestJob.findMany({where:{userId}}),
    prisma.knowledgeDocument.findMany({where:{userId},include:{sourceArtifact:true}}),
    prisma.sourceArtifact.findMany({where:{userId},include:{documents:true}}),
  ]);
  const sharedOrgs = new Set(ownershipSnapshot.organizations.filter(org=>org.disposition==='retain_shared').map(org=>org.orgId));
  const coordinates = new Map();
  const invalidCoordinates = [];
  for (const row of [...jobs,...artifacts,...documents.map(doc=>doc.sourceArtifact).filter(Boolean)]) {
    const key = keyFrom(row); if(!key) continue;
    if(!/^[a-f0-9]{64}$/i.test(row.checksum||'') || !String(key).startsWith(`org/${row.orgId}/sha256/${row.checksum}/`)) {invalidCoordinates.push(row.id);continue;}
    const coordinate = coordinates.get(key) || {key,orgId:row.orgId,shared:false};
    coordinate.shared ||= row.userId!==userId || sharedOrgs.has(row.orgId) || (row.documents||[]).some(doc=>doc.userId!==userId);
    coordinates.set(key,coordinate);
  }
  for(const coordinate of coordinates.values()) {
    const [foreignJobs,foreignArtifacts] = await Promise.all([
      prisma.knowledgeIngestJob.count({where:{userId:{not:userId},OR:[{sourceObjectKey:coordinate.key},{metadata:{path:['sourceObjectKey'],equals:coordinate.key}},{metadata:{path:['source_object_key'],equals:coordinate.key}},{metadata:{path:['objectKey'],equals:coordinate.key}},{metadata:{path:['object_key'],equals:coordinate.key}}]}}),
      prisma.sourceArtifact.count({where:{OR:[{userId:{not:userId}},{documents:{some:{userId:{not:userId}}}}],AND:[{OR:[{metadata:{path:['sourceObjectKey'],equals:coordinate.key}},{metadata:{path:['source_object_key'],equals:coordinate.key}},{metadata:{path:['objectKey'],equals:coordinate.key}},{metadata:{path:['object_key'],equals:coordinate.key}}]}]}}),
    ]);
    coordinate.foreignReferences=foreignJobs+foreignArtifacts;
    coordinate.shared ||= coordinate.foreignReferences>0;
  }
  const unknownStores = artifacts.filter(row => row.storageLocation && row.storageLocation !== 'inline:source_artifacts.payload' && !/^(kb|enterprise|connector)\//.test(row.storageLocation) && !keyFrom(row));
  return {invalidCoordinates,unknownStores,jobs,documents,artifacts,coordinates:[...coordinates.values()],inFlight:jobs.filter(job=>!TERMINAL.has(job.status)),remote:jobs.filter(job=>['remote','agent','self_hosted'].includes(job.storageMode))};
}
/** Bounded physical-copy phase; never drops SQL coordinates or connector originals. */
export async function reconcileOwnedSourceObjects({inventory,objectClient,saveReceipt,drainReceipt}) {
  if(!drainReceipt?.verified || !drainReceipt.noLateExternalWrites) throw Object.assign(new Error('Ingestion drain is not verified'),{code:'ERASURE_INGEST_DRAIN_REQUIRED'});
  if(inventory.invalidCoordinates?.length) throw Object.assign(new Error('Source object ownership is not verified'),{code:'SOURCE_ERASURE_SCOPE_UNVERIFIED'});
  if(inventory.unknownStores?.length) throw Object.assign(new Error('Unknown source storage requires an erasure adapter'),{code:'SOURCE_ERASURE_ADAPTER_REQUIRED'});
  if(inventory.remote.length) throw Object.assign(new Error('Remote source-store erasure authorization required'),{code:'SOURCE_ERASURE_AUTHORIZATION_REQUIRED'});
  for(const coordinate of inventory.coordinates) {
    if(coordinate.shared) {await saveReceipt({store:'cloudflare_r2',coordinate:coordinate.key,outcome:'retained_shared',evidence:{verified:true,foreignReferences:coordinate.foreignReferences,retainedCompanyScope:true}});continue;}
    if(!objectClient?.configured()) throw Object.assign(new Error('Source store is unavailable'),{code:'SOURCE_ERASURE_AUTHORIZATION_REQUIRED'});
    const receipt = await objectClient.deleteObjectVerified(coordinate.key);
    await saveReceipt({store:'cloudflare_r2',coordinate:coordinate.key,outcome:'erased',evidence:{verified:receipt.verifiedAbsent}});
  }
}
