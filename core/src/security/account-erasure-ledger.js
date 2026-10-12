import crypto from 'node:crypto';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = code => {throw Object.assign(new Error(code),{code,status:409});};
/** Admission is called only after authenticated DELETE confirmation and read-only ownership validation. */
export async function admitAccountErasure(prisma,{userId,ownershipSnapshot}) {
 if(!uuid(userId) || !ownershipSnapshot) fail('ERASURE_SCOPE_REQUIRED');
 return prisma.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',`account-erasure:${userId}`);
  const rows=await tx.$queryRawUnsafe(`INSERT INTO hivemind.account_erasure_operations(user_id,ownership_snapshot) VALUES($1::uuid,$2::jsonb)
   ON CONFLICT(user_id) WHERE state<>'completed' DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *`,userId,JSON.stringify(ownershipSnapshot));
  return rows[0];
 });
}
export async function claimAccountErasure(prisma,{workerId,leaseSeconds=30}) {
 if(!uuid(workerId) || !Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300) fail('ERASURE_LEASE_INVALID');
 const rows=await prisma.$queryRawUnsafe(`WITH candidate AS (SELECT id FROM hivemind.account_erasure_operations WHERE state IN ('pending','processing','blocked') AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE hivemind.account_erasure_operations op SET state='processing',lease_owner=$1::uuid,lease_until=now()+($2*interval '1 second'),attempts=attempts+1,updated_at=now() FROM candidate WHERE op.id=candidate.id RETURNING op.*`,workerId,leaseSeconds);
 return rows[0]??null;
}
export async function saveErasureReceipt(prisma,{operationId,workerId,store,coordinate,outcome,evidence}) {
 if(!uuid(operationId)||!uuid(workerId)||!store||!coordinate||!['erased','retained_shared'].includes(outcome)||!evidence?.verified) fail('ERASURE_RECEIPT_UNVERIFIED');
 if(outcome==='retained_shared'&&!evidence.foreignReferences) fail('ERASURE_SHARED_RETENTION_UNVERIFIED');
 const hash=crypto.createHash('sha256').update(coordinate).digest('hex');
 const rows=await prisma.$queryRawUnsafe(`INSERT INTO hivemind.account_erasure_receipts(operation_id,store,coordinate_hash,outcome,evidence)
 SELECT id,$3,$4,$5,$6::jsonb FROM hivemind.account_erasure_operations WHERE id=$1::uuid AND lease_owner=$2::uuid AND lease_until>now() AND state='processing'
 ON CONFLICT(operation_id,store,coordinate_hash) DO NOTHING RETURNING operation_id`,operationId,workerId,store,hash,outcome,JSON.stringify(evidence));
 // Empty insert can mean replay; independently verify the lease and exact existing receipt.
 if(!rows.length){const existing=await prisma.$queryRawUnsafe(`SELECT r.outcome FROM hivemind.account_erasure_receipts r JOIN hivemind.account_erasure_operations o ON o.id=r.operation_id WHERE o.id=$1::uuid AND o.lease_owner=$2::uuid AND o.lease_until>now() AND o.state='processing' AND r.store=$3 AND r.coordinate_hash=$4`,operationId,workerId,store,hash);if(existing[0]?.outcome!==outcome)fail('ERASURE_LEASE_OR_RECEIPT_CONFLICT');}
}
export async function blockAccountErasure(prisma,{operationId,workerId,code,retrySeconds=60}) {
 if(!uuid(operationId)||!uuid(workerId)||!Number.isInteger(retrySeconds)||retrySeconds<1||retrySeconds>86400)fail('ERASURE_RETRY_INVALID');
 const count=await prisma.$executeRawUnsafe(`UPDATE hivemind.account_erasure_operations SET state='blocked',failure_code=$3,next_attempt_at=now()+($4*interval '1 second'),lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid AND lease_owner=$2::uuid AND lease_until>now() AND state='processing'`,operationId,workerId,code,retrySeconds);
 if(!count)fail('ERASURE_LEASE_LOST');
}
