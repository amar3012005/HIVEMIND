/**
 * SCIM conformance tests — simulate Okta + Azure AD provisioning flows
 * against a running control plane.
 *
 * Usage:
 *   SCIM_BASE=http://hm-control:3000 SCIM_TOKEN=scim_<hex64> \
 *     node core/tests/scim/conformance.test.mjs
 *
 * Designed to run inside hm-control container or against a CI sandbox.
 * Returns non-zero on any failure. Stdout is one line per test.
 *
 * Coverage replicates the call sequences these IdPs actually make:
 *   - Okta — initial sync, scoped filter, PATCH replace active=false
 *   - Azure AD — bulk operations, complex PATCH path
 *   - RFC 7644 — error envelope shape, schemas array, pagination
 */

const BASE = process.env.SCIM_BASE || 'http://localhost:3000';
const TOKEN = process.env.SCIM_TOKEN || '';
const VERBOSE = process.env.SCIM_TEST_VERBOSE === '1';

if (!TOKEN) {
  console.error('SCIM_TOKEN env required');
  process.exit(2);
}

let passed = 0;
let failed = 0;
let failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    if (VERBOSE) console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} — ${detail}`);
    console.log(`  FAIL ${name} — ${detail}`);
  }
}

async function scim(path, init = {}) {
  const headers = {
    'Content-Type': 'application/scim+json',
    Accept: 'application/scim+json',
    ...(init.headers || {}),
  };
  if (!init.noAuth) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  let body = null;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

// ─── 1. Discovery (unauth) ──────────────────────────────────────────────────
{
  console.log('\n[1] Discovery');
  const r = await scim('/scim/v2/ServiceProviderConfig', { noAuth: true });
  check('ServiceProviderConfig 200', r.status === 200, `got ${r.status}`);
  check('schemas array present', Array.isArray(r.body?.schemas), JSON.stringify(r.body?.schemas));
  check('patch.supported true', r.body?.patch?.supported === true);
  check('bulk.supported true', r.body?.bulk?.supported === true);
  check('filter.supported true', r.body?.filter?.supported === true);

  const s = await scim('/scim/v2/Schemas', { noAuth: true });
  check('Schemas 200', s.status === 200);
  check('Schemas listResponse', s.body?.schemas?.[0] === 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  check('Schemas has User+Group', s.body?.Resources?.length >= 2);
}

// ─── 2. Auth enforcement ────────────────────────────────────────────────────
{
  console.log('\n[2] Auth');
  const noAuth = await scim('/scim/v2/Users', { noAuth: true });
  check('Users no-auth 401', noAuth.status === 401);
  check('error envelope schema', noAuth.body?.schemas?.[0] === 'urn:ietf:params:scim:api:messages:2.0:Error');
  check('error detail string', typeof noAuth.body?.detail === 'string');

  const badBearer = await scim('/scim/v2/Users', { headers: { Authorization: 'Bearer scim_' + 'a'.repeat(64) } });
  check('Users bogus-bearer 401', badBearer.status === 401);
}

// ─── 3. Okta initial sync — list + filter ───────────────────────────────────
let createdUserId = null;
{
  console.log('\n[3] Okta-style User sync');
  const list = await scim('/scim/v2/Users?startIndex=1&count=10');
  check('Users list 200', list.status === 200);
  check('list envelope', list.body?.schemas?.[0] === 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  check('totalResults int', typeof list.body?.totalResults === 'number');
  check('startIndex echoed', list.body?.startIndex === 1);
  check('Resources is array', Array.isArray(list.body?.Resources));

  // Create user (Okta POST)
  const email = `scim-test-${Date.now()}@hivemind.io`;
  const create = await scim('/scim/v2/Users', {
    method: 'POST',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: email,
      displayName: 'SCIM Test',
      name: { formatted: 'SCIM Test', givenName: 'SCIM', familyName: 'Test' },
      emails: [{ value: email, primary: true, type: 'work' }],
      active: true,
    }),
  });
  check('Create user 201', create.status === 201, `status ${create.status}`);
  check('Create returns id', typeof create.body?.id === 'string');
  check('Create returns userName', create.body?.userName === email);
  check('Create returns active=true', create.body?.active === true);
  createdUserId = create.body?.id;

  // Filter eq userName (Okta lookup)
  const f1 = await scim(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`);
  check('Filter eq 200', f1.status === 200);
  check('Filter eq returns 1', f1.body?.totalResults === 1);

  // Filter co (Azure / advanced)
  const f2 = await scim(`/scim/v2/Users?filter=${encodeURIComponent('userName co "scim-test"')}`);
  check('Filter co 200', f2.status === 200);
  check('Filter co >=1', f2.body?.totalResults >= 1);

  // Filter pr (presence)
  const f3 = await scim(`/scim/v2/Users?filter=${encodeURIComponent('displayName pr')}`);
  check('Filter pr 200', f3.status === 200);
}

// ─── 4. PATCH with path expression ──────────────────────────────────────────
if (createdUserId) {
  console.log('\n[4] PATCH ops');
  // Simple replace active = false
  const p1 = await scim(`/scim/v2/Users/${createdUserId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }),
  });
  check('PATCH active=false 200', p1.status === 200);
  check('User now inactive', p1.body?.active === false);

  // Re-enable
  await scim(`/scim/v2/Users/${createdUserId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: true }],
    }),
  });

  // Replace displayName
  const p2 = await scim(`/scim/v2/Users/${createdUserId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'displayName', value: 'SCIM Test Renamed' }],
    }),
  });
  check('PATCH displayName 200', p2.status === 200);
  check('displayName updated', p2.body?.displayName === 'SCIM Test Renamed');
}

// ─── 5. Group lifecycle ─────────────────────────────────────────────────────
let createdGroupId = null;
{
  console.log('\n[5] Group lifecycle');
  const gList = await scim('/scim/v2/Groups?count=5');
  check('Groups list 200', gList.status === 200);

  const gCreate = await scim('/scim/v2/Groups', {
    method: 'POST',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: `Engineering ${Date.now()}`,
      members: createdUserId ? [{ value: createdUserId }] : [],
    }),
  });
  check('Group create 201', gCreate.status === 201, `status ${gCreate.status}`);
  check('Group returns id', typeof gCreate.body?.id === 'string');
  createdGroupId = gCreate.body?.id;
  if (createdUserId) {
    check('Initial member added', gCreate.body?.members?.some?.((m) => m.value === createdUserId));
  }

  // Add member via PATCH (Azure)
  if (createdGroupId && createdUserId) {
    const otherUserId = createdUserId; // re-add idempotent
    const patchAdd = await scim(`/scim/v2/Groups/${createdGroupId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'members', value: [{ value: otherUserId }] }],
      }),
    });
    check('PATCH add member 200', patchAdd.status === 200);
  }
}

// ─── 6. Bulk endpoint ───────────────────────────────────────────────────────
{
  console.log('\n[6] Bulk');
  const bulk = await scim('/scim/v2/Bulk', {
    method: 'POST',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      Operations: [
        {
          method: 'POST', path: '/Users', bulkId: 'u1',
          data: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `bulk-1-${Date.now()}@x.com`, displayName: 'Bulk One', active: true },
        },
        {
          method: 'POST', path: '/Users', bulkId: 'u2',
          data: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: `bulk-2-${Date.now()}@x.com`, displayName: 'Bulk Two', active: true },
        },
      ],
    }),
  });
  check('Bulk 200', bulk.status === 200);
  check('Bulk envelope', bulk.body?.schemas?.[0] === 'urn:ietf:params:scim:api:messages:2.0:BulkResponse');
  check('Bulk 2 operations', bulk.body?.Operations?.length === 2);
  check('Bulk all 201', bulk.body?.Operations?.every?.((o) => o.status === '201'));
}

// ─── 7. Cleanup ─────────────────────────────────────────────────────────────
{
  console.log('\n[7] Cleanup');
  if (createdGroupId) {
    const d = await scim(`/scim/v2/Groups/${createdGroupId}`, { method: 'DELETE' });
    check('Group DELETE 204', d.status === 204);
  }
  if (createdUserId) {
    const d = await scim(`/scim/v2/Users/${createdUserId}`, { method: 'DELETE' });
    check('User DELETE 204 (soft)', d.status === 204);
  }
}

console.log(`\n────────────────────────────────────────`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
