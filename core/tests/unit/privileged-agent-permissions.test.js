import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUsePrivilegedAgent, effectiveRoles } from '../../src/auth/permissions.js';

describe('privileged agent permissions', () => {
  it('allows organization leadership and project owners', () => {
    assert.equal(canUsePrivilegedAgent(effectiveRoles({ role: 'admin' })), true);
    assert.equal(canUsePrivilegedAgent(effectiveRoles({ role: 'member' }), 'owner'), true);
    assert.equal(canUsePrivilegedAgent(['team_lead']), true);
  });

  it('denies ordinary members and viewers', () => {
    assert.equal(canUsePrivilegedAgent(effectiveRoles({ role: 'member' })), false);
    assert.equal(canUsePrivilegedAgent(['viewer'], 'viewer'), false);
  });
});
