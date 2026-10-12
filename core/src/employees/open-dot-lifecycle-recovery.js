/** Durable delivery recovery on CP's existing maintenance tick; no timer or new table. */
import { createHash, randomUUID } from 'node:crypto';
import { activateBoundOpenDotEmployee } from './native-lifecycle-bridge.js';
import { requireLifecycleAdministrator } from './native-lifecycle.js';
const KEY = 'open_dot_lifecycle_delivery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_MS = 60000;
export function lifecycleDeliveryIdentity(row) {
  const policy=row?.policyRules, binding=policy?.open_dot_employee, lifecycle=policy?.native_lifecycle;
  if (!UUID.test(row?.id || '') || !UUID.test(row.orgId || '') || !UUID.test(row.createdBy || '') ||
      row.archivedAt || row.status==='paused' || binding?.version!==1 || binding.state!=='bound' || binding.execution_backend!=='open-dot' ||
      typeof binding.dot_id!=='string' || !/^dot_[A-Za-z0-9_-]{1,196}$/.test(binding.dot_id) || !Number.isSafeInteger(binding.binding_revision) || binding.binding_revision<1 ||
      lifecycle?.version!==1 || lifecycle.phase!=='active' || !['durable','temporary'].includes(lifecycle.kind) || !/^[a-f0-9]{64}$/.test(lifecycle.creation_hash || '') ||
      !['responsibilities','runtime_review','ready'].includes(lifecycle.profile_stage) ||
      !Number.isSafeInteger(lifecycle.profile_revision) || lifecycle.profile_revision<1 ||
      (lifecycle.kind==='temporary' && !(Date.parse(lifecycle.expires_at)>Date.now()))) return null;
  const source={employee_id:row.id,organization_id:row.orgId,user_id:row.createdBy,creation_hash:lifecycle.creation_hash,binding_revision:binding.binding_revision,dot_id:binding.dot_id,
    profile_revision:lifecycle.profile_revision,profile_stage:lifecycle.profile_stage};
  return {...source,fingerprint:createHash('sha256').update(JSON.stringify(source)).digest('hex')};
}
async function locked(db,id,work) {
  return db.$transaction(async tx=>{
    const initial=await tx.digitalEmployee.findUnique({where:{id}});
    if(!initial)return work(tx,null);
    // Serialize against BOTH existing canonical configure and registry binding writers.
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock',`${initial.orgId}:${id}`);
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock',`${initial.orgId}:open-dot:${id}`);
    const row=await tx.digitalEmployee.findUnique({where:{id}});
    return work(tx,row);
  });
}
/** Fresh registry authority, fenced delivery claims and bounded work per existing tick. */
export async function recoverBoundOpenDotLifecycles(db,{limit=4,now=()=>Date.now(),activate=activateBoundOpenDotEmployee}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>8)throw Error('invalid_lifecycle_recovery_limit');
  const candidates=await db.$queryRawUnsafe(`SELECT e.id FROM "hivemind"."digital_employees" e
    JOIN "hivemind"."user_organizations" m ON m.user_id=e.created_by AND m.org_id=e.org_id AND m.is_active AND m.role IN ('owner','admin')
    CROSS JOIN LATERAL (SELECT e.policy_rules->'open_dot_employee' b,e.policy_rules->'native_lifecycle' l,e.policy_rules->'${KEY}' d) p
    WHERE e.archived_at IS NULL AND e.status <> 'paused'
      AND b->'version'='1'::jsonb AND b->>'state'='bound' AND b->>'execution_backend'='open-dot'
      AND (b->>'dot_id') ~ '^dot_[A-Za-z0-9_-]{1,196}$' AND jsonb_typeof(b->'binding_revision')='number' AND (b->>'binding_revision') ~ '^[1-9][0-9]{0,14}$'
      AND l->'version'='1'::jsonb AND l->>'phase'='active'
      AND (l->>'creation_hash') ~ '^[a-f0-9]{64}$' AND l->>'profile_stage' IN ('responsibilities','runtime_review','ready')
      AND jsonb_typeof(l->'profile_revision')='number' AND (l->>'profile_revision') ~ '^[1-9][0-9]{0,14}$'
      AND (l->>'kind'='durable' OR (l->>'kind'='temporary' AND CASE WHEN pg_input_is_valid(l->>'expires_at','timestamp with time zone') THEN (l->>'expires_at')::timestamptz > clock_timestamp() ELSE false END))
      AND (d->'employee_id' IS DISTINCT FROM to_jsonb(e.id::text) OR d->'organization_id' IS DISTINCT FROM to_jsonb(e.org_id::text) OR d->'user_id' IS DISTINCT FROM to_jsonb(e.created_by::text) OR d->'creation_hash' IS DISTINCT FROM l->'creation_hash'
        OR d->'binding_revision' IS DISTINCT FROM b->'binding_revision'
        OR d->'dot_id' IS DISTINCT FROM b->'dot_id'
        OR d->'profile_revision' IS DISTINCT FROM l->'profile_revision'
        OR d->'profile_stage' IS DISTINCT FROM l->'profile_stage'
        OR ((d->>'state') IS DISTINCT FROM 'delivered'
          AND CASE WHEN d->>'next_attempt_at' ~ '^[0-9]{1,16}$' THEN (d->>'next_attempt_at')::numeric ELSE 0 END <= $2
          AND CASE WHEN d->>'claim_until' ~ '^[0-9]{1,16}$' THEN (d->>'claim_until')::numeric ELSE 0 END <= $2))
    ORDER BY e.updated_at ASC LIMIT $1`,limit,now());
  let attempted=0,delivered=0;
  for(const candidate of candidates){
    if(attempted>=limit)break;
    const claim=await locked(db,candidate.id,async(tx,row)=>{
      const identity=lifecycleDeliveryIdentity(row);if(!identity)return null;
      const principal={orgId:row.orgId,userId:row.createdBy};
      // Original creator's CURRENT administrator membership, never ambient/admin fallback.
      try{await requireLifecycleAdministrator(tx,principal);}catch{return null;}
      const previous=row.policyRules[KEY];const same=previous?.fingerprint===identity.fingerprint;
      const at=now();
      if(same&&(previous.state==='delivered'||Number(previous.next_attempt_at)>at||Number(previous.claim_until)>at))return null;
      const attempts=same&&Number.isSafeInteger(previous.attempts)&&previous.attempts>=0?Math.min(previous.attempts+1,32):1;
      const token=randomUUID();const marker={version:1,...identity,state:'delivering',attempts,claim_token:token,claim_until:at+CLAIM_MS,next_attempt_at:at+CLAIM_MS};
      await tx.digitalEmployee.update({where:{id:row.id},data:{policyRules:{...row.policyRules,[KEY]:marker}}});
      return {row,principal,identity,marker};
    });
    if(!claim)continue;
    attempted++;
    // Re-authorize after admission immediately before transmission.
    const fresh=await locked(db,candidate.id,async(tx,row)=>{
      const identity=lifecycleDeliveryIdentity(row),marker=row?.policyRules?.[KEY];
      if(identity?.fingerprint!==claim.identity.fingerprint||marker?.claim_token!==claim.marker.claim_token||marker.claim_until<=now())return null;
      try{await requireLifecycleAdministrator(tx,claim.principal);}catch{return null;}return row;
    });
    let success=false;
    if(fresh){try{const receipt=await activate(claim.principal,fresh);success=receipt?.status==='ready'&&receipt.employeeId===fresh.id;}catch{/* Fixed retry state only; no exception/body logging. */}}
    await locked(db,candidate.id,async(tx,row)=>{
      const identity=lifecycleDeliveryIdentity(row),marker=row?.policyRules?.[KEY];
      if(identity?.fingerprint!==claim.identity.fingerprint||marker?.claim_token!==claim.marker.claim_token||marker.claim_until<=now())return;
      if(success){try{await requireLifecycleAdministrator(tx,claim.principal);}catch{success=false;}}
      const at=now();const next={...marker,state:success?'delivered':'pending',claim_token:null,claim_until:0,
        next_attempt_at:success?0:at+Math.min(300000,1000*2**Math.min(marker.attempts,8)),...(success?{delivered_at:at}:{})};
      await tx.digitalEmployee.update({where:{id:row.id},data:{policyRules:{...row.policyRules,[KEY]:next}}});
      if(success)delivered++;
    });
  }
  return {attempted,delivered};
}
