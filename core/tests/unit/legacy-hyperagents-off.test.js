// The retired legacy HyperAgents jobs (stuck-turn sweeper, nightly cycle, hm-employees transport warmup) stay off unless
// HYPERAGENTS_LEGACY_ENABLED=true, so Control no longer calls the stopped hm-employees service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../../src/hq-runtime/scheduler.js', import.meta.url), 'utf8');

test('one flag, default off', () => {
  assert.match(server, /const HYPERAGENTS_LEGACY_ENABLED = String\(process\.env\.HYPERAGENTS_LEGACY_ENABLED \|\| 'false'\)\.toLowerCase\(\) === 'true';/);
});

test('the sweeper and the nightly cycle start only with the flag', () => {
  assert.match(server, /if \(prisma && HYPERAGENTS_LEGACY_ENABLED && shouldRunRecurringMaintenanceJobs\(\)\) \{\n  const _sweepSeen/);
  assert.match(server, /if \(prisma && HYPERAGENTS_LEGACY_ENABLED && HYPER_CYCLE_ENABLED && shouldRunRecurringMaintenanceJobs\(\)\) \{/);
});

test('the hm-employees transport warmup runs only with the flag', () => {
  assert.match(scheduler, /if \(String\(process\.env\.HYPERAGENTS_LEGACY_ENABLED \|\| 'false'\)\.toLowerCase\(\) === 'true'\) \{\n\s+await warmRuntimeOrigin\(employeesSidecarUrl\(\)/);
  assert.equal((scheduler.match(/warmRuntimeOrigin\(/g) ?? []).length, 1, 'no other warmup call');
});
