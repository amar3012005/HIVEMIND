import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTenantOrg, enforceTenantFilter } from '../../src/vector/tenant-filter.js';

test('authenticated org is injected into an unscoped vector search', () => {
  const filter = enforceTenantFilter(undefined, 'org-a');
  assert.deepEqual(filter.must, [{ key: 'org_id', match: { value: 'org-a' } }]);
});

test('matching caller scope is preserved', () => {
  const filter = { must: [{ key: 'org_id', match: { value: 'org-a' } }, { key: 'layer', match: { value: 'memory' } }] };
  assert.equal(enforceTenantFilter(filter, 'org-a'), filter);
});

test('cross-tenant vector reads and writes are rejected at the storage boundary', () => {
  assert.throws(
    () => enforceTenantFilter({ must: [{ key: 'org_id', match: { value: 'org-b' } }] }, 'org-a'),
    { code: 'TENANT_SCOPE_MISMATCH' },
  );
  assert.throws(() => assertTenantOrg('org-b', 'org-a'), { code: 'TENANT_SCOPE_MISMATCH' });
});
