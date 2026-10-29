import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveComposioCallbackUrl } from '../../src/connectors/composio/connect-callback.js';

const base = {
  frontendBaseUrl: 'https://next.singulancelabs.com',
  allowedOrigins: ['https://singulancelabs.com', 'https://runtime-runner.singulancelabs.com', 'http://localhost:3000'],
  toolkit: 'hubspot',
};

test('keeps a first-party https callback and drops its fragment', () => {
  const url = resolveComposioCallbackUrl({ ...base, requested: 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot&return=%2Fhivemind%2Fapp%2Fconnectors#x' });
  assert.equal(url, 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot&return=%2Fhivemind%2Fapp%2Fconnectors');
});

test('replaces a foreign, custom-scheme or credentialed callback with the landing page', () => {
  for (const requested of ['https://evil.example/x', 'capacitor://localhost/hivemind/app/connectors', 'https://a:b@next.singulancelabs.com/x', 'javascript:alert(1)', '/relative']) {
    assert.equal(resolveComposioCallbackUrl({ ...base, requested }), 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot', requested);
  }
});

test('missing callback uses the trusted request origin, never a relative URL', () => {
  assert.equal(resolveComposioCallbackUrl({ ...base, requestOrigin: 'https://singulancelabs.com' }), 'https://singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot');
  assert.equal(resolveComposioCallbackUrl({ ...base, requestOrigin: 'https://evil.example' }), 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot');
  assert.equal(resolveComposioCallbackUrl({ ...base }), 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=hubspot');
});

import { chatConnectCallbackUrl, returnPathFromReferer } from '../../src/connectors/composio/connect-callback.js';

test('chat connect card returns the person to the page they started from', () => {
  const ctx = { composioCallbackOrigin: 'https://next.singulancelabs.com', composioReturnPath: '/hivemind/app/chat?thread=7', composioAllowedOrigins: ['https://next.singulancelabs.com'] };
  const url = new URL(chatConnectCallbackUrl(ctx, 'hubspot'));
  assert.equal(url.origin + url.pathname, 'https://next.singulancelabs.com/hivemind/connect-return');
  assert.equal(url.searchParams.get('composio_toolkit'), 'hubspot');
  assert.equal(url.searchParams.get('return'), '/hivemind/app/chat?thread=7');
});

test('chat connect card without a start page uses the landing page and never a relative or foreign URL', () => {
  assert.equal(chatConnectCallbackUrl({ composioCallbackOrigin: 'https://next.singulancelabs.com' }, 'slack'), 'https://next.singulancelabs.com/hivemind/connect-return?composio_toolkit=slack');
  assert.equal(chatConnectCallbackUrl({ composioCallbackOrigin: 'https://next.singulancelabs.com' }), 'https://next.singulancelabs.com/hivemind/connect-return');
  assert.equal(chatConnectCallbackUrl({}), null);
  const protocolRelative = chatConnectCallbackUrl({ composioCallbackOrigin: 'https://next.singulancelabs.com', composioReturnPath: '//evil.example/x' }, 'a');
  assert.ok(!protocolRelative.includes('evil'));
});

test('referer path is accepted only from a first-party origin', () => {
  const trusted = ['https://next.singulancelabs.com'];
  assert.equal(returnPathFromReferer('https://next.singulancelabs.com/hivemind/app/chat?x=1', trusted), '/hivemind/app/chat?x=1');
  assert.equal(returnPathFromReferer('https://evil.example/hivemind', trusted), null);
  assert.equal(returnPathFromReferer(undefined, trusted), null);
});
