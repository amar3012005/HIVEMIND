/**
 * Promotion Mux — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/promotion-mux
 */

import { describe, it, expect } from 'vitest';
import { PromotionMux } from '../../core/src/executor/promotion-mux.js';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return { id: 'evt-1', type: 'step_completed', trail_id: 'trail-1', ...overrides };
}

function makeTrail(overrides = {}) {
  return { id: 'trail-1', goalId: 'goal-1', status: 'active', ...overrides };
}

function makeObservation(overrides = {}) {
  return { key: 'accuracy', value: 0.95, source: 'evaluator', ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PromotionMux', () => {
  it('should emit promotion candidate with correct fields', async () => {
    const store = new InMemoryStore();
    const mux = new PromotionMux(store);
    const event = makeEvent();
    const trail = makeTrail();
    const observations = [makeObservation()];

    const candidate = await mux.emitCandidate(event, trail, 0.9, 'rule-1', observations);

    expect(candidate).not.toBeNull();
    expect(candidate.id).toBeTruthy();
    expect(candidate.source_event_id).toBe('evt-1');
    expect(candidate.trail_id).toBe('trail-1');
    expect(candidate.promotion_rule_id).toBe('rule-1');
    expect(candidate.confidence).toBe(0.9);
    expect(candidate.observations).toEqual(observations);
    expect(candidate.created_at).toBeTruthy();
  });

  it('should generate idempotency key from event + rule + goal', async () => {
    const store = new InMemoryStore();
    const mux = new PromotionMux(store);
    const event = makeEvent({ id: 'evt-42' });
    const trail = makeTrail({ goalId: 'goal-7' });

    const candidate = await mux.emitCandidate(event, trail, 0.8, 'rule-3', []);

    expect(candidate.dedupe_key).toBe('evt-42:rule-3:goal-7');
  });

  it('should deduplicate candidates with same dedupe_key', async () => {
    const store = new InMemoryStore();
    const mux = new PromotionMux(store);
    const event = makeEvent();
    const trail = makeTrail();

    const first = await mux.emitCandidate(event, trail, 0.9, 'rule-1', []);
    const second = await mux.emitCandidate(event, trail, 0.95, 'rule-1', []);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const candidates = await store.getPromotionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(0.9); // first one wins
  });

  it('should set status to pending', async () => {
    const store = new InMemoryStore();
    const mux = new PromotionMux(store);

    const candidate = await mux.emitCandidate(
      makeEvent(),
      makeTrail(),
      0.85,
      'rule-1',
      [],
    );

    expect(candidate.status).toBe('pending');
  });

  it('should include observations in candidate', async () => {
    const store = new InMemoryStore();
    const mux = new PromotionMux(store);
    const observations = [
      makeObservation({ key: 'accuracy', value: 0.95 }),
      makeObservation({ key: 'latency', value: 120 }),
    ];

    const candidate = await mux.emitCandidate(
      makeEvent(),
      makeTrail(),
      0.9,
      'rule-1',
      observations,
    );

    expect(candidate.observations).toHaveLength(2);
    expect(candidate.observations[0].key).toBe('accuracy');
    expect(candidate.observations[1].key).toBe('latency');
  });
});
