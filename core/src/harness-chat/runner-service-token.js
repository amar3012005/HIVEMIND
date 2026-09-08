import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUER = 'hivemind-harness-runner';
const AUDIENCE = 'hivemind-control-plane-harness-proxy';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function decode(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { fail('invalid_runner_service_token'); }
}
function signature(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
function equal(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyHarnessRunnerServiceToken(token, { secret, nowMs = Date.now() } = {}) {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) fail('runner_service_secret_unavailable');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) fail('invalid_runner_service_token');
  const [headerPart, claimsPart, supplied] = parts;
  const input = `${headerPart}.${claimsPart}`;
  if (!equal(supplied, signature(secret, input))) fail('invalid_runner_service_signature');
  const header = decode(headerPart); const claims = decode(claimsPart);
  if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.iss !== ISSUER || claims.aud !== AUDIENCE
      || claims.profile !== 'hivemind-chat' || !UUID_RE.test(claims.sub) || !UUID_RE.test(claims.org_id)
      || !UUID_RE.test(claims.jti)) fail('invalid_runner_service_claims');
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 5
      || claims.exp <= now || claims.exp - claims.iat > 30) fail('expired_runner_service_token');
  if (claims.project_id !== undefined && !UUID_RE.test(claims.project_id)) fail('invalid_runner_service_claims');
  return claims;
}
