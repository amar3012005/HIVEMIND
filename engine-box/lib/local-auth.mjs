import crypto from 'node:crypto';
import { hashApiKey, mapOidcRoles, verifyApiKey } from './identity.mjs';

const ROLE_RANK = { user: 0, auditor: 1, operator: 2, admin: 3, owner: 4 };

function parseGroups(value) {
  return String(value || '').split(/[;,]/).map((group) => group.trim()).filter(Boolean);
}

function parseScopes(scopes) {
  return Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === 'string') : [];
}

export function createLocalApiKey({ name, scopes = ['read'], expiresAt = null, now = Date.now() } = {}) {
  if (!name || typeof name !== 'string') throw new Error('api_key_name_required');
  const raw = `hmek_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    raw,
    record: {
      id: crypto.randomUUID(), name: name.trim(), prefix: raw.slice(0, 12), key_hash: hashApiKey(raw),
      scopes: parseScopes(scopes), expires_at: expiresAt, revoked_at: null, created_at: new Date(now).toISOString(), last_used_at: null,
    },
  };
}

export function resolveLocalPrincipal({ headers = {}, record = {}, now = Date.now() } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const bearer = String(lower.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || lower['x-api-key'];
  if (bearer) {
    const key = (record.api_keys || []).find((candidate) => !candidate.revoked_at
      && (!candidate.expires_at || Date.parse(candidate.expires_at) > now)
      && verifyApiKey(String(bearer), candidate.key_hash));
    if (!key) throw new Error('local_api_key_invalid');
    return { kind: 'api_key', id: key.id, name: key.name, roles: ['operator'], scopes: parseScopes(key.scopes) };
  }
  // These headers are accepted only from the private edge network. hm-core has
  // no host port, so an external client cannot inject them directly.
  const subject = lower['x-auth-request-user'];
  if (!subject) throw new Error('local_auth_required');
  const roles = mapOidcRoles(parseGroups(lower['x-auth-request-groups']), record.oidc?.group_mapping || {});
  if (!roles.length) throw new Error('local_role_unmapped');
  return { kind: 'oidc', id: String(subject), email: lower['x-auth-request-email'] || null, roles, scopes: ['*'] };
}

export function requireLocalAccess(principal, { role = 'user', scope = null } = {}) {
  const requiredRank = ROLE_RANK[role];
  if (requiredRank === undefined) throw new Error('local_role_invalid');
  const strongest = Math.max(...(principal?.roles || []).map((value) => ROLE_RANK[value] ?? -1), -1);
  if (strongest < requiredRank) throw new Error('local_role_forbidden');
  if (scope && !(principal.scopes || []).includes('*') && !(principal.scopes || []).includes(scope)) throw new Error('local_scope_forbidden');
  return principal;
}
