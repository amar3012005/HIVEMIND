/** Repair explicitly selected completed receipts from releases predating orphan cleanup.
 * Run by the platform operator; never accepts an email, user ID, bucket or path.
 */
import {PrismaClient} from '@prisma/client';
import {cleanupPrivateAccountRows} from '../src/security/account-private-cleanup.js';
import {validPlatformErasureAuthority} from '../src/security/account-erasure-authority.js';
const prisma=new PrismaClient();
try {
 for(const operationId of process.argv.slice(2)){
  if(!/^[a-f0-9-]{36}$/i.test(operationId))throw Error('Exact operation receipt required');
  const [op]=await prisma.$queryRawUnsafe("SELECT * FROM hivemind.account_erasure_operations WHERE id=$1::uuid AND state='completed' AND confirmation='DELETE'",operationId);
  if(!op||!validPlatformErasureAuthority(op.ownership_snapshot?.platformAdmin,op.actor_id,op.user_id))throw Error('Verified completed administrator receipt required');
  if(await prisma.user.count({where:{id:op.user_id}}))throw Error('Identity is still present; use the normal durable worker');
  for(const org of op.ownership_snapshot.organizations.filter(x=>x.disposition==='delete_exclusive'))if(await prisma.userOrganization.count({where:{orgId:org.orgId}}))throw Error('Company ownership changed; reconciliation required');
  await cleanupPrivateAccountRows(prisma,op.user_id,op.ownership_snapshot.organizations);
  console.log(JSON.stringify({operationId,ownedOrphansReconciled:true}));
 }
}finally{await prisma.$disconnect()}
