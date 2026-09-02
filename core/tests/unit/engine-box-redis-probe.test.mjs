import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { probeEngineBoxServices } from '../../src/engine-box/lean-server.mjs';

test('Engine Box readiness marks Redis unavailable when its authenticated probe cannot connect', async () => {
  const result = await probeEngineBoxServices({
    qdrantUrl: 'http://127.0.0.1:1', modelRouterUrl: 'http://127.0.0.1:1',
    probes: { postgres: async () => 'ready', extract: async () => 'ready', controlPlane: async () => 'ready', redis: async () => 'unavailable' },
  });
  assert.equal(result.redis, 'unavailable');
});
