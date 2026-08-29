import crypto from 'node:crypto';

const ROLE_ORDER = ['user', 'auditor', 'operator', 'admin', 'owner'];

function base64url(value) {
  return Buffer.from(value, 'base64url');
}

export function mapOidcRoles(groups = [], mapping = {}) {
  const set = new Set(Array.isArray(groups) ? groups : []);
  const roles = Object.entries(mapping)
    .filter(([, groupNames]) => (Array.isArray(groupNames) ? groupNames : [groupNames]).some((name) => set.has(name)))
    .map(([role]) => role)
    .filter((role) => ROLE_ORDER.includes(role));
  return roles.sort((left, right) => ROLE_ORDER.indexOf(right) - ROLE_ORDER.indexOf(left));
}

export function verifyOidcJwt({ token, issuer, audience, jwks, now = Date.now() }) {
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = String(token || '').split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length) throw new Error('malformed_oidc_token');
  const header = JSON.parse(base64url(encodedHeader));
  const claims = JSON.parse(base64url(encodedPayload));
  if (!header.kid || !['RS256', 'EdDSA'].includes(header.alg)) throw new Error('unsupported_oidc_signing_algorithm');
  const jwk = (jwks?.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('oidc_signing_key_not_found');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const algorithm = header.alg === 'RS256' ? 'RSA-SHA256' : null;
  if (!crypto.verify(algorithm, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, base64url(encodedSignature))) throw new Error('oidc_signature_invalid');
  if (claims.iss !== issuer) throw new Error('oidc_issuer_invalid');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw new Error('oidc_audience_invalid');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new Error('oidc_token_expired');
  if (!claims.sub) throw new Error('oidc_subject_missing');
  return claims;
}

export function createSealedCredential() {
  const secret = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(secret, salt, 32).toString('base64url');
  return { secret, sealed: `scrypt:${salt}:${hash}` };
}

export function verifySealedCredential(secret, sealed) {
  const [scheme, salt, expected] = String(sealed || '').split(':');
  if (scheme !== 'scrypt' || !salt || !expected || !secret) return false;
  const actual = crypto.scryptSync(secret, salt, 32).toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function hashApiKey(raw) {
  const { sealed } = createSealedCredentialFrom(raw);
  return sealed;
}

export function verifyApiKey(raw, stored) { return verifySealedCredential(raw, stored); }

function createSealedCredentialFrom(secret) {
  if (!secret || typeof secret !== 'string') throw new Error('api_key_missing');
  const salt = crypto.randomBytes(16).toString('base64url');
  return { sealed: `scrypt:${salt}:${crypto.scryptSync(secret, salt, 32).toString('base64url')}` };
}
