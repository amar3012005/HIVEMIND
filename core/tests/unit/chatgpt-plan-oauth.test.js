import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startPlanOAuth, finishPlanOAuth, connectionStatus, updateConnection, verifyIdentity, hostedClient } from '../../src/chatgpt-plan/oauth.js';
import { resolveBrainPlan } from '../../src/chatgpt-plan/connections.js';
import { registeredRefresh } from '../../src/chatgpt-plan/oauth.js';

const owner = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const other = { ...owner, userId: '33333333-3333-4333-8333-333333333333' };
const env = { HIVE_CHATGPT_PLAN_ENABLED: 'true', HIVE_CHATGPT_PLAN_APPROVED: 'true', HIVE_CHATGPT_PLAN_CLIENT_ID: 'fixture-hosted-client',
  HIVE_CHATGPT_PLAN_ENCRYPTION_KEY: 'ab'.repeat(32), HIVE_CHATGPT_PLAN_REDIRECT_URI: 'https://fixture.example/chatgpt/callback',
  HIVE_CHATGPT_PLAN_AUTHORIZATION_URL: 'https://auth.openai.com/api/accounts/authorize',
  HIVE_CHATGPT_PLAN_TOKEN_URL: 'https://auth.openai.com/api/accounts/oauth/token', HIVE_CHATGPT_PLAN_JWKS_URL: 'https://auth.openai.com/jwks',
  HIVE_CHATGPT_PLAN_REVOCATION_URL: 'https://auth.openai.com/revoke', HIVE_CHATGPT_PLAN_TOKEN_AUTH_METHOD: 'none' };
function database() {
  const attempts = new Map(), connections = new Map(); let queue = Promise.resolve(); let active = true;
  const matches = (row, where) => row && row.userId === where.userId && row.orgId === where.orgId && !row.consumedAt && row.expiresAt > new Date();
  const prisma = {
    userOrganization: { findUnique: async () => ({ isActive: active }) },
    harnessSession: { findFirst: async ({ where }) => where.id === 'brain' && where.userId === owner.userId
      ? { profile: 'hivemind-chat', header: { agentPreset: 'hivemind-chat' } } : null },
    chatgptPlanOAuthAttempt: { deleteMany: async () => {}, create: async ({ data }) => attempts.set(data.stateHash, data),
      findFirst: async ({ where }) => matches(attempts.get(where.stateHash), where) ? { ...attempts.get(where.stateHash) } : null,
      updateMany: async ({ where, data }) => { const row = attempts.get(where.stateHash); if (!matches(row, where)) return { count: 0 };
        Object.assign(row, data); return { count: 1 }; } },
    chatgptPlanConnection: { findUnique: async ({ where }) => connections.get(JSON.stringify(where.orgId_userId)),
      upsert: async ({ where, create, update }) => { const key = JSON.stringify(where.orgId_userId);
        connections.set(key, { id: 'fixture', ...(connections.get(key) ? { ...connections.get(key), ...update } : create) }); return connections.get(key); },
      update: async ({ where, data }) => { const row = connections.get(JSON.stringify(where.orgId_userId)); Object.assign(row, data); return row; } },
    $queryRawUnsafe: async () => [],
    $transaction: action => { const result = queue.then(() => action(prisma)); queue = result.catch(() => {}); return result; },
  };
  return { prisma, attempts, connections, setActive: value => { active = value; } };
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
function jwt(nonce, extras = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid: jwk.kid })}.${enc({ iss: 'https://auth.openai.com', aud: env.HIVE_CHATGPT_PLAN_CLIENT_ID,
    sub: 'fixture-subject', nonce, iat: now, exp: now + 300, ...extras })}`;
  return `${body}.${sign('sha256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
async function provider() {
  let nonce, invalidRefresh = false, refreshCalls = 0, revokedToken, tokenFields;
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const fields = new URLSearchParams(Buffer.concat(parts).toString());
    let result;
    if (req.url === '/jwks') result = { keys: [jwk] };
    else if (req.url === '/v1/models') {
      assert.match(req.headers.authorization, /^Bearer fixture-access/); result = { models: [{ slug: 'fixture-gpt', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] };
    } else if (req.url === '/revoke') { revokedToken = fields.get('token'); result = {}; }
    else {
      tokenFields = fields;
      if (fields.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        if (invalidRefresh) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      }
      result = { access_token: `fixture-access-${refreshCalls}`, refresh_token: `fixture-refresh-${refreshCalls}`, expires_in: 3600,
        token_type: 'Bearer', scope: 'openid chatgpt.tokens.use.direct', id_token: jwt(fields.get('grant_type') === 'refresh_token' ? undefined : nonce) };
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { fetchImpl: (url, init) => fetch(`${base}${new URL(url).pathname}`, init), setNonce: value => { nonce = value; },
    setInvalidRefresh: value => { invalidRefresh = value; }, get refreshCalls() { return refreshCalls; },
    get revokedToken() { return revokedToken; }, get tokenFields() { return tokenFields; },
    close: () => new Promise(resolve => server.close(resolve)) };
}
async function connect(db, fixture) {
  const started = await startPlanOAuth(db.prisma, owner, env); const url = new URL(started.authorization_url);
  fixture.setNonce(url.searchParams.get('nonce'));
  await finishPlanOAuth(db.prisma, owner, { state: url.searchParams.get('state'), code: 'fixture-code' }, env, fixture.fetchImpl);
  return url;
}
test('hosted approval and configured static client fail closed; no dynamic local registration', () => {
  assert.throws(() => hostedClient({ ...env, HIVE_CHATGPT_PLAN_APPROVED: 'false' }), /not_enabled/);
  assert.throws(() => hostedClient({ ...env, HIVE_CHATGPT_PLAN_CLIENT_ID: 'dynamic_agent_client' }), /unconfigured/);
  assert.throws(() => hostedClient({ ...env, HIVE_CHATGPT_PLAN_TOKEN_URL: 'https://attacker.test/token' }), /unconfigured/);
});
test('real fixture HTTP OAuth verifies PKCE/nonce/JWKS; callback is owner-bound and single-use', async () => {
  const db = database(), fixture = await provider();
  try {
    const start = await startPlanOAuth(db.prisma, owner, env); const url = new URL(start.authorization_url);
    assert.equal(url.searchParams.get('client_id'), 'fixture-hosted-client'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!JSON.stringify([...db.attempts.values()]).includes('code_verifier'));
    fixture.setNonce(url.searchParams.get('nonce')); const input = { state: url.searchParams.get('state'), code: 'fixture-code' };
    await assert.rejects(finishPlanOAuth(db.prisma, other, input, env, fixture.fetchImpl), /replayed/);
    assert.deepEqual(await finishPlanOAuth(db.prisma, owner, input, env, fixture.fetchImpl), { connected: true, models: ['fixture-gpt'] });
    assert.equal(fixture.tokenFields.get('redirect_uri'), env.HIVE_CHATGPT_PLAN_REDIRECT_URI);
    assert.ok(fixture.tokenFields.get('code_verifier')); assert.equal(fixture.tokenFields.get('client_id'), 'fixture-hosted-client');
    await assert.rejects(finishPlanOAuth(db.prisma, owner, input, env, fixture.fetchImpl), /replayed/);
    assert.equal((await connectionStatus(db.prisma, owner, env)).connected, true);
    assert.equal((await connectionStatus(db.prisma, other, env)).connected, false);
  } finally { await fixture.close(); }
});
test('invalid signature, nonce, audience and expiry are rejected', async () => {
  const fixture = await provider();
  try {
    await assert.rejects(verifyIdentity(jwt('wrong'), 'expected', env, fixture.fetchImpl), /invalid/);
    await assert.rejects(verifyIdentity(jwt('expected', { aud: 'other' }), 'expected', env, fixture.fetchImpl), /invalid/);
    await assert.rejects(verifyIdentity(jwt('expected', { exp: 1 }), 'expected', env, fixture.fetchImpl), /invalid/);
    const token = jwt('expected'); await assert.rejects(verifyIdentity(`${token.slice(0, -10)}aaaaaaaaaa`, 'expected', env, fixture.fetchImpl), /invalid/);
  } finally { await fixture.close(); }
});
test('catalog and selected model persist; refresh rotates once then disconnect revokes latest token', async () => {
  const db = database(), fixture = await provider();
  try {
    await connect(db, fixture);
    const selected = await updateConnection(db.prisma, owner, env, 'select', { model: 'fixture-gpt', platform_fallback: true }, fixture.fetchImpl);
    assert.equal(selected.platform_fallback, true);
    assert.deepEqual((await updateConnection(db.prisma, owner, env, 'models', {}, fixture.fetchImpl)).models, ['fixture-gpt']);
    // Force expiry through a new verified fixture grant rather than altering encrypted payloads.
    const { storeVerifiedPlanGrant } = await import('../../src/chatgpt-plan/connections.js');
    await storeVerifiedPlanGrant(db.prisma, owner, { issuer: 'https://auth.openai.com', subject: 'fixture-subject', clientId: env.HIVE_CHATGPT_PLAN_CLIENT_ID,
      accessToken: 'fixture-access-old', refreshToken: 'fixture-refresh-old', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 1000, models: ['fixture-gpt'] }, env);
    const refresh = registeredRefresh(env, fixture.fetchImpl);
    await Promise.all([resolveBrainPlan(db.prisma, owner, 'brain', 'fixture-gpt', env, { refresh }), resolveBrainPlan(db.prisma, owner, 'brain', 'fixture-gpt', env, { refresh })]);
    assert.equal(fixture.refreshCalls, 1);
    assert.equal((await updateConnection(db.prisma, owner, env, 'disconnect', {}, fixture.fetchImpl)).remote_revocation_confirmed, true);
    assert.equal(fixture.revokedToken, 'fixture-refresh-1'); assert.equal((await connectionStatus(db.prisma, owner, env)).connected, false);
    assert.equal([...db.connections.values()][0].encryptedGrant, '');
  } finally { await fixture.close(); }
});
test('invalid refresh revokes local grant; transient failure is not misclassified', async () => {
  const db = database(), fixture = await provider();
  try {
    await connect(db, fixture);
    const { storeVerifiedPlanGrant } = await import('../../src/chatgpt-plan/connections.js');
    await storeVerifiedPlanGrant(db.prisma, owner, { issuer: 'https://auth.openai.com', subject: 'fixture-subject', clientId: env.HIVE_CHATGPT_PLAN_CLIENT_ID,
      accessToken: 'fixture-access-old', refreshToken: 'fixture-refresh-old', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 1000, models: ['fixture-gpt'] }, env);
    fixture.setInvalidRefresh(true);
    await assert.rejects(resolveBrainPlan(db.prisma, owner, 'brain', 'fixture-gpt', env, { refresh: registeredRefresh(env, fixture.fetchImpl) }), /reauthorization/);
    assert.equal([...db.connections.values()][0].status, 'revoked');
  } finally { await fixture.close(); }
});

test('expired callback and revoked membership cannot complete authorization', async () => {
  const db = database(); const fixture = await provider();
  try {
    const started = new URL((await startPlanOAuth(db.prisma, owner, env)).authorization_url);
    fixture.setNonce(started.searchParams.get('nonce'));
    const input = { state: started.searchParams.get('state'), code: 'fixture-code' };
    [...db.attempts.values()][0].expiresAt = new Date(1);
    await assert.rejects(finishPlanOAuth(db.prisma, owner, input, env, fixture.fetchImpl), /expired/);
    const second = new URL((await startPlanOAuth(db.prisma, owner, env)).authorization_url);
    db.setActive(false);
    await assert.rejects(finishPlanOAuth(db.prisma, owner, { state: second.searchParams.get('state'), code: 'fixture-code' }, env, fixture.fetchImpl), /membership/);
    assert.equal(db.connections.size, 0);
  } finally { await fixture.close(); }
});
test('routing admits only persisted root Brain and distinct unavailable configuration is exposed', async () => {
  const { brainConnectionRoute } = await import('../../src/chatgpt-plan/oauth.js');
  const db = database(); const fixture = await provider();
  try {
    await connect(db, fixture);
    assert.equal((await brainConnectionRoute(db.prisma, owner, 'brain', env)).eligible, true);
    assert.equal((await brainConnectionRoute(db.prisma, owner, 'employee', env)).eligible, false);
    await assert.rejects(brainConnectionRoute(db.prisma, owner, undefined, env), /owned_brain/);
    assert.equal((await connectionStatus(db.prisma, owner, { ...env, HIVE_CHATGPT_PLAN_TOKEN_URL: '' })).reason, 'hosted_endpoints_unconfigured');
  } finally { await fixture.close(); }
});
