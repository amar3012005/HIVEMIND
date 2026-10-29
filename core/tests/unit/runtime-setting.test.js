import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handleRuntimeSettingRoute, readRuntimeEnabled, writeRuntimeEnabled } from '../../src/organizations/runtime-setting.js';
import { organizationAgentAccess } from '../../src/harness-chat/organization-agent-access.js';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';

/** In-memory stand-in for the organizations row, answering the two SQL statements the module issues. */
function fakeDb(initial = true) {
  const state = { enabled: initial, statements: [] };
  return {
    state,
    $queryRawUnsafe: async (sql, ...args) => {
      state.statements.push(sql);
      if (/^SELECT runtime_enabled/.test(sql)) return args[0] === orgId ? [{ runtime_enabled: state.enabled }] : [];
      if (/^UPDATE hivemind\.organizations/.test(sql)) {
        if (args[0] !== orgId) return [];
        const previous = state.enabled; state.enabled = args[1];
        return [{ previous, current: state.enabled }];
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
}

async function call({ method = 'GET', path = `/v1/orgs/${orgId}/runtime-settings`, body, db = fakeDb(), admin = true, session = true, prisma = db } = {}) {
  const res = {}; const audits = [];
  const handled = await handleRuntimeSettingRoute({
    req: { method, headers: { 'user-agent': 'test' }, socket: {} }, res, pathname: path, prisma,
    requireSession: async () => (session ? { session: { userId, orgId } } : null),
    requireOrgAdmin: async () => (admin ? { role: 'admin' } : null),
    parseBody: async () => body,
    jsonResponse: (r, b, status = 200, headers = {}) => Object.assign(r, { body: b, status, headers }),
    audit: async entry => { audits.push(entry); },
  });
  return { handled, res, audits, db };
}

test('GET returns the stored value and defaults to enabled', async () => {
  const on = await call();
  assert.equal(on.handled, true);
  assert.deepEqual(on.res.body, { organization_id: orgId, runtime_enabled: true });
  assert.equal(on.res.headers['Cache-Control'], 'private, no-store');
  const off = await call({ db: fakeDb(false) });
  assert.deepEqual(off.res.body, { organization_id: orgId, runtime_enabled: false });
});

test('PUT switches Runtime off, audits old and new value, and is idempotent', async () => {
  const db = fakeDb(true);
  const first = await call({ method: 'PUT', body: { runtime_enabled: false }, db });
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.res.body, { organization_id: orgId, runtime_enabled: false, changed: true });
  assert.equal(db.state.enabled, false);
  assert.equal(first.audits.length, 1);
  assert.equal(first.audits[0].eventType, 'organization.runtime_enabled_changed');
  assert.equal(first.audits[0].organizationId, orgId);
  assert.equal(first.audits[0].userId, userId);
  assert.deepEqual(first.audits[0].oldValue, { runtime_enabled: true });
  assert.deepEqual(first.audits[0].newValue, { runtime_enabled: false });
  const again = await call({ method: 'PUT', body: { runtime_enabled: false }, db });
  assert.equal(again.res.body.changed, false);
  assert.equal(again.audits.length, 0);
  const back = await call({ method: 'PUT', body: { runtime_enabled: true }, db });
  assert.deepEqual(back.res.body, { organization_id: orgId, runtime_enabled: true, changed: true });
});

test('only a boolean runtime_enabled is accepted and nothing is written otherwise', async () => {
  for (const body of [undefined, null, [], {}, { runtime_enabled: 'false' }, { runtime_enabled: 0 }, { runtime_enabled: true, plan: 'x' }]) {
    const db = fakeDb(true);
    const result = await call({ method: 'PUT', body, db });
    assert.equal(result.res.status, 400, JSON.stringify(body));
    assert.equal(db.state.enabled, true);
    assert.equal(result.audits.length, 0);
  }
});

test('non-admins and signed-out callers never read or write', async () => {
  for (const method of ['GET', 'PUT']) {
    const db = fakeDb(true);
    const denied = await call({ method, admin: false, body: { runtime_enabled: false }, db });
    assert.equal(denied.handled, true);
    assert.equal(denied.res.status, undefined, 'requireOrgAdmin owns the 404 response');
    assert.equal(db.state.statements.length, 0);
    const signedOut = await call({ method, session: false, body: { runtime_enabled: false }, db });
    assert.equal(signedOut.handled, true);
    assert.equal(db.state.statements.length, 0);
  }
});

test('other paths and methods are not claimed or are rejected', async () => {
  assert.equal((await call({ path: `/v1/orgs/${orgId}/profile` })).handled, false);
  assert.equal((await call({ path: '/v1/orgs/not-a-uuid/runtime-settings' })).handled, false);
  const post = await call({ method: 'POST', body: { runtime_enabled: false } });
  assert.equal(post.res.status, 405);
  assert.equal((await call({ prisma: null })).res.status, 503);
});

test('unknown organization is 404 and storage failures are 503 without leaking details', async () => {
  const missing = await call({ method: 'PUT', body: { runtime_enabled: false }, path: '/v1/orgs/77503d34-97e9-49a8-8c52-8ee30cc7603e/runtime-settings' });
  assert.equal(missing.res.status, 404);
  const broken = { $queryRawUnsafe: async () => { throw Object.assign(new Error('connection string postgres://secret'), { code: 'ECONNRESET' }); } };
  const failed = await call({ method: 'PUT', body: { runtime_enabled: false }, prisma: broken });
  assert.equal(failed.res.status, 503);
  assert.deepEqual(failed.res.body, { error: 'runtime_setting_unavailable' });
});

test('reads default to enabled for missing rows and a database without the column, but surface other failures', async () => {
  assert.equal(await readRuntimeEnabled(fakeDb(false), '77503d34-97e9-49a8-8c52-8ee30cc7603e'), true);
  assert.equal(await readRuntimeEnabled(fakeDb(false), 'not-a-uuid'), true);
  const noColumn = { $queryRawUnsafe: async () => { throw Object.assign(new Error('column "runtime_enabled" does not exist'), { code: '42703' }); } };
  assert.equal(await readRuntimeEnabled(noColumn, orgId), true);
  const down = { $queryRawUnsafe: async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); } };
  await assert.rejects(readRuntimeEnabled(down, orgId), /down/);
  assert.equal(await writeRuntimeEnabled(fakeDb(), 'x'.repeat(36), true), null);
});

test('organization-agent-access carries runtime_enabled next to the unchanged contract', async () => {
  const db = fakeDb(false);
  const base = db.$queryRawUnsafe;
  const access = await organizationAgentAccess({
    userOrganization: { findUnique: async () => ({ role: 'admin', isActive: true }) },
    user: { findUnique: async () => ({ displayName: 'Amar', deletedAt: null }) },
    $queryRawUnsafe: async (sql, ...args) => (/runtime_enabled/.test(sql) ? base(sql, ...args) : [{ session_id: 's1', user_id: userId }]),
  }, { orgId, userId });
  assert.equal(access.contract, 'hivemind.organization-agent-access.v1');
  assert.deepEqual(access.organization, { runtime_enabled: false });
  assert.equal(access.access, 'read-write');
});

const secret = 'fixture-secret-with-at-least-thirty-two-bytes';
function runnerToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy', sub: userId, org_id: orgId, profile: 'hivemind-chat', iat: now, exp: now + 30, jti: crypto.randomUUID() })}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

for (const enabled of [true, false]) {
  test(`server-to-server principal read reports runtime_enabled=${enabled}`, async () => {
    const res = {}; const db = fakeDb(enabled);
    await handleHarnessChatBootstrapRoute({
      req: { method: 'GET', headers: { authorization: `Bearer ${runnerToken()}` } }, res,
      pathname: '/internal/v1/harness-chat/core/principal',
      prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) }, $queryRawUnsafe: db.$queryRawUnsafe },
      env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, parseBody: async () => ({}),
      jsonResponse: (r, b, status = 200) => Object.assign(r, { body: b, status }), fetchImpl: async () => { throw Error('must not proxy'); }, redisConfig: {},
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { active: true, runtime_enabled: enabled });
  });
}

test('principal read fails closed with 503 when the setting cannot be read', async () => {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: { method: 'GET', headers: { authorization: `Bearer ${runnerToken()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/principal',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) }, $queryRawUnsafe: async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); } },
    env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, parseBody: async () => ({}),
    jsonResponse: (r, b, status = 200) => Object.assign(r, { body: b, status }), fetchImpl: async () => { throw Error('no'); }, redisConfig: {},
  });
  assert.equal(res.status, 503);
});

test('schema, migration and control plane wiring agree', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(read('../../prisma/schema.prisma'), /runtimeEnabled\s+Boolean\s+@default\(true\)\s+@map\("runtime_enabled"\)/);
  const migration = read('../../prisma/migrations/20261029100000_org_runtime_enabled/migration.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "runtime_enabled" boolean NOT NULL DEFAULT true/);
  assert.doesNotMatch(migration, /DROP|DELETE|UPDATE\s/i);
  const server = read('../../src/control-plane-server.js');
  assert.match(server, /runtime_enabled: await readRuntimeEnabled\(prisma, org\.id\)/);
  assert.match(server, /handleRuntimeSettingRoute\(\{ req, res, pathname, prisma, requireSession, requireOrgAdmin, parseBody, jsonResponse, audit \}\)/);
});
