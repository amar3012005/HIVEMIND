import crypto from 'node:crypto';

export const DEVELOPER_START = '/auth/developer/cli/start';
export function developerRequest(value, origin) {
  try {
    const u = new URL(value);
    const cb = new URL(u.searchParams.get('callback'));
    if (u.origin !== new URL(origin).origin || u.pathname !== DEVELOPER_START || u.username || u.password) return null;
    if (cb.protocol !== 'http:' || cb.hostname !== '127.0.0.1' || !cb.port || cb.pathname !== '/callback' || cb.search || cb.hash || cb.username || cb.password) return null;
    const state = u.searchParams.get('state');
    const challenge = u.searchParams.get('code_challenge');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(challenge || '') || u.searchParams.get('code_challenge_method') !== 'S256') return null;
    return { callback: cb.toString(), state, challenge };
  } catch { return null; }
}

// Browser enrollment for the SINGULANCE developer community. Only an exact https origin listed in
// DEVELOPER_WEB_ORIGINS (default dev.singulancelabs.com) qualifies; it admits a verified identity
// without customer admission, but never grants an organization or skips an existing one.
export function developerWebReturn(value, origins = process.env.DEVELOPER_WEB_ORIGINS || 'https://dev.singulancelabs.com') {
  try {
    const u = new URL(String(value));
    const allowed = String(origins).split(',').map((entry) => entry.trim()).filter(Boolean);
    if (u.protocol !== 'https:' || !allowed.includes(u.origin) || u.username || u.password || u.hash) return null;
    return u.toString();
  } catch { return null; }
}

// A distinct audience: these credentials are never customer API keys or browser sessions.
function credentialKey(secret) {
  return crypto.createHash('sha256').update(`icarus-developer-identity\0${secret}`).digest();
}
export function developerCredential(secret, claims) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(secret), iv);
  const body = Buffer.from(JSON.stringify({ ...claims, audience: 'icarus-developer', exp: Date.now() + 7 * 86400_000 }));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return `icarus_dev_${[iv, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64url')).join('.')}`;
}
export function readDeveloperCredential(secret, token) {
  try {
    if (!token?.startsWith('icarus_dev_')) return null;
    const parts = token.slice(11).split('.');
    if (parts.length !== 3 || parts.some(v => !/^[A-Za-z0-9_-]+$/.test(v) || Buffer.from(v, 'base64url').toString('base64url') !== v)) return null;
    const [iv, tag, ciphertext] = parts.map(v => Buffer.from(v, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(secret), iv);
    decipher.setAuthTag(tag);
    const claims = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    return claims.audience === 'icarus-developer' && claims.exp > Date.now() ? claims : null;
  } catch { return null; }
}

export async function handleDeveloperCli({ pathname, req, res, url, origin, frontend, currentSession, sessionStore, prisma, secret, parseBody, json, redirect }) {
  if (pathname === DEVELOPER_START && req.method === 'GET') {
    const request = developerRequest(url.toString(), origin);
    if (!request) return json(res, { error: 'Invalid developer CLI request' }, 400);
    const current = await currentSession(req);
    if (!current) return redirect(res, `${frontend}/hivemind/login?account=developer&cli_return_to=${encodeURIComponent(url.toString())}`);
    const user = await prisma.user.findUnique({ where: { id: current.session.userId }, select: { id: true, email: true, deletedAt: true } });
    if (!user || user.deletedAt) return json(res, { error: 'Account unavailable' }, 403);
    const code = await sessionStore.createAuthState({ kind: 'developer_cli', ...request, userId: user.id, email: user.email, sessionId: current.sessionId, expiresAt: Date.now() + 60_000 });
    const callback = new URL(request.callback);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', request.state);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    return redirect(res, callback.toString());
  }
  if (pathname === '/auth/developer/cli/exchange' && req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const body = await parseBody(req).catch(() => ({}));
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(body.code_verifier || '')) return json(res, { error: 'Invalid verifier' }, 400);
    const stored = await sessionStore.consumeAuthState(String(body.code || ''));
    const challenge = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
    if (!stored || stored.kind !== 'developer_cli' || stored.expiresAt <= Date.now() || stored.challenge !== challenge || body.callback !== stored.callback || !await sessionStore.getSession(stored.sessionId)) return json(res, { error: 'Invalid or expired code' }, 400);
    return json(res, { token: developerCredential(secret, { userId: stored.userId, sessionId: stored.sessionId }), userId: stored.userId, userEmail: stored.email, accountType: 'developer', scope: 'developer:identity', orgId: null });
  }
  if (pathname === '/auth/developer/me' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const claims = readDeveloperCredential(secret, req.headers.authorization?.replace(/^Bearer /, ''));
    const session = claims && await sessionStore.getSession(claims.sessionId);
    const user = session?.userId === claims?.userId && await prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true, email: true, deletedAt: true } });
    if (!user || user.deletedAt) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, { userId: user.id, email: user.email, accountType: 'developer', scope: 'developer:identity', orgId: null });
  }
  return false;
}
