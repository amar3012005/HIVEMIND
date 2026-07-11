import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEnterpriseAccessCodeAllowed } from '../../src/billing/enterprise-access.js';

describe('enterprise access codes', () => {
  const configured = 'nexster-long-code,second-code';

  it('accepts only an exactly configured code', () => {
    assert.equal(isEnterpriseAccessCodeAllowed('nexster-long-code', configured), true);
    assert.equal(isEnterpriseAccessCodeAllowed('nexster-long-code-extra', configured), false);
    assert.equal(isEnterpriseAccessCodeAllowed('NEXSTER-LONG-CODE', configured), false);
  });

  it('fails closed when no code is configured', () => {
    assert.equal(isEnterpriseAccessCodeAllowed('nexster-long-code', ''), false);
    assert.equal(isEnterpriseAccessCodeAllowed('', configured), false);
  });
});
