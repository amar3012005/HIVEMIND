import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { emailSignInContext } from '../../src/auth/email-identity-service.js';
import { renderIcarusDeveloperSignIn } from '../../src/email/templates/icarus-developer-sign-in.js';
const issuer = 'https://api.singulancelabs.com';
function developerReturn() {
  const u = new URL('/auth/developer/cli/start', issuer);
  u.search = new URLSearchParams({ callback: 'http://127.0.0.1:12345/callback', state: 's'.repeat(43), code_challenge: crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256' });
  return u.toString();
}
test('server validates full developer context and keeps ordinary OTP branding', () => {
  const value = developerReturn();
  const dev = emailSignInContext(value);
  assert.equal(dev.templateId, 'icarus_developer_sign_in');
  assert.equal(new URLSearchParams(dev.loginSearch).get('cli_return_to'), value);
  for (const other of ['https://next.singulancelabs.com/hivemind/app/overview', value.replace('api.singulancelabs.com', 'evil.test'), value.replace('127.0.0.1', 'evil.test'), value.replace('S256', 'plain'), null]) {
    assert.deepEqual(emailSignInContext(other), { templateId: 'email_identity_sign_in', loginSearch: '' });
  }
});
test('ICARUS transactional template includes text, HTML, expiry and terminal context', () => {
  const result = renderIcarusDeveloperSignIn({ otp: '123456', fragmentUrl: `https://next.singulancelabs.com/hivemind/login${emailSignInContext(developerReturn()).loginSearch}#email_challenge=fixture&email_token=fixture` });
  assert.equal(result.subject, 'Your ICARUS developer sign-in code');
  for (const content of [result.text, result.html]) { assert.match(content, /123456/); assert.match(content, /10 minutes/); assert.match(content, /terminal/); }
  assert.match(result.html, /ICARUS \/ SINGULANCE DEVELOPERS/);
  assert.match(result.html, /&amp;/);
  assert.throws(() => renderIcarusDeveloperSignIn({ otp: '<bad>', fragmentUrl: 'https://example.test' }));
});
