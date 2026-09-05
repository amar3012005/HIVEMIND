import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const controlPlaneServer = path.join(repoRoot, 'core/src/control-plane-server.js');

function readControlPlane() {
  return fs.readFileSync(controlPlaneServer, 'utf8');
}

test('control-plane gates recurring schedulers behind runtime role checks', () => {
  const text = readControlPlane();
  assert.match(text, /if \(prisma && shouldRunRecurringMaintenanceJobs\(\)\) \{/);
  assert.match(text, /if \(prisma && HYPER_CYCLE_ENABLED && shouldRunRecurringMaintenanceJobs\(\)\) \{/);
  assert.match(text, /const HYPER_CYCLE_START_EMAIL_ENABLED = String\(process\.env\.HYPER_CYCLE_START_EMAIL_ENABLED \|\| 'false'\)/);
  assert.match(text, /if \(HYPER_CYCLE_START_EMAIL_ENABLED\) \{/);
  assert.match(text, /if \(shouldStartHttpServer\(\)\) \{/);
});

test('workspace lifecycle notifications exclude generic activity events', () => {
  const text = readControlPlane();
  assert.match(text, /type: \{ startsWith: 'lifecycle\.' \}/);
  assert.match(text, /const lifecycleWhere = \{ orgId: current\.session\.orgId, userId: current\.session\.userId, type: \{ startsWith: 'lifecycle\.' \} \}/);
});

test('control-plane routes hyper room-turn dispatches through shared helper', () => {
  const text = readControlPlane();
  assert.match(text, /function dispatchHyperRoomTurn\(body\)/);
  assert.equal(text.includes("fetch(`${sidecarBase}/internal/hyper/room-turn`"), false);
  assert.equal(text.includes("fetch(`${process.env.EMPLOYEES_SIDECAR_URL || 'http://hm-employees:8060'}/internal/hyper/room-turn`"), false);
});

test('control-plane has no hard-coded internal master-key fallback', () => {
  const text = readControlPlane();
  assert.equal(text.includes('hm_master_key_99228811'), false);
  assert.match(text, /getInternalApiKey/);
});
