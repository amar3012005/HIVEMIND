// Connector Runtime V1 — capability token (plan §6).
//
// A short-lived (5-min default) capability token authorizes a remote surface
// (HyperAgents / TARA / external MCP client) to call a specific set of
// connectors at a specific access level, on behalf of an authenticated
// principal. It carries NO OAuth/provider credentials — only the authorization
// context the gateway needs to re-derive the ConnectorExecutionContext.
//
// Signing is ASYMMETRIC (Ed25519) so Employees/TARA can validate with the
// PUBLIC key without ever holding the signing key (plan §6 "asymmetric signing
// preferred"). Compact JWS (header.payload.signature, base64url). node:crypto
// only — no JWT dependency added (Phase 0 §6: no JWT lib existed).
//
// Emergency revocation: a Redis-backed JTI denylist (injected). Redis being
// down degrades to "cannot revoke" with an alert, never blocks issuance
// (plan §9 "Redis unavailable: capability validation continues; revocation
// cache degrades with alert").

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, randomUUID } from 'node:crypto';

const AUDIENCE = 'hivemind-connector-runtime';
const ISSUER = process.env.CONNECTOR_RUNTIME_ISSUER || 'hivemind-core';
const DEFAULT_TTL_SEC = Number(process.env.CONNECTOR_RUNTIME_TOKEN_TTL_SEC || 300);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
const fromB64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Key material. Prefer env PEM keys (rotatable, shared public key to consumers).
// If absent, generate an EPHEMERAL keypair at boot — fine for a single-process
// dev/test run; a warning is logged so prod always supplies real keys.
let _keys = null;
function keys() {
  if (_keys) return _keys;
  const privPem = process.env.CONNECTOR_RUNTIME_TOKEN_PRIVATE_KEY;
  const pubPem = process.env.CONNECTOR_RUNTIME_TOKEN_PUBLIC_KEY;
  if (privPem && pubPem) {
    _keys = {
      kid: process.env.CONNECTOR_RUNTIME_TOKEN_KID || 'env',
      privateKey: createPrivateKey(privPem),
      publicKey: createPublicKey(pubPem),
      ephemeral: false,
    };
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    _keys = { kid: 'ephemeral', privateKey, publicKey, ephemeral: true };
    // eslint-disable-next-line no-console
    console.warn('[capability-token] no CONNECTOR_RUNTIME_TOKEN_PRIVATE/PUBLIC_KEY — using an EPHEMERAL keypair (dev only; tokens will not verify across processes/restarts)');
  }
  return _keys;
}

/** For consumers (Employees/TARA): the PEM public key to validate tokens with. */
export function getPublicKeyPem() {
  return keys().publicKey.export({ type: 'spki', format: 'pem' });
}

/** Test/rotation hook: install explicit keys (resets the cache). */
export function _setKeys({ privateKey, publicKey, kid = 'test' }) {
  _keys = { kid, privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey), ephemeral: false };
}

/**
 * Mint a capability token.
 * @param {object} claims
 * @param {string} claims.userId @param {string} claims.orgId @param {string} [claims.role]
 * @param {string} claims.surface  one of hyperagents|tara|mcp|...
 * @param {string[]} claims.connectors  granted connector ids
 * @param {'read'|'write'} [claims.access='read']
 * @param {string[]} [claims.projectIds] @param {string} [claims.roomId] @param {string} [claims.sessionId]
 * @param {number} [claims.ttlSec]
 * @param {() => number} [now]  injectable clock (ms) for tests
 * @returns {{ token:string, jti:string, expiresAt:string }}
 */
export function mintCapabilityToken(claims, { now = Date.now } = {}) {
  if (!claims || !claims.userId || !claims.orgId || !claims.surface) {
    throw new Error('capability token requires userId, orgId, surface');
  }
  const k = keys();
  const iat = Math.floor(now() / 1000);
  const ttl = Number.isFinite(claims.ttlSec) ? claims.ttlSec : DEFAULT_TTL_SEC;
  const exp = iat + Math.max(30, Math.min(ttl, 3600));
  const jti = randomUUID();
  const header = { alg: 'EdDSA', typ: 'JWT', kid: k.kid };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: claims.userId,
    org: claims.orgId,
    role: claims.role || 'member',
    surface: claims.surface,
    connectors: Array.isArray(claims.connectors) ? claims.connectors : [],
    access: claims.access === 'write' ? 'write' : 'read',
    projects: Array.isArray(claims.projectIds) ? claims.projectIds : [],
    ...(claims.roomId ? { room: claims.roomId } : {}),
    ...(claims.sessionId ? { sid: claims.sessionId } : {}),
    jti,
    iat,
    exp,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), k.privateKey);
  return { token: `${signingInput}.${b64url(signature)}`, jti, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verify a capability token. Returns { valid, claims?, reason? }.
 * @param {string} token
 * @param {object} [opts]
 * @param {(jti:string)=>Promise<boolean>} [opts.isRevoked]  Redis JTI denylist check
 * @param {string} [opts.expectedSurface]  reject a token minted for another surface
 * @param {()=>number} [opts.now]
 */
export async function verifyCapabilityToken(token, { isRevoked, expectedSurface, now = Date.now } = {}) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return { valid: false, reason: 'malformed' };
  const [h, p, s] = token.split('.');
  let header; let payload;
  try { header = fromB64urlJson(h); payload = fromB64urlJson(p); } catch { return { valid: false, reason: 'unparseable' }; }
  if (header.alg !== 'EdDSA') return { valid: false, reason: 'bad_alg' };
  if (payload.aud !== AUDIENCE) return { valid: false, reason: 'bad_audience' };
  if (payload.iss !== ISSUER) return { valid: false, reason: 'bad_issuer' };
  let sigOk = false;
  try {
    sigOk = edVerify(null, Buffer.from(`${h}.${p}`, 'utf8'), keys().publicKey, Buffer.from(s, 'base64url'));
  } catch { sigOk = false; }
  if (!sigOk) return { valid: false, reason: 'bad_signature' };
  const nowSec = Math.floor(now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return { valid: false, reason: 'expired' };
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) return { valid: false, reason: 'not_yet_valid' };
  if (expectedSurface && payload.surface !== expectedSurface) return { valid: false, reason: 'surface_mismatch' };
  if (typeof isRevoked === 'function') {
    try { if (await isRevoked(payload.jti)) return { valid: false, reason: 'revoked' }; }
    catch { /* Redis down → cannot check; continue (degrade with alert upstream) */ }
  }
  return { valid: true, claims: payload };
}

/** Redis-backed JTI revocation helpers (redis client injected). */
export function makeRevocationStore(redis, { prefix = 'cap:revoked:' } = {}) {
  return {
    async revoke(jti, ttlSec = DEFAULT_TTL_SEC) {
      if (!redis || !jti) return false;
      try { await redis.set(`${prefix}${jti}`, '1', 'EX', Math.max(60, ttlSec)); return true; } catch { return false; }
    },
    async isRevoked(jti) {
      if (!redis || !jti) return false;
      const v = await redis.get(`${prefix}${jti}`);
      return v != null;
    },
  };
}

export const CAPABILITY_AUDIENCE = AUDIENCE;
