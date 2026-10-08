import { AI_DISCLOSURE_VERSION } from './privacy-routes.js';
export function nativeAiProtectedPath(pathname, method) {
  if (method === 'OPTIONS') return false;
  if (pathname === '/v1/proxy/health') return false;
  if (/^\/v1\/harness-chat\/sessions\/[^/]+$/.test(pathname) && method === 'DELETE') return false;
  return /^\/v1\/(?:proxy|harness-chat|chat|research|meetings|tara|hyper)(?:\/|$)/.test(pathname);
}
export async function checkNativeAiConsent(prisma, session) {
  if (!session?.nativeMobile) return { allowed: true };
  if (!prisma?.auditLog) return { allowed: false, status: 503, code: 'MOBILE_CONSENT_UNAVAILABLE' };
  try {
    const latest = await prisma.auditLog.findFirst({ where: {userId:session.userId,eventType:'mobile.ai_consent'}, orderBy:[{createdAt:'desc'},{id:'desc'}], select:{metadata:true} });
    return latest?.metadata?.version === AI_DISCLOSURE_VERSION && latest?.metadata?.granted === true
      ? {allowed:true} : {allowed:false,status:403,code:'MOBILE_AI_CONSENT_REQUIRED'};
  } catch { return {allowed:false,status:503,code:'MOBILE_CONSENT_UNAVAILABLE'}; }
}
export async function nativeBootstrapApiKey(session, org, createKey, userId) {
  return session?.nativeMobile || !org ? null : createKey(userId,org.id);
}
