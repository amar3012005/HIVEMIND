import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('authentication logs do not expose callback queries or session IDs', () => {
  const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*req\.url/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*sessionId/);
});
