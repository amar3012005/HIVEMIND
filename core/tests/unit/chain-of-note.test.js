import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatChainOfNotePayload } from '../../src/memory/operator-layer.js';

describe('formatChainOfNotePayload', () => {
  it('produces structured memory injection with query and instructions', () => {
    const memories = [
      { id: 'mem-1', content: 'Sarah proposed OAuth2 migration.', memory_type: 'decision', created_at: '2026-03-10T10:00:00Z' },
      { id: 'mem-2', content: 'Jake approved the RFC on March 14.', memory_type: 'event', created_at: '2026-03-14T10:00:00Z' },
    ];
    const payload = formatChainOfNotePayload(memories, 'What was decided about auth?');
    assert.ok(payload.includes('<chain-of-note>'));
    assert.ok(payload.includes('</chain-of-note>'));
    assert.ok(payload.includes('"id": "mem-1"'));
    assert.ok(payload.includes('OAuth2'));
    assert.ok(payload.includes('INSTRUCTIONS'));
    assert.ok(payload.includes('write a brief note'));
    assert.ok(payload.includes('reason over your notes'));
  });

  it('handles empty memories array', () => {
    const payload = formatChainOfNotePayload([], 'test query');
    assert.ok(payload.includes('<chain-of-note>'));
    assert.ok(payload.includes('[]'));
  });

  it('truncates long content to 1000 chars', () => {
    const longContent = 'x'.repeat(2000);
    const memories = [{ id: 'm1', content: longContent, memory_type: 'fact', created_at: '2026-01-01' }];
    const payload = formatChainOfNotePayload(memories, 'test');
    assert.ok(!payload.includes('x'.repeat(1001)));
  });
});
