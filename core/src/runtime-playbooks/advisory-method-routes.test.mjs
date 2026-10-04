import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdvisoryMethodApproval } from './advisory-method-routes.js';
const id = '00000000-0000-4000-8000-000000000001';
function setup({ authenticated = true, admin = true } = {}) {
  const row = { id, status: 'pending', version: 1, prior_version: 0, body: { title: '<script>unsafe</script>', content: 'Exact body' }, rationale: 'Verified change', evidence_refs: ['receipt'], content_hash: 'hash' };
  const output = {}; const res = { writeHead: (status, headers) => Object.assign(output, { status, headers }), end: body => { output.body = body; } };
  const callbacks = { requireSession: async () => authenticated ? { session: { userId: 'user', orgId: 'org' } } : null,
    requireOrgAdmin: async () => admin, parseBody: async () => ({ content_hash: 'hash', decision: 'approve' }),
    jsonResponse: (_res, body, status = 200) => Object.assign(output, { body, status }) };
  const prisma = { userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin' }) }, $queryRawUnsafe: async () => [row] };
  const execute = req => handleAdvisoryMethodApproval({ req, res, pathname: `/api/advisory-methods/${id}`, prisma, ...callbacks });
  return { execute, output };
}
test('owner approval page is exact-body readable, escaped, and has explicit approve/decline controls', async () => {
  const f = setup(); await f.execute({ method: 'GET', headers: {} });
  assert.equal(f.output.status, 200);
  assert.match(f.output.body, /Exact body/); assert.match(f.output.body, /Approve this version/); assert.match(f.output.body, /Decline/);
  assert.match(f.output.body, /&lt;script&gt;unsafe/); assert.doesNotMatch(f.output.body, /<script>unsafe/);
  assert.equal(f.output.headers['Cache-Control'], 'no-store');
});
test('API/runner bearer without human session and nonadministrators cannot see approval page', async () => {
  for (const opts of [{ authenticated: false }, { admin: false }]) {
    const f = setup(opts); await f.execute({ method: 'GET', headers: { authorization: 'Bearer runner' } });
    assert.equal(f.output.body, undefined);
  }
});
test('cross-origin and missing-origin publication are rejected before decision', async () => {
  for (const origin of [undefined, 'https://other.example']) {
    const f = setup(); await f.execute({ method: 'POST', headers: { host: 'api.example', origin } });
    assert.equal(f.output.status, 403);
  }
});
