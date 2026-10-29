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
