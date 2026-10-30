import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLanguageSettingRoute, normalizeOrgLocale, readOrgDefaultLocale, writeOrgDefaultLocale, ORG_LOCALES } from '../../src/organizations/language-setting.js';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';

/** In-memory stand-in for the organizations row, answering the two SQL statements the module issues. */
function fakeDb(initial = null) {
  const state = { locale: initial };
  return {
    state,
    $queryRawUnsafe: async (sql, ...args) => {
      if (/^SELECT default_locale/.test(sql)) return args[0] === orgId ? [{ default_locale: state.locale }] : [];
      if (/^UPDATE hivemind\.organizations/.test(sql)) {
        if (args[0] !== orgId) return [];
        const previous = state.locale; state.locale = args[1];
        return [{ previous, current: state.locale }];
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
}

async function call({ method = 'GET', path = `/v1/orgs/${orgId}/language-settings`, body, db = fakeDb(), admin = true, session = true } = {}) {
  const res = {}; const audits = [];
  const handled = await handleLanguageSettingRoute({
    req: { method, headers: { 'user-agent': 'test' }, socket: {} }, res, pathname: path, prisma: db,
    requireSession: async () => (session ? { session: { userId, orgId } } : null),
    requireOrgAdmin: async () => (admin ? { role: 'admin' } : null),
    parseBody: async () => body,
    jsonResponse: (r, b, status = 200, headers = {}) => Object.assign(r, { body: b, status, headers }),
    audit: async entry => { audits.push(entry); },
  });
  return { handled, res, audits, db };
}

test('tags normalize to a supported primary language and anything else is null', () => {
  assert.equal(normalizeOrgLocale('de-AT'), 'de');
  assert.equal(normalizeOrgLocale(' AR_eg '), 'ar');
  assert.equal(normalizeOrgLocale('fr'), null);
  assert.equal(normalizeOrgLocale(undefined), null);
  assert.equal(normalizeOrgLocale(12), null);
});

test('GET returns the stored default, null when none, and the supported list', async () => {
  const none = await call();
  assert.equal(none.handled, true);
  assert.deepEqual(none.res.body, { organization_id: orgId, default_locale: null, supported: ORG_LOCALES });
  assert.equal(none.res.headers['Cache-Control'], 'private, no-store');
  assert.equal((await call({ db: fakeDb('ja') })).res.body.default_locale, 'ja');
});

test('PUT sets, audits old and new value, is idempotent, and clears with null', async () => {
  const db = fakeDb(null);
  const first = await call({ method: 'PUT', body: { default_locale: 'de' }, db });
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.res.body, { organization_id: orgId, default_locale: 'de', supported: ORG_LOCALES, changed: true });
  assert.equal(first.audits.length, 1);
  assert.equal(first.audits[0].eventType, 'organization.default_locale_changed');
  assert.deepEqual(first.audits[0].oldValue, { default_locale: null });
  assert.deepEqual(first.audits[0].newValue, { default_locale: 'de' });
  const again = await call({ method: 'PUT', body: { default_locale: 'de' }, db });
  assert.equal(again.res.body.changed, false);
  assert.equal(again.audits.length, 0);
  const cleared = await call({ method: 'PUT', body: { default_locale: null }, db });
  assert.equal(cleared.res.body.default_locale, null);
  assert.equal(db.state.locale, null);
});

test('only a supported tag or null is accepted and nothing is written otherwise', async () => {
  for (const body of [undefined, null, [], {}, { default_locale: 'fr' }, { default_locale: 'DE' }, { default_locale: 3 }, { default_locale: 'de', plan: 'x' }]) {
    const db = fakeDb('hi');
    const result = await call({ method: 'PUT', body, db });
    assert.equal(result.res.status, 400, JSON.stringify(body));
    assert.equal(db.state.locale, 'hi');
    assert.equal(result.audits.length, 0);
  }
});

test('a visitor without a session or without admin rights changes nothing, other paths and methods are not handled or refused', async () => {
  const db = fakeDb('hi');
  assert.equal((await call({ method: 'PUT', body: { default_locale: 'de' }, db, session: false })).res.status, undefined);
  assert.equal((await call({ method: 'PUT', body: { default_locale: 'de' }, db, admin: false })).res.status, undefined);
  assert.equal(db.state.locale, 'hi');
  assert.equal((await call({ path: '/v1/orgs/x/other' })).handled, false);
  assert.equal((await call({ method: 'DELETE' })).res.status, 405);
  assert.equal((await call({ method: 'PUT', body: { default_locale: 'de' }, db: fakeDb(), session: true, path: `/v1/orgs/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/language-settings` })).res.status, 404);
});

test('a database without the column reads as no default; other errors surface', async () => {
  const missing = { $queryRawUnsafe: async () => { const error = new Error('column "default_locale" does not exist'); error.code = '42703'; throw error; } };
  assert.equal(await readOrgDefaultLocale(missing, orgId), null);
  await assert.rejects(readOrgDefaultLocale({ $queryRawUnsafe: async () => { throw new Error('down'); } }, orgId), /down/);
  assert.equal(await readOrgDefaultLocale(fakeDb('ar'), 'not-a-uuid'), null);
  assert.equal(await writeOrgDefaultLocale(fakeDb(), '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12), 'de'), null);
});
