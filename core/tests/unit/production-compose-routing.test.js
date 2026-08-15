import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production Core reaches Nango over its container listening port', async () => {
  const compose = await readFile(new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
  const coreService = compose.split('\n  nango:\n', 1)[0];

  assert.match(coreService, /^\s{6}NANGO_URL: http:\/\/nango:8080$/m);
  assert.doesNotMatch(coreService, /^\s{6}NANGO_URL: .*:3003$/m);
});
