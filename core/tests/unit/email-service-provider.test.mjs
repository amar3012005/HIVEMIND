import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = global.fetch;
const originalEnv = {
  CLOUDFLARE_EMAIL_API_TOKEN: process.env.CLOUDFLARE_EMAIL_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_EMAIL_FROM: process.env.CLOUDFLARE_EMAIL_FROM,
  SYSTEM_EMAIL_NANGO_CONNECTION_ID: process.env.SYSTEM_EMAIL_NANGO_CONNECTION_ID,
  SYSTEM_EMAIL_FROM: process.env.SYSTEM_EMAIL_FROM,
};

const { sendSystemEmail, sendTeamInvitationEmails } = await import('../../src/email/email-service.js');

function setEnv(values) {
  for (const key of Object.keys(originalEnv)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  global.fetch = originalFetch;
  setEnv(originalEnv);
});

test('Cloudflare is the primary transactional provider and reports queued delivery', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Singulance Support <support@singulancelabs.com>',
  });
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ success: true, result: { delivered: [], queued: ['owner@example.com'], permanent_bounces: [] } }), { status: 200 });
  };

  const result = await sendSystemEmail({ templateId: 'enterprise_invitation', to: 'owner@example.com', vars: { companyName: 'Example', activationUrl: 'https://example.test', recoveryCode: 'CODE', supportEmail: 'support@singulancelabs.com' } });
  assert.deepEqual(result, { ok: true, provider: 'cloudflare', deliveryStatus: 'queued' });
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/unit-account/email/sending/send');
  assert.equal(request.init.headers.Authorization, 'Bearer unit-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.from, 'Singulance Support <support@singulancelabs.com>');
  assert.equal(body.to, 'owner@example.com');
  assert.match(body.html, /background:#117dff/);
  assert.match(body.html, /HIVEMIND/);
});

test('a Cloudflare permanent bounce is not retried through another provider', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Singulance Support <support@singulancelabs.com>',
    SYSTEM_EMAIL_NANGO_CONNECTION_ID: 'gmail-fallback',
  });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ success: true, result: { delivered: [], queued: [], permanent_bounces: ['owner@example.com'] } }), { status: 200 });
  };
  const result = await sendSystemEmail({ templateId: 'welcome_login', to: 'owner@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'permanent_bounce');
  assert.equal(calls, 1);
});

test('no configured provider fails safely without attempting a network call', async () => {
  setEnv({});
  global.fetch = async () => { throw new Error('network must not run'); };
  const result = await sendSystemEmail({ templateId: 'welcome_login', to: 'owner@example.com' });
  assert.deepEqual(result, { ok: false, skipped: true, error: 'no_email_provider' });
});

test('team invitation sends the secure link only to the member and a separate admin confirmation', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Singulance Support <support@singulancelabs.com>',
  });
  const messages = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    messages.push(body);
    return new Response(JSON.stringify({ success: true, result: { delivered: [], queued: [body.to], permanent_bounces: [] } }), { status: 200 });
  };
  const result = await sendTeamInvitationEmails({
    memberEmail: 'member@example.com',
    adminEmail: 'admin@example.com',
    vars: {
      orgName: 'Example Org', inviterName: 'Admin',
      joinUrl: 'https://next.example.test/secret-invite', expiresOn: 'Aug 20, 2026',
    },
  });
  assert.equal(result.member.ok, true);
  assert.equal(result.admin.ok, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].to, 'member@example.com');
  assert.match(messages[0].html, /secret-invite/);
  assert.equal(messages[1].to, 'admin@example.com');
  assert.doesNotMatch(messages[1].html, /secret-invite/);
  assert.match(messages[1].html, /member@example\.com/);
});
