import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingLifecycleTest } from '../../src/knowledge/meeting-lifecycle-v2.js';

test('active policy requires controller, jurisdiction, lawful bases, purposes, DPIA and notice', () => {
  const incomplete = meetingLifecycleTest.requiredPolicyFields({ status: 'active' });
  assert.ok(incomplete.missing.includes('controller_name'));
  assert.ok(incomplete.missing.includes('lawful_basis'));
  assert.ok(incomplete.missing.includes('dpia_status'));
  assert.ok(incomplete.missing.includes('notice_body'));
  const complete = meetingLifecycleTest.requiredPolicyFields({
    status: 'active', controller_name: 'Example Controller', privacy_contact: 'privacy@example.invalid',
    country_code: 'DE', recording_jurisdiction: 'Germany', national_recording_rule: 'controller-approved rule',
    lawful_basis: { record_audio: 'legitimate_interests', transcribe_and_summarize: 'legitimate_interests' },
    purposes: ['record_audio', 'transcribe_and_summarize'], dpia_status: 'approved', notice_body: 'Notice text',
  });
  assert.deepEqual(complete.missing, []);
});

test('participant normalization is bounded, de-duplicated, and rejects unverifiable externals', () => {
  const participants = meetingLifecycleTest.normalizedParticipants({ participants: [
    { email: ' PERSON@Example.com ', display_name: 'Person' },
    { email: 'person@example.com', display_name: 'Duplicate' },
    { email: 'not-an-email', display_name: 'Invalid' },
    { user_id: '11111111-1111-4111-8111-111111111111', display_name: 'Member' },
  ] });
  assert.equal(participants.length, 2);
  assert.equal(participants[0].email, 'person@example.com');
  assert.equal(participants[1].kind, 'member');
});

test('public invitation secrets are represented only by deterministic hashes', () => {
  assert.match(meetingLifecycleTest.sha256('secret'), /^[a-f0-9]{64}$/);
  assert.notEqual(meetingLifecycleTest.sha256('secret'), 'secret');
});

test('outbox delivery secret is encrypted at rest and decryptable only with the configured key', () => {
  const prior = process.env.MEETING_INVITATION_ENCRYPTION_KEY;
  process.env.MEETING_INVITATION_ENCRYPTION_KEY = 'test-only-key-material-that-is-long-enough';
  try {
    const ciphertext = meetingLifecycleTest.encryptDeliverySecret('one-time-secret');
    assert.doesNotMatch(ciphertext, /one-time-secret/);
    assert.equal(meetingLifecycleTest.decryptDeliverySecret(ciphertext), 'one-time-secret');
  } finally {
    if (prior === undefined) delete process.env.MEETING_INVITATION_ENCRYPTION_KEY;
    else process.env.MEETING_INVITATION_ENCRYPTION_KEY = prior;
  }
});
