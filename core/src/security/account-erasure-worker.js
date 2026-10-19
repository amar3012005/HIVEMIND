import crypto from 'node:crypto';
import {validPlatformErasureAuthority,erasureEmailHash} from './account-erasure-authority.js';
import {claimAccountErasure,saveErasureReceipt,blockAccountErasure} from './account-erasure-ledger.js';
import {planAccountErasureScope,countForeignExclusiveStoreRecords,countForeignEvidenceReferences} from './account-erasure-scope.js';
import {inventoryAccountErasureSources,reconcileOwnedSourceObjects} from './account-erasure-sources.js';
import {verifiedAccountIngestionDrain} from './account-ingestion-lease.js';
import {cleanupExclusiveSourceCopies} from './account-erasure-cleanup.js';
import {requireReconciledSourceErasure} from './account-erasure-inventory.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function runAccountErasureOnce({prisma,objectClient,finalize,workerId=crypto.randomUUID()}) {
  const op=await claimAccountErasure(prisma,{workerId,leaseSeconds:300});
  if(!op)return null;
  try {
    const administrator=validPlatformErasureAuthority(op.ownership_snapshot?.platformAdmin,op.actor_id,op.user_id);
    if((op.actor_id!==op.user_id&&!administrator)||op.confirmation!=='DELETE')fail('ERASURE_CONFIRMATION_REQUIRED');
    const user=await prisma.user.findUnique({where:{id:op.user_id},select:{id:true,email:true}});
    if(user&&administrator&&erasureEmailHash(user.email)!==op.ownership_snapshot.platformAdmin.targetEmailHash)fail('ERASURE_EMAIL_CHANGED');
    if(!user && op.state!=='reconciled')fail('ERASURE_IDENTITY_STATE_UNKNOWN');
    if(user && op.state!=='reconciled') {
      const scope=op.ownership_snapshot;
      if(scope.organizations.some(org=>org.storageMode?.startsWith('byod')||org.hostingMode==='self_hosted'))fail('SOURCE_ERASURE_AUTHORIZATION_REQUIRED');
      const current=await planAccountErasureScope(prisma,op.user_id);
      const identity=items=>JSON.stringify(items.map(x=>({orgId:x.orgId,disposition:x.disposition,storageMode:x.storageMode,hostingMode:x.hostingMode,remainingMembers:x.remainingMembers.map(member=>({userId:member.userId,role:member.role})).sort((a,b)=>a.userId.localeCompare(b.userId))})).sort((a,b)=>a.orgId.localeCompare(b.orgId)));
      if(identity(scope.organizations)!==identity(current.organizations))fail('ERASURE_OWNERSHIP_CHANGED');
      if(await countForeignEvidenceReferences(prisma,op.user_id))fail('FOREIGN_EVIDENCE_REFERENCES_RETAINED');
      if(await countForeignExclusiveStoreRecords(prisma,op.user_id,scope.organizations))fail('FOREIGN_ORGANIZATION_COPIES_RETAINED');
      const knownOrgIds=scope.organizations.map(org=>org.orgId);
      const outsideMemories=await prisma.memory.count({where:{userId:op.user_id,orgId:knownOrgIds.length?{notIn:knownOrgIds}:{not:null}}});
      if(outsideMemories)fail('SHARED_MEMORY_SCOPE_UNVERIFIED');
      const shared=scope.organizations.filter(x=>x.disposition==='retain_shared').map(x=>x.orgId);
      if(shared.length) {
        const sharedMemories=await prisma.memory.count({where:{userId:op.user_id,orgId:{in:shared}}});
        if(sharedMemories)fail('SHARED_MEMORY_TRANSFER_REQUIRED');
        const memberships=await prisma.userOrganization.count({where:{userId:op.user_id,orgId:{in:shared},role:'owner'}});
        if(memberships)fail('SHARED_OWNER_TRANSFER_REQUIRED');
      }
      const inventory=await inventoryAccountErasureSources(prisma,{userId:op.user_id,ownershipSnapshot:scope});
      // All shared/remote classes block BEFORE physical deletion begins.
      const knownOrgs=new Set(scope.organizations.map(org=>org.orgId));
      if([...inventory.jobs,...inventory.documents,...inventory.artifacts].some(row=>!knownOrgs.has(row.orgId)))fail('SOURCE_ERASURE_SCOPE_UNVERIFIED');
      if(inventory.invalidCoordinates.length)fail('SOURCE_ERASURE_SCOPE_UNVERIFIED');
      if(inventory.unknownStores.length)fail('SOURCE_ERASURE_ADAPTER_REQUIRED');
      if(inventory.remote.length)fail('SOURCE_ERASURE_AUTHORIZATION_REQUIRED');
      if([...inventory.jobs,...inventory.documents,...inventory.artifacts].some(row=>shared.includes(row.orgId)))fail('SHARED_SOURCE_TRANSFER_REQUIRED');
      const drain=await verifiedAccountIngestionDrain(prisma,op.user_id);
      await reconcileOwnedSourceObjects({inventory,objectClient,drainReceipt:drain,saveReceipt:receipt=>saveErasureReceipt(prisma,{operationId:op.id,workerId,...receipt})});
      await cleanupExclusiveSourceCopies(prisma,{userId:op.user_id,operationId:op.id,workerId,ownershipSnapshot:scope,inventory,verifiedObjects:true});
      await requireReconciledSourceErasure(prisma,op.user_id);
      const count=await prisma.$executeRawUnsafe("UPDATE hivemind.account_erasure_operations SET state='reconciled',updated_at=now() WHERE id=$1::uuid AND lease_owner=$2::uuid AND lease_until>now() AND state='processing'",op.id,workerId);
      if(!count)fail('ERASURE_LEASE_LOST');
    }
    if(user) {
      const result=await finalize({userId:op.user_id,orgIdsToDelete:op.ownership_snapshot.organizations.filter(x=>x.disposition==='delete_exclusive').map(x=>x.orgId)});
      if(!result.ok)fail('ERASURE_FINALIZATION_FAILED');
    }
    const count=await prisma.$executeRawUnsafe("UPDATE hivemind.account_erasure_operations SET state='completed',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid AND lease_owner=$2::uuid AND lease_until>now() AND state='reconciled'",op.id,workerId);
    if(!count)fail('ERASURE_LEASE_LOST');
    return {status:'completed',operationId:op.id};
  } catch(error) {
    // Unsettled writes and missing ownership adapters remain blocked, never erased.
    await blockAccountErasure(prisma,{operationId:op.id,workerId,code:error.code||'ERASURE_RECONCILIATION_FAILED',retrySeconds:3600}).catch(()=>{});
    return {status:'blocked',operationId:op.id,code:error.code||'ERASURE_RECONCILIATION_FAILED'};
  }
}
