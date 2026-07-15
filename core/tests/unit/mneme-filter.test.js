import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter } from '../../src/vector/mneme/mneme-recall.js';

const temporalFilter = {
  must: [
    { key: 'org_id', match: { value: 'org-1' } },
    { key: 'created_at', range: { lte: '2026-01-20T00:00:00.000Z' } },
    {
      should: [
        { is_empty: { key: 'valid_from' } },
        { key: 'valid_from', range: { lte: '2026-01-15T00:00:00.000Z' } },
      ],
    },
    {
      should: [
        { is_empty: { key: 'valid_to' } },
        { key: 'valid_to', range: { gt: '2026-01-15T00:00:00.000Z' } },
      ],
    },
  ],
};

test('mneme applies nested known-time and valid-time filters before ranking', () => {
  assert.equal(matchesFilter({
    orgId: 'org-1', createdAt: '2026-01-10T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z',
  }, temporalFilter), true);
  assert.equal(matchesFilter({
    orgId: 'org-1', createdAt: '2026-01-25T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z',
  }, temporalFilter), false);
  assert.equal(matchesFilter({
    orgId: 'org-1', createdAt: '2026-01-10T00:00:00.000Z',
    validFrom: '2026-02-01T00:00:00.000Z', validTo: null,
  }, temporalFilter), false);
});

test('mneme treats missing valid-time bounds as unbounded', () => {
  assert.equal(matchesFilter({
    orgId: 'org-1', createdAt: '2026-01-10T00:00:00.000Z',
  }, temporalFilter), true);
});
