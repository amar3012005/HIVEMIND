import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_EMAIL_TEMPLATES, normalizeAdminEmailMessage } from '../../src/email/admin-email-studio.js';

test('admin email studio only permits approved welcome templates and server-owned app URL', () => {
  const message = normalizeAdminEmailMessage({ template_id: 'welcome_signup', to: ' Owner@Example.com ', name: '  Ada   Lovelace ' }, { appUrl: 'https://next.singulancelabs.com/hivemind/app' });
  assert.equal(message.to, 'owner@example.com');
  assert.equal(message.vars.name, 'Ada Lovelace');
  assert.equal(message.vars.appUrl, 'https://next.singulancelabs.com/hivemind/app');
  assert.ok(Object.hasOwn(ADMIN_EMAIL_TEMPLATES, message.templateId));
});

test('admin email studio rejects arbitrary templates and malformed recipients', () => {
  assert.throws(() => normalizeAdminEmailMessage({ template_id: 'announcement', to: 'owner@example.com' }), /Template is unavailable/);
  assert.throws(() => normalizeAdminEmailMessage({ template_id: 'welcome_login', to: 'not-an-email' }), /Recipient email is invalid/);
});
