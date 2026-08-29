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

const {
  configureSystemEmailNotificationSink,
  queueSystemEmailBundle,
  queueEmailDelivery,
  sendSystemEmail,
  sendSystemEmailBundle,
  sendTeamInvitationEmails,
} = await import('../../src/email/email-service.js');

function setEnv(values) {
  for (const key of Object.keys(originalEnv)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  global.fetch = originalFetch;
  setEnv(originalEnv);
  configureSystemEmailNotificationSink(null);
});

test('every accepted system email invokes the platform notification projection once', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Support <support@singulancelabs.com>',
  });
  global.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: { delivered: ['owner@example.com'], queued: [], permanent_bounces: [], message_id: '<receipt-1@singulancelabs.com>' },
  }), { status: 200 });
  const projections = [];
  configureSystemEmailNotificationSink(async (input) => { projections.push(input); return { created: 1 }; });
  const result = await sendSystemEmail({
    templateId: 'welcome_login',
    to: 'owner@example.com',
    notification: { orgId: 'org-1', userId: 'user-1' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.platformNotification, { created: 1 });
  assert.equal(projections.length, 1);
  assert.equal(projections[0].result.messageId, '<receipt-1@singulancelabs.com>');
  assert.deepEqual(projections[0].notification, { orgId: 'org-1', userId: 'user-1' });
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
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'cloudflare');
  assert.equal(result.deliveryStatus, 'queued');
  // A fresh RFC 5322 Message-ID is always minted (needed for real thread
  // continuity — see persona-narrator.js) — extracted from a bare domain,
  // not the raw "Name <email>" From header (that bug produced a trailing '>').
  assert.match(result.messageId, /^<[0-9a-f-]{36}@singulancelabs\.com>$/);
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/unit-account/email/sending/send');
  assert.equal(request.init.headers.Authorization, 'Bearer unit-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.from, 'Singulance Support <support@singulancelabs.com>');
  // Cloudflare's Email Sending API rejects a custom Message-ID header outright
  // (errors[0].code 10202, confirmed live 2026-08-17) — it must never be sent
  // to Cloudflare, even though we still mint one for our own thread bookkeeping.
  assert.equal(body.headers, undefined, 'no headers field at all when there is nothing else to send');
  assert.equal(body.to, 'owner@example.com');
  assert.match(body.html, /background:#117dff/);
  assert.match(body.html, /HIVEMIND/);
});

test('a thread\'s inReplyTo becomes real In-Reply-To/References headers on the request, via Cloudflare\'s documented headers passthrough', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Runtime <runtime@singulancelabs.com>',
  });
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ success: true, result: { delivered: [], queued: ['owner@example.com'], permanent_bounces: [] } }), { status: 200 });
  };
  await sendSystemEmail({
    templateId: 'announcement', to: 'owner@example.com',
    vars: { subject: 'x', heading: 'x', body: 'x' },
    thread: { inReplyTo: '<root-message-id@singulancelabs.com>' },
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.headers['In-Reply-To'], '<root-message-id@singulancelabs.com>');
  assert.equal(body.headers.References, '<root-message-id@singulancelabs.com>');
  assert.equal(body.headers['Message-ID'], undefined, 'Message-ID must never reach Cloudflare — it 400s the whole send');
});

test('Cloudflare\'s own returned message_id becomes the thread anchor, since ours is never sent', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Runtime <runtime@singulancelabs.com>',
  });
  global.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: { delivered: ['owner@example.com'], queued: [], permanent_bounces: [], message_id: '<cf-real-id@admin.singulancelabs.com>' },
  }), { status: 200 });
  const result = await sendSystemEmail({ templateId: 'announcement', to: 'owner@example.com', vars: { subject: 'x', heading: 'x', body: 'x' } });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, '<cf-real-id@admin.singulancelabs.com>');
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

test('profiled welcome templates render distinct personal and enterprise workspace messages', async () => {
  const { renderTemplate } = await import('../../src/email/email-service.js');
  const personal = renderTemplate('welcome_personal_workspace', { name: 'Maya', accountType: 'personal' });
  const enterprise = renderTemplate('welcome_enterprise_workspace', {
    name: 'Maya', orgName: 'Northstar', accountType: 'enterprise_managed', hostingMode: 'managed', onboardingEndsAt: '2026-08-26',
  });
  assert.match(personal.subject, /your HIVEMIND/);
  assert.match(personal.html, /PERSONAL WORKSPACE ACTIVATED/);
  assert.match(enterprise.subject, /Northstar/);
  assert.match(enterprise.html, /ENTERPRISE WORKSPACE ACTIVATED/);
  assert.match(enterprise.html, /Northstar/);
});

test('no configured provider fails safely without attempting a network call', async () => {
  setEnv({});
  global.fetch = async () => { throw new Error('network must not run'); };
  const result = await sendSystemEmail({ templateId: 'welcome_login', to: 'owner@example.com' });
  assert.deepEqual(result, { ok: false, skipped: true, error: 'no_email_provider' });
});

test('shared bundle preserves message keys and rejects unsafe recipients before transport', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Singulance Support <support@singulancelabs.com>',
  });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ success: true, result: { queued: ['member@example.com'] } }), { status: 200 });
  };
  const results = await sendSystemEmailBundle([
    { key: 'member', templateId: 'welcome_login', to: 'member@example.com' },
    { key: 'bad', templateId: 'welcome_login', to: 'member@example.com\r\nBcc: leak@example.com' },
  ]);
  assert.equal(results.member.ok, true);
  assert.equal(results.bad.error, 'invalid_recipient');
  assert.equal(calls, 1);
});

test('shared queue returns immediately and reconciles the provider result once', async () => {
  setEnv({
    CLOUDFLARE_EMAIL_API_TOKEN: 'unit-token',
    CLOUDFLARE_ACCOUNT_ID: 'unit-account',
    CLOUDFLARE_EMAIL_FROM: 'Singulance Support <support@singulancelabs.com>',
  });
  global.fetch = async () => new Response(JSON.stringify({ success: true, result: { queued: ['member@example.com'] } }), { status: 200 });
  let reconciled = null;
  const queued = queueSystemEmailBundle(
    [{ key: 'member', templateId: 'welcome_login', to: 'member@example.com' }],
    { context: { kind: 'test' }, onSettled: async (results) => { reconciled = results; } },
  );
  assert.equal(queued.accepted, true);
  const results = await queued.delivery;
  assert.equal(results.member.ok, true);
  assert.equal(reconciled.member.deliveryStatus, 'queued');
});

test('generic queue supports composed transactional workflows', async () => {
  let reconciled = null;
  const queued = queueEmailDelivery(
    async () => ({ member: { ok: true, provider: 'test' }, admin: { ok: true, provider: 'test' } }),
    { context: { kind: 'workspace_invitation' }, onSettled: async (results) => { reconciled = results; } },
  );
  assert.equal(queued.accepted, true);
  const results = await queued.delivery;
  assert.equal(results.admin.ok, true);
  assert.equal(reconciled.member.provider, 'test');
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
