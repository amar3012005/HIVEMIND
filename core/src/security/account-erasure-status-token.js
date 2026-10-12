import crypto from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=value=>crypto.createHash('sha256').update(value).digest();
export async function issueErasureStatusToken(prisma,operationId,userId) {
  const secret=crypto.randomBytes(32).toString('base64url');
  const token=`erasure.${operationId}.${secret}`;
  const changed=await prisma.$executeRawUnsafe("UPDATE hivemind.account_erasure_operations SET status_token_hash=$3,status_token_expires_at=now()+interval '24 hours' WHERE id=$1::uuid AND user_id=$2::uuid",operationId,userId,hash(token).toString('hex'));
  if(!changed)throw new Error('Erasure operation unavailable');
  return token;
}
export async function readErasureStatusToken(prisma,authorization,operationId,now=new Date()) {
  const token=String(authorization||'').replace(/^Erasure /,'');
  const match=/^erasure\.([^.]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if(!match||!UUID.test(match[1])||match[1]!==operationId)return null;
  const rows=await prisma.$queryRawUnsafe('SELECT id,state,failure_code,created_at,updated_at,status_token_hash,status_token_expires_at FROM hivemind.account_erasure_operations WHERE id=$1::uuid',match[1]);
  const operation=rows[0];
  const expiry=new Date(operation?.status_token_expires_at);
  if(!operation?.status_token_hash||!Number.isFinite(expiry.getTime())||expiry<=now)return null;
  const expected=Buffer.from(operation.status_token_hash,'hex');const received=hash(token);
  if(expected.length!==received.length||!crypto.timingSafeEqual(expected,received))return null;
  const {status_token_hash,status_token_expires_at,...status}=operation;
  return status;
}
