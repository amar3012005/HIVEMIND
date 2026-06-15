import test from 'node:test';
import assert from 'node:assert/strict';
import { ResidentAgentScheduler } from '../../src/resident/scheduler.js';

// tx stub that satisfies tryAcquire/release advisory-lock queries.
const txStub = {
  $queryRawUnsafe: async (sql) => {
    if (/hashtext/.test(sql)) return [{ h: 1 }];
    // H5: transaction-scoped lock (auto-released on commit/rollback, no unlock).
    if (/pg_try_advisory_xact_lock/.test(sql)) return [{ got: true }];
    return [];
  },
};

function ctx(recentRun) {
  const calls = { runOnce: [] };
  // H7: the once/20h dedup now reads tx.cognitionRun (on the locked tx), so the
  // tx handed to the $transaction callback must expose cognitionRun.findFirst.
  const tx = { ...txStub, cognitionRun: { findFirst: async () => recentRun } };
  return {
    calls,
    scheduleEnabled: true, scheduleInFlight: false, tickInFlight: false,
    scheduleLookbackHours: 24,
    _lastScheduledDreamDate: new Map(),
    logger: { log() {}, warn() {} },
    prisma: {
      $transaction: async (fn) => fn(tx),
      cognitionRun: { findFirst: async () => recentRun },
    },
    cognitionLoopRef: () => ({
      runOnce: async (org, opts) => { calls.runOnce.push({ org, opts }); return { synth: 1 }; },
      dreamRetentionForOrg: async () => ({}),
    }),
    _orgSchedules: async () => [{ id: 'org-1', mode: 'nightmode', tz: 'UTC' }],
    _localClock: () => ({ hour: 0, date: '2026-06-15' }),
    _withinDreamWindow: () => true,
  };
}
const run = (c) => ResidentAgentScheduler.prototype._maybeScheduledDream.call(c);

test('scheduled dream passes skipCompaction:true (never destructive drift-compaction on auto path)', async () => {
  const c = ctx(null); // no recent run → should dream
  await run(c);
  assert.equal(c.calls.runOnce.length, 1, 'one scheduled dream fired');
  assert.equal(c.calls.runOnce[0].opts.skipCompaction, true, 'skipCompaction MUST be true');
  assert.equal(c.calls.runOnce[0].opts.trigger, 'scheduled');
  assert.equal(c.calls.runOnce[0].opts.lookbackHours, 24);
});

test('scheduled dream cross-replica once/day dedup: skips when a recent scheduled run exists', async () => {
  const c = ctx({ id: 'already-ran-today' }); // recent run present
  await run(c);
  assert.equal(c.calls.runOnce.length, 0, 'no second dream when one already ran in the last 20h');
});
