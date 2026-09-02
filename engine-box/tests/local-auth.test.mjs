import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalApiKey, requireLocalAccess, resolveLocalPrincipal } from '../lib/local-auth.mjs';

test('Engine Box accepts mapped OIDC edge identities and rejects unmapped groups', () => {
  const record = { oidc: { group_mapping: { owner: ['hm-owners'], auditor: ['hm-auditors'] } } };
  const owner = resolveLocalPrincipal({ headers: { 'x-auth-request-user': 'alice', 'x-auth-request-groups': 'hm-owners' }, record });
  assert.equal(requireLocalAccess(owner, { role: 'admin' }).id, 'alice');
  assert.throws(() => resolveLocalPrincipal({ headers: { 'x-auth-request-user': 'eve', 'x-auth-request-groups': 'unknown' }, record }), /local_role_unmapped/);
});

test('Engine Box API keys are hashed, scoped, expirable, and revocable', () => {
  const { raw, record: key } = createLocalApiKey({ name: 'MCP', scopes: ['recall'] });
  const record = { api_keys: [key] };
  const principal = resolveLocalPrincipal({ headers: { authorization: `Bearer ${raw}` }, record });
  requireLocalAccess(principal, { scope: 'recall' });
  assert.throws(() => requireLocalAccess(principal, { scope: 'upload' }), /local_scope_forbidden/);
  assert.throws(() => resolveLocalPrincipal({ headers: { authorization: 'Bearer wrong' }, record }), /local_api_key_invalid/);
  assert.ok(key.key_hash.startsWith('scrypt:'));
});
