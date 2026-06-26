import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGate,
  localClock,
  LAWFUL_BASES,
  DEFAULT_B2B_COUNTRIES,
  DEFAULT_B2C_RESTRICTED,
} from '../../src/tara/compliance-gate.js';

// A Tuesday 14:00 UTC — inside default Mon-Fri 09:00-20:00 window for IE/NL/FR.
const TUE_1400_UTC = new Date('2026-06-23T14:00:00.000Z');

/** Build a passing contact, overridable per-test. */
const contact = (over = {}) => ({
  phone: '+353871234567',
  country: 'IE',
  lawfulBasis: 'legitimate_interest',
  timezone: 'Europe/Dublin',
  ...over,
});

test('happy path: valid B2B contact in window is cleared', () => {
  const d = evaluateGate({ contact: contact(), now: TUE_1400_UTC });
  assert.equal(d.allow, true);
  assert.equal(d.stage, 'cleared');
});

test('default is don\'t-call: empty input blocks', () => {
  const d = evaluateGate();
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'input');
});

test('stage 1 DNC: phone on do-not-call list is blocked', () => {
  const dncSet = new Set(['+353871234567']);
  const d = evaluateGate({ contact: contact(), dncSet, now: TUE_1400_UTC });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'dnc');
});

test('stage 2 lawful basis: missing basis is blocked', () => {
  const d = evaluateGate({ contact: contact({ lawfulBasis: undefined }), now: TUE_1400_UTC });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'lawful_basis');
});

test('stage 2 lawful basis: unrecognised basis is blocked', () => {
  const d = evaluateGate({ contact: contact({ lawfulBasis: 'vibes' }), now: TUE_1400_UTC });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'lawful_basis');
});

test('stage 3 country: DE B2C-restricted with legitimate-interest is skipped', () => {
  const d = evaluateGate({
    contact: contact({ country: 'DE', timezone: 'Europe/Berlin' }),
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'country');
  assert.match(d.reason, /B2C-restricted/);
});

test('stage 3 country: IT B2C-restricted is skipped', () => {
  const d = evaluateGate({
    contact: contact({ country: 'IT', timezone: 'Europe/Rome' }),
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'country');
});

test('stage 3 country: unknown country blocked for legitimate-interest', () => {
  const d = evaluateGate({ contact: contact({ country: '' }), now: TUE_1400_UTC });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'country');
});

test('stage 3 country: explicit consent OVERRIDES B2C restriction', () => {
  const d = evaluateGate({
    contact: contact({ country: 'DE', timezone: 'Europe/Berlin', lawfulBasis: 'consent' }),
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, true);
  assert.equal(d.stage, 'cleared');
});

test('stage 4 calling hours: before window start is blocked', () => {
  // 06:00 UTC == 07:00 IST, before 09:00 default start.
  const early = new Date('2026-06-23T06:00:00.000Z');
  const d = evaluateGate({ contact: contact(), now: early });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'calling_hours');
});

test('stage 4 calling hours: weekend blocked by default Mon-Fri', () => {
  const sat = new Date('2026-06-20T14:00:00.000Z'); // Saturday
  const d = evaluateGate({ contact: contact(), now: sat });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'calling_hours');
});

test('stage 4 calling hours: missing timezone blocked', () => {
  const d = evaluateGate({
    contact: contact({ timezone: undefined }),
    campaign: {},
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'calling_hours');
});

test('stage 4 calling hours: invalid timezone blocked', () => {
  const d = evaluateGate({ contact: contact({ timezone: 'Mars/Olympus' }), now: TUE_1400_UTC });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'calling_hours');
});

test('stage 5 caps: concurrency at cap is blocked', () => {
  const d = evaluateGate({
    contact: contact(),
    campaign: { caps: { concurrency: 2 } },
    concurrency: 2,
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'caps');
  assert.match(d.reason, /concurrency/);
});

test('stage 5 caps: daily max reached is blocked', () => {
  const d = evaluateGate({
    contact: contact(),
    campaign: { caps: { concurrency: 5, dailyMax: 100 } },
    concurrency: 1,
    todayCount: 100,
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, false);
  assert.equal(d.stage, 'caps');
  assert.match(d.reason, /daily/);
});

test('stage 5 caps: under both caps clears', () => {
  const d = evaluateGate({
    contact: contact(),
    campaign: { caps: { concurrency: 5, dailyMax: 100 } },
    concurrency: 1,
    todayCount: 50,
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, true);
});

test('order: DNC beats lawful-basis (DNC checked first)', () => {
  const dncSet = new Set(['+353871234567']);
  const d = evaluateGate({
    contact: contact({ lawfulBasis: undefined }),
    dncSet,
    now: TUE_1400_UTC,
  });
  assert.equal(d.stage, 'dnc'); // not lawful_basis
});

test('campaign complianceConfig can extend allowed B2B countries', () => {
  const d = evaluateGate({
    contact: contact({ country: 'ES', timezone: 'Europe/Madrid' }),
    campaign: { complianceConfig: { b2bCountries: ['IE', 'NL', 'FR', 'ES'] } },
    now: TUE_1400_UTC,
  });
  assert.equal(d.allow, true);
});

test('localClock resolves tz hour/weekday', () => {
  const c = localClock(TUE_1400_UTC, 'Europe/Dublin');
  assert.equal(c.weekday, 2); // Tuesday
  assert.equal(c.hour, 15); // 14:00 UTC = 15:00 IST (summer)
});

test('exported policy constants are sane', () => {
  assert.ok(LAWFUL_BASES.includes('consent'));
  assert.deepEqual([...DEFAULT_B2B_COUNTRIES], ['IE', 'NL', 'FR']);
  assert.deepEqual([...DEFAULT_B2C_RESTRICTED], ['DE', 'IT']);
});
