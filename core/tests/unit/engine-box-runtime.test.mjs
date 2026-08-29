import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEngineBoxCapability, engineBoxReadiness, loadEngineBoxRuntime } from '../../src/engine-box/runtime.js';

test('Engine Box boot needs explicit mode and does not silently enable hosted capabilities', () => {
  assert.equal(loadEngineBoxRuntime({}).enabled, false);
  assert.throws(() => loadEngineBoxRuntime({ ENGINE_BOX_MODE: 'true', ENGINE_BOX_ENABLE: 'chat,connectors' }), /hosted-only/);
  const runtime = loadEngineBoxRuntime({ ENGINE_BOX_MODE: 'true' });
  assert.throws(() => assertEngineBoxCapability(runtime, 'voice'), /disabled/);
});

test('Engine Box readiness degrades safely after lease expiry', () => {
  const services = Object.fromEntries(['postgres', 'qdrant', 'redis', 'core', 'ingestion', 'hm_extract', 'mcp'].map((name) => [name, 'ready']));
  assert.equal(engineBoxReadiness({ services, modelRoute: { execution: 'local' }, license: { expiresAt: '2020-01-01T00:00:00Z' } }).state, 'DEGRADED');
});
