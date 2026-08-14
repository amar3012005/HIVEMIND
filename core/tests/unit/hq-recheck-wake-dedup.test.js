import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for a real production incident (2026-08-15): the
// /v1/hq/capabilities/recheck endpoint keyed its connector_changed wake with
// `connector_changed:${Date.now()}`, which is unique every millisecond and
// defeats HqSchedule's `@@unique([orgId, idempotencyKey])` dedup. Every
// recheck call (however fast the caller polls) minted a brand-new schedule
// row and immediately triggered a full HQ wake-and-reprocess cycle — observed
// as a sub-second noise storm of identical wake narration for an org stuck
// waiting on an unconnected capability. requestWake's own default key
// (triggerType + minute bucket) is what every other call site in this file
// relies on for safe coalescing; this endpoint must use that same default,
// not a custom always-unique key.
const routesSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '..', 'src', 'hq-runtime', 'routes.js'),
  'utf8',
);

test('capabilities/recheck does not mint a Date.now()-unique wake key', () => {
  assert.equal(
    routesSource.includes('connector_changed:${Date.now()}'),
    false,
    'a Date.now()-suffixed idempotency key defeats HqSchedule dedup and causes a wake-storm on rapid polling',
  );
});

test('capabilities/recheck requests a connector_changed wake without a custom key (falls back to requestWake\'s minute-bucketed default)', () => {
  const match = routesSource.match(
    /const schedule = result\.resolved\.length \? null : await requestWake\(\{([^}]*)\}\);/,
  );
  assert.ok(match, 'expected the recheck endpoint\'s wake-request call to still exist in this shape');
  assert.equal(/\bkey\s*:/.test(match[1]), false, 'no custom `key` should be passed — let it use the safe per-minute default');
  assert.match(match[1], /triggerType:\s*'connector_changed'/);
});
