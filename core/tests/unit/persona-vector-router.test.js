import test from 'node:test';
import assert from 'node:assert/strict';
import { personaPointId } from '../../src/memory/persona-vector.js';
import { isPersonaQuery, routePersona } from '../../src/memory/persona-router.js';

test('personaPointId is deterministic + UUID-shaped (re-embed updates in place)', () => {
  const a = personaPointId('user-1', 'role');
  const b = personaPointId('user-1', 'role');
  const c = personaPointId('user-1', 'company');
  const d = personaPointId('user-2', 'role');
  assert.equal(a, b, 'same (user,key) → same point id');
  assert.notEqual(a, c, 'different key → different id');
  assert.notEqual(a, d, 'different user → different id');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'valid v5 UUID');
});

test('isPersonaQuery detects user-about-self intent', () => {
  assert.equal(isPersonaQuery('what are my preferences?'), true);
  assert.equal(isPersonaQuery('who am I'), true);
  assert.equal(isPersonaQuery('my role and company'), true);
  assert.equal(isPersonaQuery('what is the SOLVIS billing engine'), false);
  assert.equal(isPersonaQuery('summarize the Q3 report'), false);
});

test('routePersona is inert unless enabled (or forced)', async () => {
  const res = await routePersona({ query: 'what are my preferences', userId: 'u1', orgId: 'o1' });
  assert.equal(res.routed, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(res.context, '');
});

test('routePersona forced falls back to Postgres profile context when vector lane empty', async () => {
  const profileStore = { buildProfileContext: async () => 'User Profile:\n  role: founder' };
  // force bypasses the disabled flag + intent gate; no QDRANT_URL in test → vector empty → Postgres fallback
  const res = await routePersona({ query: 'irrelevant', userId: 'u1', orgId: 'o1', profileStore, force: true });
  assert.equal(res.routed, true);
  assert.equal(res.source, 'postgres');
  assert.match(res.context, /founder/);
});
