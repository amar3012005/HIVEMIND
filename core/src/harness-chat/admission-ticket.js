import crypto from 'node:crypto';

export const HIVE_HARNESS_TICKET_ISSUER = 'hivemind-control-plane';
export const HIVE_HARNESS_TICKET_AUDIENCE = 'hivemind-harness-runner';
export const HIVE_HARNESS_TICKET_PROFILE = 'hivemind-chat';
export const HIVE_HARNESS_TICKET_TTL_SECONDS = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIATIONS = new Set(['preview', 'harness']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { fail('invalid_ticket'); }
}

function signature(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashHarnessTicket(ticket) {
  return crypto.createHash('sha256').update(ticket).digest('hex');
}

export function mintHarnessAdmissionTicket({
  secret,
  userId,
  orgId,
  projectId = null,
  variation,
  nowMs = Date.now(),
  ttlSeconds = HIVE_HARNESS_TICKET_TTL_SECONDS,
  jti = crypto.randomUUID(),
} = {}) {
  if (!secret) fail('ticket_secret_unavailable');
  if (Buffer.byteLength(secret, 'utf8') < 32) fail('ticket_secret_too_short');
  if (!UUID_RE.test(userId) || !UUID_RE.test(orgId) || (projectId && !UUID_RE.test(projectId))) fail('invalid_ticket_scope');
  if (!VARIATIONS.has(variation)) fail('invalid_ticket_variation');
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.min(HIVE_HARNESS_TICKET_TTL_SECONDS, Math.max(1, Number(ttlSeconds) || HIVE_HARNESS_TICKET_TTL_SECONDS));
  const claims = {
    iss: HIVE_HARNESS_TICKET_ISSUER,
    aud: HIVE_HARNESS_TICKET_AUDIENCE,
    sub: userId,
    org_id: orgId,
    profile: HIVE_HARNESS_TICKET_PROFILE,
    ...(projectId ? { project_id: projectId } : {}),
    variation,
    jti,
    iat,
    exp,
  };
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return { ticket: `${signingInput}.${signature(secret, signingInput)}`, claims };
}

export function verifyHarnessAdmissionTicket(ticket, {
  secret,
  expectedOrgId,
  expectedUserId,
  nowMs = Date.now(),
} = {}) {
  if (!secret) fail('ticket_secret_unavailable');
  if (Buffer.byteLength(secret, 'utf8') < 32) fail('ticket_secret_too_short');
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3) fail('invalid_ticket');
  const [encodedHeader, encodedClaims, suppliedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  if (!secureEqual(suppliedSignature, signature(secret, signingInput))) fail('invalid_ticket_signature');
  const header = decode(encodedHeader);
  const claims = decode(encodedClaims);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') fail('invalid_ticket');
  if (claims.iss !== HIVE_HARNESS_TICKET_ISSUER || claims.aud !== HIVE_HARNESS_TICKET_AUDIENCE
      || claims.profile !== HIVE_HARNESS_TICKET_PROFILE || !UUID_RE.test(claims.sub)
      || !UUID_RE.test(claims.org_id) || !UUID_RE.test(claims.jti) || !VARIATIONS.has(claims.variation)) {
    fail('invalid_ticket_claims');
  }
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= now || claims.iat > now + 5
      || claims.exp - claims.iat > HIVE_HARNESS_TICKET_TTL_SECONDS) fail('expired_ticket');
  if (expectedOrgId && claims.org_id !== expectedOrgId) fail('ticket_org_scope_mismatch');
  if (expectedUserId && claims.sub !== expectedUserId) fail('ticket_user_scope_mismatch');
  return claims;
}

function nonceKey(jti) {
  return `hive:harness-ticket:${jti}`;
}

export async function registerHarnessTicketNonce(redis, ticket, claims, { nowMs = Date.now() } = {}) {
  if (!redis?.set) fail('ticket_nonce_store_unavailable');
  const ttl = Math.max(1, claims.exp - Math.floor(nowMs / 1000));
  const stored = await redis.set(nonceKey(claims.jti), hashHarnessTicket(ticket), 'EX', ttl, 'NX');
  if (stored !== 'OK') fail('ticket_nonce_collision');
}

export async function consumeHarnessAdmissionTicket(redis, ticket, options = {}) {
  const claims = verifyHarnessAdmissionTicket(ticket, options);
  if (!redis?.getdel) fail('ticket_nonce_store_unavailable');
  const storedHash = await redis.getdel(nonceKey(claims.jti));
  if (!storedHash || !secureEqual(storedHash, hashHarnessTicket(ticket))) fail('ticket_already_consumed');
  return claims;
}
