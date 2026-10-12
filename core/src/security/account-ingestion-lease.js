/** A crashed or timed-out external write stays active/unknown; time is never proof of drain. */
export async function withAccountIngestionLease(prisma,{userId,lane},operation) {
  if(!prisma?.$transaction || !userId || !lane) throw Object.assign(new Error('Durable ingestion lease unavailable'),{code:'INGESTION_LEASE_UNAVAILABLE'});
  const lease=await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',`account-erasure:${userId}`);
    const erased=await tx.$queryRawUnsafe("SELECT id FROM hivemind.account_erasure_operations WHERE user_id=$1::uuid AND state<>'completed' LIMIT 1",userId);
    if(erased.length) throw Object.assign(new Error('Account erasure fences ingestion'),{code:'ACCOUNT_ERASURE_ACTIVE'});
    return (await tx.$queryRawUnsafe('INSERT INTO hivemind.account_ingestion_leases(user_id,lane) VALUES($1::uuid,$2) RETURNING id',userId,lane))[0];
  });
  try {
    const value=await operation();
    await prisma.$executeRawUnsafe("UPDATE hivemind.account_ingestion_leases SET state='settled',settled_at=now() WHERE id=$1::uuid AND state='active'",lease.id);
    return value;
  } catch(error) {
    // A provider error/abort may still have committed a remote write. Keep it blocked
    // until an adapter proves terminal settlement; never interpret rejection as absence.
    await prisma.$executeRawUnsafe("UPDATE hivemind.account_ingestion_leases SET state='unknown' WHERE id=$1::uuid AND state='active'",lease.id).catch(()=>{});
    throw error;
  }
}
export async function verifiedAccountIngestionDrain(prisma,userId) {
  const rows=await prisma.$queryRawUnsafe("SELECT count(*)::integer AS count FROM hivemind.account_ingestion_leases WHERE user_id=$1::uuid AND state<>'settled'",userId);
  if(rows[0]?.count!==0)throw Object.assign(new Error('Unsettled ingestion prevents erasure'),{code:'ERASURE_INGEST_DRAIN_REQUIRED'});
  return {verified:true,noLateExternalWrites:true};
}
