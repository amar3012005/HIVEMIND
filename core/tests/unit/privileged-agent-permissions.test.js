import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUsePrivilegedAgent } from '../../src/auth/permissions.js';

describe('privileged agent permissions', () => {
  it('allows admins and scoped project or team heads', () => {
    assert.equal(canUsePrivilegedAgent({ role: 'admin' }), true);
    assert.equal(canUsePrivilegedAgent({ role: 'member' }, { projectRole: 'owner' }), true);
    assert.equal(canUsePrivilegedAgent({ role: 'member' }, { teamRole: 'lead' }), true);
  });

  it('denies ordinary members and viewers', () => {
    assert.equal(canUsePrivilegedAgent({ role: 'member' }), false);
    assert.equal(canUsePrivilegedAgent({ roles: ['viewer'] }, { projectRole: 'viewer' }), false);
  });
});
