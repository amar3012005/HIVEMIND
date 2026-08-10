import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignupAdmission,
  invitationCodeMatches,
  verifySignupAdmission,
} from '../../src/control-plane/signup-admission.js';

const secret = 'test-signup-admission-secret';
const now = Date.UTC(2026, 7, 3, 12, 0, 0);

test('a configured invitation code is required and compared without normalization', () => {
  assert.equal(invitationCodeMatches('valid-code', 'valid-code'), true);
  assert.equal(invitationCodeMatches('valid-code ', 'valid-code'), false);
  assert.equal(invitationCodeMatches('valid-code', ''), false);
});

test('signup admissions are account-bound, short-lived, and tamper resistant', () => {
  const ticket = createSignupAdmission({ accountType: 'personal', secret, ttlSeconds: 60, now });
  assert.ok(ticket);
  assert.deepEqual(
    verifySignupAdmission({ ticket, accountType: 'personal', secret, now: now + 59_000 }),
    { accountType: 'personal', expiresAt: Math.floor(now / 1000) + 60 },
  );
  assert.equal(verifySignupAdmission({ ticket, accountType: 'enterprise', secret, now }), null);
  assert.equal(verifySignupAdmission({ ticket: `${ticket}x`, accountType: 'personal', secret, now }), null);
  assert.equal(verifySignupAdmission({ ticket, accountType: 'personal', secret, now: now + 60_000 }), null);
});

test('admissions fail closed without a configured signing secret', () => {
  assert.equal(createSignupAdmission({ accountType: 'personal', secret: '' }), null);
  assert.equal(verifySignupAdmission({ ticket: 'anything', accountType: 'personal', secret: '' }), null);
});
