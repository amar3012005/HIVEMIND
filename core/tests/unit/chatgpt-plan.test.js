import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { storeVerifiedPlanGrant, resolveBrainPlan, refreshPlanGrant, disconnectPlan } from '../../src/chatgpt-plan/connections.js';
import { serveBrainPlan, validatePlanRequest } from '../../src/chatgpt-plan/brain-broker.js';
import { gatewayRequestHeaders } from '../../src/llm/cloudflare-gateway.js';
const owner = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const other = { ...owner, orgId: '33333333-3333-4333-8333-333333333333' };
const env = { HIVE_CHATGPT_PLAN_ENABLED: 'true', HIVE_CHATGPT_PLAN_APPROVED: 'true', HIVE_CHATGPT_PLAN_CLIENT_ID: 'test-approved-client', HIVE_CHATGPT_PLAN_ENCRYPTION_KEY: 'ab'.repeat(32) };
const grant = () => ({ issuer: 'https://auth.openai.com', subject: 'test-subject', clientId: env.HIVE_CHATGPT_PLAN_CLIENT_ID,
  accessToken: 'fixture-only-access-token', refreshToken: 'fixture-only-refresh-token', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 60000, models: ['test-gpt'] });
function fixture() {
  const records = new Map(); let active = true; let preset = 'hivemind-chat';
  return { records, setActive: value => { active = value; }, setPreset: value => { preset = value; }, prisma: {
    userOrganization: { findUnique: async () => ({ isActive: active }) },
    harnessSession: { findFirst: async ({ where }) => where.id === 'owned-brain' && where.userId === owner.userId
      && where.orgId === owner.orgId ? { profile: 'hivemind-chat', header: { agentPreset: preset } } : null },
    chatgptPlanConnection: { upsert: async ({ where, create, update }) => {
      const id = JSON.stringify(where.orgId_userId); records.set(id, { id: 'fixture', ...(records.has(id) ? update : create) }); return { id: 'fixture', status: 'active' };
    }, findUnique: async ({ where }) => records.get(JSON.stringify(where.orgId_userId)) },
  } };
}
test('private vault encrypts grants; owner and client AAD reject row substitution', async () => {
  const f = fixture(); await storeVerifiedPlanGrant(f.prisma, owner, grant(), env);
  const row = f.records.get(JSON.stringify(owner)); assert.ok(!row.encryptedGrant.includes('fixture-only'));
  assert.equal((await resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', env)).accessToken, grant().accessToken);
  f.records.set(JSON.stringify(other), row);
  const different = { ...f.prisma, harnessSession: { findFirst: async () => ({ profile: 'hivemind-chat', header: { agentPreset: 'hivemind-chat' } }) } };
  await assert.rejects(resolveBrainPlan(different, other, 'owned-brain', 'test-gpt', env), /integrity/);
  await assert.rejects(resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', { ...env, HIVE_CHATGPT_PLAN_CLIENT_ID: 'different' }), /integrity/);
});
test('approval absent, member removed, Runtime and unowned session fail closed', async () => {
  const f = fixture(); await assert.rejects(storeVerifiedPlanGrant(f.prisma, owner, grant(), { ...env, HIVE_CHATGPT_PLAN_APPROVED: 'false' }), /not_enabled/);
  await storeVerifiedPlanGrant(f.prisma, owner, grant(), env);
  await assert.rejects(resolveBrainPlan(f.prisma, owner, 'some-other-room', 'test-gpt', env), /owned_brain/);
  f.setPreset('hivemind-hq'); await assert.rejects(resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', env), /owned_brain/);
  f.setPreset('hivemind-chat'); f.setActive(false);
  await assert.rejects(resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', env), /membership/);
});
test('identity-only grant, expired grant and unsupported model cannot fund calls', async () => {
  const f = fixture(); await assert.rejects(storeVerifiedPlanGrant(f.prisma, owner, { ...grant(), scopes: ['openid'] }, env), /verified/);
  await assert.rejects(storeVerifiedPlanGrant(f.prisma, owner, { ...grant(), expiresAt: 1 }, env), /verified/);
  await storeVerifiedPlanGrant(f.prisma, owner, grant(), env);
  await assert.rejects(resolveBrainPlan(f.prisma, owner, 'owned-brain', 'unknown-gpt', env), /model_unavailable/);
});
test('public request allowlist rejects unsupported fields and hosted tools', () => {
  const body = { model: 'test-gpt', input: [{ role: 'user', content: [] }], store: false, stream: true };
  assert.equal(validatePlanRequest(body), body);
  assert.throws(() => validatePlanRequest({ ...body, temperature: 1 }), /contract/);
  assert.throws(() => validatePlanRequest({ ...body, tools: [{ type: 'mcp' }] }), /namespace/);
});
test('broker uses exact provider URL and user bearer despite existing platform BYOK', async () => {
  const restore = { ...process.env }; Object.assign(process.env, { CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_AI_GATEWAY_ID: 'fixture-gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'fixture-gateway-token', CLOUDFLARE_AI_GATEWAY_OPENAI_BYOK_ALIAS: 'platform' });
  try {
    const f = fixture(); await storeVerifiedPlanGrant(f.prisma, owner, grant(), env);
    const res = new PassThrough(); let code; let payload;
    res.writeHead = status => { code = status; }; res.on('data', () => {});
    await serveBrainPlan({ req: { method: 'POST' }, res, prisma: f.prisma,
      claims: { sub: owner.userId, org_id: owner.orgId }, env,
      parseBody: async () => ({ session_id: 'owned-brain', request: { model: 'test-gpt', input: [{ role: 'user', content: 'hi' }], store: false, stream: true } }),
      jsonResponse: (_, body, status) => { payload = body; code = status; }, fetchImpl: async (url, request) => {
        assert.equal(url, 'https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/openai/responses');
        assert.equal(request.headers.get('authorization'), `Bearer ${grant().accessToken}`);
        assert.equal(request.headers.get('cf-aig-authorization'), 'Bearer fixture-gateway-token');
        assert.equal(request.headers.has('cf-aig-byok-alias'), false);
        return new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      } }); assert.equal(code, 200, JSON.stringify(payload));
    assert.throws(() => gatewayRequestHeaders({}, 'openai', { billingMode: 'user-plan' }), /credential_required/);
  } finally { for (const name of Object.keys(process.env)) if (!(name in restore)) delete process.env[name]; Object.assign(process.env, restore); }
});

test('atomic refresh rotates once; local disconnect erases encrypted grant', async () => {
  const f = fixture();
  await storeVerifiedPlanGrant(f.prisma, owner, { ...grant(), expiresAt: Date.now() + 5000 }, env);
  let tail = Promise.resolve(); let refreshes = 0;
  f.prisma.chatgptPlanConnection.update = async ({ where, data }) => {
    const row = f.records.get(JSON.stringify(where.orgId_userId)); Object.assign(row, data); return row;
  };
  f.prisma.chatgptPlanConnection.updateMany = async ({ where, data }) => { Object.assign(f.records.get(JSON.stringify(where)), data); };
  f.prisma.$queryRawUnsafe = async () => [];
  f.prisma.$transaction = callback => {
    const task = tail.then(() => callback(f.prisma)); tail = task.then(() => {}, () => {}); return task;
  };
  const refresh = async current => { refreshes++; return { ...current, accessToken: 'fixture-new-access-token', refreshToken: 'fixture-rotated-refresh-token', expiresAt: Date.now() + 60000 }; };
  await Promise.all([refreshPlanGrant(f.prisma, owner, env, refresh), refreshPlanGrant(f.prisma, owner, env, refresh)]);
  assert.equal(refreshes, 1);
  assert.equal((await resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', env)).accessToken, 'fixture-new-access-token');
  await disconnectPlan(f.prisma, owner);
  assert.equal(f.records.get(JSON.stringify(owner)).encryptedGrant, '');
  await assert.rejects(resolveBrainPlan(f.prisma, owner, 'owned-brain', 'test-gpt', env), /connection_required/);
});
test('malformed null/scopes metadata and system input fail closed', async () => {
  const f = fixture();
  await assert.rejects(storeVerifiedPlanGrant(f.prisma, owner, null, env), /verified/);
  await assert.rejects(storeVerifiedPlanGrant(f.prisma, owner, { ...grant(), scopes: 'chatgpt.tokens.use.direct' }, env), /verified/);
  assert.throws(() => validatePlanRequest({ model: 'test-gpt', store: false, stream: true, input: [{ role: 'system', content: 'system' }] }), /input_contract/);
  assert.throws(() => validatePlanRequest(null), /contract/);
});
