const http = require('node:http');
const crypto = require('node:crypto');
const AUTH_ORIGIN = 'https://api.singulancelabs.com';
const APP_ORIGINS = new Set(['https://runtime-runner.singulancelabs.com', 'https://next.singulancelabs.com', 'https://singulancelabs.com', 'https://www.singulancelabs.com']);

function isGoogleSignIn(url, initiator) {
  try {
    const target = new URL(url), source = new URL(initiator);
    return APP_ORIGINS.has(source.origin) && target.origin === AUTH_ORIGIN && target.pathname === '/auth/google';
  } catch { return false; }
}

// Reuse the deployed external-tool session exchange. Google credentials and
// browser cookies never enter Electron. Only the new server-issued application
// session is admitted, after checking it against /auth/session with no old cookie.
async function admitSession(token, cookies, fetcher = fetch, isCurrent = () => true) {
  const response = await fetcher(`${AUTH_ORIGIN}/auth/session`, {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Sign-in session could not be verified. Please try again.');
  const identity = await response.json();
  if (identity.authenticated !== true || typeof identity.user?.id !== 'string') throw new Error('Sign-in identity was not confirmed.');
  const issued = response.headers.getSetCookie().find(value => value.startsWith('hm_cp_session='));
  if (!issued) throw new Error('Authentication service did not issue a browser session.');
  const [pair, ...attributes] = issued.split(';').map(value => value.trim());
  const attrs = new Map(attributes.map(value => { const i = value.indexOf('='); return i < 0 ? [value.toLowerCase(), true] : [value.slice(0, i).toLowerCase(), value.slice(i + 1)]; }));
  const domain = attrs.get('domain');
  if (!attrs.has('secure') || !attrs.has('httponly') || attrs.get('path') !== '/' || (domain && !['.singulancelabs.com', 'singulancelabs.com', 'api.singulancelabs.com'].includes(domain))) throw new Error('Authentication service returned an unexpected cookie boundary.');
  const seconds = Number(attrs.get('max-age'));
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Authentication session has expired.');
  if (!isCurrent()) throw new Error('Sign-in expired.');
  await cookies.set({ url: AUTH_ORIGIN, name: 'hm_cp_session', value: pair.slice('hm_cp_session='.length),
    ...(domain ? { domain } : {}), path: '/', secure: true, httpOnly: true,
    sameSite: ({ none: 'no_restriction', lax: 'lax', strict: 'strict' })[String(attrs.get('samesite')).toLowerCase()] || 'lax',
    expirationDate: Date.now() / 1000 + seconds });
  await cookies.flushStore();
  return identity;
}

function createBrowserSignIn({ openExternal, admit, onComplete, onError, timeoutMs = 300000 }) {
  let active;
  function cancel() { active?.finish(); }
  async function start(loginUrl) {
    if (active) return; // A double click cannot create two different sign-ins.
    const target = new URL(loginUrl);
    if (target.origin !== AUTH_ORIGIN || target.pathname !== '/auth/google') throw new Error('Unsupported sign-in destination');
    const nonce = crypto.randomBytes(32).toString('hex');
    let consumed = false, expired = false, timer;
    const attempt = { finish() { expired = true; clearTimeout(timer); server.close(); server.closeIdleConnections(); if (active === attempt) active = null; } };
    const server = http.createServer(async (req, res) => {
      const reply = (status, text, extra = {}) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(text); };
      const address = server.address();
      const host = `127.0.0.1:${address?.port}`;
      if (req.headers.host !== host || req.method !== 'GET' || (req.headers.origin && req.headers.origin !== AUTH_ORIGIN)) return reply(403, 'This sign-in request is not allowed.');
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/complete') return reply(200, 'Signed in. Return to SINGULANCE. You can close this tab.');
      if (url.pathname !== '/callback') return reply(404, 'Not found');
      const state = url.searchParams.get('state') || '';
      if (state.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(nonce))) return reply(403, 'Sign-in request did not match.');
      if (expired || consumed) return reply(409, 'This sign-in request has already been used.');
      const token = url.searchParams.get('token');
      if (!token || token.length > 4096 || /[\r\n\s]/.test(token)) return reply(400, 'Sign-in response is incomplete.');
      consumed = true;
      try {
        const identity = await admit(token, () => !expired);
        if (expired) return reply(410, 'Sign-in expired. Return to SINGULANCE and try again.');
        // Strip the callback query before displaying any page or loading assets.
        reply(303, '', { Location: '/complete' });
        await onComplete(identity);
        clearTimeout(timer);
        timer = setTimeout(() => attempt.finish(), 15000); timer.unref();
      } catch {
        reply(401, 'Sign-in could not be verified. Return to SINGULANCE and try again.');
        attempt.finish(); onError(new Error('Browser sign-in could not be verified. Please try again.'));
      }
    });
    active = attempt;
    server.requestTimeout = 20000; server.headersTimeout = 10000;
    timer = setTimeout(() => { attempt.finish(); onError(new Error('Browser sign-in expired. Please try again.')); }, timeoutMs); timer.unref();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const callback = new URL(`http://127.0.0.1:${server.address().port}/callback?hivemind_auth=callback`);
      callback.searchParams.set('state', nonce);
      target.searchParams.set('return_to', callback.href);
      await openExternal(target.href);
    } catch { attempt.finish(); onError(new Error('Could not open browser sign-in. Please try again.')); }
  }
  return { start, cancel };
}
module.exports = { isGoogleSignIn, admitSession, createBrowserSignIn };
