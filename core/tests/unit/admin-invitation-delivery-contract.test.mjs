import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');

test('platform invitation creation is draft-only and dispatch is restricted to send actions', () => {
  const createStart = source.indexOf("if (pathname === '/admin/api/platform/invitations'");
  const personalStart = source.indexOf("if (pathname === '/admin/api/platform/personal-invitation-link'", createStart);
  const createRoute = source.slice(createStart, personalStart);
  assert.match(createRoute, /delivery_status: 'not_sent'/);
  assert.match(createRoute, /Creation never sends mail/);
  assert.doesNotMatch(createRoute, /dispatchEnterpriseInvitation\(/);
  assert.doesNotMatch(createRoute, /sendSystemEmail\(/);
  assert.doesNotMatch(createRoute, /code: created\.plaintextCode/);

  const actionStart = source.indexOf('const adminInvitationAction = pathname.match');
  const actionEnd = source.indexOf('// ─── Public commercial', actionStart);
  const actionRoute = source.slice(actionStart, actionEnd);
  assert.match(actionRoute, /action === 'preview'/);
  assert.match(actionRoute, /if \(!\['send', 'resend'\]\.includes\(action\)\)/);
  assert.match(actionRoute, /dispatchEnterpriseInvitation\(/);
  assert.match(actionRoute, /if \(!sent\.delivery\.ok\) return jsonResponse\(res,[\s\S]*502\)/);
});
