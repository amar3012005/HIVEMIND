import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_STAGES,
  activationReminderCopy,
  advanceActivationForEmail,
  isActivationLifecycleEnabled,
  renderActivationReminderEmail,
  scheduleActivationWorkflow,
  startSignupActivation,
} from '../../src/lifecycle/activation-lifecycle.js';

test('activation lifecycle transport gate is fail-closed while Flagship owns admission', () => {
  const previous = {
    url: process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL,
    secret: process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET,
  };
  try {
    delete process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL;
    delete process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET;
    assert.equal(isActivationLifecycleEnabled(), false);
    process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL = 'https://activation.example.test';
    assert.equal(isActivationLifecycleEnabled(), false);
    process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET = 'unit-secret';
    assert.equal(isActivationLifecycleEnabled(), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const env = key === 'url' ? 'HIVEMIND_ACTIVATION_WORKFLOW_URL' : 'HIVEMIND_ACTIVATION_WORKFLOW_SECRET';
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test('state progression is persisted even while Flagship admission is disabled', async () => {
  const result = await advanceActivationForEmail({
    prisma: { $queryRawUnsafe: async () => [{ id: 'activation', generation: 2, stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY }] },
    email: 'person@example.test',
    stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY,
  });
  assert.deepEqual(result, [{ id: 'activation', generation: 2, stage: ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY }]);
  assert.doesNotThrow(() => [...result]);
});

test('direct signup joins the same recipient lifecycle without retaining raw email', async () => {
  let query = '';
  const activation = await startSignupActivation({
    prisma: { $queryRawUnsafe: async (sql) => { query = sql; return [{ id: 'activation', generation: 1 }]; } },
    email: 'person@example.test',
    userId: '11111111-1111-1111-1111-111111111111',
    metadata: { activation_source: 'email_signup' },
  });
  assert.deepEqual(activation, { id: 'activation', generation: 1 });
  assert.doesNotMatch(query, /person@example\.test/);
});

test('activation scheduling sends identifiers and deterministic reminder sequence only', async () => {
  const previous = {
    url: process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL,
    secret: process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET,
  };
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL = 'https://activation.example.test';
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET = 'unit-secret';
  let request;
  try {
    await scheduleActivationWorkflow({
      activation: {
        id: '11111111-1111-1111-1111-111111111111', generation: 3, reminder_count: 2,
        next_reminder_at: '2026-09-06T10:00:00.000Z', email: 'must-not-leak@example.test',
      },
      fetchImpl: async (url, init = {}) => {
        if (url.endsWith('/enabled?activation_id=11111111-1111-1111-1111-111111111111')) {
          assert.equal(init.headers.authorization, 'Bearer unit-secret');
          return new Response(JSON.stringify({ enabled: true }), { status: 200 });
        }
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
      const env = key === 'url' ? 'HIVEMIND_ACTIVATION_WORKFLOW_URL' : 'HIVEMIND_ACTIVATION_WORKFLOW_SECRET';
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test('Flagship refusal does not start a durable workflow', async () => {
  const previous = {
    url: process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL,
    secret: process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET,
  };
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_URL = 'https://activation.example.test';
  process.env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET = 'unit-secret';
  try {
    const result = await scheduleActivationWorkflow({
      activation: { id: '11111111-1111-1111-1111-111111111111', generation: 1, next_reminder_at: '2026-09-06T10:00:00.000Z' },
      fetchImpl: async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    });
    assert.deepEqual(result, { skipped: true, reason: 'feature_disabled' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const env = key === 'url' ? 'HIVEMIND_ACTIVATION_WORKFLOW_URL' : 'HIVEMIND_ACTIVATION_WORKFLOW_SECRET';
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

test('each activation reminder has a dedicated, escaped, responsive email rendering', () => {
  for (const stage of [
    ACTIVATION_STAGES.INVITED_PENDING_SIGNUP,
    ACTIVATION_STAGES.SIGNED_IN_PENDING_COMPANY,
    ACTIVATION_STAGES.ONBOARDING_IN_PROGRESS,
  ]) {
    const rendered = renderActivationReminderEmail({
      stage,
      companyName: 'Canary <Company>',
      appUrl: 'https://dev.next.singulancelabs.com/hivemind/app/employees/mycompany?onboard=1',
    });
    assert.match(rendered.subject, /HIVEMIND|awaken/i);
    assert.match(rendered.text, /https:\/\/dev\.next\.singulancelabs\.com/);
    assert.match(rendered.html, /SINGULANCE/);
    assert.match(rendered.html, /class="action"/);
    assert.match(rendered.html, /@media only screen and \(max-width:620px\)/);
    assert.match(rendered.html, /Canary &lt;Company&gt;/);
    assert.doesNotMatch(rendered.html, /Canary <Company>/);
  }
});

test('activation reminder refuses an unsafe or missing destination', () => {
  assert.throws(
    () => renderActivationReminderEmail({ stage: ACTIVATION_STAGES.INVITED_PENDING_SIGNUP, appUrl: 'http://example.test' }),
    /activation_reminder_requires_https_destination/,
  );
});
