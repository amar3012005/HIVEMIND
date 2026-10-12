import crypto from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// Roll out desktop handoff separately from existing browser sign-in. Never
// advertise it merely because the routes were deployed.
export function desktopAuthEnabled(value) {
  return value === '1';
}

export function desktopEnabledProviders({ google, zitadel, idpHints = '' }) {
  // An OIDC client alone does not prove that either federated IdP is configured.
  const hints = new Set(typeof idpHints === 'string' ? idpHints.split(',').map((hint) => hint.trim()) : []);
  return [
    ...(google ? ['google'] : []),
    ...(zitadel && hints.has('microsoft') ? ['microsoft'] : []),
    ...(zitadel && hints.has('apple') ? ['apple'] : []),
    ...(zitadel ? ['zitadel'] : []),
  ];
}

// Auth codes rely on a shared Redis GETDEL. A Redis connection alone does
// not prove this operation exists (for example, on a pre-6.2 deployment).
export async function redisSupportsAtomicDesktopCodes(redis) {
  if (!redis || redis.status !== 'ready') return false;
  try {
    const info = await redis.call('COMMAND', 'INFO', 'GETDEL');
    return Array.isArray(info) && Array.isArray(info[0])
      && String(info[0][0]).toLowerCase() === 'getdel';
  } catch {
    return false;
  }
}

export function validDesktopNonce(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 128 && BASE64URL.test(value);
}

export function validDesktopChallenge(value) {
  return typeof value === 'string' && value.length === 43 && BASE64URL.test(value);
}

export function desktopChallenge(verifier) {
  if (!validDesktopNonce(verifier)) return null;
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function validDesktopIssuedAt(issuedAt, now = Date.now()) {
  return Number.isSafeInteger(issuedAt) && issuedAt > 0 && issuedAt <= now && now - issuedAt <= 10 * 60 * 1000;
}

export function validDesktopExchange({ codeRecord, state, verifier }) {
  if (codeRecord?.type !== 'desktop-login-code' || !validDesktopIssuedAt(codeRecord.issuedAt) || !validDesktopNonce(state)
      || !validDesktopChallenge(codeRecord.challenge) || !validDesktopNonce(verifier)
      || codeRecord.nonce !== state || typeof codeRecord.sessionId !== 'string') return false;
  const actual = Buffer.from(desktopChallenge(verifier), 'ascii');
  const expected = Buffer.from(codeRecord.challenge, 'ascii');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
