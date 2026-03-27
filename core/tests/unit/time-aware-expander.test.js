import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// We use a fixed "now" so tests are deterministic.
// Set it to 2026-03-26T12:00:00.000Z (matches the project's current date)
const FIXED_NOW = new Date('2026-03-26T12:00:00.000Z');

let expandTemporalQuery;

before(async () => {
  // Patch Date so the module uses a deterministic "now"
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(FIXED_NOW.getTime());
      } else {
        super(...args);
      }
    }
    static now() { return FIXED_NOW.getTime(); }
  };
  // Copy over static methods not covered by class
  Object.setPrototypeOf(globalThis.Date, RealDate);

  ({ expandTemporalQuery } = await import('../../src/search/time-aware-expander.js'));
});

describe('expandTemporalQuery - relative: last week', () => {
  it('returns hasTemporalFilter true and ~7 day range', () => {
    const result = expandTemporalQuery('show me notes from last week');
    assert.equal(result.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(result.dateRange, 'should have dateRange');
    const start = new Date(result.dateRange.start);
    const end = new Date(result.dateRange.end);
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    assert.ok(diffDays >= 6 && diffDays <= 8, `Expected ~7 day range, got ${diffDays} days`);
  });
});

describe('expandTemporalQuery - weekday references', () => {
  it('returns the most recent Tuesday for last Tuesday and the upcoming Monday for next Monday', () => {
    const lastTuesday = expandTemporalQuery('what changed last Tuesday?');
    assert.equal(lastTuesday.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(lastTuesday.dateRange, 'should have dateRange');
    const lastTuesdayStart = new Date(lastTuesday.dateRange.start);
    assert.equal(lastTuesdayStart.getUTCFullYear(), 2026);
    assert.equal(lastTuesdayStart.getUTCMonth(), 2);
    assert.equal(lastTuesdayStart.getUTCDate(), 24);

    const nextMonday = expandTemporalQuery('what is planned for next Monday?');
    assert.equal(nextMonday.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(nextMonday.dateRange, 'should have dateRange');
    const nextMondayStart = new Date(nextMonday.dateRange.start);
    assert.equal(nextMondayStart.getUTCFullYear(), 2026);
    assert.equal(nextMondayStart.getUTCMonth(), 2);
    assert.equal(nextMondayStart.getUTCDate(), 30);
  });
});

describe('expandTemporalQuery - quarter references', () => {
  it('returns hasTemporalFilter true and Q1 2026 range', () => {
    const result = expandTemporalQuery('what happened in Q1 2026?');
    assert.equal(result.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(result.dateRange, 'should have dateRange');
    const start = new Date(result.dateRange.start);
    const end = new Date(result.dateRange.end);
    assert.equal(start.getUTCFullYear(), 2026);
    assert.equal(start.getUTCMonth(), 0);
    assert.equal(start.getUTCDate(), 1);
    assert.equal(end.getUTCFullYear(), 2026);
    assert.equal(end.getUTCMonth(), 2);
    assert.equal(end.getUTCDate(), 31);
  });
});

describe('expandTemporalQuery - absolute month+year: in March 2026', () => {
  it('returns hasTemporalFilter true and March date range (month index 2)', () => {
    const result = expandTemporalQuery('what happened in March 2026?');
    assert.equal(result.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(result.dateRange, 'should have dateRange');
    const start = new Date(result.dateRange.start);
    assert.equal(start.getUTCMonth(), 2, 'start month should be March (index 2)');
    assert.equal(start.getUTCFullYear(), 2026, 'start year should be 2026');
    assert.equal(start.getUTCDate(), 1, 'start day should be 1st');
    const end = new Date(result.dateRange.end);
    assert.equal(end.getUTCMonth(), 2, 'end month should be March (index 2)');
    assert.equal(end.getUTCDate(), 31, 'end day should be 31st');
  });
});

describe('expandTemporalQuery - non-temporal query', () => {
  it('returns hasTemporalFilter false for plain query', () => {
    const result = expandTemporalQuery('what is the capital of France?');
    assert.equal(result.hasTemporalFilter, false, 'should not have temporal filter');
    assert.equal(result.dateRange, undefined, 'should have no dateRange');
  });
});

describe('expandTemporalQuery - yesterday', () => {
  it('returns hasTemporalFilter true and ~1 day back range', () => {
    const result = expandTemporalQuery('what did I work on yesterday?');
    assert.equal(result.hasTemporalFilter, true, 'should have temporal filter');
    assert.ok(result.dateRange, 'should have dateRange');
    const start = new Date(result.dateRange.start);
    // start should be 2026-03-25 (1 day before fixed now of 2026-03-26)
    assert.equal(start.getUTCFullYear(), 2026, 'year should be 2026');
    assert.equal(start.getUTCMonth(), 2, 'month should be March (index 2)');
    assert.equal(start.getUTCDate(), 25, 'day should be 25 (yesterday)');
    // Start should be approximately 1-2 days before now
    const daysBack = (FIXED_NOW - start) / (1000 * 60 * 60 * 24);
    assert.ok(daysBack >= 0.5 && daysBack <= 2, `Expected start ~1 day back, got ${daysBack} days back`);
  });
});

describe('expandTemporalQuery - empty/null input', () => {
  it('returns hasTemporalFilter false for empty string', () => {
    const result = expandTemporalQuery('');
    assert.equal(result.hasTemporalFilter, false);
    assert.equal(result.dateRange, undefined);
  });

  it('returns hasTemporalFilter false for null', () => {
    const result = expandTemporalQuery(null);
    assert.equal(result.hasTemporalFilter, false);
    assert.equal(result.dateRange, undefined);
  });

  it('returns hasTemporalFilter false for undefined', () => {
    const result = expandTemporalQuery(undefined);
    assert.equal(result.hasTemporalFilter, false);
    assert.equal(result.dateRange, undefined);
  });
});
