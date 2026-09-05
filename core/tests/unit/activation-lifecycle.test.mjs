import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_STAGES,
  activationReminderCopy,
  isActivationLifecycleEnabled,
  scheduleActivationWorkflow,
} from '../../src/lifecycle/activation-lifecycle.js';

test('activation lifecycle backend gate is fail-closed', () => {
  const previous = process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED;
  try {
    delete process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED;
    assert.equal(isActivationLifecycleEnabled(), false);
    process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED = 'TRUE';
    assert.equal(isActivationLifecycleEnabled(), false);
    process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED = 'true';
    assert.equal(isActivationLifecycleEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED;
    else process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED = previous;
  }
});

test('activation scheduling sends identifiers and deterministic reminder sequence only', async () => {
  const previous = {
    enabled: process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED,
    url: process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL,
    secret: process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET,
  };
  process.env.HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED = 'true';
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL = 'https://activation.example.test';
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET = 'unit-secret';
  let request;
  try {
    await scheduleActivationWorkflow({
      activation: {
        id: '11111111-1111-1111-1111-111111111111', generation: 3, reminder_count: 2,
        next_reminder_at: '2026-09-06T10:00:00.000Z', email: 'must-not-leak@example.test',
      },
      fetchImpl: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      },
    });
    assert.equal(request.url, 'https://activation.example.test/start');
    assert.equal(request.init.headers.authorization, 'Bearer unit-secret');
    assert.deepEqual(request.body, {
      activation_id: '11111111-1111-1111-1111-111111111111', generation: 3, sequence: 2,
      target_at: '2026-09-06T10:00:00.000Z',
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const env = key === 'enabled' ? 'HIVEMIND_ACTIVATION_LIFECYCLE_ENABLED' : key === 'url' ? 'HIVEMIND_ACTIVATION_WORKFLOW_URL' : 'HIVEMIND_ACTIVATION_WORKFLOW_SECRET';
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test('reminder copy remains typed lifecycle communication', () => {
  const invite = activationReminderCopy(ACTIVATION_STAGES.INVITED_PENDING_SIGNUP);
  const signup = activationReminderCopy(ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY);
  assert.equal(invite.type, 'lifecycle.invitation.reminder');
  assert.equal(signup.type, 'lifecycle.signup.reminder');
  assert.match(signup.href, /onboard=1/);
});
