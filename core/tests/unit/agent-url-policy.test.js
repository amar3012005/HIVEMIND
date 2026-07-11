import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentUrl } from '../../src/selfhost/agent-url-policy.js';

test('agent URL policy allows public HTTPS and Tailscale only', () => {
  assert.equal(normalizeAgentUrl('https://box.example.com/'), 'https://box.example.com');
  assert.equal(normalizeAgentUrl('http://100.109.148.14:8787'), 'http://100.109.148.14:8787');
  assert.throws(() => normalizeAgentUrl('http://127.0.0.1:8787'));
  assert.throws(() => normalizeAgentUrl('https://169.254.169.254/latest/meta-data'));
  assert.throws(() => normalizeAgentUrl('https://user:pass@box.example.com'));
});
