import crypto from 'node:crypto';
const normalizedEmail=value=>String(value||'').trim().toLowerCase();
export const erasureEmailHash=email=>crypto.createHash('sha256').update(normalizedEmail(email)).digest('hex');
export function validPlatformErasureAuthority(authority,actorId,userId) {
 return authority?.kind==='platform_admin' && authority.sessionId===actorId && authority.userId===userId && typeof authority.operator==='string' && authority.operator.length>0 && /^[a-f0-9]{64}$/.test(authority.targetEmailHash||'');
}
