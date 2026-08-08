import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersonalInvitationLink,
  createSignupAdmission,
  invitationCodeMatches,
  verifyPersonalInvitationLink,
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

test('personal invitation links are time-bound and invalidated when the shared code rotates', () => {
  const token = createPersonalInvitationLink({ configuredCode: 'PRIVATE-BETA', secret, ttlSeconds: 60, now });
  assert.ok(token);
  assert.deepEqual(
    verifyPersonalInvitationLink({ token, configuredCode: 'PRIVATE-BETA', secret, now: now + 59_000 }),
    { accountType: 'personal', expiresAt: Math.floor(now / 1000) + 60 },
  );
  assert.equal(verifyPersonalInvitationLink({ token, configuredCode: 'ROTATED', secret, now }), null);
  assert.equal(verifyPersonalInvitationLink({ token: `${token}x`, configuredCode: 'PRIVATE-BETA', secret, now }), null);
  assert.equal(verifyPersonalInvitationLink({ token, configuredCode: 'PRIVATE-BETA', secret, now: now + 60_000 }), null);
});

test('enterprise admissions preserve only a signed invitation identity, never a code or link', () => {
  const ticket = createSignupAdmission({
    accountType: 'enterprise', secret, now,
    enterpriseInvitation: { id: '11111111-1111-4111-8111-111111111111', method: 'link', version: 2 },
  });
  const decoded = verifySignupAdmission({ ticket, accountType: 'enterprise', secret, now });
  assert.deepEqual(decoded.enterpriseInvitation, { id: '11111111-1111-4111-8111-111111111111', method: 'link', version: 2 });
  assert.equal(ticket.includes('recovery-code'), false);
  assert.equal(createSignupAdmission({ accountType: 'personal', secret, enterpriseInvitation: { id: '11111111-1111-4111-8111-111111111111', method: 'link', version: 1 } }), null);
});
