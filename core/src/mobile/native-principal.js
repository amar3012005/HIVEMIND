import { createHash } from 'node:crypto';
import { getRedisClient } from '../control-plane/session-store.js';
import { checkNativeAiConsent } from './consent-guard.js';
export const nativeSessionHash = (sessionId) => createHash('sha256').update(sessionId).digest('hex');
export const validNativeHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export async function nativeRunnerPrincipalAllowed({claims,prisma,redisConfig,getRedis=getRedisClient}) {
  if (claims.native_session_hash === undefined) return true;
  if (!validNativeHash(claims.native_session_hash)) return false;
  try {
    const redis=await getRedis(redisConfig || {});if(!redis)return false;
    const sessionId=await redis.get(`cp:mobile-native-index:${claims.native_session_hash}`);
    if (!sessionId || nativeSessionHash(sessionId)!==claims.native_session_hash) return false;
    const raw=await redis.get(`cp:session:${sessionId}`);if(!raw)return false;
    const session=JSON.parse(raw);
    if(session.nativeMobile!==true || session.userId!==claims.sub || session.orgId!==claims.org_id)return false;
    return (await checkNativeAiConsent(prisma,session)).allowed;
  } catch {return false;}
}
