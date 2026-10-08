// Workspace activation must not turn an OS-held native credential into a browser
// session, extend its lifetime, or leave the application holding a revoked token.
export const NATIVE_ORGANIZATION_UPDATE = `local raw=redis.call('GET',KEYS[1]);if not raw then return false end
local rec=cjson.decode(raw);local expected=cjson.decode(ARGV[1]);
if rec.nativeMobile~=true or rec.userId~=expected.userId or rec.orgId~=expected.orgId then return false end
local ttl=redis.call('PTTL',KEYS[1]);if ttl<=0 then return false end
rec.orgId=ARGV[2];redis.call('SET',KEYS[1],cjson.encode(rec),'PX',ttl);return true`;
export async function changeSessionOrganization({ current, orgId, sessionStore, mobileAuthStore }) {
  if (current.session.nativeMobile === true) {
    const redis = await mobileAuthStore.client();
    const updated = await redis.eval(NATIVE_ORGANIZATION_UPDATE, 1, `cp:session:${current.sessionId}`, JSON.stringify({ userId: current.session.userId, orgId: current.session.orgId ?? null }), orgId);
    if (!updated) throw Object.assign(new Error('Native session expired or changed. Sign in again.'), { status: 401 });
    return current.sessionId;
  }
  await sessionStore.destroySession(current.sessionId);
  return sessionStore.createSession({ ...current.session, orgId });
}
