import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_PUBLIC_FRONTEND,
  resolveInvitationBaseUrl,
  resolvePublicAppUrl,
  resolvePublicFrontendBaseUrl,
} from '../../src/public-frontend-url.js';

test('public frontend defaults to the canonical Singulance application', () => {
  assert.equal(resolvePublicFrontendBaseUrl(''), CANONICAL_PUBLIC_FRONTEND);
  assert.equal(resolveInvitationBaseUrl({}), CANONICAL_PUBLIC_FRONTEND);
  assert.equal(resolvePublicAppUrl({}), `${CANONICAL_PUBLIC_FRONTEND}/hivemind/app`);
});

test('legacy frontend configuration cannot leak into invitations or email links', () => {
  const legacy = { HIVEMIND_FRONTEND_URL: 'https://hivemind.davinciai.eu/' };
  assert.equal(resolvePublicFrontendBaseUrl(legacy.HIVEMIND_FRONTEND_URL), CANONICAL_PUBLIC_FRONTEND);
  assert.equal(resolveInvitationBaseUrl(legacy), CANONICAL_PUBLIC_FRONTEND);
  assert.equal(resolvePublicAppUrl({ HIVEMIND_APP_URL: 'https://hivemind.davinciai.eu/hivemind/app' }), `${CANONICAL_PUBLIC_FRONTEND}/hivemind/app`);
});

test('valid preview and self-hosted overrides remain available', () => {
  assert.equal(resolveInvitationBaseUrl({ HIVEMIND_INVITATION_BASE_URL: 'https://next.preview.singulancelabs.com/' }), 'https://next.preview.singulancelabs.com');
  assert.equal(resolvePublicFrontendBaseUrl('http://localhost:3000/hivemind'), 'http://localhost:3000');
});
