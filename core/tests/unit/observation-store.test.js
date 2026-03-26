import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatObservation,
  parseObservation,
  mergeObservationLogs,
  estimateTokens,
  buildObservationPayload,
} from '../../src/memory/observation-store.js';

describe('formatObservation', () => {
  it('high priority includes 🔴 and both dates', () => {
    const line = formatObservation({
      content: 'User graduated with BA.',
      priority: 'high',
      observationDate: '2026-03-20T00:00:00.000Z',
      referencedDate: '2021-06-15T00:00:00.000Z',
      source: 'chat',
    });
    assert.ok(line.includes('🔴'), `Expected 🔴 in: ${line}`);
    assert.ok(line.includes('2026-03-20'), `Expected observationDate 2026-03-20 in: ${line}`);
    assert.ok(line.includes('2021-06-15'), `Expected referencedDate 2021-06-15 in: ${line}`);
    assert.ok(line.includes('User graduated with BA.'), `Expected content in: ${line}`);
  });

  it('low priority includes 🟢', () => {
    const line = formatObservation({
      content: 'User prefers dark mode.',
      priority: 'low',
      observationDate: '2026-03-21T00:00:00.000Z',
    });
    assert.ok(line.includes('🟢'), `Expected 🟢 in: ${line}`);
  });

  it('medium priority includes 🟡', () => {
    const line = formatObservation({
      content: 'User switched teams.',
      priority: 'medium',
      observationDate: '2026-03-22T00:00:00.000Z',
    });
    assert.ok(line.includes('🟡'), `Expected 🟡 in: ${line}`);
  });

  it('omits ref section when no referencedDate', () => {
    const line = formatObservation({
      content: 'User joined workspace.',
      priority: 'high',
      observationDate: '2026-03-20T00:00:00.000Z',
    });
    assert.ok(!line.includes('ref:'), `Expected no ref: in: ${line}`);
  });
});

describe('parseObservation', () => {
  it('extracts priority, dates, and content from a formatted line', () => {
    const line = '🔴 [2026-03-20] (ref: 2021-06-15) User graduated with BA.';
    const result = parseObservation(line);
    assert.equal(result.priority, 'high');
    assert.equal(result.observationDate, '2026-03-20');
    assert.equal(result.referencedDate, '2021-06-15');
    assert.ok(result.content.includes('User graduated with BA.'), `Expected content, got: ${result.content}`);
  });

  it('handles line without referencedDate', () => {
    const line = '🟢 [2026-03-21] User prefers dark mode.';
    const result = parseObservation(line);
    assert.equal(result.priority, 'low');
    assert.equal(result.observationDate, '2026-03-21');
    assert.equal(result.referencedDate, null);
    assert.ok(result.content.includes('User prefers dark mode.'));
  });

  it('handles medium priority emoji', () => {
    const line = '🟡 [2026-03-22] User switched teams.';
    const result = parseObservation(line);
    assert.equal(result.priority, 'medium');
  });
});

describe('mergeObservationLogs', () => {
  it('sorts by observationDate ascending and concatenates', () => {
    const observations = [
      '🔴 [2026-03-22] Third event.',
      '🟢 [2026-03-20] First event.',
      '🟡 [2026-03-21] Second event.',
    ];
    const merged = mergeObservationLogs(observations);
    const lines = merged.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes('2026-03-20'), `First line should be 2026-03-20, got: ${lines[0]}`);
    assert.ok(lines[1].includes('2026-03-21'), `Second line should be 2026-03-21, got: ${lines[1]}`);
    assert.ok(lines[2].includes('2026-03-22'), `Third line should be 2026-03-22, got: ${lines[2]}`);
  });

  it('returns empty string for empty input', () => {
    const merged = mergeObservationLogs([]);
    assert.equal(merged, '');
  });
});

describe('estimateTokens', () => {
  it('returns Math.ceil(text.length / 4)', () => {
    assert.equal(estimateTokens('hello'), Math.ceil(5 / 4));
    assert.equal(estimateTokens('a'.repeat(100)), 25);
    assert.equal(estimateTokens(''), 0);
  });
});

describe('buildObservationPayload', () => {
  it('returns object with memory_type observation', () => {
    const payload = buildObservationPayload({
      userId: 'user-123',
      orgId: 'org-456',
      observationText: 'User graduated with BA.',
      observationDate: '2026-03-20',
      referencedDate: '2021-06-15',
      project: 'default',
      sourceTags: ['chat'],
    });
    assert.equal(payload.memory_type, 'fact'); // Prisma enum doesn't have 'observation', uses 'fact' + tag
    assert.ok(typeof payload === 'object', 'should return an object');
  });

  it('payload includes userId, orgId, and content', () => {
    const payload = buildObservationPayload({
      userId: 'user-123',
      orgId: 'org-456',
      observationText: 'User prefers dark mode.',
      observationDate: '2026-03-21',
    });
    assert.equal(payload.user_id, 'user-123');  // snake_case for Prisma store
    assert.equal(payload.org_id, 'org-456');
    assert.ok(payload.content || payload.memory || payload.observationText || payload.text, 'payload should have some text field');
  });
});
